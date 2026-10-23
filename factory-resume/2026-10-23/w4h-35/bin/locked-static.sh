#!/usr/bin/env bash
# locked-static.sh (gated-flock only): the freeze's static and coverage legs at HEAD. Unit suites (the branch's mapped set) with
# lcov in batches, the PostgreSQL provisioning suite with lcov on an own pg15, merge, patch and new-file coverage vs 390c49a90,
# gate-integrity default / origin/main / 390c49a90, lint, factory boundaries, deployment locks. Each leg's exit is recorded.
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
. evidence/w00/lock-veto.sh; lock_veto integrator-2
. evidence/w00/resource-gate.sh; RESOURCE_GATE_MAX_WAIT_S=0
stamp=$(date -u +%Y%m%dT%H%M%SZ); D=$E/static-$stamp; mkdir -p "$D"; S=$D/legs.log
resource_gate w4h35-static "$S" || { echo "release: gate red" >> "$S"; exit 75; }
. evidence/w00/bun-pin.sh; bun_pin "$W" > /dev/null
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE; cd "$W" || exit 1
echo "head $(git rev-parse --short HEAD) $(date -u +%FT%TZ)" >> "$S"; st=0
# Typecheck first (tc-gate, in-lock floor): the head carries commits made without one (C5).
. evidence/w00/tc-gate.sh; export TC_IN_LOCK=1
tc_run w4h35-static-typecheck "$S" bun run typecheck > "$D/typecheck.log" 2>&1; rc=$?
echo "leg typecheck exit $rc" >> "$S"; [ "$rc" = 75 ] && exit 75; [ "$rc" = 0 ] || st=1
leg() { local name=$1; shift; "$@" > "$D/$name.log" 2>&1; local rc=$?; echo "leg $name exit $rc $(grep -E '^ *[0-9]+ (pass|fail)$' "$D/$name.log" | tr '\n' ' ')" >> "$S"; [ "$rc" = 0 ] || st=1; }
bash -c 'source scripts/lib/hook-lib.sh >/dev/null 2>&1; staged_test_targets $(git diff --name-only 390c49a90 HEAD)' 2>/dev/null | sort -u | grep -v '^tests/postgres/' > "$D/unit-suites.txt"
mkdir -p "$D/lcov"; split -l 9 "$D/unit-suites.txt" "$D/batch-"
for b in "$D"/batch-*; do n=$(basename "$b"); leg "unit-$n" bun test --timeout 60000 --coverage --coverage-reporter=lcov --coverage-dir="$D/cov-$n" $(sed 's#^#./#' "$b"); cp "$D/cov-$n/lcov.info" "$D/lcov/$n.lcov" 2>/dev/null; done
. evidence/w00/own-pg.sh; own_pg_start w4h35-static-pg > /dev/null || { echo "own pg failed" >> "$S"; exit 1; }
pgleg() { ( . "$PG_ENV_FILE"; port=$(podman port "$PG_CONTAINER" 5432 | head -1 | sed 's/.*://')
  export FACTORY_TEST_POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}"; unset POSTGRES_PASSWORD
  EZCORP_FACTORY_STORAGE_SECRETS_DIR=$(ls -d /run/user/$(id -u)/ezcorp-factory-storage.* | head -1); export EZCORP_FACTORY_STORAGE_SECRETS_DIR
  bun test --timeout <PID> --coverage --coverage-reporter=lcov --coverage-dir="$D/cov-pg" ./tests/postgres/factory-provisioning.test.ts ); }
leg pg-provisioning pgleg; cp "$D/cov-pg/lcov.info" "$D/lcov/pg.lcov" 2>/dev/null
leg merge bun scripts/merge-lcov.ts "$D/lcov/*.lcov" coverage/lcov.info
leg patch-coverage env BASE_REF=390c49a90 bun scripts/check-patch-coverage.ts
leg newfile-coverage env BASE_REF=390c49a90 bun scripts/check-new-file-coverage.ts
leg gate-integrity-default bun scripts/gate-integrity.ts
leg gate-integrity-main env BASE_REF=origin/main bun scripts/gate-integrity.ts
leg gate-integrity-base env BASE_REF=390c49a90 bun scripts/gate-integrity.ts
leg lint bun run lint
leg boundaries bun scripts/check-factory-boundaries.ts
leg locks bun scripts/check-factory-deployment-locks.ts
echo "STATIC DONE status=$st $(date -u +%FT%TZ)" >> "$S"; exit $st
