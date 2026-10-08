#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
mode="${1:---probe}"
if [[ "$mode" != "--probe" && "$mode" != "--install" ]]; then
  echo "Usage: $0 [--probe|--install]" >&2
  exit 2
fi
if [[ "$(id -u)" == "0" ]]; then
  echo "The extension runner must be tested as a non-root account." >&2
  exit 1
fi

# Keep the mounted supervisor fixture and rootless runner on the same verified
# namespace prerequisites. Never repair an ambiguous existing allocation.
validate_subordinate_mapping() {
  python3 - "$1" "$(id -un)" "$(id -u)" "${2:-$mode}" <<'PYMAP'
import pathlib, sys
path, account, uid, mode = sys.argv[1:]
try:
    allocations = []
    for line in pathlib.Path(path).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split(":")
        if len(fields) != 3 or not fields[1].isdigit() or not fields[2].isdigit():
            raise ValueError("malformed allocation")
        owner, start, count = fields[0], int(fields[1]), int(fields[2])
        if not owner or start < 1 or count < 1 or start + count > 4294967295:
            raise ValueError("unsafe allocation")
        allocations.append((start, start + count, owner))
    ordered = sorted(allocations)
    if any(left[1] > right[0] for left, right in zip(ordered, ordered[1:])):
        raise ValueError("overlapping allocations")
    owned = [entry for entry in allocations if entry[2] in (account, uid)]
    if len(owned) > 1:
        raise ValueError("ambiguous account allocations")
    if owned:
        if owned[0][1] - owned[0][0] < 62041:
            raise ValueError("requires 62041 contiguous subordinate IDs")
    elif mode == "--install":
        start = max([100000] + [entry[1] for entry in allocations])
        if start + 65536 > 4294967295:
            raise ValueError("no safe allocation available")
        print(start)
    else:
        raise ValueError("requires 62041 contiguous subordinate IDs")
except (OSError, ValueError) as error:
    sys.exit(f"{path}: {error}; provision a safe account range before running CI")
PYMAP
}

