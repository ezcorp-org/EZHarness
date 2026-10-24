#!/usr/bin/env bash
# detached-merge/commit.sh <config> (lock-free; lead's detached-HEAD form, first used for W18c): stage the --no-ff merge on a
# DETACHED HEAD at BASE, prove the staged tree and the hook mapping, run the fast checks on the staged merge, then commit.
# integ/w00 does not move. The config (sourced) sets: D BRANCH HEADSHA BASE TREE LIST MSG SKIP GATE_APPROVED FOCUSED.
#   LIST: the ruled/expected hook list file (the mapping at commit time must equal it byte for byte)
#   SKIP=1 only with a list-bound ruling; GATE_APPROVED=1 only with the user's one-commit decision file.
set -u
. "${1:?config}"
REPO=/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration
. evidence/w00/bun-pin.sh; bun_pin "$REPO"
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GATE_CHANGE_APPROVED DATABASE_URL FACTORY_TEST_POSTGRES_URL   # no database from the caller (W4H-34)
cd "$REPO" || exit 2
INSTALLED=0
. evidence/w00/installs-lib.sh
reinstall() { # frozen installs plus package builds for the tree now checked out, under that tree's pin (w00/installs-lib.sh)
  bun_pin "$REPO"; frozen_installs "$REPO" $D/installs.log; }
back() { git merge --abort 2>/dev/null; git checkout integ/w00 >/dev/null 2>&1; [ "$INSTALLED" = 1 ] && { reinstall && echo "restored installs for integ/w00 after abort" >> $D/installs.txt || echo "WARNING: reinstall for integ/w00 after abort failed (installs.log)" >> $D/installs.txt; }; }
fail() { echo "REFUSED: $*"; exit 1; }
# hook_red_files and hook_zero_files live in detached-merge/pg-hook-lib.sh (sourced below), ONE definition for commit.sh and every locked
# commit script (w4h-35's request after validator-8's S1 on merge13, 2026-10-18).
# PG-HOOK-STEP (team-lead's ruling 2026-10-17 after W4H-34): PG_HOOK is derived from the hook list (detached-merge/pg-hook-lib.sh, shared with
# reprep.sh). A list that maps a tests/postgres suite with PG_HOOK not 1 is refused here, before any git step.
. "${PG_HOOK_LIB:-evidence/w00/detached-merge/pg-hook-lib.sh}" || fail "pg-hook-lib.sh not readable"
declare -F pg_hook_dburl_line hook_red_files hook_zero_files > /dev/null || fail "pg-hook-lib.sh lacks pg_hook_dburl_line, hook_red_files or hook_zero_files (install it with this commit.sh)"
pg_hook_guard "$LIST" "${PG_HOOK:-0}"; case $? in 0) ;; 1) fail "PG_HOOK=${PG_HOOK:-unset} but the hook list $LIST maps a tests/postgres suite (PG_HOOK is derived from the list)" ;; *) fail "the hook list ${LIST:-unset} is missing or empty" ;; esac
# IDENTITY, the FIRST checks (the coordinator's rule after W4H-27 F1, 2026-10-13; team-lead's ruling R1, 2026-10-17): the merge commit's own
# identity is the <USER> noreply address; then ONE shared step (detached-merge/merge-identity-lib.sh, also used by reprep.sh): in package mode
# the branch's own commits from the fork point (git merge-base BASE HEADSHA), and in both modes the merge's STAGED files from TREE.
# IDENTITY_MODE comes from config.sh (package|sync; unset = package); the old BRANCH=wp/* heuristic and the BASE..HEADSHA content read are gone.
[ "$(git config --get user.email)" = <GIT-IDENTITY> ] || fail "the integ worktree's user.email is not the <USER> noreply address"
# IDENTITY-STEP-BEGIN
. "${MERGE_IDENTITY_LIB:-evidence/w00/detached-merge/merge-identity-lib.sh}"
merge_identity "$D" commit- "$BASE" "$HEADSHA" "$TREE" "${IDENTITY_MODE:-package}" "$REPO" > "$D/identity-check.txt" 2>&1 || fail "identity (identity-check.txt, commit-identity-*.txt)"
# IDENTITY-STEP-END
# W03g lesson: when the hook RUNS its tests (SKIP=0), an approval in the commit environment leaks into the gate tests and turns
# their expected failures into passes. The approval belongs in merge-commit-gates.sh (decision file), never in this commit.
[ "$GATE_APPROVED" = 1 ] && [ "$SKIP" != 1 ] && fail "GATE_APPROVED=1 with the hook running tests: the approval would leak into gate tests"
python3 evidence/w00/config-check.py --accept-note "$D/config-note.txt" > "$D/config-check.txt" 2>&1 || fail "shared config check STOP (config-check.txt): report to the lead"
[ "$(git config --get core.bare)" = false ] || fail "core.bare is not false"
[ "$(git branch --show-current)" = integ/w00 ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse $BASE)" ] && [ -z "$(git status --porcelain)" ] || fail "worktree is not integ/w00 at $BASE, clean"
[ "$(git rev-parse $BRANCH)" = "$(git rev-parse $HEADSHA)" ] || fail "$BRANCH moved off $HEADSHA"
git checkout --detach "$BASE" > $D/detach.log 2>&1 || fail "detach"
# rerere OFF on the command line (team-lead ruling 2026-10-16 after W4H-32: the shared rr-cache replayed an old resolution silently;
# never a config edit): a conflict here must stay a conflict.
if ! git -c rerere.enabled=false merge --no-ff --no-commit "$HEADSHA" > $D/stage.log 2>&1; then
  # Standing docs rule (lead 2026-10-03): conflicts confined to tasks/*.md are resolved by union with w00/doc-union.sh, the same
  # function the trial used for its tree; any other conflict aborts.
  mapfile -t CONF < <(git diff --name-only --diff-filter=U)
  [ "${#CONF[@]}" -gt 0 ] && ! printf '%s\n' "${CONF[@]}" | grep -qvE '^tasks/.*\.md$' || { back; fail "merge did not stage cleanly (stage.log)"; }
  bash evidence/w00/doc-union.sh worktree "${CONF[@]}" >> $D/stage.log 2>&1 || { back; fail "doc union failed (stage.log)"; }
  printf '%s\n' "${CONF[@]}" > $D/doc-union-paths.txt; echo "docs union: ${CONF[*]}" >> $D/stage.log
