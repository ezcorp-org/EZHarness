#!/usr/bin/env bash
# publish-if-main.sh <config.sh> <expected origin/main sha> (integrator-5, 2026-10-13; the coordinator's order after the 48d90eb54 sync, where a
# printed but unchecked main head let a publish go ahead after main moved): COMPARE the remote main with the sha recorded at the prep and run
# publish.sh only when they are equal. A moved main (or a failed ls-remote) = rc 1, NOTHING published; report and re-sync.
# Identity step (team-lead 2026-10-15): after the main compare, before the publish, w00/identity-check.sh commits <BASE> <merge> runs with the
# config's environment (a W-SYNC config exports SYNC_BASE_MAIN and IDENTITY_EXCLUDE); its output goes to <D>/identity-publish.txt; any
# finding (or a missing merge sha) = rc 1, NOTHING published.
# Test seam: PUBLISH_IF_MAIN_PUBLISH=<command> replaces publish.sh (hook-free tests only; publish-if-main.test.sh).
set -u
CFG=${1:?config} XM=${2:?expected main}
I=/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration
. evidence/w00/remote-read.sh   # one bounded read for the publish and push steps (a stalled SSH read hung 192 s, 2026-10-16)
R=$(REMOTE_READ_TIMEOUT_S=${PIM_LSREMOTE_TIMEOUT_S:-60} remote_head $I main)
[ "$R" != UNREADABLE ] || { echo "STOP: remote main UNREADABLE (bounded read); not published"; exit 1; }
X=$(git -C $I rev-parse "$XM" 2>/dev/null)
echo "remote main ${R:-none}; expected ${X:-unresolved}"
if [ -z "$R" ] || [ -z "$X" ] || [ "$R" != "$X" ]; then echo "STOP: main moved (or could not be read); not published"; exit 1; fi
( export IDENTITY_REPO=${IDENTITY_REPO:-$I}; . "$CFG" && MS=$(cat "$D/merge-sha.txt") && bash evidence/w00/identity-check.sh commits "$BASE" "$MS" > "$D/identity-publish.txt" 2>&1 ); id=$?
echo "identity step: exit $id ($( . "$CFG"; tail -1 "$D/identity-publish.txt" 2>/dev/null))"
[ "$id" = 0 ] || { echo "STOP: identity step not clean; not published"; exit 1; }
exec ${PUBLISH_IF_MAIN_PUBLISH:-bash evidence/w00/detached-merge/publish.sh} "$CFG"
