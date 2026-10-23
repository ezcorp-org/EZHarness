#!/usr/bin/env bash
# locked-commit.sh <message-file>: under the heavy lock, typecheck (tc-gate, in-lock floor), then commit the staged
# index with the proof PostgreSQL URL for the hook. Exit 75 on a red gate so gated-flock re-queues.
set -uo pipefail
E=evidence/w4h-35; S=$E/logs/locked-commit.log; W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
. evidence/w00/lock-veto.sh; lock_veto integrator-2
. evidence/w00/resource-gate.sh; RESOURCE_GATE_MAX_WAIT_S=0
resource_gate w4h35-commit "$S" || { echo "release: gate red $(date -u +%FT%TZ)" >> "$S"; exit 75; }
. evidence/w00/tc-gate.sh; export TC_IN_LOCK=1
export PATH=/tmp/factory-tools/bun-1.4.2/bun-linux-x64:$PATH
cd "$W" || exit 1
log=$E/logs/typecheck-$(date -u +%Y%m%dT%H%M%SZ).log
tc_run w4h35-typecheck "$S" bun run typecheck > "$log" 2>&1; rc=$?
echo "typecheck exit $rc ($log) $(date -u +%FT%TZ)" >> "$S"
[ "$rc" = 75 ] && exit 75
[ "$rc" = 0 ] || exit "$rc"
COMMIT_LOG=$E/logs/commit-$(date -u +%Y%m%dT%H%M%SZ).log bash "$E/bin/commit-with-postgres.sh" "$1" >> "$S" 2>&1; rc=$?
echo "commit exit $rc $(date -u +%FT%TZ)" >> "$S"
exit "$rc"
