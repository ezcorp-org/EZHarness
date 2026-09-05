#!/usr/bin/env bash
set -euo pipefail
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
umask 077
run_root="$(mktemp -d "${TMPDIR:-/tmp}/ez-real-runner-XXXXXXXX")"
runner_pid=""
preview_pid=""
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$preview_pid" ]]; then kill -TERM "$preview_pid" 2>/dev/null || true; wait "$preview_pid" 2>/dev/null || true; fi
  if [[ -n "$runner_pid" ]]; then kill -TERM "$runner_pid" 2>/dev/null || true; wait "$runner_pid" 2>/dev/null || true; fi
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
bun run build
bun ./node_modules/vite/bin/vite.js preview --port "${EZCORP_PORT:-4173}" --strictPort &
preview_pid=$!
wait "$preview_pid"
