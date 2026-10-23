#!/usr/bin/env bash
# launch.sh commit|hold|publish (integrator-5, 2026-10-17): the W4H-35 merge of 3698c8e84 onto integ/w00 802d46288. commit and hold are each ONE
# gated-flock job (margin 3) that yields to the user's real run. The team rules in the launcher itself: (1) COORD_WORD=<the coordinator word's
# id> is the FIRST step of each lock branch (w00/coord-word.sh: refuses without it; the id is the first line of the gate log); (2) the lock
# condition is read by the shared w00/lock-read.sh twice, 60 s apart (lock free, gated 0, holders 0, MemAvailable >= 15 GiB, no yield file),
# both reads in the gate log; not met = refused (exit 5), no job. Run hold only after commit.exit = 0; publish only after heavy.exit = 0.
set -u
. evidence/w00/coord-word.sh || exit 4
E=evidence/w00; D=$E/w4h-merge/w4h-35-w16-k8s-profiles-3698c8e84-on-802d46288; MAIN=802d46288ab9f15310a5d54bd038b14075789286
export GATED_FLOCK_YIELD_FILE=evidence/w4h-28/proof/real-run.pending GATED_FLOCK_MAX_S=36000 GATED_FLOCK_START_MEM_GIB=12 GATED_FLOCK_MEM_MARGIN_GIB=3
export GATED_FLOCK_BUN_REPO=/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration
lock_ok() { # <gate log>: two reads 60 s apart, both recorded; 0 = both meet the condition
  local a b r; a=$(bash $E/lock-read.sh); sleep 60; b=$(bash $E/lock-read.sh)
  echo "lock condition: read1 $a | read2 $b" >> "$1"
  for r in "$a" "$b"; do [[ "$r" == *" lock=free gated=0 holders=0 yield=no" ]] && awk -v m="${r%% *}" 'BEGIN{exit !(substr(m, 5) + 0 >= 15)}' || return 1; done; }
cd /tmp || exit 2
case "${1:-}" in
  commit) coord_word $D/commit-gate.log w4h-35-commit || exit 4
          lock_ok $D/commit-gate.log || { echo "REFUSED: lock condition not met (commit-gate.log)"; exit 5; }
          [ -e $D/commit.exit ] && mv $D/commit.exit $D/old-exits/commit.exit.$(date -u +%Y%m%dT%H%M%SZ)
          GATED_FLOCK_EXIT_FILE=$D/commit.exit nohup bash $E/gated-flock.sh w4h-35-commit $D/commit-gate.log timeout 7200 bash $D/commit-locked.sh > $D/commit.out 2>&1 & ;;
  hold)   coord_word $D/hold-gate.log w4h-35-hold || exit 4
          [ "$(cat $D/commit.exit 2>/dev/null)" = 0 ] || { echo "REFUSED: commit.exit is not 0"; exit 3; }
          lock_ok $D/hold-gate.log || { echo "REFUSED: lock condition not met (hold-gate.log)"; exit 5; }
          [ -e $D/heavy.exit ] && mv $D/heavy.exit $D/old-exits/heavy.exit.$(date -u +%Y%m%dT%H%M%SZ)
          GATED_FLOCK_EXIT_FILE=$D/heavy.exit nohup bash $E/gated-flock.sh w4h-35-hold $D/hold-gate.log timeout 18000 bash $D/hold-own-pg.sh $D > $D/hold.out 2>&1 & ;;
  publish) [ "$(cat $D/heavy.exit 2>/dev/null)" = 0 ] || { echo "REFUSED: heavy.exit is not 0"; exit 3; }
          bash evidence/integrator-5/publish-if-main.sh $D/config.sh $MAIN > $D/publish.out 2>&1; rc=$?
          echo "publish exit $rc $(date -u +%FT%TZ)"; tail -4 $D/publish.out; exit $rc ;;
  *) echo "usage: COORD_WORD=<id> launch.sh commit|hold|publish"; exit 2 ;;
esac
echo "launched $1 $(date -u +%FT%TZ) on word ${COORD_WORD:-none} (yield file: $GATED_FLOCK_YIELD_FILE)"
