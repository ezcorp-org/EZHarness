#!/usr/bin/env bash
# Replays the real File Organizer lifecycle case against an owned image.
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
image=${EZ_RUNTIME_IMAGE:?Set EZ_RUNTIME_IMAGE to the exact Docker image tag}
receipt_dir=${EZ_RUNTIME_RECEIPT_DIR:?Set EZ_RUNTIME_RECEIPT_DIR to an empty owned directory}
port=${EZ_RUNTIME_PORT:-4282}
project=${EZ_RUNTIME_COMPOSE_PROJECT:-extension-v4-runtime-replay}
container=${EZ_RUNTIME_APP_CONTAINER:-extension-v4-runtime-replay-app}
container_uid=${EZ_RUNTIME_APP_UID:-$(id -u)}
container_gid=${EZ_RUNTIME_APP_GID:-$(id -g)}
runner_app_uid=${EZ_RUNTIME_RUNNER_APP_UID:-$(id -u)}
bun_path=${EZ_RUNTIME_BUN_PATH:-/tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun}
node_path=${EZ_RUNTIME_NODE_PATH:-/nix/store/vs03s8q30qg698zzpbszk08j4shb0gsl-nodejs-slim-22.22.2/bin/node}

if [[ -x "$bun_path" ]]; then export PATH="$(dirname "$bun_path"):$PATH"; fi
if [[ -x "$node_path" ]]; then export PATH="$(dirname "$node_path"):$PATH"; fi

