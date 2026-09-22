#!/usr/bin/env bash
# Keep the public entry point shell-compatible for Compose and boot scripts.
# The implementation uses Bun so Docker-ignore matching and direct blob checks
# stay portable across Linux and macOS.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v bun >/dev/null 2>&1; then
  echo unknown
  exit 0
fi

if [ "$#" -eq 0 ]; then
  set -- "$SCRIPT_DIR/.."
elif [ "$1" = "--revision" ] && [ "$#" -eq 1 ]; then
  set -- --revision "$SCRIPT_DIR/.."
fi

exec bun --no-install "$SCRIPT_DIR/resolve-dev-image-source-state.ts" "$@"
