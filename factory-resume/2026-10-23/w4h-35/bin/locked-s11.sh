#!/usr/bin/env bash
# locked-s11.sh (gated-flock only; session 11, team-lead's ruling: ONE session per merge-prep/session-11-plan.txt a28b5c748c7e4be8,
# with validator-8's order fix): commits 08-11 on wp/w4h-35-w16-k8s-profiles at 3698c8e84, each through bin/locked-commit-fix.sh.
#  08: apply; the lock checker tests; the full factory image with the HOSTED builder (Podman 4.9.3, built here --pull=never from the
#      pinned Containerfile, id recorded) and with the host Podman 5.8.7; commit only if all three are green.
#  09: commit (its own unit case runs in the hook).
#  R3 red-first: r3-github-repeat.sh on the a27d301c4 tree, --repeat-each 20; :208 must be RED on every repeat, else STOP (exit 10)
#      with no commit 10 or 11.
#  10, 11: commit.
#  mutants at the new head (each must turn its tests red; the file is restored after); R3 on the new head (:208 green every repeat);
#  R2 counts (own pg) on a27d301c4 and the new head; the fast stage and C9 against the checked merge-base 063b3d16e.
#  Last: the builder image's tag removed (by tag, never by id); the manifest. Exit 0 only when every gate above is green; 75 (re-queue) only
#  before commit 08 exists: after it, the start check (HEAD = 3698c8e84) cannot pass again, so a 75 there ends with exit 1, named.
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; BASE=3698c8e84
C9BASE=063b3d16efc4074ebcf78a7df8c20fedfb54ccf0; P=$E/merge-prep/session11; MP=$E/merge-prep
BUN=/tmp/factory-tools/bun-1.4.2/bun-linux-x64/bun; stamp=$(date -u +%Y%m%dT%H%M%SZ); D=$E/s11-$stamp; mkdir -p "$D"; S=$D/legs.log
HB=localhost/w4h35-hosted-builder:podman-4.9.3; hbid=
say() { echo "[$(date -u +%FT%TZ)] $*" >> "$S"; }
# leg <name> <cmd...>: output to $D/<name>.log; START and END (with the exit) in legs.log; returns the exit.
leg() { local n=$1 rc; shift; say "START $n"; "$@" > "$D/$n.log" 2>&1; rc=$?; say "END $n exit=$rc"; return $rc; }
manifest() { (cd "$D" && find . \( -path ./ctx08 -o -path ./tree-a27 -o -path ./tree-new -o -path ./hb-ctx -o -name test-results \) -prune -o -type f ! -name s11-shas.txt -print0 | sort -z | xargs -0 sha256sum) > "$D/s11-shas.txt"; }
# The builder is removed by OUR TAG only, never by id: the same Containerfile gives the same id, which other tags (integrator-5's w00
# builder) can share; `podman rmi <tag>` only untags while another tag keeps the image (W4H-35 session 11, builder-removal.log).
finish() { [ -n "$hbid" ] && { cur=$(podman image inspect --format '{{.Id}}' "$HB" 2>/dev/null)
    if [ "$cur" = "$hbid" ]; then echo "podman rmi $HB (our tag; id $hbid)"; podman rmi "$HB"; else echo "tag $HB is ${cur:-absent}, not the recorded $hbid: nothing removed"; fi; } >> "$D/builder-removal.log" 2>&1
  say "final exit $1: head $(git -C "$W" log -1 --format='%h %s'), porcelain $(git -C "$W" status --porcelain | wc -l)"; manifest; exit "$1"; }
# commit_fix <nn> <msg> <paths...>: the patch is applied already; the commit through the hook; a refused commit is unstaged and reverted.
commit_fix() { local nn=$1 msg=$2 parent rc; shift 2; parent=$(git rev-parse --short HEAD)
  leg "commit-$nn" bash "$E/bin/locked-commit-fix.sh" "$msg" "$parent" "$@"; rc=$?
  say "after commit $nn: $(git log -1 --format='%h %s')"
  if [ "$rc" != 0 ] && [ "$(git rev-parse --short HEAD)" = "$parent" ]; then git reset -q && git apply -R "$P/$nn.patch"; say "commit $nn not made: patch reverted, porcelain $(git status --porcelain | wc -l)"; fi
  return $rc; }
