#!/usr/bin/env bash
# s11r-launch.sh: ONLY on team-lead's word, by message id (COORD_WORD). The RESUME of session 11 from 305a543c0 (commits 08 and 09
# landed in session 11 v4, exit 10 at the R3 leg because the runner could not build the web app in a linked tree). Checks every
# script, patch, message and plan by hash; that the w4h-35 worktree is a clean 305a543c0 on its branch; two clear lock reads 60 s
# apart (mem >= 15 GiB), bound 4 h; then ONE gated job: bin/locked-s11r.sh (exit 10 = R3 not red at a27d301c4, no commit 10 or 11).
. evidence/w00/coord-word.sh || exit 4
coord_word evidence/w4h-35/logs/gated-s11r.log w4h35-s11r || exit 4   # FIRST: the team guard, fixed path, no override
set -u
E=evidence/w4h-35; W0=evidence/w00; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
L=$E/logs/gated-s11r.log
say() { echo "[$(date -u +%FT%TZ)] $*" >> "$L"; }
for f in "$E/bin/locked-s11r.sh=742a04d783a4b3b8" "$E/bin/s11-lib.sh=0afe22b240d785c0" "$E/bin/locked-commit-fix.sh=04f0b619ddccfb79" "$E/bin/commit-hook-checks.sh=8c449bd2dfaf663f" "$E/bin/locked-fast-c9.sh=8708360d0aa385ea" "$E/bin/locked-static-c9.sh=f8c45cc75b60eafd" "$E/bin/c9-base.sh=85c3f0c4c0ca4081" "$E/bin/c9-map.sh=c92b5bb517781d22" "$E/bin/gate-leg.sh=0037edeb941be7be" "$E/bin/list-guard.sh=dbd3674c573a0b84" "$E/bin/pg-split.sh=92d8565d3e752ba3" "$E/bin/r2-repro-judge.py=7d52748a6837d162" "$E/bin/import-map.py=9d12a8b4c20cfff0" "$E/bin/scratch-tree.sh=81344ddbb8232e29" "$E/bin/r2-notif-repeat.sh=51704fae17f10d43" "$E/bin/r3-github-repeat.sh=5fa79188ddd5d507" "$E/merge-prep/session11/10.patch=b2cdd95b3e4b073a" "$E/merge-prep/session11/11.patch=c9862d2cac3ac389" "$E/merge-prep/msg-s11-10.txt=db912d6ed392e6d5" "$E/merge-prep/msg-s11-11.txt=052a3c4704e38748" "$E/merge-prep/session-11-plan.txt=a28b5c748c7e4be8" "$W0/coord-word.sh=34d9989d558e3b61" "$W0/own-pg.sh=915a85ccefdb066a" "$W0/gated-flock.sh=cbdce362d8f71b61" "$W0/lock-veto.sh=36055ae9a28cf0f8" "$W0/resource-gate.sh=6d494b2772241dea" "$W0/tc-gate.sh=dec72f316b128cb4" "$W0/bun-pin.sh=cf1aad7852b8afdc" "$W0/detached-merge/pg-hook-lib.sh=8b087d44f488aca0" "$W0/merge-fast-checks.sh=a703a0a4abd39472" "$W0/fast-judge.py=3594517cc96c8add"; do
  h=$(sha256sum "${f%%=*}" | cut -c1-16); [ "$h" = "${f##*=}" ] || { say "STOP: ${f%%=*} is $h, not ${f##*=}"; exit 3; }
done
[ "$(git -C "$W" branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] && [ "$(git -C "$W" rev-parse --short HEAD)" = 305a543c0 ] && [ -z "$(git -C "$W" status --porcelain)" ] || { say "STOP: the w4h-35 worktree is not a clean 305a543c0 on its branch"; exit 3; }
clear() { [[ "$1" == *"lock=free gated=0 holders=0 yield=no" ]] && awk -v m="$(echo "$1" | sed 's/mem=\([0-9.]*\).*/\1/')" 'BEGIN{exit !(m>=15)}'; }
end=$(( $(date +%s) + 14400 ))
while :; do
  [ "$(date +%s)" -lt "$end" ] || { say "STOP: no two clear lock reads within 4 h; no job launched"; echo "never launched: no two clear lock reads within 4 h; last pair: ${a:-none} | ${b:-none}; $(date -u +%FT%TZ)" > "$E/s11r.never-launched.$(date -u +%Y%m%dT%H%M%SZ)"; exit 3; }
  a=$(bash evidence/w00/lock-read.sh); sleep 60; b=$(bash evidence/w00/lock-read.sh)
  if clear "$a" && clear "$b"; then say "read1 $a | read2 $b: ok"; break; fi
  say "read1 $a | read2 $b: wait"; sleep 60
done
cd "$W" && GATED_FLOCK_BUN_REPO=$W GATED_FLOCK_MEM_MARGIN_GIB=3 GATED_FLOCK_YIELD_FILE=evidence/w4h-28/proof/real-run.pending GATED_FLOCK_EXIT_FILE=$E/s11r.exit.$(date -u +%Y%m%dT%H%M%SZ) \
  bash evidence/w00/gated-flock.sh w4h35-s11r "$L" timeout 9000 bash "$E/bin/locked-s11r.sh"
say "s11r done; exit record $(ls -t "$E"/s11r.exit.* 2>/dev/null | head -1) = $(cat "$(ls -t "$E"/s11r.exit.* 2>/dev/null | head -1)" 2>/dev/null)"
