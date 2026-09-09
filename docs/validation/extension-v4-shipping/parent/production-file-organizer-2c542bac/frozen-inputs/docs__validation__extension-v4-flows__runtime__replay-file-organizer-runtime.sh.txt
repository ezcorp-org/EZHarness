#!/usr/bin/env bash
# Replays the real File Organizer lifecycle case against an owned image.
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
image=${EZ_RUNTIME_IMAGE:?Set EZ_RUNTIME_IMAGE to the exact Docker image tag}
receipt_dir=${EZ_RUNTIME_RECEIPT_DIR:?Set EZ_RUNTIME_RECEIPT_DIR to an empty owned directory}
receipt_dir="$(realpath -m "$receipt_dir")"
port=${EZ_RUNTIME_PORT:-4282}
bun_path=${EZ_RUNTIME_BUN_PATH:-/tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun}
node_path=${EZ_RUNTIME_NODE_PATH:-/nix/store/vs03s8q30qg698zzpbszk08j4shb0gsl-nodejs-slim-22.22.2/bin/node}

if [[ -x "$bun_path" ]]; then export PATH="$(dirname "$bun_path"):$PATH"; fi
if [[ -x "$node_path" ]]; then export PATH="$(dirname "$node_path"):$PATH"; fi

if [[ "${EZ_RUNTIME_LAUNCHED:-}" != "1" ]]; then
  exec env EZ_PRODUCTION_IMAGE="$image" EZ_PRODUCTION_RECEIPT_DIR="$receipt_dir" EZ_PRODUCTION_PORT="$port" \
    EZ_PRODUCTION_COMPOSE_PROJECT="${EZ_RUNTIME_COMPOSE_PROJECT:-extension-v4-runtime-replay}" \
    EZ_PRODUCTION_APP_CONTAINER="${EZ_RUNTIME_APP_CONTAINER:-extension-v4-runtime-replay-app}" \
    EZ_PRODUCTION_APP_UID="${EZ_RUNTIME_APP_UID:-0}" EZ_PRODUCTION_APP_GID="${EZ_RUNTIME_APP_GID:-0}" \
    EZ_PRODUCTION_RUNNER_APP_UID="${EZ_RUNTIME_RUNNER_APP_UID:-$(id -u)}" \
    bash scripts/verify-production-image-lifecycle.sh -- \
      env EZ_RUNTIME_LAUNCHED=1 EZ_RUNTIME_IMAGE="$image" EZ_RUNTIME_RECEIPT_DIR="$receipt_dir" EZ_RUNTIME_PORT="$port" bash "$0"
fi

run_root=${EZ_PRODUCTION_RUN_ROOT:?Launcher did not provide its owned run root}
session_cookie=${EZ_PRODUCTION_COOKIE_FILE:?Launcher did not provide a session cookie}
container=${EZ_PRODUCTION_CONTAINER:?Launcher did not provide the app container}

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
  if (reader) {
    try {
      await reader.cancel();
    } catch (error) {
      const name = error instanceof Error ? error.name : "Unknown";
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : "none";
      console.log(`sse_cleanup_error_name=${name}`);
      console.log(`sse_cleanup_error_code=${code}`);
      passed = false;
      process.exitCode = 1;
    }
  }
  console.log("sse_path=/api/runtime-events");
  console.log(`sse_connected_frames=${connectedFrames}`);
  console.log(`sse_heartbeat_frames=${heartbeatFrames}`);
  console.log(`sse_connected_at_ms=${connectedAtMs ?? "none"}`);
  console.log(`sse_heartbeat_at_ms=${heartbeatAtMs.join(",") || "none"}`);
  console.log(`sse_elapsed_ms=${Math.round(performance.now() - startedAt)}`);
  console.log(`sse_idle_check=${passed ? "passed" : "failed"}`);
}
EOF
set +e
EZ_RUNTIME_ORIGIN="$EZ_PRODUCTION_ORIGIN" EZ_RUNTIME_COOKIE_PATH="$session_cookie" bun "$run_root/check-idle-runtime-events.ts" > "$receipt_dir/runtime-events.log" 2>&1
runtime_events_code=$?
set -e
printf 'runtime_events_idle_exit=%s\n' "$runtime_events_code" >> "$receipt_dir/command.log"
if [[ "$runtime_events_code" -ne 0 ]]; then exit "$runtime_events_code"; fi

cd "$repo_root/web"
set +e
DOCKER_TEST=1 DOCKER_TEST_URL="$EZ_PRODUCTION_ORIGIN" EZCORP_APP_CONTAINER="$container" ./node_modules/.bin/playwright test e2e/file-organizer-real.spec.ts --project=chromium > "$receipt_dir/playwright.log" 2>&1
run_code=$?
set -e
printf 'playwright_exit=%s\n' "$run_code" >> "$receipt_dir/command.log"
tail -180 "$receipt_dir/playwright.log"
exit "$run_code"
