#!/usr/bin/env bash
# locked-s11r.sh (gated-flock only; the RESUME of session 11, team-lead 2026-10-23 after s11.exit.20261023T145022Z = 10):
# from 305a543c0 (commits 08 1efed0344 and 09 305a543c0 landed; both image legs passed in session 11 v4):
#  R3 red-first: r3-github-repeat.sh on an INSTALLED a27d301c4 tree (scratch-tree.sh ... install), 20 repeats; the case must be RED on all
#      20, else STOP exit 10 (no commit 10 or 11); NOT RUN (runner exit 3) is the same STOP, named.
#  10, 11: commit through bin/locked-commit-fix.sh. A 75 before commit 10 re-queues (the start check passes again at 305a543c0);
#      after commit 10 a 75 ends with a named STOP and exit 1 (a resume needs a new set).
#  mutants at the new head (08 the old Dockerfile of 3698c8e84, 09 no reset generation, 11 held dropped); R3 on an installed new-head
#      tree (green on all 20); R2 counts on its own pg (a27d301c4 and the new head; records); fast stage and C9 against 063b3d16e.
#  Last: the manifest. Exit 0 only when every gate is green.
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; BASE=305a543c0; MUTANT_DOCKERFILE_REV=3698c8e84
C9BASE=063b3d16efc4074ebcf78a7df8c20fedfb54ccf0; P=$E/merge-prep/session11; MP=$E/merge-prep
BUN=/tmp/factory-tools/bun-1.4.2/bun-linux-x64/bun; stamp=$(date -u +%Y%m%dT%H%M%SZ); D=$E/s11r-$stamp; mkdir -p "$D"; S=$D/legs.log
. "$E/bin/s11-lib.sh"
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE DATABASE_URL FACTORY_TEST_POSTGRES_URL
. evidence/w00/lock-veto.sh; lock_veto integrator-2
. evidence/w00/resource-gate.sh; RESOURCE_GATE_MAX_WAIT_S=0
resource_gate w4h35-s11r "$S" || { say "release: gate red"; exit 75; }
cd "$W" || exit 1
[ "$(git branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] && [ "$(git rev-parse --short HEAD)" = "$BASE" ] && [ -z "$(git status --porcelain)" ] \
  || { say "STOP: the worktree is not a clean $BASE on its branch"; exit 1; }
# ---- R3 red-first on a27d301c4, before commit 10 (leak: see r3_run in s11-lib.sh)
leak=0
leg tree-a27-install bash "$E/bin/scratch-tree.sh" a27d301c4 "$D/tree-a27" install || { say "STOP: no installed a27d301c4 tree"; finish 1; }
r3_run r3-a27 "$D/tree-a27"
[ "$r3rc" != 3 ] && [ "${red:-0}" = 20 ] && [ "${green:-1}" = 0 ] && [ "$leak" = 0 ] || { say "STOP (exit 10): R3 is not red on every repeat at a27d301c4, or it wrote into the owner worktree (runner exit $r3rc, leak $leak); no commit 10 or 11"; finish 10; }
# ---- 10, 11
apply 10
commit_fix 10 "$MP/msg-s11-10.txt" web/e2e/personal-github-settings.spec.ts; r=$?
[ "$r" = 75 ] && finish 75; [ "$r" = 0 ] || finish 1
apply 11
commit_fix 11 "$MP/msg-s11-11.txt" src/factory/runner/supervisor-process.ts src/factory/service-probes.ts src/factory/service-probes.test.ts src/factory/runtime-composition.test.ts src/factory/observability/alert-evaluator.integration.test.ts; r=$?
[ "$r" = 75 ] && { say "STOP: commit 11 asked to re-queue (75); after commit 10 a resume needs a new set"; finish 1; }; [ "$r" = 0 ] || finish 1
NEW=$(git rev-parse --short HEAD); say "new head $NEW"
# ---- mutants at the new head
mut=0
mutant 08 deploy/factory/Dockerfile old-dockerfile ./scripts/check-factory-deployment-locks.test.ts
mutant 09 src/__tests__/helpers/factory-webhook-receiver.ts 's/ \&\& arrivedIn === generation) delivered.add(/) delivered.add(/' ./src/factory/notification-sender.test.ts
mutant 11 src/factory/service-probes.ts 's/return heldProbeOf("host-supervisor", async (signal) => {/return probeOf("host-supervisor", async (signal) => {/' ./src/factory/service-probes.test.ts ./src/factory/installation-startup.test.ts ./src/factory/runtime-composition.test.ts
[ -z "$(git status --porcelain)" ] || { say "STOP: the worktree is not clean after the mutants"; finish 1; }
# ---- R3 on the new head (green expected), R2 counts (records)
leg tree-new-install bash "$E/bin/scratch-tree.sh" "$NEW" "$D/tree-new" install || { say "no installed new-head tree"; mut=1; }
r3_run r3-new "$D/tree-new"
[ "$r3rc" = 0 ] && [ "${green:-0}" = 20 ] && [ "${red:-1}" = 0 ] && [ "$leak" = 0 ] || { say "R3 NOT GREEN at the new head, or a leak (runner exit $r3rc, leak $leak)"; mut=1; }
. evidence/w00/own-pg.sh
if own_pg_start w4h35-s11r-pg > "$D/own-pg.log" 2>&1; then
  for t in a27 new; do
    leg "r2-$t" bash -c '. "$PG_ENV_FILE"; port=$(podman port "$PG_CONTAINER" 5432 | head -1 | sed "s/.*://")
      export FACTORY_TEST_POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}"; unset POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB port
      exec bash "$1/bin/r2-notif-repeat.sh" "$2/tree-$3" "$2/r2-$3" 200 600' _ "$E" "$D" "$t"
    say "R2 $t: $(tail -1 "$D/r2-$t/runs.txt" 2>/dev/null)"; done
  own_pg_stop
else say "R2 not run: own pg failed (own-pg.log)"; fi
# ---- fast stage and C9
. "$E/bin/c9-base.sh"; c9_base_check "$W" "$C9BASE" "$S" || finish 3
leg fast-c9 bash "$E/bin/locked-fast-c9.sh" "$NEW" "$C9BASE"; fc=$?
[ "$fc" = 75 ] && { say "STOP: fast-c9 asked to re-queue (75); after commit 10 a resume needs a new set"; finish 1; }
say "done: mutants/R3-new $mut, fast-c9 $fc"
[ "$mut" = 0 ] && [ "$fc" = 0 ] && finish 0; finish 1
