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

if [[ "$mode" == "--install" ]]; then
  if [[ "${CI:-}" != "true" || ! -x /usr/bin/apt-get ]]; then
    echo "Automatic installation is restricted to ephemeral Debian/Ubuntu CI hosts." >&2
    exit 1
  fi
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends podman uidmap slirp4netns fuse-overlayfs dbus-user-session python3 util-linux ca-certificates
  runner_user="$(id -un)"
  runner_uid="$(id -u)"
  for mapping in subuid subgid; do
    if ! awk -F: -v account="$runner_user" '$1 == account { found = 1 } END { exit !found }' "/etc/$mapping"; then
      range_start="$(awk -F: 'BEGIN { start = 100000 } { end = $2 + $3; if (end > start) start = end } END { print start }' "/etc/$mapping")"
      range_end="$((range_start + 65535))"
      if [[ "$mapping" == "subuid" ]]; then sudo usermod --add-subuids "$range_start-$range_end" "$runner_user"; else sudo usermod --add-subgids "$range_start-$range_end" "$runner_user"; fi
    fi
  done
  sudo loginctl enable-linger "$runner_user"
  sudo systemctl start "user@$runner_uid.service"
  sudo systemctl set-property --runtime "user@$runner_uid.service" Delegate=yes
  export XDG_RUNTIME_DIR="/run/user/$runner_uid"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    printf 'XDG_RUNTIME_DIR=%s\nDBUS_SESSION_BUS_ADDRESS=%s\n' "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" >> "$GITHUB_ENV"
  fi
fi

for executable in podman python3 flock setpriv bun; do command -v "$executable" >/dev/null; done
image="$(bun -e 'import { DEFAULT_IMAGE } from "./packages/@ezcorp/extension-runner/src/index.ts"; console.log(DEFAULT_IMAGE)')"
if [[ "$mode" == "--install" ]]; then podman pull "$image"; fi
podman image exists "$image"
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
