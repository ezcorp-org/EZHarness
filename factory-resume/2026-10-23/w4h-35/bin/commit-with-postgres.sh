#!/usr/bin/env bash
# commit-with-postgres.sh <message-file>: commit the staged index of the W4H-35 worktree with the proof PostgreSQL URL
# exported for the pre-commit hook (built here from postgres.env, never in argv). Run only under gated-flock.
set -uo pipefail
W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
export PATH=/tmp/factory-tools/bun-1.4.2/bun-linux-x64:$PATH
. evidence/postgres.env
port=$(podman port factory-platform-proof-postgres 5432 | head -1 | sed 's/.*://')
EZCORP_FACTORY_STORAGE_SECRETS_DIR=${EZCORP_FACTORY_STORAGE_SECRETS_DIR:-$(ls -d /run/user/1001/ezcorp-factory-storage.* | head -1)}
export EZCORP_FACTORY_STORAGE_SECRETS_DIR
export FACTORY_TEST_POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}"
export DATABASE_URL="$FACTORY_TEST_POSTGRES_URL"
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE
cd "$W" || exit 1
[ "$(git branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] || { echo "wrong branch"; exit 1; }
log="${COMMIT_LOG:-evidence/w4h-35/logs/commit-$(date -u +%Y%m%dT%H%M%SZ).log}"
git commit -q -F "$1" > "$log" 2>&1
rc=$?
grep --line-buffered -E "^ *[0-9]+ (pass|fail)$|✗|error:" "$log" | head -8
echo "commit exit $rc (full hook output: $log)"
exit $rc