fi
[ "$(git write-tree)" = "$(git rev-parse $TREE^{tree})" ] || { back; fail "staged tree differs from the trial tree"; }
# Re-pin from the STAGED tree (W12e sets .bun-version to 1.4.2): the fast checks re-pin themselves, but the hook inherits this PATH.
bun_pin "$REPO"; echo "pinned bun $(bun --version) / bunx $(bunx --version) from the staged tree; BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=${BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING-unset}" > $D/staged-pin.txt
git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMR > $D/staged-files.txt
# A merge that changes bun.lock or a package.json (W12e) runs the fast checks, the hook and the hold on a FRESH frozen install of
# the staged lockfile, under the staged pin; an abort reinstalls for the tree it returns to (back()).
# A changed dependency patch (patches/*.patch, bun's patchedDependencies) needs the same fresh install, or the hook and the hold
# test the previously patched package (W4H-23, integrator-5 2026-10-12).
if grep -qE '(^|/)bun\.lock$|(^|/)package\.json$|(^|/)patches/[^/]+\.patch$' $D/staged-files.txt; then
  reinstall || { back; fail "frozen install of the staged lockfile failed (installs.log)"; }
  INSTALLED=1; echo "installed the staged lockfile under bun $(bun --version) (root, web, gate-integrity-deps)" >> $D/installs.txt
fi
bash -c 'mapfile -t CH < "$1"; . scripts/lib/hook-lib.sh; staged_test_targets "${CH[@]}" | { grep -v "^$ORCHESTRATOR_PACKAGE/" || true; }' _ $D/staged-files.txt > $D/hook-mapped-staged.txt
# The hook also prints the orchestrator package as one line when its files are staged (W12e 4d0c708c5): compare as a set incl. that line.
PKGLINE="packages/@ezcorp/factory-orchestrator (node: bun run test)"
grep -q '^packages/@ezcorp/factory-orchestrator/' $D/staged-files.txt && echo "$PKGLINE" >> $D/hook-mapped-staged.txt
cmp -s <(sort $D/hook-mapped-staged.txt) <(sort "$LIST") || { back; fail "mapping at commit time differs from $LIST as a set (hook-mapped-staged.txt): ruling void"; }
# Standing rule: rebuild every workspace package the merge changes before typecheck (consumers resolve the built dist types;
# C2 run 1: @ezcorp/sdk/git missing). Only packages with a build script; a failed build is red.
for p in $(grep '^packages/@ezcorp/' $D/staged-files.txt | cut -d/ -f3 | sort -u); do
  python3 -c "import json,sys;sys.exit(0 if json.load(open(sys.argv[1])).get('scripts',{}).get('build') else 1)" packages/@ezcorp/$p/package.json 2>/dev/null || continue
  bun run --cwd packages/@ezcorp/$p build > $D/build-$p.log 2>&1 || { back; fail "build of packages/@ezcorp/$p failed (build-$p.log)"; }
  echo "built packages/@ezcorp/$p" >> $D/builds.txt
