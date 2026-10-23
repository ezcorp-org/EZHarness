#!/usr/bin/env bash
# r2-notif-repeat.sh <tree> <out dir> [<max runs> [<max seconds>]]: CI root 2 (ci 39956956620, C11 N7 at
# tests/postgres/factory-notification-sender.test.ts:334, "Expected 1, Received 2") re-run as CI runs it: the whole file, pinned Bun,
# BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1, on the hold's OWN pg. Run it through heavy-lib's pg() (`leg r2 pg bash r2-notif-repeat.sh ...`):
# pg() exports FACTORY_TEST_POSTGRES_URL to this child only. Stops at <max runs> (default 200) or <max seconds> (default 600).
# One line per run in <out dir>/runs.txt; each red run's full log kept as run-<n>.log. Exit 0 always when it ran (a count, not a gate);
# 2 when it could not run. Summary last line: "r2: <runs> runs, <red> red, N7 red <n7>".
set -uo pipefail
T=${1:?tree} O=${2:?out} MAX=${3:-200} SECS=${4:-600}
[ -n "${FACTORY_TEST_POSTGRES_URL:-}" ] || { echo "r2: no FACTORY_TEST_POSTGRES_URL (run it through pg)"; exit 2; }
BUN=/tmp/factory-tools/bun-1.4.2/bun-linux-x64/bun; F=./tests/postgres/factory-notification-sender.test.ts
[ -f "$T/$F" ] || { echo "r2: no $F in $T"; exit 2; }
mkdir -p "$O"; cd "$T" || exit 2; start=$SECONDS; n=0; red=0; n7=0
while [ "$n" -lt "$MAX" ] && [ $((SECONDS-start)) -lt "$SECS" ]; do n=$((n+1))
  BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 "$BUN" test "$F" > "$O/run.tmp" 2>&1; rc=$?
  counts=$(grep -aE '^ *[0-9]+ (pass|fail)$' "$O/run.tmp" | tr -s ' \n' ' ')
  if [ "$rc" != 0 ]; then red=$((red+1)); mv "$O/run.tmp" "$O/run-$n.log"
    grep -q '^(fail) re-drive after a lost settlement (C11 N7) > a lapsed lease' "$O/run-$n.log" && n7=$((n7+1))
    echo "run $n exit $rc$counts| $(grep -a '^(fail)' "$O/run-$n.log" | sort -u | tr '\n' ';')" >> "$O/runs.txt"
  else echo "run $n exit 0$counts" >> "$O/runs.txt"; fi
done; rm -f "$O/run.tmp"
echo "r2: $n runs in $((SECONDS-start)) s, $red red, N7 red $n7" | tee -a "$O/runs.txt"
