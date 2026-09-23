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
print(f"{pool}\t{bridge}")
PY
)
IFS=$'\t' read -r storage_pool network_name <<< "$build_targets"
printf '%s  %s\n' "$docker_sha" "$docker_tar" "$compose_sha" "$compose_binary" "$helper_sha" "$helper_file" | sha256sum --check --status

name="ezh-build-$(date +%s)-$$"
cleanup() { incus delete "$name" --force --project default >/dev/null 2>&1 || true; }
trap cleanup EXIT

if incus image alias list --project default --format json | python3 -c 'import json,sys;alias=sys.argv[1];sys.exit(0 if any(x.get("name")==alias for x in json.load(sys.stdin)) else 1)' "$alias"; then
  echo 'image alias already exists; review its fingerprint instead of replacing it' >&2
  exit 1
fi

incus launch "$base_fingerprint" "$name" --project default --storage "$storage_pool" --network "$network_name"
incus file push "$helper_file" "$name/root/ezh-helper.py" --project default
incus file push "$docker_tar" "$name/root/ezh-docker.tgz" --project default
incus file push "$compose_binary" "$name/root/ezh-compose" --project default

incus exec "$name" --project default -- env DEBIAN_FRONTEND=noninteractive apt-get update
incus exec "$name" --project default -- env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "python3=$python_version"
incus exec "$name" --project default -- sh -eu -c '
  install -d -m 0755 /usr/local/bin /usr/local/libexec /usr/local/lib/docker/cli-plugins
  tar -xzf /root/ezh-docker.tgz -C /usr/local/bin --strip-components=1
  install -m 0755 /root/ezh-compose /usr/local/lib/docker/cli-plugins/docker-compose
  install -o root -g root -m 0755 /root/ezh-helper.py /usr/local/libexec/ezharness-helper
  groupadd -g 1000 sandbox
  useradd -u 1000 -g 1000 -m -d /workspace -s /bin/sh sandbox
  install -d -o 1000 -g 1000 -m 0700 /workspace /var/lib/ezharness-helper
  groupadd -f docker
  usermod -aG docker sandbox
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
ExecStart=/usr/local/bin/dockerd --host=unix:///var/run/docker.sock --storage-driver=vfs
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
incus stop "$name" --project default
incus publish "$name" --project default --alias "$alias"
incus query "/1.0/images/aliases/$alias?project=default" | python3 -c 'import json,sys;print(json.load(sys.stdin)["metadata"]["target"])'