done
bash evidence/w00/merge-fast-checks.sh $D/fast "$FOCUSED" --web > $D/fast.log 2>&1; echo $? > $D/fast.exit
[ "$(cat $D/fast.exit)" = 0 ] || { back; fail "fast checks red (fast.log); nothing committed"; }
[ "$(git write-tree)" = "$(git rev-parse $TREE^{tree})" ] || { back; fail "the fast checks changed the index"; }
# PG_HOOK=1: the hook runs real-PostgreSQL suites (and the orchestrator package) inside the commit: the caller holds the heavy
# lock (lock_veto first); the URL is built here in memory from postgres.env, never on argv, never in a file, never printed.
if [ "${PG_HOOK:-0}" = 1 ]; then
  . "${PG_ENV_FILE:-evidence/postgres.env}"   # PG_ENV_FILE / PG_CONTAINER: an OWN fresh server (w00/own-pg.sh); default the shared proof server
  port=$(podman port "${PG_CONTAINER:-factory-platform-proof-postgres}" 5432 | head -1 | sed 's/.*://')
  export FACTORY_TEST_POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}"
  # DATABASE_URL names the same own server (W4H-34 commit red 2026-10-17: tests/postgres/factory-gateway-process.test.ts and the
  # DATABASE_URL-gated suites read it, as CI's db-postgres.yml sets it); in memory only, unset after the commit.
  # Note (validator-8): every mapped backend test runs in its own process and inherits this env, so with PG_HOOK=1 each backend unit
  # test also sees DATABASE_URL and src/db/connection.ts takes its Postgres mode for it (CI unit jobs never set it). Fail-safe: a red hook
  # commits nothing; the hold's unit legs still run on the default path (heavy-lib unsets DATABASE_URL).
  export DATABASE_URL="$FACTORY_TEST_POSTGRES_URL"
  unset POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB port
  EZCORP_FACTORY_STORAGE_SECRETS_DIR=$(ls -d /run/user/1001/ezcorp-factory-storage.* | head -1); export EZCORP_FACTORY_STORAGE_SECRETS_DIR
  export FACTORY_TEMPORAL_TEST_SERVER=/tmp/factory-tools/temporal-test-server/temporal-test-server_1.38.0_linux_amd64/temporal-test-server
fi
# DB-URL-LINE (team-lead's ruling B for staging item 3): a mixed list under PG_HOOK=1 names the bounded leak in commit.log (one line, after
# the hook's output, on the green and the red path); not with SKIP=1 (the hook runs no test then). The root fix is a hook change (ledger).
dbl=; [ "${PG_HOOK:-0}" = 1 ] && [ "$SKIP" != 1 ] && dbl=$(pg_hook_dburl_line "$LIST")
env $( [ "$SKIP" = 1 ] && echo EZ_SKIP_HOOK_TESTS=1 ) $( [ "$GATE_APPROVED" = 1 ] && echo GATE_CHANGE_APPROVED=1 ) git commit -F "$MSG" > $D/commit.log 2>&1; crc=$?
[ -z "$dbl" ] || echo "$dbl" >> $D/commit.log
[ $crc = 0 ] || { hook_red_files $D/commit.log > $D/hook-red.txt; back; fail "commit failed (commit.log); hook red: $(tr '\n' ' ' < $D/hook-red.txt)(hook-red.txt)"; }
# The skips-only rule: a mapped test that ran 0 tests or only skips is RED by name; the detached merge commit is abandoned (its sha kept in
# abandoned-merge-sha.txt); integ/w00 never moved, so nothing is published. Not with SKIP=1 (the hook runs no test then).
[ "$SKIP" != 1 ] && hook_zero_files $D/commit.log > $D/hook-zero.txt && [ -s $D/hook-zero.txt ] && { git rev-parse HEAD > $D/abandoned-merge-sha.txt; back; fail "the hook ran a mapped test with 0 tests or only skips: $(tr '\n' ' ' < $D/hook-zero.txt)(hook-zero.txt); the merge commit is abandoned"; }
if [ "$SKIP" = 1 ]; then sed -n '/test files map to this commit/,/EZ_SKIP_HOOK_TESTS=1 set/p' $D/commit.log | sed '1d;$d' | sed 's/^ *//' > $D/hook-printed.txt
  sed -i -E 's#^(packages/@ezcorp/factory-orchestrator \(node: bun run test\)).*#\1#' $D/hook-printed.txt
  cmp -s <(sort $D/hook-printed.txt) <(sort "$LIST") || echo "WARNING: the hook's printed list differs from the ruled list as a set (hook-printed.txt): the ruling is void; do not publish"; fi
unset FACTORY_TEST_POSTGRES_URL DATABASE_URL
git rev-parse HEAD > $D/merge-sha.txt
echo "merge $(cat $D/merge-sha.txt) tree $(git rev-parse HEAD^{tree}) parents $(git log -1 --format=%P) | integ/w00 still $(git rev-parse integ/w00) | detached"