apply() { git apply "$P/$1.patch" || { say "STOP: $1.patch does not apply at $(git rev-parse --short HEAD)"; finish 1; }; }
r3_count() { sed -nE 's/^r3: exit [0-9]+; ([0-9]+) red of :208, ([0-9]+) green of :208$/\1 \2/p' "$1" | tail -1; }
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE DATABASE_URL FACTORY_TEST_POSTGRES_URL
. evidence/w00/lock-veto.sh; lock_veto integrator-2
. evidence/w00/resource-gate.sh; RESOURCE_GATE_MAX_WAIT_S=0
resource_gate w4h35-s11 "$S" || { say "release: gate red"; exit 75; }
cd "$W" || exit 1
[ "$(git branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] && [ "$(git rev-parse --short HEAD)" = "$BASE" ] && [ -z "$(git status --porcelain)" ] \
  || { say "STOP: the worktree is not a clean $BASE on its branch"; exit 1; }
# ---- 08
mkdir "$D/ctx08" && git archive "$BASE" | tar -x -C "$D/ctx08" && (cd "$D/ctx08" && git apply "$P/08.patch") || { say "STOP: ctx08 not made"; finish 1; }
apply 08
leg c08-checker-tests "$BUN" test ./scripts/check-factory-deployment-locks.test.ts; g2=$?
leg c08-lock-check "$BUN" scripts/check-factory-deployment-locks.ts || g2=1
mkdir "$D/hb-ctx" && cp "$E/hosted-builder/Containerfile" "$D/hb-ctx/"
leg c08-builder-image podman build --pull=never -t "$HB" "$D/hb-ctx"; g3=$?
hbid=$(podman image inspect --format '{{.Id}}' "$HB" 2>/dev/null); say "builder image $HB id ${hbid:-none}"
[ "$g3" = 0 ] && { HB_IMAGE=$HB HB_REPO=$W leg c08-hosted-builder-image bash "$E/hosted-builder/hosted-builder-leg.sh" "$BASE" "$D/ctx08"; g3=$?; }
dang() { podman images -q --no-trunc -f dangling=true | sort -u; }
before=$(dang); T4=localhost/w4h35-s11-host:$stamp
leg c08-host-image podman build --pull=never -f "$D/ctx08/deploy/factory/Dockerfile" --build-arg REVISION="$BASE+08" -t "$T4" "$D/ctx08"; g4=$?
mine=$(sed -nE 's/^--> ([0-9a-f]{12})[[:space:]]*$/\1/p' "$D/c08-host-image.log" | sort -u)
{ id=$(podman image inspect --format '{{.Id}}' "$T4" 2>/dev/null) && echo "podman rmi $T4 ($id)" && podman rmi "$T4"
  for id in $(comm -13 <(printf '%s\n' "$before") <(dang)); do h=${id#sha256:}
    if grep -qxF -- "${h:0:12}" <<< "$mine"; then echo "podman rmi $id (this build's stage)"; podman rmi "$id"; else echo "new dangling $id: not this build: kept"; fi; done; } >> "$D/host-image-removals.log" 2>&1
if [ "$g2" != 0 ] || [ "$g3" != 0 ] || [ "$g4" != 0 ]; then git apply -R "$P/08.patch"; say "STOP: 08 legs red (checker $g2, hosted builder $g3, host $g4); patch reverted"; finish 1; fi
commit_fix 08 "$MP/msg-fix-ci-01.txt" deploy/factory/Dockerfile docs/factory-deployment.md scripts/check-factory-deployment-locks.ts scripts/check-factory-deployment-locks.test.ts; r=$?
[ "$r" = 75 ] && finish 75; [ "$r" = 0 ] || finish 1
# ---- 09
apply 09
commit_fix 09 "$MP/msg-s11-09.txt" src/__tests__/helpers/factory-webhook-receiver.ts src/factory/notification-sender.test.ts; r=$?
[ "$r" = 75 ] && { say "STOP: commit 09 asked to re-queue (75); no re-queue after commit 08: a resume needs a new set"; finish 1; }; [ "$r" = 0 ] || finish 1
# ---- R3 red-first on a27d301c4, before commit 10
bash "$E/bin/scratch-tree.sh" a27d301c4 "$D/tree-a27" "$W" >> "$S" 2>&1 || { say "STOP: no a27d301c4 tree"; finish 1; }
leg r3-a27 bash "$E/bin/r3-github-repeat.sh" "$D/tree-a27" "$D/r3-a27" 20
read -r red green <<< "$(r3_count "$D/r3-a27/playwright.log")"; say "R3 on a27d301c4: :208 red ${red:-?} green ${green:-?} of 20"
[ "${red:-0}" = 20 ] && [ "${green:-1}" = 0 ] || { say "STOP (exit 10): R3 is not red on every repeat at a27d301c4; no commit 10 or 11"; finish 10; }
# ---- 10, 11
apply 10
commit_fix 10 "$MP/msg-s11-10.txt" web/e2e/personal-github-settings.spec.ts; r=$?
[ "$r" = 75 ] && { say "STOP: commit 10 asked to re-queue (75); no re-queue after commit 08: a resume needs a new set"; finish 1; }; [ "$r" = 0 ] || finish 1
apply 11
commit_fix 11 "$MP/msg-s11-11.txt" src/factory/runner/supervisor-process.ts src/factory/service-probes.ts src/factory/service-probes.test.ts src/factory/runtime-composition.test.ts src/factory/observability/alert-evaluator.integration.test.ts; r=$?
[ "$r" = 75 ] && { say "STOP: commit 11 asked to re-queue (75); no re-queue after commit 08: a resume needs a new set"; finish 1; }; [ "$r" = 0 ] || finish 1
NEW=$(git rev-parse --short HEAD); say "new head $NEW"
# ---- mutants at the new head: each must turn its tests red; the file is restored from HEAD after each.
mut=0
mutant() { local n=$1 file=$2 how=$3; shift 3; say "mutant $n: $how"
  case $how in old-dockerfile) git show "$BASE:$file" > "$file" ;; *) sed -i "$how" "$file" ;; esac
  git diff --quiet -- "$file" && { say "mutant $n NOT PLANTED (no change)"; mut=1; return; }
  leg "mutant-$n" "$BUN" test "$@"; [ $? != 0 ] || { say "mutant $n NOT KILLED"; mut=1; }
  git checkout -q -- "$file"; }
