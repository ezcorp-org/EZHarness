#!/usr/bin/env bash
# locked-commit-c2.sh <message-file> (run only through gated-flock; coordinator's Q8 ruling): typecheck (tc-gate, in-lock floor),
# then the commit with the hook's FULL run: EZ_PRECOMMIT_TEST_MAX = the mapped suite count (never fewer suites), PG_HOOK form with
# an OWN fresh pg15 (w00/own-pg.sh); the URL is built in memory from its env file, never argv, never printed. Red = nothing committed.
set -uo pipefail
E=evidence/w4h-35; S=$E/logs/locked-commit-c2.log; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
. evidence/w00/lock-veto.sh; lock_veto integrator-2
. evidence/w00/resource-gate.sh; RESOURCE_GATE_MAX_WAIT_S=0
resource_gate w4h35-c2 "$S" || { echo "release: gate red $(date -u +%FT%TZ)" >> "$S"; exit 75; }
. evidence/w00/tc-gate.sh; export TC_IN_LOCK=1
# The team's pin (w00/bun-pin.sh): bun and bunx from .bun-version, and the SQL auto-pipelining flag that pin needs.
. evidence/w00/bun-pin.sh; bun_pin "$W" > /dev/null
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE
cd "$W" || exit 1
[ "$(git branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] || { echo "wrong branch" >> "$S"; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
tc_run w4h35-typecheck "$S" bun run typecheck > "$E/logs/typecheck-$stamp.log" 2>&1; rc=$?
echo "typecheck exit $rc ($E/logs/typecheck-$stamp.log) $(date -u +%FT%TZ)" >> "$S"
[ "$rc" = 75 ] && exit 75; [ "$rc" = 0 ] || exit "$rc"
bash -c 'source scripts/lib/hook-lib.sh >/dev/null 2>&1; staged_test_targets $(git diff --cached --name-only)' | sort -u > "$E/logs/c2-suites-$stamp.txt"
count=$(wc -l < "$E/logs/c2-suites-$stamp.txt")
echo "mapped suites: $count ($E/logs/c2-suites-$stamp.txt)" >> "$S"
. evidence/w00/own-pg.sh; own_pg_start w4h35-c2-pg || { echo "own pg failed" >> "$S"; exit 1; }
. "$PG_ENV_FILE"
port=$(podman port "$PG_CONTAINER" 5432 | head -1 | sed 's/.*://')
export FACTORY_TEST_POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}"
unset POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB port
EZCORP_FACTORY_STORAGE_SECRETS_DIR=$(ls -d /run/user/1001/ezcorp-factory-storage.* | head -1); export EZCORP_FACTORY_STORAGE_SECRETS_DIR
EZ_PRECOMMIT_TEST_MAX=$count GIT_CONFIG_NOSYSTEM=1 git commit -F "$1" > "$E/logs/commit-c2-$stamp.log" 2>&1; rc=$?
echo "commit exit $rc ($E/logs/commit-c2-$stamp.log) head $(git log -1 --format=%h) $(date -u +%FT%TZ)" >> "$S"
if [ "$rc" = 0 ]; then
  # The PostgreSQL suite's own lcov, for the patch-coverage gate (the hook's run writes none). Same own server, same URL.
  env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE GIT_CONFIG_NOSYSTEM=1 bun test --timeout <PID> --coverage --coverage-reporter=lcov --coverage-dir="$E/cov/pg-$stamp" ./tests/postgres/factory-provisioning.test.ts > "$E/logs/pg-coverage-$stamp.log" 2>&1
  echo "pg coverage exit $? $(grep -E '^ *[0-9]+ (pass|fail)$' "$E/logs/pg-coverage-$stamp.log" | tr '\n' ' ') ($E/cov/pg-$stamp)" >> "$S"
fi
unset FACTORY_TEST_POSTGRES_URL
exit "$rc"