diagnose_namespace_restriction() {
  local context
  context='
import json, pathlib, platform, sys
paths = ["/proc/self/uid_map", "/proc/self/gid_map", "/proc/self/attr/current",
         "/sys/module/apparmor/parameters/enabled",
         "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
         "/proc/sys/kernel/unprivileged_userns_clone"]
result = {"context": sys.argv[1], "kernel": platform.release()}
for name in paths:
    try:
        result[name] = pathlib.Path(name).read_text().strip()
    except OSError as error:
        result[name] = {"unavailable": error.errno}
try:
    result["status"] = [line for line in pathlib.Path("/proc/self/status").read_text().splitlines()
                        if line.split(":", 1)[0] in ("Uid", "Gid", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp")]
except OSError as error:
    result["status"] = {"unavailable": error.errno}
print(json.dumps(result, sort_keys=True))
'
  echo "Namespace failure diagnostics (the required probe still fails):" >&2
  unshare --version >&2 || true
  python3 -c "$context" host >&2 || true
  # Diagnostic only: keep the same user mapping while avoiding the failed
  # propagation operation long enough to inspect capabilities and LSM label.
  timeout 5s unshare --user --map-root-user --map-auto --mount --propagation unchanged \
    python3 -c "$context" mapped-namespace >&2 || true
  if [[ "$mode" == "--install" ]] && command -v journalctl >/dev/null; then
    timeout 5s sudo journalctl --dmesg --no-pager --since "2 minutes ago" \
      --grep 'apparmor="DENIED"' --output cat >&2 || true
  fi
}

verify_namespace_prerequisites() {
  local executable mapping range_start range_end
  for executable in podman python3 flock setpriv bun unshare newuidmap newgidmap timeout; do
    if ! command -v "$executable" >/dev/null; then
      echo "Missing required namespace/runner tool: $executable; install uidmap, util-linux and python3." >&2
      exit 1
    fi
  done
  for mapping in subuid subgid; do
    range_start="$(validate_subordinate_mapping "/etc/$mapping")"
    if [[ -n "$range_start" ]]; then
      range_end="$((range_start + 65535))"
      if [[ "$mapping" == "subuid" ]]; then
        sudo usermod --add-subuids "$range_start-$range_end" "$(id -un)"
      else
        sudo usermod --add-subgids "$range_start-$range_end" "$(id -un)"
      fi
      # Read the actual post-provisioning file; do not assume usermod succeeded.
      validate_subordinate_mapping "/etc/$mapping" --probe
    fi
  done
  if ! timeout 15s unshare --user --map-root-user --map-auto --mount python3 - <<'PYNS'
import ctypes, os, pathlib, tempfile
libc = ctypes.CDLL(None, use_errno=True)
with tempfile.TemporaryDirectory(prefix="ez-runner-namespace-probe-") as temporary:
    source = pathlib.Path(temporary) / "source"
    target = pathlib.Path(temporary) / "target"
    source.mkdir()
    target.mkdir()
    os.chown(source, 62040, 62040)
    if libc.mount(os.fsencode(source), os.fsencode(target), None, 4096, None) != 0:
        raise OSError(ctypes.get_errno(), "namespace bind mount failed")
    try:
        observed = target.stat()
        if observed.st_uid != 62040 or observed.st_gid != 62040:
            raise ValueError("namespace mapping does not cover application UID/GID 62040")
    finally:
        if libc.umount2(os.fsencode(target), 0) != 0:
            raise OSError(ctypes.get_errno(), "namespace unmount failed")
PYNS
  then
    diagnose_namespace_restriction
    echo "User namespace mount probe failed; enable Linux user namespaces and permit unshare/newuidmap/newgidmap for this CI account." >&2
    exit 1
  fi
}

if [[ "$mode" == "--install" ]]; then
  if [[ "${CI:-}" != "true" || ! -x /usr/bin/apt-get ]]; then
    echo "Automatic installation is restricted to ephemeral Debian/Ubuntu CI hosts." >&2
    exit 1
  fi
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends podman uidmap slirp4netns fuse-overlayfs dbus-user-session python3 util-linux ca-certificates curl
  source "$repo_root/scripts/lib/extension-runner-conmon.sh"
  install_extension_runner_conmon
  verify_namespace_prerequisites
  source "$repo_root/scripts/lib/extension-runner-delegation.sh"
  configure_extension_runner_delegation
  if [[ "$(podman info --format '{{.Host.Conmon.Path}}')" != /usr/local/libexec/ezcorp-extension-runner/conmon-2.2.1 ]]; then
    echo "Podman did not select the verified CI container monitor." >&2
    exit 1
  fi
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    printf 'XDG_RUNTIME_DIR=%s\nDBUS_SESSION_BUS_ADDRESS=%s\n' "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" >> "$GITHUB_ENV"
  fi
fi

if [[ "$mode" == "--probe" ]]; then verify_namespace_prerequisites; fi
image="$(bun -e 'import { DEFAULT_IMAGE } from "./packages/@ezcorp/extension-runner/src/index.ts"; console.log(DEFAULT_IMAGE)')"
postgres_image="$(bun -e 'import images from "./scripts/test-images.json"; console.log(images.postgres)')"
for required_image in "$image" "$postgres_image"; do
  if [[ "$mode" == "--install" ]]; then podman pull "$required_image"; fi
  podman image exists "$required_image"
done
bun -e '
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner } from "./packages/@ezcorp/extension-runner/src/index.ts";
const root = await mkdtemp(join(tmpdir(), "ez-runner-ci-probe-"));
const runner = new PodmanRunner({ root });
try { await runner.initialize(); console.log("Extension runner kernel controls verified"); }
finally { await runner.close(); await rm(root, { recursive: true, force: true }); }
'
