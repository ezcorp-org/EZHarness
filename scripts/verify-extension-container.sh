#!/usr/bin/env bash
set -euo pipefail
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
umask 077
run_root="$(mktemp -d "${TMPDIR:-/tmp}/ez-container-runner-XXXXXXXX")"
container="ez-extension-check-$(basename "$run_root")"
runner_pid=""
cleanup() {
  trap - EXIT INT TERM
  podman rm -f -v "$container" >/dev/null 2>&1 || true
  if [[ -n "$runner_pid" ]]; then kill -TERM "$runner_pid" 2>/dev/null || true; wait "$runner_pid" 2>/dev/null || true; fi
  rm -rf "$run_root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -m 700 "$run_root/socket"
export EZ_EXTENSION_RUNNER_SOCKET="$run_root/socket/runner.sock"
export EZ_EXTENSION_RUNNER_TOKEN_FILE="$run_root/token"
export EZ_EXTENSION_RUNNER_STORE="$run_root/store"
export EZ_EXTENSION_APP_UID="$(id -u)"
bash scripts/start-extension-runner-e2e.sh >"$run_root/runner.log" 2>&1 &
runner_pid=$!
export EZ_TEST_RUNNER_PID="$runner_pid"
if ! bun -e '
const deadline=Date.now()+120000;
while(true) {
  process.kill(Number(process.env.EZ_TEST_RUNNER_PID),0);
  try {
    const token=(await Bun.file(process.env.EZ_EXTENSION_RUNNER_TOKEN_FILE).text()).trim();
    const response=await fetch("http://localhost/v4/inspect",{unix:process.env.EZ_EXTENSION_RUNNER_SOCKET,method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({id:"readiness"}),signal:AbortSignal.timeout(1000)});
    if(!response.ok || (await response.json()).state!=="unknown") throw new Error("Runner readiness rejected");
    break;
  } catch(error) { if(Date.now()>=deadline) throw error; await Bun.sleep(100); }
}
'; then
  cat "$run_root/runner.log" >&2
  exit 1
fi
# Use the same connection and startup check as both default stacks. Hand-wiring
# podman run here used to pass while normal Compose omitted the runner entirely.
export EZ_VERIFY_RUNNER_REPO="$repo_root"
export EZ_VERIFY_RUNNER_IMAGE="${1:?Pass the locally built application image}"
export EZ_VERIFY_RUNNER_CONTAINER="$container"
export EZ_RUNNER_SOCKET_DIR="$run_root/socket"
export EZ_RUNNER_TOKEN_FILE="$run_root/token"
cat > "$run_root/compose.yml" <<'YAML'
services:
  app:
    extends:
      file: ${EZ_VERIFY_RUNNER_REPO}/deploy/extension-runner/compose.runner.yml
      service: app
    image: ${EZ_VERIFY_RUNNER_IMAGE}
    container_name: ${EZ_VERIFY_RUNNER_CONTAINER}
    network_mode: none
    userns_mode: keep-id:uid=1000,gid=1000
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
  podman logs --tail 100 "$container" >&2
  cat "$run_root/runner.log" >&2
  exit 1
fi
