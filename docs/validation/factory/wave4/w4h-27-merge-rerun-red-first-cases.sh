#!/usr/bin/env bash
# rerun-red-first-cases.sh (integrator-5; the coordinator's ruling 2026-10-14): ONE leg re-run under the heavy lock, against the merge
# d4f1c6b0f, with case-check.sh v7 (the lines binding on changed TEST files only; producer scripts excluded from the shell-line binding).
# The worktree must be at the clean DETACHED merge (as the hold left it); nothing else runs.
set -u
E=/tmp/factory-platform-evidence/w00; D=$E/w4h-merge/w4h-27-compose-comes-up; I=/home/dev/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration
M=d4f1c6b0f24f9005af2bd2d73e4790517c7caead
. $E/lock-veto.sh; lock_veto integrator-2
cd $I || exit 2; [ "$(git rev-parse HEAD)" = $M ] && [ -z "$(git branch --show-current)" ] && [ -z "$(git status --porcelain)" ] || { echo "REFUSED: not at the clean detached merge $M"; exit 3; }
. $E/bun-pin.sh; bun_pin "$I"; unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE
echo "--- START red-first-cases-rerun $(date -u +%FT%TZ) case-check.sh $(sha256sum $E/w4h-merge/w4h-24-web-shard-timeout/case-check.sh | cut -c1-16)"
bash $E/w4h-merge/w4h-24-web-shard-timeout/case-check.sh "$M" "$D"; rc=$?
echo "--- END   red-first-cases-rerun $(date -u +%FT%TZ) exit=$rc; worktree $(git rev-parse --short=9 HEAD) dirty=$(git status --porcelain | wc -l)"
exit $rc
