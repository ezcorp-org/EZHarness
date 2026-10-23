#!/usr/bin/env bash
# locked-commit-fix.sh <message-file> <parent-head> <path>... (gated-flock only): typecheck (tc-gate, in-lock floor), then
# commit the named paths on <parent-head> with the hook's FULL run (EZ_PRECOMMIT_TEST_MAX = the mapped suite count; own pg15;
# URL from its env file, never argv). Resumable: if the branch already has the message's subject, it exits 0 at once.
set -uo pipefail
E=evidence/w4h-35; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; stamp=$(date -u +%Y%m%dT%H%M%SZ)
MSG=$1 PARENT=$2; shift 2
D=$E/commit-$stamp; mkdir -p "$D"; S=$D/legs.log
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE; cd "$W" || exit 1
if git log --format=%s "$PARENT..HEAD" | grep -qxF "$(head -1 "$MSG")"; then echo "already committed: $(git log -1 --format=%h)" >> "$S"; exit 0; fi
. evidence/w00/lock-veto.sh; lock_veto integrator-2
. evidence/w00/resource-gate.sh; RESOURCE_GATE_MAX_WAIT_S=0
resource_gate w4h35-commit "$S" || { echo "release: gate red $(date -u +%FT%TZ)" >> "$S"; exit 75; }
. evidence/w00/tc-gate.sh; export TC_IN_LOCK=1
. evidence/w00/bun-pin.sh; bun_pin "$W" > /dev/null
[ "$(git branch --show-current)" = wp/w4h-35-w16-k8s-profiles ] || { echo "wrong branch" >> "$S"; exit 1; }
[ "$(git rev-parse --short HEAD)" = "$PARENT" ] || { echo "head is not $PARENT" >> "$S"; exit 1; }
tc_run w4h35-commit-typecheck "$S" bun run typecheck > "$D/typecheck.log" 2>&1; rc=$?; echo "typecheck exit $rc $(date -u +%FT%TZ)" >> "$S"
[ "$rc" = 75 ] && exit 75; [ "$rc" = 0 ] || exit "$rc"
git add -- "$@"
bash -c 'source scripts/lib/hook-lib.sh >/dev/null 2>&1; staged_test_targets $(git diff --cached --name-only)' | sort -u > "$D/mapped.txt"
count=$(wc -l < "$D/mapped.txt"); echo "mapped suites: $count" >> "$S"
# The shared hook rules (validator-8 S1): w00/detached-merge/pg-hook-lib.sh through bin/commit-hook-checks.sh; refused by name without them.
. "$E/bin/commit-hook-checks.sh" >> "$S" 2>&1 || { echo "STOP: the shared hook rules are not available" >> "$S"; exit 1; }
. evidence/w00/own-pg.sh; own_pg_start w4h35-commit-pg > "$D/own-pg.log" 2>&1 || { echo "own pg failed" >> "$S"; exit 1; }
. "$PG_ENV_FILE"; port=$(podman port "$PG_CONTAINER" 5432 | head -1 | sed 's/.*://')
export FACTORY_TEST_POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}"; unset POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB port
# A mapped tests/postgres suite (the shared pg_hook_needed rule): DATABASE_URL names the same own server, as CI's db-postgres.yml sets it,
# with the temporal test server, as w00/detached-merge/commit.sh's PG_HOOK block does; in memory only, unset after the commit.
dbl=
case $(commit_hook_pg_mode "$D/mapped.txt") in
  export) export DATABASE_URL="$FACTORY_TEST_POSTGRES_URL"
          export FACTORY_TEMPORAL_TEST_SERVER=/tmp/factory-tools/temporal-test-server/temporal-test-server_1.38.0_linux_amd64/temporal-test-server
          dbl=$(pg_hook_dburl_line "$D/mapped.txt"); echo "pg suites mapped: DATABASE_URL exported for the hook" >> "$S" ;;
  none)   echo "no pg suite mapped: DATABASE_URL not exported" >> "$S" ;;
  *)      echo "mapped list empty (no suite maps to this commit): DATABASE_URL not exported" >> "$S" ;;
esac
EZCORP_FACTORY_STORAGE_SECRETS_DIR=$(ls -d /run/user/1001/ezcorp-factory-storage.* | head -1); export EZCORP_FACTORY_STORAGE_SECRETS_DIR
EZ_PRECOMMIT_TEST_MAX=$count GIT_CONFIG_NOSYSTEM=1 git -c rerere.enabled=false commit -F "$MSG" > "$D/commit.log" 2>&1; rc=$?
unset DATABASE_URL FACTORY_TEST_POSTGRES_URL FACTORY_TEMPORAL_TEST_SERVER
[ -z "$dbl" ] || echo "$dbl" >> "$D/commit.log"
echo "commit exit $rc head $(git log -1 --format=%h) $(date -u +%FT%TZ)" >> "$S"
# The hook's own verdict per mapped file (shared rules): a red file, or one that ran 0 tests or only skips, stops the session by name.
commit_hook_judge "$D/commit.log" "$D"; j=$?
if [ "$j" = 1 ]; then echo "STOP: hook red: $(tr '\n' ' ' < "$D/hook-red.txt")(hook-red.txt)" >> "$S"; [ "$rc" = 0 ] || exit "$rc"; fi
if [ "$j" != 0 ] && [ "$rc" = 0 ]; then
  # The commit went in although a mapped file was red or empty: it is abandoned (its sha kept), the branch goes back to its parent.
  git rev-parse HEAD > "$D/abandoned-commit-sha.txt"; git reset -q --keep "$PARENT"
  [ "$j" = 2 ] && echo "STOP: the hook ran a mapped test with 0 tests or only skips: $(tr '\n' ' ' < "$D/hook-zero.txt")(hook-zero.txt); commit abandoned, head back to $PARENT" >> "$S"
  exit 1
fi
exit "$rc"
