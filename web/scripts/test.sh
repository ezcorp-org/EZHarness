#!/usr/bin/env bash
# Keep the package-local `bun test` entrypoint on the canonical web Bun pool.
# Selection and per-file failure handling live in one place so this command
# cannot drift into Vitest-owned tests.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

exec bash "$REPO_ROOT/scripts/test-web.sh"
