#!/usr/bin/env bash
# run11-static-launch.sh: ONLY on team-lead's word, by message id (COORD_WORD). Checks that the tree is bda171d19 plus exactly the
# run-11 rows and fix files, and that its diff is the worded patch e9c6c79d22b69771; waits lock-free for two reads 60 s apart (lock=free, gated 0, holders 0, no yield, MemAvailable >= 15
# GiB); then ONE gated session: locked-run11.sh (rows commit, fix commit, fast stage and C9 at the new head).
. evidence/w00/coord-word.sh || exit 4
coord_word evidence/w4h-35/logs/gated-run11-static.log w4h35-run11-static || exit 4   # FIRST: the team guard, fixed path, no override
set -u
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
L=$E/logs/gated-run11-static.log
WANT="docs/plans/2026-09-12-composable-factory-platform-contracts.md src/factory/pool/process.test.ts src/factory/pool/process.ts src/factory/private-files.test.ts src/factory/private-files.ts src/factory/provisioning/kubernetes-profile.test.ts src/factory/provisioning/kubernetes-profile.ts"
[ "$(git -C "$W" rev-parse --short HEAD)" = bda171d19 ] && [ "$(git -C "$W" status --short | awk '{print $2}' | sort | tr '\n' ' ')" = "$(echo $WANT | tr ' ' '\n' | sort | tr '\n' ' ')" ] || { echo "[$(date -u +%FT%TZ)] STOP: the tree is not bda171d19 plus exactly the run-11 files" >> "$L"; exit 3; }
[ "$(git -C "$W" diff | sha256sum | cut -d' ' -f1)" = e9c6c79d22b69771254b134061804f90313da44494281f66b69f5fac8c005abe ] || { echo "[$(date -u +%FT%TZ)] STOP: the tree's diff is not the worded patch e9c6c79d22b69771" >> "$L"; exit 3; }
clear() { [[ "$1" == *"lock=free gated=0 holders=0 yield=no" ]] && awk -v m="$(echo "$1" | sed 's/mem=\([0-9.]*\).*/\1/')" 'BEGIN{exit !(m>=15)}'; }
while :; do
  a=$(bash evidence/w00/lock-read.sh); sleep 60; b=$(bash evidence/w00/lock-read.sh)
  if clear "$a" && clear "$b"; then echo "[$(date -u +%FT%TZ)] read1 $a | read2 $b: ok" >> "$L"; break; fi
  echo "[$(date -u +%FT%TZ)] read1 $a | read2 $b: wait" >> "$L"; sleep 60
done
cd "$W" && GATED_FLOCK_BUN_REPO=$W GATED_FLOCK_MEM_MARGIN_GIB=3 GATED_FLOCK_YIELD_FILE=evidence/w4h-28/proof/real-run.pending GATED_FLOCK_EXIT_FILE=$E/run11-static.exit.$(date -u +%Y%m%dT%H%M%SZ) \
  bash evidence/w00/gated-flock.sh w4h35-run11-static "$L" timeout 5400 bash "$E/bin/locked-run11.sh"
echo "[$(date -u +%FT%TZ)] run11-static done; exit record $(ls -t "$E"/run11-static.exit.* 2>/dev/null | head -1) = $(cat "$(ls -t "$E"/run11-static.exit.* 2>/dev/null | head -1)" 2>/dev/null)" >> "$L"
