#!/usr/bin/env bash
# Starts the real-auth preview with either a caller-owned database or one
# fixture-owned temporary root. The latter is removed only after the preview
# command has exited, so PGlite is never removed while it is open.
set -euo pipefail

if (($# == 0)); then
  echo 'run-real-auth-fixture.sh: missing preview command' >&2
  exit 64
fi

if [[ -n "${PI_E2E_REAL_DB_PATH:-}" ]]; then
  # A caller supplied this path. It is not fixture-owned and is never removed.
  export EZCORP_DB_PATH="$PI_E2E_REAL_DB_PATH"
  exec "$@"
fi

fixture_parent="$(realpath "${TMPDIR:-/tmp}")"
fixture_root="$(mktemp -d "${fixture_parent}/ezcorp-e2e-XXXXXXXX")"
marker="${fixture_root}/.ezcorp-real-auth-fixture"
printf '%s\n' 'owned-real-auth-fixture-v1' > "$marker"
mkdir -m 700 "${fixture_root}/secrets"
export EZCORP_DB_PATH="${fixture_root}/pglite"
export EZCORP_SECRETS_DIR="${fixture_root}/secrets"

cleanup() {
  local command_status=$?
  trap - EXIT INT TERM
  local canonical_root canonical_parent
  canonical_root="$(realpath "$fixture_root" 2>/dev/null)" || {
    echo 'real-auth fixture cleanup refused: owned root is missing' >&2
    exit 1
  }
  canonical_parent="$(dirname "$canonical_root")"
  if [[ "$canonical_parent" != "$fixture_parent" || "$(basename "$canonical_root")" != ezcorp-e2e-* || ! -f "$marker" || "$(cat "$marker")" != 'owned-real-auth-fixture-v1' ]]; then
    echo 'real-auth fixture cleanup refused: root ownership validation failed' >&2
    exit 1
  fi
  rm -rf -- "$canonical_root"
  if [[ -e "$canonical_root" ]]; then
    echo 'real-auth fixture cleanup failed: owned root remains' >&2
    exit 1
  fi
  exit "$command_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$@"
