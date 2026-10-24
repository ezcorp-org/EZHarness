#!/usr/bin/env bash
# c9r-launch.sh: ONLY on team-lead's word, by message id (COORD_WORD). The C9-only resume at 9446008c6 (commits 08-11 landed; the
# resume session's C9 stopped at the R2-reproduction guard because commit 11 removed one expected failure). Checks every script and
# record by hash; a clean 9446008c6 on its branch; two clear lock reads 60 s apart (mem >= 15 GiB), bound 4 h; then ONE gated job:
# bin/locked-c9r.sh (locked-static-c9.sh against 063b3d16e with R2_EXPECTED = merge-prep/r2-expected.v2.json).
. evidence/w00/coord-word.sh || exit 4
coord_word evidence/w4h-35/logs/gated-c9r.log w4h35-c9r || exit 4   # FIRST: the team guard, fixed path, no override
set -u
E=evidence/w4h-35; W0=evidence/w00; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
L=$E/logs/gated-c9r.log
say() { echo "[$(date -u +%FT%TZ)] $*" >> "$L"; }
for f in "$E/bin/locked-c9r.sh=3a021688efe1cade" "$E/merge-prep/r2-expected.v2.reason.txt=13219862410b89c1" "$E/bin/locked-static-c9.sh=25d691e14c257064" "$E/bin/c9-base.sh=85c3f0c4c0ca4081" "$E/bin/c9-map.sh=c92b5bb517781d22" "$E/bin/gate-leg.sh=0037edeb941be7be" "$E/bin/list-guard.sh=dbd3674c573a0b84" "$E/bin/pg-split.sh=92d8565d3e752ba3" "$E/bin/r2-repro-judge.py=7d52748a6837d162" "$E/bin/import-map.py=9d12a8b4c20cfff0" "$E/merge-prep/r2-expected.v2.json=ecdc6176f2cf551c" "$E/merge-prep/r2-session5-mapped.txt=c6630bca785d1c64" "$E/merge-prep/r2-pg-suites.txt=238cc5885a509f75" "$W0/coord-word.sh=34d9989d558e3b61" "$W0/own-pg.sh=915a85ccefdb066a" "$W0/gated-flock.sh=cbdce362d8f71b61" "$W0/lock-veto.sh=36055ae9a28cf0f8" "$W0/resource-gate.sh=6d494b2772241dea" "$W0/tc-gate.sh=dec72f316b128cb4" "$W0/bun-pin.sh=cf1aad7852b8afdc"; do
  h=$(sha256sum "${f%%=*}" | cut -c1-16); [ "$h" = "${f##*=}" ] || { say "STOP: ${f%%=*} is $h, not ${f##*=}"; exit 3; }
done
[ "$(git -C "$W" branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] && [ "$(git -C "$W" rev-parse --short HEAD)" = 9446008c6 ] && [ -z "$(git -C "$W" status --porcelain)" ] || { say "STOP: the w4h-35 worktree is not a clean 9446008c6 on its branch"; exit 3; }
clear() { [[ "$1" == *"lock=free gated=0 holders=0 yield=no" ]] && awk -v m="$(echo "$1" | sed 's/mem=\([0-9.]*\).*/\1/')" 'BEGIN{exit !(m>=15)}'; }
end=$(( $(date +%s) + 14400 ))
while :; do
  [ "$(date +%s)" -lt "$end" ] || { say "STOP: no two clear lock reads within 4 h; no job launched"; echo "never launched: no two clear lock reads within 4 h; last pair: ${a:-none} | ${b:-none}; $(date -u +%FT%TZ)" > "$E/c9r.never-launched.$(date -u +%Y%m%dT%H%M%SZ)"; exit 3; }
  a=$(bash evidence/w00/lock-read.sh); sleep 60; b=$(bash evidence/w00/lock-read.sh)
  if clear "$a" && clear "$b"; then say "read1 $a | read2 $b: ok"; break; fi
  say "read1 $a | read2 $b: wait"; sleep 60
done
cd "$W" && GATED_FLOCK_BUN_REPO=$W GATED_FLOCK_MEM_MARGIN_GIB=3 GATED_FLOCK_YIELD_FILE=evidence/w4h-28/proof/real-run.pending GATED_FLOCK_EXIT_FILE=$E/c9r.exit.$(date -u +%Y%m%dT%H%M%SZ) \
  bash evidence/w00/gated-flock.sh w4h35-c9r "$L" timeout 7200 bash "$E/bin/locked-c9r.sh"
say "c9r done; exit record $(ls -t "$E"/c9r.exit.* 2>/dev/null | head -1) = $(cat "$(ls -t "$E"/c9r.exit.* 2>/dev/null | head -1)" 2>/dev/null)"
