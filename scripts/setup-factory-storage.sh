#!/usr/bin/env bash
set -euo pipefail

# Generates local-test credentials outside the repository. Credential values are
# never printed. The two SeaweedFS instances read separate generated files.
readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly compose_file="$repo_root/compose.factory-storage.local.yml"
readonly runtime_base="${XDG_RUNTIME_DIR:-}"
readonly project_name="ezcorp-factory-storage-${UID}"

fail() { printf '%s\n' "$1" >&2; exit 1; }

require_loopback() {
  case "${EZCORP_FACTORY_STORAGE_BIND_IP:-127.0.0.1}" in
    127.0.0.1) ;;
    *) fail 'Factory local storage accepts only a loopback bind address.' ;;
  esac
}

require_runtime() {
  [[ -n "$runtime_base" && -d "$runtime_base" && ! -L "$runtime_base" ]] || fail 'XDG_RUNTIME_DIR must be a private runtime directory.'
  [[ "$(stat -c '%a:%u' "$runtime_base")" == "700:$UID" ]] || fail 'XDG_RUNTIME_DIR must be owned by this user with mode 0700.'
}

compose() {
  COMPOSE_PROJECT_NAME="$project_name" docker compose -f "$compose_file" --profile factory-storage "$@"
}

require_owned_credentials() {
  require_runtime
  [[ -n "${EZCORP_FACTORY_STORAGE_SECRETS_DIR:-}" ]] || fail 'Set the generated credential directory before stop.'
  local canonical
  canonical="$(realpath -e -- "$EZCORP_FACTORY_STORAGE_SECRETS_DIR")"
  [[ "$canonical" == "${runtime_base%/}"/ezcorp-factory-storage.* && "$(dirname -- "$canonical")" == "${runtime_base%/}" ]] || fail 'Credential directory must be generated directly below XDG_RUNTIME_DIR.'
  [[ ! -L "$EZCORP_FACTORY_STORAGE_SECRETS_DIR" && "$(stat -c '%u' "$canonical")" == "$UID" ]] || fail 'Credential directory ownership is invalid.'
  [[ -f "$canonical/.factory-storage-owner" && ! -L "$canonical/.factory-storage-owner" && "$(cat "$canonical/.factory-storage-owner")" == "$project_name" ]] || fail 'Credential directory has no matching ownership record.'
}

write_config() {
  local name="$1" prefix="$2" target="$3" first=1 tenant
  umask 077
  {
    printf '{"identities":['
    for tenant in $(seq -w 1 10); do
      if [[ "$first" -eq 0 ]]; then printf ','; fi
      first=0
      printf '{"name":"tenant-%s","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Read:tenant-%s/%s/*","List:tenant-%s/%s/*","Tagging:tenant-%s/%s/*","Write:tenant-%s/%s/*"]}' \
        "$tenant" "${name}-${tenant}-$(openssl rand -hex 8)" "$(openssl rand -hex 32)" "$tenant" "$prefix" "$tenant" "$prefix" "$tenant" "$prefix" "$tenant" "$prefix"
    done
    printf ']}'
  } >"$target"
  # SeaweedFS drops to uid 1000. The parent runtime directory remains mode
  # 0700, so this read permission is visible only through the container mount.
  chmod 644 "$target"
}

seed_buckets() {
  local service="$1" tenant
  {
    for tenant in $(seq -w 1 10); do
      printf 's3.bucket.create -name=tenant-%s\n' "$tenant"
      printf 's3.bucket.versioning -name=tenant-%s -enable\n' "$tenant"
    done
  } | compose exec -T "$service" weed shell -master=localhost:9333
}

start() {
  require_loopback
  require_runtime
  if docker ps -aq --filter "label=com.docker.compose.project=$project_name" | read -r _; then
    fail 'Factory storage containers already exist. Use their credential directory or stop them first.'
  fi
  local secrets_dir
  secrets_dir="$(mktemp -d "${runtime_base%/}/ezcorp-factory-storage.XXXXXXXX")"
  chmod 755 "$secrets_dir"
  (umask 077; printf '%s\n' "$project_name" > "$secrets_dir/.factory-storage-owner")
  export EZCORP_FACTORY_STORAGE_SECRETS_DIR="$secrets_dir"
  write_config ordinary ordinary "$secrets_dir/ordinary.json"
  write_config archive archive "$secrets_dir/archive.json"
  compose up -d --wait
  seed_buckets factory-storage-ordinary
  seed_buckets factory-storage-archive
  printf 'Factory local storage is ready. Credentials are in %s below mode-0700 XDG_RUNTIME_DIR.\n' "$secrets_dir"
  printf 'Export EZCORP_FACTORY_STORAGE_SECRETS_DIR=%q before later compose commands.\n' "$secrets_dir"
}

stop() {
  require_loopback
  require_owned_credentials
  compose down --volumes
  rm -rf -- "$EZCORP_FACTORY_STORAGE_SECRETS_DIR"
}

case "${1:-up}" in
  up) start ;;
  down) stop ;;
  *) fail 'Usage: scripts/setup-factory-storage.sh [up|down]' ;;
esac
