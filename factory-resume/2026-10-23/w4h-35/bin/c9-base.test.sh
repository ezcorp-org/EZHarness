#!/usr/bin/env bash
# c9-base.test.sh: c9_base_check passes only when `git merge-base HEAD origin/main` is the wanted base (F1, team-lead 2026-10-20),
# and refuses by name otherwise (a moved main, a wrong base, no origin/main), on a temp repository.
set -u
. evidence/w4h-35/bin/c9-base.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
g() { git -C "$T/r" -c rerere.enabled=false -c user.name=t -c user.email=<EMAIL> "$@" > /dev/null 2>&1; }
git init -q -b main "$T/r"; g commit --allow-empty -m base; base=$(git -C "$T/r" rev-parse HEAD)
g checkout -q -b topic; g commit --allow-empty -m topic
check() { local want=$1 label=$2 b=$3; c9_base_check "$T/r" "$b" "$T/log"; local got=$?; [ "$got" = "$want" ] || { echo "FAIL: $label: want $want got $got"; fail=1; }; }
check 3 "no origin/main" "$base"
g update-ref refs/remotes/origin/main "$base"
check 0 "merge-base equals the base" "$base"
check 3 "a wrong base" "$(git -C "$T/r" rev-parse HEAD)"
g checkout -q main; g commit --allow-empty -m moved; g update-ref refs/remotes/origin/main HEAD; g checkout -q topic
check 0 "main moved, merge-base unchanged" "$base"
g merge -q --no-ff -m in main; check 3 "main merged into the branch: the merge-base moved" "$base"
[ "$(grep -c '^STOP: c9 base' "$T/log")" = 3 ] || { echo "FAIL: three named refusals expected"; fail=1; }
[ "$fail" = 0 ] && echo "c9-base.test.sh: 5 of 5 pass"
exit "$fail"
