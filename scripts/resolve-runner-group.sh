#!/usr/bin/env bash
# Print the numeric group that makes the host extension-runner socket usable
# inside an application container.
set -euo pipefail

usage() {
  echo "usage: scripts/resolve-runner-group.sh --docker|--podman" >&2
  exit 2
}

mode="${1:-}"
case "$mode" in
  --docker | --podman) ;;
  *) usage ;;
esac

socket_dir="${EZ_RUNNER_SOCKET_DIR:-/run/ez-extension-runner}"
socket="$socket_dir/runner.sock"
if [ ! -S "$socket" ]; then
  echo "error: no extension-runner socket at $socket" >&2
  echo "  Start and provision the host runner before starting Compose." >&2
  exit 1
fi

host_gid="$(stat -c '%g' "$socket" 2>/dev/null || stat -f '%g' "$socket" 2>/dev/null)" || host_gid=""
if [[ ! "$host_gid" =~ ^[0-9]+$ ]]; then
  echo "error: could not read a numeric group from $socket" >&2
  exit 1
fi

if [ "$mode" = "--docker" ]; then
  printf '%s\n' "$host_gid"
  exit 0
fi

if ! command -v podman >/dev/null 2>&1; then
  echo "error: rootless Podman is required to map the runner socket group." >&2
  exit 1
fi

if ! gid_map="$(podman unshare cat /proc/self/gid_map)"; then
  echo "error: could not read the rootless Podman gid map." >&2
  echo "  Run this as the user that starts the development stack." >&2
  exit 1
fi

while read -r container_start mapped_host_start length; do
  if [[ ! "$container_start" =~ ^[0-9]+$ ]] ||
    [[ ! "$mapped_host_start" =~ ^[0-9]+$ ]] ||
    [[ ! "$length" =~ ^[0-9]+$ ]]; then
    continue
  fi

  if ((host_gid >= mapped_host_start && host_gid - mapped_host_start < length)); then
    printf '%s\n' "$((container_start + host_gid - mapped_host_start))"
    exit 0
  fi
done <<<"$gid_map"

echo "error: runner socket host GID $host_gid is not mapped into rootless Podman." >&2
echo "  Create the runner shared group within this user's subordinate GID range." >&2
echo "  See deploy/extension-runner/README.md for the mapping setup." >&2
exit 1
