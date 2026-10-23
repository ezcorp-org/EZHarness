#!/usr/bin/env bash
# locked-rows-fix-c9.sh <parent> <rows-msg> <fix-msg> <base> <fix path>... (gated-flock only; ONE job on team-lead's word): the C12 rows
# (the contracts document only) as their own commit on <parent>, then the fix (locked-commit-fix.sh: typecheck, the hook's full mapped
# run on an own pg15), then the fast stage and the C9 set at the new head (locked-fast-c9.sh against <base>). Resumable: a commit
# already in the branch is not made again. The parameterized form of locked-run11.sh (run 12 on).
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
PARENT=$1 ROWS_MSG=$2 FIX_MSG=$3 BASE=$4; shift 4
S=$E/logs/locked-rows-fix-c9-$(date -u +%Y%m%dT%H%M%SZ).log
ROWS=docs/plans/2026-09-12-composable-factory-platform-contracts.md
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE; cd "$W" || exit 1
[ "$(git branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] || { echo "wrong branch" >> "$S"; exit 1; }
made() { git log --format=%h --fixed-strings --grep="$(head -1 "$1")" "$PARENT..HEAD" | head -1; }
if [ -z "$(made "$ROWS_MSG")" ]; then
  [ "$(git rev-parse --short HEAD)" = "$PARENT" ] || { echo "STOP: head is not $PARENT before the rows" >> "$S"; exit 1; }
  git add -- "$ROWS" && GIT_CONFIG_NOSYSTEM=1 git -c rerere.enabled=false commit -q -F "$ROWS_MSG" > "$S.rows-commit" 2>&1; rc=$?
  echo "rows commit exit $rc head $(git rev-parse --short HEAD) $(date -u +%FT%TZ)" >> "$S"; [ "$rc" = 0 ] || exit "$rc"
fi
rows=$(made "$ROWS_MSG"); echo "rows commit $rows" >> "$S"
bash "$E/bin/locked-commit-fix.sh" "$FIX_MSG" "$rows" "$@"; rc=$?; echo "fix commit exit $rc head $(git rev-parse --short HEAD) $(date -u +%FT%TZ)" >> "$S"
[ "$rc" = 0 ] || exit "$rc"
[ -n "$(made "$FIX_MSG")" ] && [ -z "$(git status --short)" ] || { echo "STOP: the fix commit is not in the branch, or the tree is not clean" >> "$S"; exit 1; }
new=$(git rev-parse --short HEAD); echo "fast stage and C9 at $new $(date -u +%FT%TZ)" >> "$S"
bash "$E/bin/locked-fast-c9.sh" "$new" "$BASE"; rc=$?; echo "fast-c9 exit $rc $(date -u +%FT%TZ)" >> "$S"; exit "$rc"
