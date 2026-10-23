#!/usr/bin/env bash
# fast-c9-launch.sh <head> <base>: ONLY on team-lead's word, by message id: COORD_WORD=<id> (coord-word.sh refuses without it). Lock-free wait until two reads 60 s apart show no gated job, no holder,
# no yield file, MemAvailable >= 15 GiB; then ONE gated session: locked-fast-c9.sh <head> <base>.
. evidence/w00/coord-word.sh || exit 4
coord_word evidence/w4h-35/logs/gated-fast-c9.log w4h35-fast-c9 || exit 4   # FIRST: the team guard, fixed path, no override (lesson 21)
set -u
HEAD_WANT=$1; BASE=$2; E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
L=$E/logs/gated-fast-c9.log
clear() { [[ "$1" == *"lock=free gated=0 holders=0 yield=no" ]] && awk -v m="$(echo "$1" | sed 's/mem=\([0-9.]*\).*/\1/')" 'BEGIN{exit !(m>=15)}'; }
[ "$(git -C "$W" rev-parse --short HEAD)" = "$HEAD_WANT" ] && [ -z "$(git -C "$W" status --short)" ] || { echo "[$(date -u +%FT%TZ)] STOP: head is not a clean $HEAD_WANT" >> "$L"; exit 3; }
while :; do
  a=$(bash evidence/w00/lock-read.sh); sleep 60; b=$(bash evidence/w00/lock-read.sh)
  if clear "$a" && clear "$b"; then echo "[$(date -u +%FT%TZ)] read1 $a | read2 $b: ok" >> "$L"; break; fi
  echo "[$(date -u +%FT%TZ)] read1 $a | read2 $b: wait" >> "$L"; sleep 60
done
cd "$W" && GATED_FLOCK_BUN_REPO=$W GATED_FLOCK_MEM_MARGIN_GIB=3 GATED_FLOCK_YIELD_FILE=evidence/w4h-28/proof/real-run.pending GATED_FLOCK_EXIT_FILE=$E/fast-c9.exit \
  bash evidence/w00/gated-flock.sh w4h35-fast-c9 "$L" timeout 5400 bash "$E/bin/locked-fast-c9.sh" "$HEAD_WANT" "$BASE"
echo "[$(date -u +%FT%TZ)] fast-c9 exit $(cat "$E/fast-c9.exit" 2>/dev/null)" >> "$L"
