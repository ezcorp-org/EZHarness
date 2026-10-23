#!/usr/bin/env bash
# r2-repro-judge.test.sh: the judge passes the session-5 unit-cov log against the signature it was made from, and fails a log
# with one fail fewer, a fail moved to another file, the leak error replaced, the unhandled error gone, or no test output.
set -u
J=evidence/w4h-35/bin/r2-repro-judge.py
LOG=evidence/w4h-35/static-c9-20261020T153104Z/unit-cov.log
SIG=evidence/w4h-35/merge-prep/r2-expected.json
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
check() { local want=$1 label=$2 log=$3; python3 -I "$J" "$log" "$SIG" > "$T/out" 2>&1; local got=$?; [ "$got" = "$want" ] || { echo "FAIL: $label: want $want got $got"; cat "$T/out"; fail=1; }; }
check 0 "the session-5 log" "$LOG"
awk '/^\(fail\) /&&!d{d=1;next}1' "$LOG" > "$T/one-fewer"; check 1 "one fail fewer" "$T/one-fewer"
sed 's#^tests/postgres/factory-metrics-scrape.test.ts:$#tests/postgres/factory-other.test.ts:#' "$LOG" > "$T/moved"; check 1 "a fail in another file" "$T/moved"
sed 's#TypeError: N is not a function#TypeError: undefined is not an object#' "$LOG" > "$T/other-error"; check 1 "the leak error replaced" "$T/other-error"
grep -v '^# Unhandled error between tests' "$LOG" > "$T/no-unhandled"; check 1 "no unhandled error" "$T/no-unhandled"
: > "$T/empty"; check 1 "no test output" "$T/empty"
[ "$fail" = 0 ] && echo "r2-repro-judge.test.sh: 6 of 6 pass"
exit "$fail"