if [[ -e "$receipt_dir" && -n "$(find "$receipt_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Receipt directory must be empty: $receipt_dir" >&2
  exit 2
fi
mkdir -p "$receipt_dir"
umask 077
run_root=$(mktemp -d /tmp/ez-file-organizer-runtime-XXXXXXXX)
compose="$run_root/compose.yml"
session_cookie="$run_root/session.cookie"
mkdir -m 700 "$run_root/socket" "$run_root/app-data" "$run_root/extension-state"
export RUN_ROOT="$run_root" APP_UID="$container_uid" APP_GID="$container_gid"
export EZ_EXTENSION_RUNNER_SOCKET="$run_root/socket/runner.sock"
export EZ_EXTENSION_RUNNER_TOKEN_FILE="$run_root/token"
export EZ_EXTENSION_RUNNER_STORE="$run_root/store"
export EZ_EXTENSION_APP_UID="$runner_app_uid"
runner_pid=""
run_code=1

cleanup() {
  set +e
  docker compose -p "$project" -f "$compose" logs --no-color > "$receipt_dir/compose.log" 2>&1
  logs_code=$?
  docker compose -p "$project" -f "$compose" down --volumes --remove-orphans >> "$receipt_dir/compose.log" 2>&1
  cleanup_code=$?
  if [[ -n "$runner_pid" ]]; then
    kill -TERM "$runner_pid" 2>/dev/null
    wait "$runner_pid" 2>/dev/null
  fi
  rm -rf "$run_root"
  printf 'app_log_exit=%s\nowned_cleanup_exit=%s\n' "$logs_code" "$cleanup_code" >> "$receipt_dir/command.log"
  if [[ "$run_code" -eq 0 && "$cleanup_code" -ne 0 ]]; then
    trap - EXIT
    exit "$cleanup_code"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cat > "$compose" <<EOF
services:
  app:
    image: ${image}
    container_name: ${container}
    user: "\${APP_UID}:\${APP_GID}"
    ports:
      - "127.0.0.1:${port}:3000"
    environment:
      EZCORP_PORT: "3000"
      ORIGIN: "http://localhost:${port}"
      EZCORP_PUBLIC_URL: "http://localhost:${port}"
      EZCORP_ENCRYPTION_SECRET: "runtime-audit-secret"
      EZCORP_ENCRYPTION_SALT: "runtime-audit-salt"
      EZCORP_JWT_SECRET: "runtime-audit-jwt-secret"
      EZCORP_PROJECT_ROOT: "/app"
      EZCORP_EXTENSION_RUNNER_SOCKET: "/run/ez-extension-runner/runner.sock"
      EZCORP_EXTENSION_RUNNER_TOKEN_FILE: "/run/secrets/extension-runner-token"
    volumes:
      - \${RUN_ROOT}/app-data:/app/data
      - \${RUN_ROOT}/extension-state:/app/.ezcorp
      - \${RUN_ROOT}/socket:/run/ez-extension-runner:ro
      - \${RUN_ROOT}/token:/run/secrets/extension-runner-token:ro
EOF

{
  printf 'source_commit=%s\n' "$(git -C "$repo_root" rev-parse HEAD)"
  printf 'image=%s\n' "$image"
  printf 'host_uid=%s\ncontainer_uid=%s\ncontainer_gid=%s\nrunner_peer_uid=%s\n' "$(id -u)" "$container_uid" "$container_gid" "$runner_app_uid"
  printf 'bun_version=%s\n' "$(bun --version)"
  printf 'node_version=%s\n' "$(node --version)"
  docker image inspect "$image" --format 'image_id={{.Id}}'
  sha256sum "$repo_root/web/e2e/file-organizer-real.spec.ts"
} > "$receipt_dir/provenance.txt"

cd "$repo_root"
bash scripts/start-extension-runner-e2e.sh > "$receipt_dir/runner.log" 2>&1 & runner_pid=$!
for _ in $(seq 1 120); do
  if [[ -S "$EZ_EXTENSION_RUNNER_SOCKET" && -s "$EZ_EXTENSION_RUNNER_TOKEN_FILE" ]]; then break; fi
  if ! kill -0 "$runner_pid" 2>/dev/null; then cat "$receipt_dir/runner.log"; exit 1; fi
  sleep 1
done
[[ -S "$EZ_EXTENSION_RUNNER_SOCKET" && -s "$EZ_EXTENSION_RUNNER_TOKEN_FILE" ]]

docker compose -p "$project" -f "$compose" up -d
for _ in $(seq 1 90); do
  if curl -fsS "http://localhost:${port}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://localhost:${port}/api/health" >/dev/null
setup_code=$(curl -sS -c "$session_cookie" -o "$receipt_dir/setup.json" -w '%{http_code}' -H 'content-type: application/json' --data '{"email":"test@test.com","password":"Test123!","name":"Runtime Audit"}' "http://localhost:${port}/api/auth/setup")
printf 'setup_http=%s\n' "$setup_code" > "$receipt_dir/command.log"
[[ "$setup_code" == 201 ]]
[[ -s "$session_cookie" ]]
chmod 600 "$session_cookie"

# The production image and the real preview both execute the generated
# svelte-adapter-bun server. When IDLE_TIMEOUT is unset, that server uses
# Bun's 10-second idle close. Require three authenticated 15-second heartbeat
# frames: this crosses that close boundary, then cancels the reader deliberately.
# The cookie remains under run_root and is removed by cleanup; receipts only
# record the route, frame counts, frame arrival times, elapsed time, and result.
cat > "$run_root/check-idle-runtime-events.ts" <<'EOF'
const origin = process.env.EZ_RUNTIME_ORIGIN;
const cookiePath = process.env.EZ_RUNTIME_COOKIE_PATH;
if (!origin || !cookiePath) throw new Error("Missing runtime SSE probe configuration");

const cookie = (await Bun.file(cookiePath).text())
  .split("\n")
  .filter(line => line.length > 0 && (!line.startsWith("#") || line.startsWith("#HttpOnly_")))
  .map(line => line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line)
  .map(line => line.split("\t"))
  .filter(fields => fields.length >= 7)
  .map(fields => `${fields[5]}=${fields[6]}`)
  .join("; ");
if (!cookie) throw new Error("Setup response did not write a session cookie");

const startedAt = performance.now();
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 60_000);
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
let connectedFrames = 0;
let heartbeatFrames = 0;
let connectedAtMs: number | undefined;
const heartbeatAtMs: number[] = [];
let passed = false;
try {
  const response = await fetch(`${origin}/api/runtime-events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  if (!response.ok || !response.body || response.headers.get("content-type") !== "text/event-stream") {
    throw new Error(`Runtime SSE response was ${response.status}`);
  }
  reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (connectedFrames < 1 || heartbeatFrames < 3) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`Runtime SSE closed after connected=${connectedFrames} heartbeat=${heartbeatFrames}`);
    buffered += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffered.indexOf("\n\n")) >= 0) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      if (frame === ": connected") {
        connectedFrames += 1;
        connectedAtMs ??= Math.round(performance.now() - startedAt);
      }
      if (frame === ": heartbeat") {
        heartbeatFrames += 1;
        heartbeatAtMs.push(Math.round(performance.now() - startedAt));
      }
    }
  }
  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs <= 10_000) {
    throw new Error(`Runtime SSE did not remain open beyond Bun's default idle boundary: ${Math.round(elapsedMs)}ms`);
  }
  await reader.cancel("idle SSE probe complete");
  reader = undefined;
  passed = true;
} catch (_error) {
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  console.log("sse_path=/api/runtime-events");
  console.log(`sse_connected_frames=${connectedFrames}`);
  console.log(`sse_heartbeat_frames=${heartbeatFrames}`);
  console.log(`sse_connected_at_ms=${connectedAtMs ?? "none"}`);
  console.log(`sse_heartbeat_at_ms=${heartbeatAtMs.join(",") || "none"}`);
  console.log(`sse_elapsed_ms=${Math.round(performance.now() - startedAt)}`);
  console.log(`sse_idle_check=${passed ? "passed" : "failed"}`);
  if (reader) await reader.cancel();
}
EOF
EZ_RUNTIME_ORIGIN="http://localhost:${port}" EZ_RUNTIME_COOKIE_PATH="$session_cookie" bun "$run_root/check-idle-runtime-events.ts" > "$receipt_dir/runtime-events.log" 2>&1
printf 'runtime_events_idle_exit=0\n' >> "$receipt_dir/command.log"

cd "$repo_root/web"
set +e
DOCKER_TEST=1 DOCKER_TEST_URL="http://localhost:${port}" EZCORP_APP_CONTAINER="$container" ./node_modules/.bin/playwright test e2e/file-organizer-real.spec.ts --project=chromium > "$receipt_dir/playwright.log" 2>&1
run_code=$?
set -e
printf 'playwright_exit=%s\n' "$run_code" >> "$receipt_dir/command.log"
tail -180 "$receipt_dir/playwright.log"
exit "$run_code"
