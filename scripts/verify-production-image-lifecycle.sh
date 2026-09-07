#!/usr/bin/env bash
# Start one owned production image with its real extension runner.
#
# Required environment: EZ_PRODUCTION_IMAGE and EZ_PRODUCTION_RECEIPT_DIR.
# The command after -- runs only after health and a fresh owner/API key exist.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
: "${EZ_PRODUCTION_IMAGE:?Set the exact production image tag}"
: "${EZ_PRODUCTION_RECEIPT_DIR:?Set an empty owned receipt directory}"

if [[ "${1:-}" != "--" || "$#" -lt 2 ]]; then
  echo "Usage: EZ_PRODUCTION_IMAGE=… EZ_PRODUCTION_RECEIPT_DIR=… $0 -- command [args…]" >&2
  exit 2
fi
shift

receipt_dir="$EZ_PRODUCTION_RECEIPT_DIR"
if [[ -e "$receipt_dir" && -n "$(find "$receipt_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Receipt directory must be empty: $receipt_dir" >&2
  exit 2
fi
mkdir -p "$receipt_dir"
umask 077

port="${EZ_PRODUCTION_PORT:-4282}"
project="${EZ_PRODUCTION_COMPOSE_PROJECT:-ezcorp-production-lifecycle-${RANDOM}${RANDOM}}"
container="${EZ_PRODUCTION_APP_CONTAINER:-${project}-app}"
# Rootless Podman maps host-owned bind mounts through a user namespace. Run the
# owned app as container root by default so it can initialise those mounts;
# callers can still set explicit IDs for a different engine contract.
app_uid="${EZ_PRODUCTION_APP_UID:-0}"
app_gid="${EZ_PRODUCTION_APP_GID:-0}"
runner_uid="${EZ_PRODUCTION_RUNNER_APP_UID:-$(id -u)}"
run_root="$(mktemp -d /tmp/ez-production-lifecycle-XXXXXXXX)"
state_root="${EZ_PRODUCTION_STATE_DIR:-$run_root}"
external_state=0
[[ -n "${EZ_PRODUCTION_STATE_DIR:-}" ]] && external_state=1
compose="$run_root/compose.yml"
runner_pid=""
command_exit=1
compose_started=0

cleanup() {
  set +e
  logs_exit=0
  cleanup_exit=0
  if [[ "$compose_started" -eq 1 ]]; then
    docker compose -p "$project" -f "$compose" logs --no-color > "$receipt_dir/compose.log" 2>&1
    logs_exit=$?
    docker compose -p "$project" -f "$compose" down --volumes --remove-orphans >> "$receipt_dir/compose.log" 2>&1
    cleanup_exit=$?
  fi
  if [[ -n "$runner_pid" ]]; then
    kill -TERM "$runner_pid" 2>/dev/null
    wait "$runner_pid" 2>/dev/null
  fi
  printf 'command_exit=%s\ncompose_started=%s\napp_log_exit=%s\nowned_cleanup_exit=%s\n' "$command_exit" "$compose_started" "$logs_exit" "$cleanup_exit" >> "$receipt_dir/command.log"
  rm -rf "$run_root"
  if [[ "$command_exit" -eq 0 && ( "$logs_exit" -ne 0 || "$cleanup_exit" -ne 0 ) ]]; then
    trap - EXIT
    exit 1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$state_root"
chmod 700 "$state_root"
# A persistent external state root can be too long for the runner's private
# Unix socket (`socket/.private-<uuid>/runner.sock`). Keep transport material
# below the launcher's short, owned root; only data that must survive a replay
# stays below state_root.
runner_root="$run_root/s"
runner_token="$run_root/token"
mkdir -p "$runner_root" "$state_root/app-data" "$state_root/extension-state"
chmod 700 "$runner_root" "$state_root/app-data" "$state_root/extension-state"
rm -f "$runner_root/runner.sock"
export RUN_ROOT="$state_root" RUNNER_ROOT="$runner_root" RUNNER_TOKEN="$runner_token" APP_UID="$app_uid" APP_GID="$app_gid"
export EZ_EXTENSION_RUNNER_SOCKET="$runner_root/runner.sock"
export EZ_EXTENSION_RUNNER_TOKEN_FILE="$runner_token"
export EZ_EXTENSION_RUNNER_STORE="$state_root/store"
export EZ_EXTENSION_APP_UID="$runner_uid"

if docker container inspect "$container" >/dev/null 2>&1 || docker network inspect "${project}_default" >/dev/null 2>&1; then
  echo "Refusing to reuse existing container or compose project: $container / $project" >&2
  exit 2
fi

cat > "$compose" <<'EOF'
services:
  app:
    image: ${EZ_PRODUCTION_IMAGE}
    container_name: ${EZ_PRODUCTION_APP_CONTAINER}
    user: "${APP_UID}:${APP_GID}"
    ports:
      - "127.0.0.1:${EZ_PRODUCTION_PORT}:3000"
    environment:
      EZCORP_PORT: "3000"
      ORIGIN: "http://localhost:${EZ_PRODUCTION_PORT}"
      EZCORP_PUBLIC_URL: "http://localhost:${EZ_PRODUCTION_PORT}"
      EZCORP_ENCRYPTION_SECRET: "production-lifecycle-secret"
      EZCORP_ENCRYPTION_SALT: "production-lifecycle-salt"
      EZCORP_JWT_SECRET: "production-lifecycle-jwt"
      EZCORP_PROJECT_ROOT: "/app"
      # Test-only internal callback origins. Runtime cases may set this before
      # invoking the launcher; production defaults to the empty allowlist.
      EZCORP_EXTENSION_INTERNAL_ORIGINS: "${EZCORP_EXTENSION_INTERNAL_ORIGINS:-[]}"
      EZCORP_EXTENSION_RUNNER_SOCKET: "/run/ez-extension-runner/runner.sock"
      EZCORP_EXTENSION_RUNNER_TOKEN_FILE: "/run/secrets/extension-runner-token"
    volumes:
      - ${RUN_ROOT}/app-data:/app/data
      - ${RUN_ROOT}/extension-state:/app/.ezcorp
      - ${RUNNER_ROOT}:/run/ez-extension-runner:ro
      - ${RUNNER_TOKEN}:/run/secrets/extension-runner-token:ro
EOF

export EZ_PRODUCTION_PORT="$port" EZ_PRODUCTION_APP_CONTAINER="$container"
{
  printf 'launcher_source=%s\n' "$(git rev-parse HEAD)"
  printf 'image=%s\nproject=%s\ncontainer=%s\nport=%s\n' "$EZ_PRODUCTION_IMAGE" "$project" "$container" "$port"
  docker image inspect "$EZ_PRODUCTION_IMAGE" --format 'image_id={{.Id}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
} > "$receipt_dir/provenance.txt"

bash scripts/start-extension-runner-e2e.sh > "$receipt_dir/runner.log" 2>&1 & runner_pid=$!
for _ in $(seq 1 120); do
  if [[ -S "$EZ_EXTENSION_RUNNER_SOCKET" && -s "$EZ_EXTENSION_RUNNER_TOKEN_FILE" ]]; then break; fi
  kill -0 "$runner_pid" 2>/dev/null || { cat "$receipt_dir/runner.log" >&2; exit 1; }
  sleep 1
done
[[ -S "$EZ_EXTENSION_RUNNER_SOCKET" && -s "$EZ_EXTENSION_RUNNER_TOKEN_FILE" ]]
bun -e '
const token=(await Bun.file(process.env.EZ_EXTENSION_RUNNER_TOKEN_FILE).text()).trim();
const response=await fetch("http://localhost/v4/inspect", { unix: process.env.EZ_EXTENSION_RUNNER_SOCKET, method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "launcher-readiness" }), signal: AbortSignal.timeout(1000) });
if (!response.ok || (await response.json()).state !== "unknown") throw new Error("Runner readiness rejected");
'

compose_started=1
docker compose -p "$project" -f "$compose" up -d
origin="http://127.0.0.1:$port"
for _ in $(seq 1 120); do
  curl -fsS "$origin/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$origin/api/health" >/dev/null

cookie_file="$run_root/session.cookie"
key_file="$run_root/api.key"
setup_code="$(curl -sS -c "$cookie_file" -o "$run_root/setup.json" -w '%{http_code}' -H 'content-type: application/json' --data '{"email":"test@test.com","password":"Test123!","name":"Production lifecycle"}' "$origin/api/auth/setup")"
if [[ "$setup_code" != 201 ]]; then
  login_code="$(curl -sS -c "$cookie_file" -o "$run_root/login.json" -w '%{http_code}' -H 'content-type: application/json' --data '{"email":"test@test.com","password":"Test123!"}' "$origin/api/auth/login")"
  [[ "$login_code" == 200 ]] || { cat "$run_root/login.json" >&2; exit 1; }
else
  login_code="not-needed"
fi
key_code="$(curl -sS -b "$cookie_file" -o "$run_root/key.json" -w '%{http_code}' -H 'content-type: application/json' --data '{"name":"Production lifecycle","scopes":["read","write","chat","extensions"]}' "$origin/api/settings/developer/api-keys")"
[[ "$key_code" == 201 ]]
jq -er '.key | strings | select(length > 0)' "$run_root/key.json" > "$key_file"
chmod 600 "$cookie_file" "$key_file"
printf 'setup_http=%s\nlogin_http=%s\nkey_http=%s\n' "$setup_code" "$login_code" "$key_code" > "$receipt_dir/command.log"

export EZ_PRODUCTION_ORIGIN="$origin" EZ_PRODUCTION_CONTAINER="$container" EZ_PRODUCTION_RUN_ROOT="$state_root"
export EZ_PRODUCTION_COOKIE_FILE="$cookie_file" EZ_PRODUCTION_API_KEY_FILE="$key_file" EZ_PRODUCTION_RUNNER_PID="$runner_pid"
set +e
"$@" 2>&1 | tee "$receipt_dir/verification.log"
verification_status=("${PIPESTATUS[@]}")
command_exit="${verification_status[0]}"
if [[ "$command_exit" -eq 0 && "${verification_status[1]}" -ne 0 ]]; then command_exit="${verification_status[1]}"; fi
set -e
exit "$command_exit"
