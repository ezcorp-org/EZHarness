#!/usr/bin/env bash
# Real cross-image proof: install and run a legacy main extension, then adopt
# that exact database identity into v4. This is intentionally separate from
# the v4-to-v4 upgrade verifier.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Respect the caller's Docker engine. CI uses rootful Docker; local rootless
# replays may set DOCKER_HOST explicitly.
# shellcheck source=scripts/lib/build-archived-image.sh
source scripts/lib/build-archived-image.sh
legacy_base_image="${VERIFY_LEGACY_ADOPTION_BASE_IMAGE:-localhost/ezcorp-extension-v4:legacy-main-537f074e}"
legacy_image="${VERIFY_LEGACY_ADOPTION_IMAGE:-${legacy_base_image}-derived}"
legacy_source="${VERIFY_LEGACY_ADOPTION_LEGACY_SOURCE:-537f074e7303ecdf3cbef1a7af4fd60a3244b0a3}"
# The candidate is always an explicit test input. Do not accidentally accept
# an old short-SHA image as a final adoption proof.
candidate_image="${VERIFY_LEGACY_ADOPTION_CANDIDATE_IMAGE:?Set the candidate image}"
candidate_id="${VERIFY_LEGACY_ADOPTION_CANDIDATE_IMAGE_ID:?Set the exact candidate image ID}"
candidate_source="${VERIFY_LEGACY_ADOPTION_CANDIDATE_SOURCE:?Set the full candidate source SHA}"
asset_sha256="${VERIFY_LEGACY_ADOPTION_ASSET_SHA256:-bc318f06884e68874ba57613ca2ae88e93e9845445c2a0f19383606b041f77cc}"
run_id="${VERIFY_LEGACY_ADOPTION_RUN_ID:-$(openssl rand -hex 6)}"
receipt_root="${VERIFY_LEGACY_ADOPTION_RECEIPT_DIR:-$(mktemp -d /tmp/ezcorp-legacy-adoption-receipts-XXXXXXXX)}"

