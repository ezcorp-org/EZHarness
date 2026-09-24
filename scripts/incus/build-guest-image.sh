#!/usr/bin/env bash
# Run on the approved Incus server only after the input fingerprints are reviewed.
set -euo pipefail

if [ "$#" -ne 10 ]; then
  echo 'usage: build-guest-image.sh RECIPE_JSON BASE_FINGERPRINT PYTHON_PACKAGE_VERSION DOCKER_TAR DOCKER_SHA256 COMPOSE_BINARY COMPOSE_SHA256 HELPER_PY HELPER_SHA256 ALIAS' >&2
  exit 2
fi

recipe_file=$1
base_fingerprint=$2
python_version=$3
docker_tar=$4
docker_sha=$5
compose_binary=$6
compose_sha=$7
helper_file=$8
helper_sha=$9
alias=${10}
iptables_version=1.8.9-2
nftables_version=1.0.6-2+deb12u2

for value in "$base_fingerprint" "$docker_sha" "$compose_sha" "$helper_sha"; do
  if [[ ! "$value" =~ ^[a-f0-9]{64}$ ]]; then echo 'expected exact SHA-256 fingerprint' >&2; exit 2; fi
done
if [[ ! "$python_version" =~ ^[A-Za-z0-9.+:~_-]{1,128}$ ]] || [[ ! "$alias" =~ ^[a-z][a-z0-9-]{0,62}$ ]]; then
  echo 'invalid pinned package version or alias' >&2; exit 2
fi
for artifact in "$recipe_file" "$docker_tar" "$compose_binary" "$helper_file"; do
  if [ ! -f "$artifact" ]; then echo "missing artifact: $artifact" >&2; exit 2; fi
done
build_targets=$(python3 - "$recipe_file" "$base_fingerprint" "$python_version" "$docker_sha" "$compose_sha" "$helper_sha" "$alias" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    recipe = json.load(source)
image = recipe["guestImage"]
expected = (image["sourceFingerprint"], image["pythonPackageVersion"],
            image["dockerArchiveSha256"], image["composeSha256"],
            image["helperSha256"], image["alias"])
if any(value is None for value in expected) or tuple(sys.argv[2:]) != expected:
    sys.exit("build inputs do not match the reviewed recipe pins")
if image["user"] != "sandbox" or image["uid"] != 1000 or image["gid"] != 1000:
    sys.exit("guest identity does not match the reviewed recipe")
pool = recipe.get("storage", {}).get("name")
network = recipe.get("network", {})
bridge = network.get("name")
if not all(isinstance(name, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,62}", name)
           for name in (pool, bridge)) or network.get("project") != "default" or network.get("type") != "bridge":
    sys.exit("build storage or network does not match the reviewed recipe")
profile = recipe.get("profile", {}).get("config", {})
if any(profile.get(key) != value for key, value in {
    "security.nesting": "true", "security.privileged": "false", "security.idmap.isolated": "true",
}.items()):
    sys.exit("build nesting and isolation do not match the reviewed recipe")
print(f"{pool}\t{bridge}")
PY
)
IFS=$'\t' read -r storage_pool network_name <<< "$build_targets"
printf '%s  %s\n' "$docker_sha" "$docker_tar" "$compose_sha" "$compose_binary" "$helper_sha" "$helper_file" | sha256sum --check --status

name="ezh-build-$(date +%s)-$$"
cleanup() { incus delete "$name" --force --project default >/dev/null 2>&1 || true; }
trap cleanup EXIT

assert_alias_absent() {
  alias_state=$(incus image alias list --project default --format json | python3 -c '
import json, sys
rows = json.load(sys.stdin)
if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get("name"), str) for row in rows):
    sys.exit("image alias inventory is invalid")
print("present" if any(row["name"] == sys.argv[1] for row in rows) else "absent")
' "$alias")
  if [ "$alias_state" = present ]; then
    echo 'image alias already exists; review its fingerprint instead of replacing it' >&2
    return 1
  fi
}
image_fingerprints() {
  incus image list --project default --format json | python3 -c '
import json, re, sys
rows = json.load(sys.stdin)
if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get("fingerprint"), str)
                                    or not re.fullmatch(r"[a-f0-9]{64}", row["fingerprint"]) for row in rows):
    sys.exit("image inventory has an invalid fingerprint")
fingerprints = [row["fingerprint"] for row in rows]
if len(fingerprints) != len(set(fingerprints)):
    sys.exit("image inventory has duplicate fingerprints")
print("\n".join(sorted(fingerprints)))
'
}
assert_alias_absent

incus launch "$base_fingerprint" "$name" --project default --storage "$storage_pool" --network "$network_name" \
  --config security.nesting=true --config security.privileged=false --config security.idmap.isolated=true
