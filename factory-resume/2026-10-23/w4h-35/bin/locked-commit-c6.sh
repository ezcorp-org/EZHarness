#!/usr/bin/env bash
# locked-commit-c6.sh (gated-flock only; team-lead's C6 commit word): typecheck (tc-gate, in-lock floor); C6 rows (docs only);
# C6 fix with the hook's FULL run (EZ_PRECOMMIT_TEST_MAX = the mapped suite count; own pg15; URL from its env file, never argv);
# then the changed lines' coverage vs def32c1a4 (5 focused suites + the PostgreSQL provisioning suite, merged), lint, gate integrity.
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; stamp=$(date -u +%Y%m%dT%H%M%SZ)
D=$E/c6-$stamp; mkdir -p "$D/lcov"; S=$D/legs.log
. evidence/w00/lock-veto.sh; lock_veto integrator-2
. evidence/w00/resource-gate.sh; RESOURCE_GATE_MAX_WAIT_S=0
resource_gate w4h35-c6 "$S" || { echo "release: gate red $(date -u +%FT%TZ)" >> "$S"; exit 75; }
. evidence/w00/tc-gate.sh; export TC_IN_LOCK=1
. evidence/w00/bun-pin.sh; bun_pin "$W" > /dev/null
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE; cd "$W" || exit 1
[ "$(git branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] || { echo "wrong branch" >> "$S"; exit 1; }
[ "$(git rev-parse --short HEAD)" = def32c1a4 ] || { echo "head is not def32c1a4" >> "$S"; exit 1; }
FIX="src/factory/provisioning/compose-profile.ts src/factory/provisioning/deployment.ts src/factory/provisioning/kubernetes-profile.test.ts src/factory/provisioning/kubernetes-profile.ts"
ROWS=docs/plans/2026-09-12-composable-factory-platform-contracts.md
tc_run w4h35-c6-typecheck "$S" bun run typecheck > "$D/typecheck.log" 2>&1; rc=$?; echo "typecheck exit $rc $(date -u +%FT%TZ)" >> "$S"
[ "$rc" = 75 ] && exit 75; [ "$rc" = 0 ] || exit "$rc"
git add $ROWS && GIT_CONFIG_NOSYSTEM=1 git commit -F "$E/msg-c6-rows.txt" > "$D/commit-rows.log" 2>&1; rc=$?
echo "commit rows exit $rc head $(git log -1 --format=%h) $(date -u +%FT%TZ)" >> "$S"; [ "$rc" = 0 ] || exit "$rc"
git add $FIX
bash -c 'source scripts/lib/hook-lib.sh >/dev/null 2>&1; staged_test_targets $(git diff --cached --name-only)' | sort -u > "$D/mapped.txt"
count=$(wc -l < "$D/mapped.txt"); echo "mapped suites: $count" >> "$S"
. evidence/w00/own-pg.sh; own_pg_start w4h35-c6-pg > /dev/null || { echo "own pg failed" >> "$S"; exit 1; }
. "$PG_ENV_FILE"; port=$(podman port "$PG_CONTAINER" 5432 | head -1 | sed 's/.*://')
export FACTORY_TEST_POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}"; unset POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB port
EZCORP_FACTORY_STORAGE_SECRETS_DIR=$(ls -d /run/user/1001/ezcorp-factory-storage.* | head -1); export EZCORP_FACTORY_STORAGE_SECRETS_DIR
EZ_PRECOMMIT_TEST_MAX=$count GIT_CONFIG_NOSYSTEM=1 git commit -F "$E/msg-c6.txt" > "$D/commit-fix.log" 2>&1; rc=$?
echo "commit fix exit $rc head $(git log -1 --format=%h) $(date -u +%FT%TZ)" >> "$S"; [ "$rc" = 0 ] || exit "$rc"
leg() { local name=$1; shift; "$@" > "$D/$name.log" 2>&1; local r=$?; echo "$name exit $r $(grep -E '^ *[0-9]+ (pass|fail)$' "$D/$name.log" | tr '\n' ' ')" >> "$S"; [ "$r" = 0 ] || st=1; }
st=0
leg unit-cov bun test --timeout 60000 --coverage --coverage-reporter=lcov --coverage-dir="$D/cov-unit" ./src/factory/provisioning/kubernetes-profile.test.ts ./src/factory/provisioning/compose-profile.test.ts ./src/factory/provisioning/deployment.test.ts ./src/factory/provisioning/kubernetes-target.test.ts ./src/factory/provisioning/host.test.ts
cp "$D/cov-unit/lcov.info" "$D/lcov/unit.lcov" 2>/dev/null
leg pg-cov bun test --timeout <PID> --coverage --coverage-reporter=lcov --coverage-dir="$D/cov-pg" ./tests/postgres/factory-provisioning.test.ts
cp "$D/cov-pg/lcov.info" "$D/lcov/pg.lcov" 2>/dev/null
unset FACTORY_TEST_POSTGRES_URL
leg merge bun scripts/merge-lcov.ts "$D/lcov/*.lcov" coverage/lcov.info
leg patch-coverage env BASE_REF=def32c1a4 bun scripts/check-patch-coverage.ts
leg gate-integrity env BASE_REF=def32c1a4 bun scripts/gate-integrity.ts
leg lint bun run lint
leg boundaries bun scripts/check-factory-boundaries.ts
echo "done status=$st head $(git rev-parse --short HEAD) $(date -u +%FT%TZ)" >> "$S"
exit "$st"