[[ "$candidate_source" =~ ^[0-9a-f]{40}$ ]] || { echo "Candidate source must be a full 40-character SHA" >&2; exit 2; }
[[ "$legacy_source" =~ ^[0-9a-f]{40}$ ]] || { echo "Legacy source must be a full 40-character SHA" >&2; exit 2; }
if [[ -e "$receipt_root" ]]; then
  [[ -d "$receipt_root" ]] || { echo "Receipt path is not a directory: $receipt_root" >&2; exit 2; }
  [[ -z "$(find "$receipt_root" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo "Receipt directory must be empty: $receipt_root" >&2; exit 2; }
else
  mkdir -p "$receipt_root"
fi
receipt_build_root="$receipt_root/build"
mkdir -p "$receipt_build_root"
export VERIFY_ARCHIVED_IMAGE_RECEIPT_ROOT="$receipt_build_root"
state_root="$(mktemp -d /tmp/ezcorp-legacy-adoption-state-XXXXXXXX)"
receipt_file="$receipt_root/adoption-state.json"

finish() {
  local exit_code="$?"
  if ! podman unshare rm -rf "$state_root" 2>/dev/null && ! rm -rf "$state_root"; then
    echo "Failed to remove owned state root: $state_root" >&2
    exit_code=1
  fi
  printf 'exit=%s\nlegacy_source=%s\ncandidate_source=%s\nlegacy_image=%s\ncandidate_image=%s\n' "$exit_code" "$legacy_source" "$candidate_source" "$legacy_image" "$candidate_image" >> "$receipt_root/provenance.txt"
  printf 'Legacy adoption receipts: %s\n' "$receipt_root"
  exit "$exit_code"
}
trap finish EXIT

ensure_archived_image "$legacy_source" "$legacy_base_image" "legacy-base" || exit 1
legacy_base_id="$(docker image inspect "$legacy_base_image" --format '{{.Id}}')"
legacy_base_revision="$(docker image inspect "$legacy_base_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$legacy_base_revision" == "$legacy_source" ]] || { echo "Wrong legacy base OCI revision" >&2; exit 1; }
candidate_actual_id="$(docker image inspect "$candidate_image" --format '{{.Id}}')"
[[ "${candidate_actual_id#sha256:}" == "${candidate_id#sha256:}" ]] || { echo "Wrong candidate image ID" >&2; exit 1; }
[[ "${candidate_actual_id#sha256:}" != "${legacy_base_id#sha256:}" ]] || { echo "Legacy base and candidate image IDs must differ" >&2; exit 1; }
candidate_revision="$(docker image inspect "$candidate_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$candidate_revision" == "$candidate_source" ]] || { echo "Wrong candidate OCI revision" >&2; exit 1; }
actual_asset_sha256="$(docker run --rm --entrypoint sha256sum "$candidate_image" /app/web/node_modules/@electric-sql/pglite-pgvector/dist/vector.tar.gz | awk '{print $1}')"
[[ "$actual_asset_sha256" == "$asset_sha256" ]] || { echo "Candidate vector asset checksum mismatch" >&2; exit 1; }
if ! docker image inspect "$legacy_image" >/dev/null 2>&1; then
  docker build --load -f scripts/Dockerfile.legacy-adoption-derived \
    --build-arg LEGACY_BASE="$legacy_base_image" --build-arg LEGACY_BASE_ID="$legacy_base_id" \
    --build-arg ASSET_SOURCE="$candidate_image" --build-arg VECTOR_SHA256="$actual_asset_sha256" \
    -t "$legacy_image" . >"$receipt_build_root/legacy-derived-build.log" 2>&1
fi
legacy_id="$(docker image inspect "$legacy_image" --format '{{.Id}}')"
legacy_revision="$(docker image inspect "$legacy_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
legacy_base="$(docker image inspect "$legacy_image" --format '{{index .Config.Labels "org.ezcorp.legacy-adoption.base-image"}}')"
[[ "$legacy_revision" == "$legacy_source" ]] || { echo "Wrong legacy OCI revision" >&2; exit 1; }
[[ "$legacy_base" == "$legacy_base_id" ]] || { echo "Derived legacy image has the wrong base" >&2; exit 1; }
printf 'legacy_image_id=%s\nlegacy_revision=%s\nlegacy_base_image_id=%s\ncandidate_image_id=%s\ncandidate_revision=%s\nasset_sha256=%s\n' "$legacy_id" "$legacy_revision" "$legacy_base_id" "$candidate_actual_id" "$candidate_revision" "$actual_asset_sha256" > "$receipt_root/provenance.txt"

run_image() {
  local image="$1"
  local mode="$2"
  local port="$3"
  local project="$4"
  local receipt="$receipt_root/$mode"
  local app_uid="${EZ_LEGACY_ADOPTION_APP_UID:-${EZ_PRODUCTION_APP_UID:-0}}"
  mkdir "$receipt"
  EZ_PRODUCTION_IMAGE="$image" \
  EZ_PRODUCTION_RECEIPT_DIR="$receipt" \
  EZ_PRODUCTION_STATE_DIR="$state_root" \
  EZ_PRODUCTION_PORT="$port" \
  EZ_PRODUCTION_COMPOSE_PROJECT="$project" \
  EZ_PRODUCTION_APP_CONTAINER="${project}-app" \
  EZ_PRODUCTION_APP_UID="$app_uid" EZ_PRODUCTION_APP_GID="${EZ_LEGACY_ADOPTION_APP_GID:-$app_uid}" EZ_PRODUCTION_RUNNER_APP_UID="${EZ_PRODUCTION_RUNNER_APP_UID:-$(id -u)}" \
  EZ_LEGACY_ADOPTION_MODE="$mode" \
  EZ_LEGACY_ADOPTION_RECEIPT="$receipt_file" \
  EZ_LEGACY_SOURCE="$legacy_source" EZ_CANDIDATE_SOURCE="$candidate_source" \
  bash scripts/verify-production-image-lifecycle.sh -- \
    bun scripts/verify-legacy-adoption.ts
  grep -qx 'command_exit=0' "$receipt/command.log"
  grep -qx 'owned_cleanup_exit=0' "$receipt/command.log"
}

run_image "$legacy_image" seed 13124 "ezcorp-legacy-adoption-old-$run_id"
[[ -s "$receipt_file" ]] || { echo "Legacy seed did not produce a receipt" >&2; exit 1; }
run_image "$candidate_image" adopt 13125 "ezcorp-legacy-adoption-v4-$run_id"

printf 'LEGACY_MAIN_TO_V4_ADOPTION_VERIFIED\n'