if ! timeout 75s incus exec "$name" --project default -- sh -eu -c '
  bridge=$1
  set --
  for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do
    if [ -f "$source" ]; then set -- "$@" "$source"; fi
  done
  if [ "$#" -eq 0 ]; then echo "guest has no APT source files; inspect its package sources before building" >&2; exit 1; fi
  apt_uri=$(awk '\''$1 == "URIs:" { print $2; exit } $1 == "deb" { for (i = 2; i <= NF; i++) if ($i ~ /^https?:\/\//) { print $i; exit } }'\'' "$@")
  case "$apt_uri" in
    http://*|https://*) apt_host=${apt_uri#*://}; apt_host=${apt_host%%/*}; apt_host=${apt_host##*@}; apt_host=${apt_host%%:*} ;;
    *) echo "guest has no configured HTTP APT mirror; inspect its package sources before building" >&2; exit 1 ;;
  esac
  if [ -z "$apt_host" ]; then echo "guest APT mirror host is empty; inspect its package sources before building" >&2; exit 1; fi
  has_ipv4() { ip -4 -o addr show dev eth0 scope global 2>/dev/null | grep --line-buffered -Eq " inet [0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+/"; }
  attempt=1
  while [ "$attempt" -le 12 ]; do
    if has_ipv4 && timeout 3s getent ahostsv4 "$apt_host" >/dev/null; then exit 0; fi
    if [ "$attempt" -eq 12 ]; then break; fi
    sleep 2
    attempt=$((attempt + 1))
  done
  if ! has_ipv4; then echo "guest has no global IPv4 on eth0; check DHCP and host firewall rules for reviewed bridge $bridge" >&2; exit 1; fi
  echo "guest DNS cannot resolve configured APT mirror $apt_host; check DNS and host firewall rules for reviewed bridge $bridge" >&2
  exit 1
' sh "$network_name"; then
  echo "guest network is not ready on reviewed bridge $network_name; image build stopped before APT" >&2
  exit 1
fi
incus file push "$helper_file" "$name/root/ezh-helper.py" --project default
incus file push "$docker_tar" "$name/root/ezh-docker.tgz" --project default
incus file push "$compose_binary" "$name/root/ezh-compose" --project default

if ! incus exec "$name" --project default -- sh -eu -c '. /etc/os-release; [ "$ID" = debian ] && [ "$VERSION_ID" = 12 ]'; then
  echo 'guest base must be Debian 12 for the reviewed package versions' >&2
  exit 1
fi
incus exec "$name" --project default -- env DEBIAN_FRONTEND=noninteractive apt-get update
incus exec "$name" --project default -- env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  "python3=$python_version" "iptables=$iptables_version" "nftables=$nftables_version"
incus exec "$name" --project default -- sh -eu -c '
  update-alternatives --set iptables /usr/sbin/iptables-nft
  update-alternatives --set ip6tables /usr/sbin/ip6tables-nft
  install -d -m 0755 /usr/local/bin /usr/local/libexec /usr/local/lib/docker/cli-plugins
  tar -xzf /root/ezh-docker.tgz -C /usr/local/bin --strip-components=1
  install -m 0755 /root/ezh-compose /usr/local/lib/docker/cli-plugins/docker-compose
  install -o root -g root -m 0755 /root/ezh-helper.py /usr/local/libexec/ezharness-helper
  groupadd -g 1000 sandbox
  useradd -u 1000 -g 1000 -m -d /workspace -s /bin/sh sandbox
  install -d -o 1000 -g 1000 -m 0700 /workspace /var/lib/ezharness-helper
  cat >/etc/systemd/system/ezh-containerd.service <<EOF
[Unit]
Description=Containerd for EZHarness guest
After=network-online.target
[Service]
ExecStart=/usr/local/bin/containerd
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
  cat >/etc/systemd/system/ezh-docker.service <<EOF
[Unit]
Description=Docker for EZHarness guest
Requires=ezh-containerd.service
After=ezh-containerd.service network-online.target
[Service]
ExecStart=/usr/local/bin/dockerd --host=unix:///var/run/docker.sock --group=sandbox --storage-driver=vfs
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
  systemctl enable ezh-containerd.service ezh-docker.service
  python3 --version
  docker compose version
  stat -c "%u:%g:%a" /var/lib/ezharness-helper | grep --line-buffered -x "1000:1000:700"
  stat -c "%u:%g:%a" /usr/local/libexec/ezharness-helper | grep --line-buffered -x "0:0:755"
  rm -f /root/ezh-helper.py /root/ezh-docker.tgz /root/ezh-compose
  apt-get clean
  rm -rf /var/lib/apt/lists/*
'
if ! timeout 120s incus exec "$name" --project default -- sh -eu -c '
  command -v iptables >/dev/null
  command -v nft >/dev/null
  case "$(iptables -V)" in *nf_tables*) ;; *) echo "iptables is not using the nft backend" >&2; exit 1;; esac
  systemctl start ezh-containerd.service ezh-docker.service
  systemctl is-active --quiet ezh-containerd.service
  systemctl is-active --quiet ezh-docker.service
  docker info --format "{{.ServerVersion}}" >/dev/null
'; then
  echo 'nested Docker daemon did not become ready; inspect the temporary guest service logs before publishing' >&2
  exit 1
fi
if ! timeout 30s incus exec "$name" --project default -- sh -eu -c '
  # Incus process calls set only the primary UID/GID. Verify that exact identity.
  setpriv --reuid=1000 --regid=1000 --clear-groups /usr/local/bin/docker info --format "{{.ServerVersion}}" >/dev/null
'; then
  echo 'sandbox identity cannot access the nested Docker socket; inspect its guest socket group before publishing' >&2
  exit 1
fi
incus exec "$name" --project default -- sh -eu -c '
  systemctl stop ezh-docker.service ezh-containerd.service
  if systemctl is-active --quiet ezh-docker.service || systemctl is-active --quiet ezh-containerd.service; then
    echo "Docker or containerd is still active; refusing to publish its state" >&2
    exit 1
  fi
  rm -rf -- /var/lib/docker /var/lib/containerd
  if [ -L /etc/machine-id ]; then echo "systemd machine-id is a symlink; inspect it before publishing" >&2; exit 1; fi
  : > /etc/machine-id
  install -d -m 0755 /var/lib/dbus
  rm -f -- /var/lib/dbus/machine-id
  ln -s /etc/machine-id /var/lib/dbus/machine-id
  if [ -s /etc/machine-id ] || [ ! -L /var/lib/dbus/machine-id ] || [ -e /var/lib/docker ] || [ -e /var/lib/containerd ]; then
    echo "guest identity or Docker state was not cleared" >&2
    exit 1
  fi
'
incus stop "$name" --project default
assert_alias_absent
images_before=$(image_fingerprints)
incus publish "$name" --project default --alias "$alias" --expire 2099-12-31T00:00:00Z
images_after=$(image_fingerprints)
published_fingerprint=$(python3 - "$images_before" "$images_after" <<'PY'
import sys
before = set(filter(None, sys.argv[1].splitlines()))
after = set(filter(None, sys.argv[2].splitlines()))
new = after - before
if len(new) != 1 or before - after:
    sys.exit("published image inventory does not have exactly one new fingerprint; review server state")
print(next(iter(new)))
PY
)
alias_target=$(incus query "/1.0/images/aliases/$alias?project=default" | python3 -c '
import json, re, sys
alias = json.load(sys.stdin)
if not isinstance(alias, dict) or alias.get("name") != sys.argv[1]:
    sys.exit("published image alias readback is missing or has the wrong name")
target = alias.get("target")
if not isinstance(target, str) or not re.fullmatch(r"[a-f0-9]{64}", target):
    sys.exit("published image alias has no exact fingerprint target")
print(target)
' "$alias")
if [ "$alias_target" != "$published_fingerprint" ]; then
  echo 'published image alias target differs from the published fingerprint; review server state' >&2
  exit 1
fi
image_before=$(incus query "/1.0/images/$published_fingerprint?project=default")
retention_payload=$(printf '%s\n' "$image_before" | python3 -c '
import json, sys
image = json.load(sys.stdin)
if not isinstance(image, dict) or image.get("fingerprint") != sys.argv[1]:
    sys.exit("published image fingerprint readback differs; review server state")
if not isinstance(image.get("public"), bool) or not isinstance(image.get("auto_update"), bool) or not isinstance(image.get("properties"), dict):
    sys.exit("published image writable metadata is incomplete; review server state")
profiles = image.get("profiles", ["default"])
if not isinstance(profiles, list) or any(not isinstance(profile, str) for profile in profiles):
    sys.exit("published image profiles are invalid; review server state")
payload = {key: image[key] for key in ("public", "auto_update", "properties")}
payload["profiles"] = profiles
# Incus 6.0 ignores zero time in image PUT and ignores expires_at in image PATCH.
payload["expires_at"] = "2099-12-31T00:00:00Z"
print(json.dumps(payload, separators=(",", ":")))
' "$published_fingerprint")
incus query -X PUT -d "$retention_payload" "/1.0/images/$published_fingerprint?project=default" >/dev/null
incus query "/1.0/images/$published_fingerprint?project=default" | python3 -c '
import json, sys
image = json.load(sys.stdin)
original = json.loads(sys.argv[2])
if not isinstance(image, dict) or image.get("fingerprint") != sys.argv[1] or image.get("expires_at") != "2099-12-31T00:00:00Z":
    sys.exit("published image fingerprint or durable retention readback differs; review server state")
if any(image.get(key) != original.get(key) for key in ("public", "auto_update", "properties")) or image.get("profiles", ["default"]) != original.get("profiles", ["default"]):
    sys.exit("published image metadata changed during retention update; review server state")
' "$published_fingerprint" "$image_before"
final_alias_target=$(incus query "/1.0/images/aliases/$alias?project=default" | python3 -c '
import json, sys
alias = json.load(sys.stdin)
if not isinstance(alias, dict) or alias.get("name") != sys.argv[1] or alias.get("target") != sys.argv[2]:
    sys.exit("published image alias changed during retention update; review server state")
print(alias["target"])
' "$alias" "$published_fingerprint")
printf '%s\n' "$final_alias_target"
