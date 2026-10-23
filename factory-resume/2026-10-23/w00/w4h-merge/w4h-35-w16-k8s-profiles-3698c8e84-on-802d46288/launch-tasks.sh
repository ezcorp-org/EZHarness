#!/usr/bin/env bash
# launch-tasks.sh (integrator-5, 2026-10-23; the W4H-35 tasks commit after the receipts d6ba7dedb; a named copy of the OK'd
# launch-receipts.sh f60607d269357028 with the job body replaced): w4h-36's tasks blocks in the lock, one gated launch:
# ONE gated-flock job w4h-35-tasks: the two dry-run after-files copied over tasks/lessons.md and tasks/todo.md (hashes checked), exactly
# those two staged (additions only), then the commit
# with the normal hook (TC_IN_LOCK=1: the in-lock typecheck form). GATED_FLOCK_MEM_MARGIN_GIB=3 (set here). Refuses if tasks.exit exists.
# COORD_WORD=<the tasks word id> is the FIRST step (w00/coord-word.sh: refuses without it; the id is line 1 of tasks-gate.log).
set -u
. evidence/w00/coord-word.sh || exit 4
E=evidence/w00; D=$E/w4h-merge/w4h-35-w16-k8s-profiles-3698c8e84-on-802d46288
I=/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration
export GATED_FLOCK_YIELD_FILE=evidence/w4h-28/proof/real-run.pending GATED_FLOCK_MAX_S=7200 GATED_FLOCK_START_MEM_GIB=12 GATED_FLOCK_MEM_MARGIN_GIB=3 GATED_FLOCK_BUN_REPO=$I
[ -e $D/tasks.exit ] && { echo "REFUSED: tasks.exit exists (a try already ran)"; exit 3; }
[ "$(git -C $I rev-parse integ/w00)" = d6ba7dedb21e69917dd521d060334bb178fa71a0 ] && [ "$(git -C $I branch --show-current)" = integ/w00 ] && [ -z "$(git -C $I status --porcelain)" ] || { echo "REFUSED: integ worktree not clean on integ/w00 at d6ba7dedb"; exit 3; }
cd /tmp || exit 2
coord_word $D/tasks-gate.log w4h-35-tasks || exit 4
GATED_FLOCK_EXIT_FILE=$D/tasks.exit bash $E/gated-flock.sh w4h-35-tasks $D/tasks-gate.log bash -c '
  D=$1 I=$2 X=evidence/w4h-36/receipts-round/dryrun-d6ba7dedb
  cd "$I" || exit 2
  # the two after-files of the w4h-36 dry run at d6ba7dedb, byte for byte, over the tracked files; nothing else is staged
  [ "$(sha256sum $X/lessons.after.md | cut -c1-16)" = eea01c3b5859cced ] && [ "$(sha256sum $X/todo.after.md | cut -c1-16)" = 2f7e86448bf0adbd ] || { echo "after-file hash differs"; exit 1; }
  [ "$(sha256sum tasks/lessons.md | cut -c1-16)" = be241eba36d6bfda ] && [ "$(sha256sum tasks/todo.md | cut -c1-16)" = 1713fe975c3c3aff ] || { echo "tasks/ base differs from d6ba7dedb"; exit 1; }
  cp $X/lessons.after.md tasks/lessons.md && cp $X/todo.after.md tasks/todo.md && git add -f tasks/lessons.md tasks/todo.md || exit 1   # tasks/ is in .gitignore (tracked files; the W4H-32 form)
  [ "$(git diff --cached --name-only | tr "\n" " ")" = "tasks/lessons.md tasks/todo.md " ] && [ "$(git diff --cached --numstat | awk "{d+=\$2} END {print d+0}")" = 0 ] || { echo "staged set is not the two additions-only files"; git diff --cached --name-only; exit 1; }
  TC_IN_LOCK=1 git commit -F "$D/tasks-msg.txt" > "$D/tasks-commit.log" 2>&1; rc=$?; [ $rc = 75 ] && exit 76; exit $rc' _ $D $I > $D/tasks.out 2>&1
echo "gated-flock rc=$? tasks.exit=$(cat $D/tasks.exit 2>/dev/null) $(date -u +%FT%TZ)"
