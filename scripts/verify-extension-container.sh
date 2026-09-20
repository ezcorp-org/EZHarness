#!/usr/bin/env bash
set -euo pipefail
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
umask 077
run_root="$(mktemp -d "${TMPDIR:-/tmp}/ez-container-runner-XXXXXXXX")"
container="ez-extension-check-$(basename "$run_root")"
runner_pid=""
runner_secret=""
redact_log() {
  local secret="$runner_secret" line
  if [[ -z "$secret" && -r "$run_root/token" ]]; then
    IFS= read -r secret < "$run_root/token" || true
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ -n "$secret" ]]; then line="${line//"$secret"/[REDACTED]}"; fi
    printf '%s\n' "$line" >&2
  done
}
diagnostics() {
  printf 'Extension container verification failed.\n' >&2
  if podman container exists "$container" 2>/dev/null; then
    podman inspect --format 'state={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}' "$container" 2>&1 | redact_log || true
    podman logs --tail 100 "$container" 2>&1 | redact_log || true
  fi
  if [[ -f "$run_root/runner.log" ]]; then
    printf 'Extension runner log:\n' >&2
    redact_log < "$run_root/runner.log" || true
  fi
}
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 )); then diagnostics; fi
  podman rm -f -v "$container" >/dev/null 2>&1 || true
  if [[ -n "$runner_pid" ]]; then kill -TERM "$runner_pid" 2>/dev/null || true; wait "$runner_pid" 2>/dev/null || true; fi
  podman unshare chown -R 0:0 "$run_root" 2>/dev/null || true
  rm -rf "$run_root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -m 700 "$run_root/socket"
export EZ_EXTENSION_RUNNER_SOCKET="$run_root/socket/runner.sock"
export EZ_EXTENSION_RUNNER_TOKEN_FILE="$run_root/token"
export EZ_EXTENSION_RUNNER_STORE="$run_root/store"
export EZ_EXTENSION_APP_UID="$(podman unshare awk -v id=1000 '$1 <= id && id < $1 + $3 { print $2 + id - $1 }' /proc/self/uid_map)"
bash scripts/start-extension-runner-e2e.sh >"$run_root/runner.log" 2>&1 &
runner_pid=$!
runner_ready=false
for _attempt in $(seq 1 1200); do
  if ! kill -0 "$runner_pid" 2>/dev/null; then break; fi
  if [[ -S "$EZ_EXTENSION_RUNNER_SOCKET" && -s "$EZ_EXTENSION_RUNNER_TOKEN_FILE" ]]; then
    runner_ready=true
    break
  fi
  sleep 0.1
done
if ! $runner_ready; then
  exit 1
fi
IFS= read -r runner_secret < "$run_root/token" || true
# Model a separate runner owner and a group mapped through rootless Podman's
# user namespace. Container gid 1 maps to the second host gid-map range.
shared_container_gid=1
chmod 2750 "$run_root/socket"
chmod 0660 "$run_root/socket/runner.sock"
chmod 0640 "$run_root/token"
podman unshare chown -R "65534:$shared_container_gid" "$run_root/socket" "$run_root/token"
# Use the same connection and startup check as both default stacks. Hand-wiring
# podman run here used to pass while normal Compose omitted the runner entirely.
export EZ_VERIFY_RUNNER_REPO="$repo_root"
export EZ_VERIFY_RUNNER_IMAGE="${1:?Pass the locally built application image}"
export EZ_VERIFY_RUNNER_CONTAINER="$container"
export EZ_RUNNER_SOCKET_DIR="$run_root/socket"
export EZ_RUNNER_TOKEN_FILE="$run_root/token"
export EZ_RUNNER_GROUP="$shared_container_gid"
# Negative control: the exact split-owner fixture must deny the app unless the
# mapped shared group is added.
if podman run --rm --network none \
  -v "$EZ_RUNNER_SOCKET_DIR:/run/ez-extension-runner:ro" \
  -v "$EZ_RUNNER_TOKEN_FILE:/run/secrets/extension-runner-token:ro" \
  -e EZCORP_EXTENSION_RUNNER_SOCKET=/run/ez-extension-runner/runner.sock \
  -e EZCORP_EXTENSION_RUNNER_TOKEN_FILE=/run/secrets/extension-runner-token \
  --entrypoint /bin/sh "$EZ_VERIFY_RUNNER_IMAGE" \
  /app/deploy/extension-runner/app-entrypoint.sh /bin/sh -c 'exit 0' \
  >"$run_root/without-shared-group.log" 2>&1; then
  printf 'Runner connection succeeded without the required shared group.\n' >&2
  exit 1
fi
printf 'Split-owner negative control denied access without group_add.\n'
cat > "$run_root/compose.yml" <<'YAML'
services:
  app:
    extends:
      file: ${EZ_VERIFY_RUNNER_REPO}/deploy/extension-runner/compose.runner.yml
      service: app
    image: ${EZ_VERIFY_RUNNER_IMAGE}
    container_name: ${EZ_VERIFY_RUNNER_CONTAINER}
    network_mode: none
    logging:
      driver: k8s-file
YAML
DOCKER_HOST="unix://${PODMAN_SOCKET:-/run/user/$(id -u)/podman/podman.sock}" \
  docker compose --env-file /dev/null -p "${container,,}" -f "$run_root/compose.yml" up -d >/dev/null
podman exec "$container" bun -e '
const module = await import("@ezcorp/harness-client");
if (typeof module.HarnessClient !== "function") throw new Error("Production image cannot import HarnessClient");
'
bun build scripts/verify-extension-container.ts --target=bun --outfile "$run_root/verify.js"
podman cp "$run_root/verify.js" "$container:/tmp/verify-extension-container.js"
if ! podman exec "$container" bun /tmp/verify-extension-container.js; then
  exit 1
fi
