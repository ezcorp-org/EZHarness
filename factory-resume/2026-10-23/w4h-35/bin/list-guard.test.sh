#!/usr/bin/env bash
# list-guard.test.sh: list_nonempty refuses a missing, an empty and a blank-only list by name, and passes a real one.
set -u
. evidence/w4h-35/bin/list-guard.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
check() { local want=$1 list=$2; list_nonempty "$list" "$T/log" t; local got=$?; [ "$got" = "$want" ] || { echo "FAIL: $list: want $want got $got"; fail=1; }; }
check 3 "$T/missing"
: > "$T/empty"; check 3 "$T/empty"
printf '\n  \n' > "$T/blank"; check 3 "$T/blank"
printf './src/a.test.ts\n' > "$T/real"; check 0 "$T/real"
[ "$(grep -c '^STOP: t: the test list' "$T/log")" = 3 ] || { echo "FAIL: three named refusals expected"; fail=1; }
[ "$fail" = 0 ] && echo "list-guard.test.sh: 4 of 4 pass"
exit "$fail"
