#!/usr/bin/env bash
# ts2578-judge.test.sh (validator-8 condition 3 on the in-lock type steps): the judge passes a typecheck that FAILED with only
# TS2578 (unused @ts-expect-error) at the named file and line, once or once per typecheck leg; it reds a passing run, any other
# error, TS2578 at another line or file, and a log with no error.
set -u
J=evidence/w4h-35/bin/ts2578-judge.py
F=src/factory/observability/metrics-listener.test.ts
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0; n=0
check() { n=$((n + 1)); local want=$1 label=$2 rc=$3; python3 -I "$J" "$T/log" "$rc" "$F" 205 > "$T/out" 2>&1; local got=$?; [ "$got" = "$want" ] || { echo "FAIL: $label: want $want got $got"; cat "$T/out"; fail=1; }; }
hit="$F(205,5): error TS2578: Unused '@ts-expect-error' directive."
printf '%s\n\n✗ Backend (src/) typecheck failed.\n' "$hit" > "$T/log"; check 0 "only TS2578 at the named line" 1
printf '%s\n%s\n✗ Tests/e2e typecheck failed.\n' "$hit" "$hit" > "$T/log"; check 0 "the same TS2578 once per leg" 1
printf '%s\n' "$hit" > "$T/log"; check 1 "the typecheck exit was 0" 0
printf '%s\nsrc/factory/x.ts(3,1): error TS2322: Type string is not assignable.\n' "$hit" > "$T/log"; check 1 "another error beside it" 1
printf "%s(211,5): error TS2578: Unused '@ts-expect-error' directive.\n" "$F" > "$T/log"; check 1 "TS2578 at another line" 1
printf "src/other.test.ts(205,5): error TS2578: Unused '@ts-expect-error' directive.\n" > "$T/log"; check 1 "TS2578 in another file" 1
printf '✗ Backend (src/) typecheck failed.\n' > "$T/log"; check 1 "a failure with no TS2578" 1
[ "$fail" = 0 ] && echo "ts2578-judge.test.sh: $n of $n pass"
exit "$fail"
