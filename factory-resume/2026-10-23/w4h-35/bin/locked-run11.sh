#!/usr/bin/env bash
# locked-run11.sh (gated-flock only; ONE job on team-lead's word): the C12 rows (docs only) as their own commit on bda171d19, then
# the run-11 fix (locked-commit-fix.sh: typecheck, the hook's full mapped run on an own pg15), then the fast stage and the C9 set at
# the new head (locked-fast-c9.sh, base cf1de889b). Resumable: a commit already in the branch is not made again.
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
S=$E/logs/locked-run11-$(date -u +%Y%m%dT%H%M%SZ).log
ROWS=docs/plans/2026-09-12-composable-factory-platform-contracts.md
FIX="src/factory/pool/process.test.ts src/factory/pool/process.ts src/factory/private-files.test.ts src/factory/private-files.ts src/factory/provisioning/kubernetes-profile.test.ts src/factory/provisioning/kubernetes-profile.ts"
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE; cd "$W" || exit 1
[ "$(git branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] || { echo "wrong branch" >> "$S"; exit 1; }
made() { git log --format=%h --fixed-strings --grep="$(head -1 "$1")" bda171d19..HEAD | head -1; }
if [ -z "$(made "$E/msg-run11-rows.txt")" ]; then
  [ "$(git rev-parse --short HEAD)" = bda171d19 ] || { echo "STOP: head is not bda171d19 before the rows" >> "$S"; exit 1; }
  git add -- "$ROWS" && GIT_CONFIG_NOSYSTEM=1 git -c rerere.enabled=false commit -q -F "$E/msg-run11-rows.txt" > "$E/logs/commit-run11-rows.log" 2>&1; rc=$?
  echo "rows commit exit $rc head $(git rev-parse --short HEAD) $(date -u +%FT%TZ)" >> "$S"; [ "$rc" = 0 ] || exit "$rc"
fi
rows=$(made "$E/msg-run11-rows.txt"); echo "rows commit $rows" >> "$S"
bash "$E/bin/locked-commit-fix.sh" "$E/msg-run11-fix.txt" "$rows" $FIX; rc=$?; echo "fix commit exit $rc head $(git rev-parse --short HEAD) $(date -u +%FT%TZ)" >> "$S"
[ "$rc" = 0 ] || exit "$rc"
[ -n "$(made "$E/msg-run11-fix.txt")" ] && [ -z "$(git status --short)" ] || { echo "STOP: the fix commit is not in the branch, or the tree is not clean" >> "$S"; exit 1; }
new=$(git rev-parse --short HEAD); echo "fast stage and C9 at $new $(date -u +%FT%TZ)" >> "$S"
bash "$E/bin/locked-fast-c9.sh" "$new" cf1de889b; rc=$?; echo "fast-c9 exit $rc $(date -u +%FT%TZ)" >> "$S"; exit "$rc"
