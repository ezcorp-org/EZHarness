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
setup_code=$(curl -sS -o "$receipt_dir/setup.json" -w '%{http_code}' -H 'content-type: application/json' --data '{"email":"test@test.com","password":"Test123!","name":"Runtime Audit"}' "http://localhost:${port}/api/auth/setup")
printf 'setup_http=%s\n' "$setup_code" > "$receipt_dir/command.log"
[[ "$setup_code" == 201 ]]

cd "$repo_root/web"
set +e
DOCKER_TEST=1 DOCKER_TEST_URL="http://localhost:${port}" EZCORP_APP_CONTAINER="$container" ./node_modules/.bin/playwright test e2e/file-organizer-real.spec.ts --project=chromium > "$receipt_dir/playwright.log" 2>&1
run_code=$?
set -e
printf 'playwright_exit=%s\n' "$run_code" >> "$receipt_dir/command.log"
tail -180 "$receipt_dir/playwright.log"
exit "$run_code"
