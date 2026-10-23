#!/usr/bin/env bash
# s11a-launch.sh: ONLY on team-lead's word, by message id (COORD_WORD). Session 11a (team-lead's amended ruling; plan
# merge-prep/session-08-plan.txt): checks every script, patch, plan and message by hash; that the w4h-35 worktree is a clean 3698c8e84
# on its branch; waits lock-free for two reads 60 s apart (lock=free, gated 0, holders 0, no yield, MemAvailable >= 15 GiB), bound 4 h;
# then ONE gated job: bin/locked-s11a.sh (commit 08 only if the checker and both full image builds are green; R2/R3 repro records).
. evidence/w00/coord-word.sh || exit 4
coord_word evidence/w4h-35/logs/gated-s11a.log w4h35-s11a || exit 4   # FIRST: the team guard, fixed path, no override
set -u
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
L=$E/logs/gated-s11a.log
say() { echo "[$(date -u +%FT%TZ)] $*" >> "$L"; }
for f in "$E/bin/locked-s11a.sh=1c09214e886d91f9" "$E/bin/locked-commit-fix.sh=04f0b619ddccfb79" "$E/bin/commit-hook-checks.sh=8c449bd2dfaf663f" "$E/bin/scratch-tree.sh=38d221856311f3af" "$E/bin/r2-notif-repeat.sh=51704fae17f10d43" "$E/bin/r3-github-repeat.sh=9cfa421f8f3fec54" "$E/fix-ci-01.patch=15021d3d6a9bab34" "$E/merge-prep/msg-fix-ci-01.txt=b6d761e6386d2865" "$E/merge-prep/session-08-plan.txt=20652a664b423105" "$E/hosted-builder/hosted-builder-leg.sh=7176b0452b1ab5a8" "$E/hosted-builder/Containerfile=babe6afbbbc5feb1" "evidence/w00/coord-word.sh=34d9989d558e3b61" "evidence/w00/own-pg.sh=915a85ccefdb066a" "evidence/w00/gated-flock.sh=cbdce362d8f71b61" "evidence/w00/lock-veto.sh=36055ae9a28cf0f8" "evidence/w00/resource-gate.sh=6d494b2772241dea" "evidence/w00/tc-gate.sh=dec72f316b128cb4" "evidence/w00/detached-merge/pg-hook-lib.sh=8b087d44f488aca0"; do
  h=$(sha256sum "${f%%=*}" | cut -c1-16); [ "$h" = "${f##*=}" ] || { say "STOP: ${f%%=*} is $h, not ${f##*=}"; exit 3; }
done
[ "$(git -C "$W" branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] && [ "$(git -C "$W" rev-parse --short HEAD)" = 3698c8e84 ] && [ -z "$(git -C "$W" status --porcelain)" ] || { say "STOP: the w4h-35 worktree is not a clean 3698c8e84 on its branch"; exit 3; }
clear() { [[ "$1" == *"lock=free gated=0 holders=0 yield=no" ]] && awk -v m="$(echo "$1" | sed 's/mem=\([0-9.]*\).*/\1/')" 'BEGIN{exit !(m>=15)}'; }
end=$(( $(date +%s) + 14400 ))
while :; do
  [ "$(date +%s)" -lt "$end" ] || { say "STOP: no two clear lock reads within 4 h; no job launched"; echo "never launched: no two clear lock reads within 4 h; last pair: ${a:-none} | ${b:-none}; $(date -u +%FT%TZ)" > "$E/s11a.never-launched.$(date -u +%Y%m%dT%H%M%SZ)"; exit 3; }
  a=$(bash evidence/w00/lock-read.sh); sleep 60; b=$(bash evidence/w00/lock-read.sh)
  if clear "$a" && clear "$b"; then say "read1 $a | read2 $b: ok"; break; fi
  say "read1 $a | read2 $b: wait"; sleep 60
done
cd "$W" && GATED_FLOCK_BUN_REPO=$W GATED_FLOCK_MEM_MARGIN_GIB=3 GATED_FLOCK_YIELD_FILE=evidence/w4h-28/proof/real-run.pending GATED_FLOCK_EXIT_FILE=$E/s11a.exit.$(date -u +%Y%m%dT%H%M%SZ) \
  bash evidence/w00/gated-flock.sh w4h35-s11a "$L" timeout 9000 bash "$E/bin/locked-s11a.sh"
say "s11a done; exit record $(ls -t "$E"/s11a.exit.* 2>/dev/null | head -1) = $(cat "$(ls -t "$E"/s11a.exit.* 2>/dev/null | head -1)" 2>/dev/null)"