mutant 08 deploy/factory/Dockerfile old-dockerfile ./scripts/check-factory-deployment-locks.test.ts
mutant 09 src/__tests__/helpers/factory-webhook-receiver.ts 's/ \&\& arrivedIn === generation) delivered.add(/) delivered.add(/' ./src/factory/notification-sender.test.ts
mutant 11 src/factory/service-probes.ts 's/return heldProbeOf("host-supervisor", async (signal) => {/return probeOf("host-supervisor", async (signal) => {/' ./src/factory/service-probes.test.ts ./src/factory/installation-startup.test.ts ./src/factory/runtime-composition.test.ts
[ -z "$(git status --porcelain)" ] || { say "STOP: the worktree is not clean after the mutants"; finish 1; }
# ---- R3 on the new head (green expected), R2 counts (records)
bash "$E/bin/scratch-tree.sh" "$NEW" "$D/tree-new" "$W" >> "$S" 2>&1 || say "no new-head tree"
leg r3-new bash "$E/bin/r3-github-repeat.sh" "$D/tree-new" "$D/r3-new" 20; r3n=$?
read -r red green <<< "$(r3_count "$D/r3-new/playwright.log")"; say "R3 on $NEW: :208 red ${red:-?} green ${green:-?} of 20; playwright exit $r3n"
[ "$r3n" = 0 ] && [ "${green:-0}" = 20 ] || { say "R3 NOT GREEN at the new head"; mut=1; }
. evidence/w00/own-pg.sh
if own_pg_start w4h35-s11-pg > "$D/own-pg.log" 2>&1; then
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
[ "$fc" = 75 ] && { say "STOP: fast-c9 asked to re-queue (75); no re-queue after commit 08 (the start check needs HEAD = $BASE): a resume needs a new set"; finish 1; }
say "done: mutants/R3-new $mut, fast-c9 $fc"
[ "$mut" = 0 ] && [ "$fc" = 0 ] && finish 0; finish 1
