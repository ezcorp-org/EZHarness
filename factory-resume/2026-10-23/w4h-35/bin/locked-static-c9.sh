#!/usr/bin/env bash
# locked-static-c9.sh [base] (gated-flock only; team-lead's C9 lock word): static legs at the head against <base> (default
# 0df478ce3): typecheck (tc-gate, in-lock floor), the R2 reproduction (red-first: the session-5 one-process form red as recorded,
# the same PostgreSQL suites green each in its own process), unit coverage of every mapped suite (the hook's name mapping plus every
# importer of a changed source, c9-map.sh) each in its own process,
# every mapped PostgreSQL suite in its own process with DATABASE_URL at start (pg-split.sh, F2), the PostgreSQL provisioning suite,
# all with lcov on an own pg15, merge, patch and new-file coverage, gate integrity (default, origin/main and base, each by exit code:
# the expected set is EMPTY, team-lead N1 2026-10-20), lint, boundaries, deployment locks.
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; stamp=$(date -u +%Y%m%dT%H%M%SZ)
D=$E/static-c9-$stamp; mkdir -p "$D/lcov"; S=$D/legs.log; BASE=${1:-0df478ce3}
. evidence/w00/lock-veto.sh; lock_veto integrator-2
. evidence/w00/resource-gate.sh; RESOURCE_GATE_MAX_WAIT_S=0
resource_gate w4h35-static-c9 "$S" || { echo "release: gate red $(date -u +%FT%TZ)" >> "$S"; exit 75; }
. evidence/w00/tc-gate.sh; export TC_IN_LOCK=1
. evidence/w00/bun-pin.sh; bun_pin "$W" > /dev/null
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE; cd "$W" || exit 1
[ -z "$(git status --short)" ] || { echo "worktree not clean" >> "$S"; exit 1; }
echo "head $(git rev-parse --short HEAD) base $BASE $(date -u +%FT%TZ)" >> "$S"
st=0
leg() { local name=$1; shift; "$@" > "$D/$name.log" 2>&1; local r=$?; echo "$name exit $r $(grep -E '^ *[0-9]+ (pass|fail)$' "$D/$name.log" | tr '\n' ' ')" >> "$S"; [ "$r" = 0 ] || st=1; }
tc_run w4h35-c9-typecheck "$S" bun run typecheck > "$D/typecheck.log" 2>&1; rc=$?; echo "typecheck exit $rc" >> "$S"
[ "$rc" = 75 ] && exit 75; [ "$rc" = 0 ] || st=1
. evidence/w00/own-pg.sh; own_pg_start w4h35-c9-pg > "$D/own-pg.log" 2>&1 || { echo "own pg failed" >> "$S"; exit 1; }
. "$PG_ENV_FILE"; port=$(podman port "$PG_CONTAINER" 5432 | head -1 | sed 's/.*://')
export FACTORY_TEST_POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}"; unset POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB port
EZCORP_FACTORY_STORAGE_SECRETS_DIR=$(ls -d /run/user/1001/ezcorp-factory-storage.* | head -1); export EZCORP_FACTORY_STORAGE_SECRETS_DIR
. "$E/bin/list-guard.sh"; . "$E/bin/pg-split.sh"; M=$E/merge-prep
# R2 reproduction (team-lead 2026-10-20 16:10Z/16:20Z), before the C9 legs: the session-5 unit form (merge-prep/r2-session5-mapped.txt,
# 37 suites in ONE process, FACTORY_TEST_POSTGRES_URL set, DATABASE_URL unset) must give the recorded session-5 red
# (r2-expected.json: the test-pglite db/connection mock leak and the missing DATABASE_URL); its 7 PostgreSQL suites
# (r2-pg-suites.txt), each in its own process with DATABASE_URL at start, must be green. A mismatch stops red; no C9 leg runs.
list_nonempty "$M/r2-session5-mapped.txt" "$S" r2-repro-old || exit 1   # never a bare bun test (lesson 32)
env -u DATABASE_URL bun test --timeout 60000 --coverage --coverage-reporter=lcov --coverage-dir="$D/cov-r2-old" $(cat "$M/r2-session5-mapped.txt") > "$D/r2-repro-old.log" 2>&1
echo "r2-repro-old exit $? (red expected) $(grep -E '^ *[0-9]+ (pass|fail)$' "$D/r2-repro-old.log" | tr '\n' ' ')" >> "$S"
leg r2-repro-old-match python3 -I "$E/bin/r2-repro-judge.py" "$D/r2-repro-old.log" "$M/r2-expected.json"
mkdir -p "$D/r2-new"; pg_each "$M/r2-pg-suites.txt" "$D/r2-new" r2-repro-new "$S"; rn=$?; echo "r2-repro-new exit $rn (green expected)" >> "$S"
[ "$st" = 0 ] && [ "$rn" = 0 ] || { echo "STOP: the R2 reproduction does not match; no C9 leg runs" >> "$S"; exit 1; }
. "$E/bin/c9-map.sh"; c9_mapped "$BASE" "$D/mapped.txt"   # the hook's name mapping plus every importer of a changed source (D4a)
pg_split "$D/mapped.txt" "$D/mapped-unit.txt" "$D/mapped-pg.txt" "$S" || exit 1
echo "mapped suites: $(wc -l < "$D/mapped.txt") = unit $(wc -l < "$D/mapped-unit.txt") + pg $(wc -l < "$D/mapped-pg.txt") (plus the PostgreSQL provisioning suite)" >> "$S"
list_nonempty "$D/mapped-unit.txt" "$S" unit-cov || exit 1   # never a bare bun test (lesson 32)
unit_each "$D/mapped-unit.txt" "$D" unit-cov "$S" --coverage || st=1   # one process per suite, as the hook runs them (team-lead (c))
if grep -q '[^[:space:]]' "$D/mapped-pg.txt"; then pg_each "$D/mapped-pg.txt" "$D" pg-mapped "$S" --coverage || st=1; else echo "pg-mapped: 0 suites mapped" >> "$S"; fi
leg pg-cov bun test --timeout <PID> --coverage --coverage-reporter=lcov --coverage-dir="$D/cov-pg" ./tests/postgres/factory-provisioning.test.ts
cp "$D/cov-pg/lcov.info" "$D/lcov/pg.lcov" 2>/dev/null
unset FACTORY_TEST_POSTGRES_URL
leg merge bun scripts/merge-lcov.ts "$D/lcov/*.lcov" coverage/lcov.info
leg patch-coverage env BASE_REF=$BASE bun scripts/check-patch-coverage.ts
leg newfile-coverage env BASE_REF=$BASE bun scripts/check-new-file-coverage.ts
# Default, origin/main and base legs: the expected set is EMPTY (team-lead N1 2026-10-20; origin/main 802d46288 contains integ
# 063b3d16e), so each must exit 0 AND print the 0-findings form (gate-leg.sh; exit 0 alone can be a bypass).
. "$E/bin/gate-leg.sh"; unset GATE_CHANGE_APPROVED
gleg() { leg "$@"; gate_leg_ok "$D/$1.log" "$1" "$S" || st=1; }
gleg gate-integrity-default bun scripts/gate-integrity.ts
gleg gate-integrity-main env BASE_REF=origin/main bun scripts/gate-integrity.ts
gleg gate-integrity-base env BASE_REF=$BASE bun scripts/gate-integrity.ts
leg lint bun run lint
leg boundaries bun scripts/check-factory-boundaries.ts
leg locks bun scripts/check-factory-deployment-locks.ts
git checkout -- coverage/lcov.info 2> /dev/null || true
echo "done status=$st head $(git rev-parse --short HEAD) $(date -u +%FT%TZ)" >> "$S"
exit "$st"
