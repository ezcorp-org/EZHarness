#!/usr/bin/env bash
# merge13-static-launch.sh: ONLY on team-lead's word, by message id (COORD_WORD). Checks every script, patch and message by hash,
# that the w4h-35 worktree is a clean 631e60da2 on its branch (session 9 landed commit 06; session 10 = commit 07 (the coverage key of
# service-roles.ts) with the hook, the five commit mutants, then the fast stage and C9 against the checked merge-base 063b3d16e with
# the R2 reproduction first), and waits lock-free for two reads 60 s apart (lock=free, gated 0,
# holders 0, no yield, MemAvailable >= 15 GiB); then ONE gated session: locked-merge-session.sh (merge commit, rows commit, code
# commit, the two commit mutants, fast stage and C9).
. evidence/w00/coord-word.sh || exit 4
coord_word evidence/w4h-35/logs/gated-merge13-static.log w4h35-merge13-static || exit 4   # FIRST: the team guard, fixed path, no override
set -u
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
L=$E/logs/gated-merge13-static.log
say() { echo "[$(date -u +%FT%TZ)] $*" >> "$L"; }
for f in "$E/bin/locked-merge-session.sh=3eb796c4be3d3ad9" "$E/bin/locked-commit-fix.sh=04f0b619ddccfb79" "$E/bin/locked-fast-c9.sh=8708360d0aa385ea" "$E/bin/locked-static-c9.sh=f8c45cc75b60eafd" "$E/bin/list-guard.sh=dbd3674c573a0b84" "$E/bin/run12-mutants.py=5eb309335576e5f5" "$E/merge-prep/01-merge-resolution.patch=22ca9785030f74e2" "$E/merge-prep/02-rows.patch=5f447e76b4fc8927" "$E/merge-prep/03-code.patch=e71410e15fcd17f4" "$E/merge-prep/msg-merge.txt=dfc459a8f1113ee3" "$E/merge-prep/msg-rows13.txt=2e4bd70c7d9c5068" "$E/merge-prep/msg-code13.txt=551f735746cdbd9d" "$E/merge-prep/session-mutants.json=892eaa95e263adb7" "evidence/w00/coord-word.sh=34d9989d558e3b61" "evidence/w00/merge-fast-checks.sh=a703a0a4abd39472" "evidence/w00/fast-judge.py=3594517cc96c8add" "$E/bin/commit-hook-checks.sh=8c449bd2dfaf663f" "evidence/w00/detached-merge/pg-hook-lib.sh=8b087d44f488aca0" "$E/merge-prep/02c-rows-amendment.patch=a5c2a78573993f18" "$E/merge-prep/msg-rows13b.txt=85d3e95fafa094e8" "$E/bin/c9-base.sh=85c3f0c4c0ca4081" "$E/bin/pg-split.sh=92d8565d3e752ba3" "$E/bin/r2-repro-judge.py=7d52748a6837d162" "$E/merge-prep/r2-expected.json=966779cd27fe66c8" "$E/merge-prep/r2-session5-mapped.txt=c6630bca785d1c64" "$E/merge-prep/r2-pg-suites.txt=238cc5885a509f75" "$E/bin/gate-leg.sh=0037edeb941be7be" "evidence/w00/own-pg.sh=915a85ccefdb066a" "$E/merge-prep/04-code.patch=091bee2cab8db205" "$E/merge-prep/msg-code14.txt=c4c0b6323a4b56da" "$E/bin/c9-map.sh=c92b5bb517781d22" "$E/bin/import-map.py=9d12a8b4c20cfff0" "$E/bin/ts2578-judge.py=5777c2a4b4fbdeb3" "$E/merge-prep/05-code.patch=3616c5ecd81d4562" "$E/merge-prep/msg-code15.txt=916ad912fb93b7b0" "$E/merge-prep/06-code.patch=e25f9b3da28d093f" "$E/merge-prep/msg-code16.txt=9cc98dba97a14546" "$E/merge-prep/07-code.patch=8c35d54c2f39f141" "$E/merge-prep/msg-code17.txt=e2fffd3e4034c94d"; do
  h=$(sha256sum "${f%%=*}" | cut -c1-16); [ "$h" = "${f##*=}" ] || { say "STOP: ${f%%=*} is $h, not ${f##*=}"; exit 3; }
done
[ "$(git -C "$W" branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] && [ "$(git -C "$W" rev-parse --short HEAD)" = 631e60da2 ] && [ -z "$(git -C "$W" status --porcelain)" ] || { say "STOP: the w4h-35 worktree is not a clean 631e60da2 (commit 06 landed) on its branch"; exit 3; }
clear() { [[ "$1" == *"lock=free gated=0 holders=0 yield=no" ]] && awk -v m="$(echo "$1" | sed 's/mem=\([0-9.]*\).*/\1/')" 'BEGIN{exit !(m>=15)}'; }
# Bounded (validator-8 S3): after 4 h with no clear pair, STOP with no job.
end=$(( $(date +%s) + 14400 ))
while :; do
  [ "$(date +%s)" -lt "$end" ] || { say "STOP: no two clear lock reads within 4 h; no job launched"; echo "never launched: no two clear lock reads within 4 h; last pair: ${a:-none} | ${b:-none}; $(date -u +%FT%TZ)" > "$E/merge13-static.never-launched.$(date -u +%Y%m%dT%H%M%SZ)"; exit 3; }
  a=$(bash evidence/w00/lock-read.sh); sleep 60; b=$(bash evidence/w00/lock-read.sh)
  if clear "$a" && clear "$b"; then say "read1 $a | read2 $b: ok"; break; fi
  say "read1 $a | read2 $b: wait"; sleep 60
done
cd "$W" && GATED_FLOCK_BUN_REPO=$W GATED_FLOCK_MEM_MARGIN_GIB=3 GATED_FLOCK_YIELD_FILE=evidence/w4h-28/proof/real-run.pending GATED_FLOCK_EXIT_FILE=$E/merge13-static.exit.$(date -u +%Y%m%dT%H%M%SZ) \
  bash evidence/w00/gated-flock.sh w4h35-merge13-static "$L" timeout 9000 bash "$E/bin/locked-merge-session.sh"
say "merge13-static done; exit record $(ls -t "$E"/merge13-static.exit.* 2>/dev/null | head -1) = $(cat "$(ls -t "$E"/merge13-static.exit.* 2>/dev/null | head -1)" 2>/dev/null)"
