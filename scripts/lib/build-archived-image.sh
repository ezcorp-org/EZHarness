#!/usr/bin/env bash
# Shared immutable-source image builder for upgrade and legacy-adoption proofs.
# Usage: ensure_archived_image <full-source-sha> <image-tag> <receipt-label>
# Callers normally source container-engine.sh themselves; resolve here too so
# this stays correct when sourced on its own.
if [ -z "${ENGINE:-}" ]; then
  # shellcheck source=scripts/lib/container-engine.sh
  source "$(dirname "${BASH_SOURCE[0]}")/container-engine.sh"
fi

ensure_archived_image() {
  local source="$1" image="$2" label="$3"
  [[ "$source" =~ ^[0-9a-f]{40}$ ]] || { echo "Archived source must be a full SHA: $source" >&2; return 2; }
  if ! git cat-file -e "${source}^{commit}" 2>/dev/null; then
    git fetch --no-tags origin "$source" || { echo "Cannot fetch archived source: $source" >&2; return 1; }
  fi
  git cat-file -e "${source}^{commit}" || { echo "Archived source is not a commit: $source" >&2; return 1; }
  if "$ENGINE" image inspect "$image" >/dev/null 2>&1; then
    printf 'archived_image=%s\narchived_source=%s\narchived_build=reused\n' "$image" "$source"
    return 0
  fi
  local version created log_dir log
  version="$(git show "$source:package.json" | jq -er .version)" || { echo "Cannot read archived package version" >&2; return 1; }
  created="$(git show -s --format=%cI "$source")" || { echo "Cannot read archived commit time" >&2; return 1; }
  log_dir="${VERIFY_ARCHIVED_IMAGE_RECEIPT_ROOT:-/tmp}"
  mkdir -p "$log_dir" || return 1
  log="$log_dir/${label}-archive-build.log"
  git archive "$source" | "$ENGINE" build --load \
    --build-arg VERSION="$version" --build-arg REVISION="$source" --build-arg CREATED="$created" \
    -t "$image" - >"$log" 2>&1 || { tail -30 "$log" >&2; return 1; }
  printf 'archived_image=%s\narchived_source=%s\narchived_build_log=%s\n' "$image" "$source" "$log"
}
