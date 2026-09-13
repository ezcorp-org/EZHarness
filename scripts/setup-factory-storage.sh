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
    127.0.0.1|::1) ;;
    *) fail 'Factory local storage accepts only a loopback bind address.' ;;
  esac
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
  } | COMPOSE_PROJECT_NAME="$project_name" docker compose -f "$compose_file" --profile factory-storage exec -T "$service" weed shell -master=localhost:9333
}

start() {
  require_loopback
  [[ -n "$runtime_base" && -d "$runtime_base" ]] || fail 'XDG_RUNTIME_DIR is required for generated local storage credentials.'
  local secrets_dir
  secrets_dir="$(mktemp -d "${runtime_base%/}/ezcorp-factory-storage.XXXXXXXX")"
  chmod 755 "$secrets_dir"
  write_config ordinary ordinary "$secrets_dir/ordinary.json"
  write_config archive archive "$secrets_dir/archive.json"
  EZCORP_FACTORY_STORAGE_SECRETS_DIR="$secrets_dir" EZCORP_FACTORY_STORAGE_BIND_IP="${EZCORP_FACTORY_STORAGE_BIND_IP:-127.0.0.1}" COMPOSE_PROJECT_NAME="$project_name" \
    docker compose -f "$compose_file" --profile factory-storage up -d --wait
  seed_buckets factory-storage-ordinary
  seed_buckets factory-storage-archive
  printf 'Factory local storage is ready. Credentials are in %s below mode-0700 XDG_RUNTIME_DIR.\n' "$secrets_dir"
  printf 'Export EZCORP_FACTORY_STORAGE_SECRETS_DIR=%q before later compose commands.\n' "$secrets_dir"
}

stop() {
  require_loopback
  : "${EZCORP_FACTORY_STORAGE_SECRETS_DIR:?Set the generated credential directory before stop.}"
  COMPOSE_PROJECT_NAME="$project_name" docker compose -f "$compose_file" --profile factory-storage down --volumes
  rm -rf -- "$EZCORP_FACTORY_STORAGE_SECRETS_DIR"
}

case "${1:-up}" in
  up) start ;;
  down) stop ;;
  *) fail 'Usage: scripts/setup-factory-storage.sh [up|down]' ;;
esac
