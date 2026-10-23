#!/usr/bin/env bash
# launch-receipts.sh (integrator-5, 2026-10-23; the W4H-35 receipts after the publish of b701cf0e2; a named copy of W4H-32b's launch-receipts.sh
# 64ed5c183926fedf + the COORD_WORD guard of launch.sh and the margin set inside): the receipts in the lock, one gated launch:
# ONE gated-flock job w4h-35-receipts: merge-receipts.sh (identity, copy, append-only SHA256SUMS, gitleaks, lint, stage) then the commit
# with the normal hook (TC_IN_LOCK=1: the in-lock typecheck form). GATED_FLOCK_MEM_MARGIN_GIB=3 (set here). Refuses if receipts.exit exists.
# COORD_WORD=<the receipts word id> is the FIRST step (w00/coord-word.sh: refuses without it; the id is line 1 of receipts-gate.log).
set -u
. evidence/w00/coord-word.sh || exit 4
E=evidence/w00; D=$E/w4h-merge/w4h-35-w16-k8s-profiles-3698c8e84-on-802d46288
I=/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration
export GATED_FLOCK_YIELD_FILE=evidence/w4h-28/proof/real-run.pending GATED_FLOCK_MAX_S=7200 GATED_FLOCK_START_MEM_GIB=12 GATED_FLOCK_MEM_MARGIN_GIB=3 GATED_FLOCK_BUN_REPO=$I
[ -e $D/receipts.exit ] && { echo "REFUSED: receipts.exit exists (a try already ran)"; exit 3; }
[ "$(git -C $I rev-parse integ/w00)" = b701cf0e28dc39ccd5415964318bf02917cf0c0f ] && [ "$(git -C $I branch --show-current)" = integ/w00 ] && [ -z "$(git -C $I status --porcelain)" ] || { echo "REFUSED: integ worktree not clean on integ/w00 at b701cf0e2"; exit 3; }
cd /tmp || exit 2
coord_word $D/receipts-gate.log w4h-35-receipts || exit 4
GATED_FLOCK_EXIT_FILE=$D/receipts.exit bash $E/gated-flock.sh w4h-35-receipts $D/receipts-gate.log bash -c '
  D=$1 I=$2
  bash evidence/w00/merge-receipts.sh "$D" "$D/receipts-sources.txt" > "$D/merge-receipts.log" 2>&1 || { echo "merge-receipts failed"; exit 1; }
  cd "$I" && TC_IN_LOCK=1 git commit -F "$D/receipts-msg.txt" > "$D/receipts-commit.log" 2>&1; rc=$?; [ $rc = 75 ] && exit 76; exit $rc' _ $D $I > $D/receipts.out 2>&1
echo "gated-flock rc=$? receipts.exit=$(cat $D/receipts.exit 2>/dev/null) $(date -u +%FT%TZ)"
