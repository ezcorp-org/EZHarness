#!/usr/bin/env bash
set -euo pipefail
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
umask 077
# The runner service creates a private socket below this directory. Unix socket
# paths are limited to 108 bytes on Linux; long inherited TMPDIR values (for
# example a Nix shell build directory) made the gateway accept connections but
# reset them because its private upstream path was too long.
run_root="$(mktemp -d "/tmp/ez-real-runner-XXXXXXXX")"
runner_pid=""
preview_pid=""
restart_file=""
restart_ack_file=""
restart_pid_file=""
stop_preview() {
  if [[ -n "$preview_pid" ]]; then
    # The preview has the same 30s graceful-shutdown budget as the real E2E
    # webServer. Never leave an owned restart child behind if its shutdown
    # handler wedges; escalation is limited to this direct Bun child.
    kill -TERM "$preview_pid" 2>/dev/null || true
    stop_deadline=$(( $(date +%s) + 30 ))
    while kill -0 "$preview_pid" 2>/dev/null; do
      if (( $(date +%s) >= stop_deadline )); then
        kill -KILL "$preview_pid" 2>/dev/null || true
        break
      fi
      sleep 0.1
    done
    wait "$preview_pid" 2>/dev/null || true
    preview_pid=""
  fi
}
cleanup() {
  trap - EXIT INT TERM
  stop_preview
  if [[ -n "$runner_pid" ]]; then kill -TERM "$runner_pid" 2>/dev/null || true; wait "$runner_pid" 2>/dev/null || true; fi
  if [[ -n "$restart_file" ]]; then rm -f -- "$restart_file" "$restart_ack_file" "$restart_pid_file"; fi
  rm -rf "$run_root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export EZ_EXTENSION_RUNNER_SOCKET="$run_root/runner.sock"
export EZ_EXTENSION_RUNNER_TOKEN_FILE="$run_root/token"
export EZ_EXTENSION_RUNNER_STORE="$run_root/store"
export EZCORP_EXTENSION_RUNNER_SOCKET="$EZ_EXTENSION_RUNNER_SOCKET"
bun -e 'import {randomBytes} from "node:crypto"; await Bun.write(process.env.EZ_EXTENSION_RUNNER_TOKEN_FILE, randomBytes(32).toString("hex"));'
export EZCORP_EXTENSION_RUNNER_TOKEN="$(cat "$EZ_EXTENSION_RUNNER_TOKEN_FILE")"
bash scripts/start-extension-runner-e2e.sh &
runner_pid=$!
export EZ_TEST_RUNNER_PID="$runner_pid"
bun -e '
const deadline=Date.now()+120000;
while(true) {
  process.kill(Number(process.env.EZ_TEST_RUNNER_PID),0);
  try {
    const response=await fetch("http://localhost/v4/inspect",{unix:process.env.EZCORP_EXTENSION_RUNNER_SOCKET,method:"POST",headers:{authorization:`Bearer ${process.env.EZCORP_EXTENSION_RUNNER_TOKEN}`,"content-type":"application/json"},body:JSON.stringify({id:"readiness-probe"}),signal:AbortSignal.timeout(1000)});
    if(!response.ok || (await response.json()).state!=="unknown") throw new Error("Invalid runner readiness response");
    break;
  } catch(error) { if(Date.now()>=deadline) throw error; await Bun.sleep(100); }
}
console.log("Authenticated rootless runner ready");
'
if [[ "${1:-}" == "--probe-only" ]]; then exit 0; fi
cd web
# Browser route coverage builds source-mapped assets once before it starts its
# mock, fresh-setup, and real-auth tiers. Rebuilding here would produce a new
# asset graph between those receipts and defeat their immutable-build merge.
# Normal real-auth runs retain their self-contained production build.
if [[ "${EZCORP_BROWSER_COVERAGE:-}" == "1" ]]; then
  [[ -f build/client/manifest.json ]] || {
    echo "browser coverage requires a prepared web/build/client/manifest.json" >&2
    exit 1
  }
else
  bun run build
fi
export PORT="${EZCORP_PORT:-4173}"
export HOST=127.0.0.1
export ORIGIN="${ORIGIN:-http://localhost:$PORT}"
export BODY_SIZE_LIMIT="${BODY_SIZE_LIMIT:-134217728}"
unset SOCKET_PATH
restart_file="${EZCORP_TEST_PREVIEW_RESTART_FILE:-}"
if [[ -n "$restart_file" ]]; then
  # This control exists solely for the real E2E runner. It never activates in
  # a normal preview or production process, where an arbitrary file could not
  # control the app lifetime.
  if [[ "${PI_E2E_REAL:-}" != "1" || "${NODE_ENV:-}" != "test" ]]; then
    echo "test preview restart control requires PI_E2E_REAL=1 and NODE_ENV=test" >&2
    exit 1
  fi
  restart_ack_file="${restart_file}.ack"
  restart_pid_file="${restart_file}.pid"
  rm -f -- "$restart_file" "$restart_ack_file" "$restart_pid_file"
fi

start_preview() {
  bun build/index.js &
  preview_pid=$!
  if [[ -n "$restart_pid_file" ]]; then printf '%s\n' "$preview_pid" > "$restart_pid_file"; fi
}


wait_preview_ready() {
  EZCORP_PREVIEW_ORIGIN="$ORIGIN" bun -e '
const deadline = Date.now() + 120000;
while (true) {
  try {
    const response = await fetch(process.env.EZCORP_PREVIEW_ORIGIN, { signal: AbortSignal.timeout(1000) });
    if (response.ok || response.status === 302 || response.status === 303) break;
  } catch {}
  if (Date.now() >= deadline) throw new Error("preview did not become ready after restart");
  await Bun.sleep(100);
}
'
}

start_preview
if [[ -z "$restart_file" ]]; then
  wait "$preview_pid"
  exit $?
fi
wait_preview_ready
while kill -0 "$preview_pid" 2>/dev/null; do
  if [[ -f "$restart_file" ]]; then
    restart_token="$(cat -- "$restart_file")"
    rm -f -- "$restart_file"
    stop_preview
    start_preview
    wait_preview_ready
    printf '%s\n' "$restart_token" > "$restart_ack_file"
  fi
  sleep 0.1
done
wait "$preview_pid"
