#!/usr/bin/env bash
set -euo pipefail

# Generates local-test credentials outside the repository. Credential values are
# never printed. The two SeaweedFS instances read separate generated files.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repo_root
readonly compose_file="$repo_root/compose.factory-storage.local.yml"
readonly runtime_base="${XDG_RUNTIME_DIR:-}"
# One project per store pair. The default is the host's shared pair; a proof that needs its own pair names its own
# project and tenant ids (W4H-35's kind proof: EZCORP_FACTORY_STORAGE_PROJECT=w4h35-stores EZCORP_FACTORY_STORAGE_TENANTS="01 35").
readonly default_project="ezcorp-factory-storage-${UID}"
readonly project_name="${EZCORP_FACTORY_STORAGE_PROJECT:-$default_project}"
# The shared pair keeps its credential-directory prefix, which other tools look up; another pair uses its project name.
if [[ "$project_name" == "$default_project" ]]; then readonly secrets_prefix="ezcorp-factory-storage"; else readonly secrets_prefix="$project_name"; fi
if [[ -v EZCORP_FACTORY_STORAGE_TENANTS ]]; then read -r -a tenant_ids <<< "$EZCORP_FACTORY_STORAGE_TENANTS"; else mapfile -t tenant_ids < <(seq -w 1 10); fi
readonly tenant_ids

# One engine rule for the whole repository (scripts/lib/container-engine.sh):
# Podman by default on a developer host, Docker under CI, and
# EZCORP_CONTAINER_ENGINE to choose. Compose is only a client; under Podman
# `resolve_compose` points it at the rootless socket through DOCKER_HOST.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/container-engine.sh
. "$repo_root/scripts/lib/container-engine.sh"
resolve_compose || exit 2

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ "$project_name" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail 'EZCORP_FACTORY_STORAGE_PROJECT must be a lowercase compose project name.'
[[ "${#tenant_ids[@]}" -gt 0 ]] || fail 'EZCORP_FACTORY_STORAGE_TENANTS must name at least one two-digit tenant id.'
for tenant in "${tenant_ids[@]}"; do [[ "$tenant" =~ ^[0-9]{2}$ ]] || fail 'EZCORP_FACTORY_STORAGE_TENANTS takes two-digit tenant ids only (tenant-XX).'; done
[[ "$(printf '%s\n' "${tenant_ids[@]}" | sort -u | wc -l)" -eq "${#tenant_ids[@]}" ]] || fail 'EZCORP_FACTORY_STORAGE_TENANTS names a tenant twice.'

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
  COMPOSE_PROJECT_NAME="$project_name" "${COMPOSE[@]}" -f "$compose_file" --profile factory-storage "$@"
}

require_owned_credentials() {
  require_runtime
  [[ -n "${EZCORP_FACTORY_STORAGE_SECRETS_DIR:-}" ]] || fail 'Set the generated credential directory before stop.'
  local canonical
  canonical="$(realpath -e -- "$EZCORP_FACTORY_STORAGE_SECRETS_DIR")"
  [[ "$canonical" == "${runtime_base%/}/${secrets_prefix}".* && "$(dirname -- "$canonical")" == "${runtime_base%/}" ]] || fail 'Credential directory must be generated directly below XDG_RUNTIME_DIR.'
  [[ ! -L "$EZCORP_FACTORY_STORAGE_SECRETS_DIR" && "$(stat -c '%u' "$canonical")" == "$UID" ]] || fail 'Credential directory ownership is invalid.'
  [[ -f "$canonical/.factory-storage-owner" && ! -L "$canonical/.factory-storage-owner" && "$(cat "$canonical/.factory-storage-owner")" == "$project_name" ]] || fail 'Credential directory has no matching ownership record.'
}

write_config() {
  local name="$1" prefix="$2" target="$3" first=1 tenant
  umask 077
  {
    printf '{"identities":['
    for tenant in "${tenant_ids[@]}"; do
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
    for tenant in "${tenant_ids[@]}"; do
      printf 's3.bucket.create -name=tenant-%s\n' "$tenant"
      printf 's3.bucket.versioning -name=tenant-%s -enable\n' "$tenant"
    done
  } | compose exec -T "$service" weed shell -master=localhost:9333
}

start() {
  require_loopback
  require_runtime
  if "$ENGINE" ps -aq --filter "label=com.docker.compose.project=$project_name" | read -r _; then
    fail 'Factory storage containers already exist. Use their credential directory or stop them first.'
  fi
  local secrets_dir
  secrets_dir="$(mktemp -d "${runtime_base%/}/${secrets_prefix}.XXXXXXXX")"
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

# After a host reboot the credential directory (tmpfs below XDG_RUNTIME_DIR) is
# gone while the containers and their data volumes remain, so `up` refuses the
# existing containers and `down` cannot prove ownership. Recover by removing
# the containers only (volumes stay) and starting again with fresh credentials.
recover() {
  require_loopback
  require_runtime
  if ! "$ENGINE" ps -aq --filter "label=com.docker.compose.project=$project_name" | read -r _; then
    fail 'No factory storage containers exist. Use up.'
  fi
  if ls -d "${runtime_base%/}/${secrets_prefix}".* >/dev/null 2>&1; then
    fail 'A credential directory still exists. Use down, then up.'
  fi
  EZCORP_FACTORY_STORAGE_SECRETS_DIR=/nonexistent compose down
  start
}

case "${1:-up}" in
  up) start ;;
  down) stop ;;
  recover) recover ;;
  *) fail 'Usage: scripts/setup-factory-storage.sh [up|down|recover]' ;;
esac
