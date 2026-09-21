#!/usr/bin/env bash
# Runs a factory PostgreSQL producer with the database URL assembled here rather than in an argv.
#
# The URL carries the password. Building it in a caller's command line puts it in the process
# table, in shell history, and in any transcript of the run; building it inside this file keeps it
# in this process's environment only. Callers pass test paths, never credentials.
#
# Usage: scripts/run-factory-postgres-suite.sh <test path> [<test path> ...]
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <test path> [<test path> ...]" >&2
  exit 2
fi

export PATH="/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH"

ENV_FILE="${FACTORY_POSTGRES_ENV_FILE:-/tmp/factory-platform-evidence/postgres.env}"
if [ ! -r "$ENV_FILE" ]; then
  echo "missing PostgreSQL environment file: $ENV_FILE" >&2
  exit 2
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

PORT="$(podman port factory-platform-proof-postgres 5432 | head -1 | cut -d: -f2)"
if [ -z "$PORT" ]; then
  echo "the proof PostgreSQL container publishes no port for 5432" >&2
  exit 2
fi

FACTORY_TEST_POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${PORT}/${POSTGRES_DB}"
export FACTORY_TEST_POSTGRES_URL
export DATABASE_URL="$FACTORY_TEST_POSTGRES_URL"
export EZCORP_FACTORY_STORAGE_SECRETS_DIR="${EZCORP_FACTORY_STORAGE_SECRETS_DIR:-/run/user/1001/ezcorp-factory-storage.8yWJyCIQ}"

exec bun test --timeout 600000 "$@"
