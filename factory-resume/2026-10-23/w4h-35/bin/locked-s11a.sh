#!/usr/bin/env bash
# locked-s11a.sh (gated-flock only; session 11a, team-lead's amended ruling; plan merge-prep/session-08-plan.txt 20652a664b423105):
#  L1 trees: fix-ci-01.patch applied in the clean w4h-35 worktree (3698c8e84) and in a git-archive context ctx08; a27d301c4 tree for R2/R3.
#  L2 the lock checker's tests and the lock check on the patched worktree.
#  L3 the full factory image of ctx08 with the HOSTED builder (Podman 4.9.3; builder image built here from the pinned Containerfile).
#  L4 the full factory image of ctx08 with the host's Podman 5.8.7 (its own tag and stage images removed by id after).
#  L5 R2 repro: bin/r2-notif-repeat.sh on the a27d301c4 tree against an own pg (200 runs or 600 s). A record, never a gate.
#  L6 R3 repro: bin/r3-github-repeat.sh on the a27d301c4 tree, --repeat-each 20. A record, never a gate.
#  L7 commit 08 (bin/locked-commit-fix.sh: in-lock typecheck, the hook) ONLY if L2, L3 and L4 are green; else the patch is reverted.
#  L8 the builder image removed by id; the manifest of every record made last. Exit: 0 when L2-L4 and L7 are green, else 1; 75 re-queue.
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; BASE=3698c8e84
P=$E/fix-ci-01.patch; BUN=/tmp/factory-tools/bun-1.4.2/bun-linux-x64/bun; stamp=$(date -u +%Y%m%dT%H%M%SZ)
D=$E/s11a-$stamp; mkdir -p "$D"; S=$D/legs.log
say() { echo "[$(date -u +%FT%TZ)] $*" >> "$S"; }
# leg <name> <cmd...>: output to $D/<name>.log, one START and one END line with the exit in legs.log; returns the exit.
leg() { local n=$1 rc; shift; say "START $n"; "$@" > "$D/$n.log" 2>&1; rc=$?; say "END $n exit=$rc"; return $rc; }
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE DATABASE_URL FACTORY_TEST_POSTGRES_URL
. evidence/w00/lock-veto.sh; lock_veto integrator-2
. evidence/w00/resource-gate.sh; RESOURCE_GATE_MAX_WAIT_S=0
resource_gate w4h35-s11a "$S" || { say "release: gate red"; exit 75; }
cd "$W" || exit 1
[ "$(git branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] && [ "$(git rev-parse --short HEAD)" = "$BASE" ] && [ -z "$(git status --porcelain)" ] \
  || { say "STOP: the worktree is not a clean $BASE on its branch"; exit 1; }
# L1
mkdir "$D/ctx08" && git archive "$BASE" | tar -x -C "$D/ctx08" && (cd "$D/ctx08" && git apply "$P") && git apply "$P" \
  || { say "STOP: fix-ci-01.patch does not apply"; git checkout -q -- . ; exit 1; }
bash "$E/bin/scratch-tree.sh" a27d301c4 "$D/tree-a27" "$W" >> "$S" 2>&1 || say "a27d301c4 tree not made: L5 and L6 will not run"
say "L1 trees made: worktree patched ($(git diff --stat | tail -1)); ctx08; tree-a27"
# L2
leg L2-checker-tests "$BUN" test ./scripts/check-factory-deployment-locks.test.ts; l2=$?
leg L2-lock-check "$BUN" scripts/check-factory-deployment-locks.ts || l2=1
# L3
mkdir "$D/hb-ctx" && cp "$E/hosted-builder/Containerfile" "$D/hb-ctx/"
HB=localhost/w4h35-hosted-builder:podman-4.9.3
leg L3-builder-image podman build --pull=never -t "$HB" "$D/hb-ctx"; l3=$?
hbid=$(podman image inspect --format '{{.Id}}' "$HB" 2>/dev/null); say "builder image $HB id ${hbid:-none}"
[ "$l3" = 0 ] && { HB_IMAGE=$HB HB_REPO=$W leg L3-hosted-builder-image bash "$E/hosted-builder/hosted-builder-leg.sh" "$BASE" "$D/ctx08"; l3=$?; }
# L4 (own tag; the stage images this build printed and left dangling are removed by id, as w00/image-leg.sh build_own does)
dang() { podman images -q --no-trunc -f dangling=true | sort -u; }
before=$(dang); T4=localhost/w4h35-s11a-host:$stamp
leg L4-host-image podman build --pull=never -f "$D/ctx08/deploy/factory/Dockerfile" --build-arg REVISION="$BASE+fix-ci-01" -t "$T4" "$D/ctx08"; l4=$?
mine=$(sed -nE 's/^--> ([0-9a-f]{12})[[:space:]]*$/\1/p' "$D/L4-host-image.log" | sort -u)
{ id=$(podman image inspect --format '{{.Id}}' "$T4" 2>/dev/null) && echo "podman rmi $T4 ($id)" && podman rmi "$T4"
  for id in $(comm -13 <(printf '%s\n' "$before") <(dang)); do h=${id#sha256:}
    if grep -qxF -- "${h:0:12}" <<< "$mine"; then echo "podman rmi $id (this build's stage)"; podman rmi "$id"; else echo "new dangling $id: not this build: kept"; fi; done; } >> "$D/L4-removals.log" 2>&1
# L5
if [ -d "$D/tree-a27" ]; then
  . evidence/w00/own-pg.sh
  if own_pg_start w4h35-s11a-pg > "$D/own-pg.log" 2>&1; then
    leg L5-r2-repro bash -c '. "$PG_ENV_FILE"; port=$(podman port "$PG_CONTAINER" 5432 | head -1 | sed "s/.*://")
      export FACTORY_TEST_POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}"; unset POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB port
      exec bash "$1/bin/r2-notif-repeat.sh" "$2/tree-a27" "$2/r2" 200 600' _ "$E" "$D"
    own_pg_stop
  else say "L5 not run: own pg failed (own-pg.log)"; fi
  leg L6-r3-repro bash "$E/bin/r3-github-repeat.sh" "$D/tree-a27" "$D/r3" 20
fi
say "R2: $(tail -1 "$D/r2/runs.txt" 2>/dev/null)"; say "R3: $(tail -1 "$D/r3/playwright.log" 2>/dev/null)"
# L7
rc=1
if [ "$l2" = 0 ] && [ "$l3" = 0 ] && [ "$l4" = 0 ]; then
  leg L7-commit-08 bash "$E/bin/locked-commit-fix.sh" "$E/merge-prep/msg-fix-ci-01.txt" "$BASE" deploy/factory/Dockerfile docs/factory-deployment.md scripts/check-factory-deployment-locks.ts scripts/check-factory-deployment-locks.test.ts; rc=$?
  say "head after L7: $(git log -1 --format='%h %s')"
  # A refused or abandoned commit leaves the head at BASE with the patch staged: unstage and revert it, so the worktree is clean again.
  if [ "$rc" != 0 ] && [ "$(git rev-parse --short HEAD)" = "$BASE" ]; then git reset -q && git apply -R "$P" && say "commit 08 not made: patch reverted, porcelain $(git status --porcelain | wc -l)"; fi
else say "L7 NOT RUN: L2=$l2 L3=$l3 L4=$l4; the patch is reverted"; git apply -R "$P" && say "worktree clean again: $(git status --porcelain | wc -l) changed"; fi
[ "$rc" = 75 ] && { say "release: commit leg asked to re-queue (worktree reverted above)"; exit 75; }
# L8
[ -n "${hbid:-}" ] && { echo "podman rmi $hbid ($HB)"; podman rmi "$hbid"; } >> "$D/L8-removals.log" 2>&1
say "final: L2=$l2 L3=$l3 L4=$l4 L7=$rc; worktree $(git log -1 --format=%h) porcelain $(git status --porcelain | wc -l)"
(cd "$D" && find . -path ./ctx08 -prune -o -path ./tree-a27 -prune -o -path ./hb-ctx -prune -o -path ./r3/test-results -prune -o -type f ! -name s11a-shas.txt -print0 | sort -z | xargs -0 sha256sum) > "$D/s11a-shas.txt"
[ "$rc" = 0 ]; exit $?
