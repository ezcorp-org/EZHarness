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
  sudo apt-get install -y --no-install-recommends podman uidmap slirp4netns fuse-overlayfs dbus-user-session python3 util-linux ca-certificates curl
  source "$repo_root/scripts/lib/extension-runner-conmon.sh"
  install_extension_runner_conmon
  runner_user="$(id -un)"
  for mapping in subuid subgid; do
    if ! awk -F: -v account="$runner_user" '$1 == account { found = 1 } END { exit !found }' "/etc/$mapping"; then
      range_start="$(awk -F: 'BEGIN { start = 100000 } { end = $2 + $3; if (end > start) start = end } END { print start }' "/etc/$mapping")"
      range_end="$((range_start + 65535))"
      if [[ "$mapping" == "subuid" ]]; then sudo usermod --add-subuids "$range_start-$range_end" "$runner_user"; else sudo usermod --add-subgids "$range_start-$range_end" "$runner_user"; fi
    fi
  done
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

for executable in podman python3 flock setpriv bun; do command -v "$executable" >/dev/null; done
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
