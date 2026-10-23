#!/usr/bin/env bash
# commit-hook-checks.test.sh: a hook output with a red file stops the commit (1), one with a zero-test file stops it (2), a green one
# passes (0); the pg rule maps a tests/postgres list. Fixture hook outputs only; no git, no database.
set -u
. evidence/w4h-35/bin/commit-hook-checks.sh || { echo "FAIL: the helper refused to load"; exit 1; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
printf '  bun: ./src/a.test.ts\n 3 pass\n 0 fail\n  bun: ./tests/postgres/b.test.ts\n 1 pass\n 2 fail\n' > "$T/red.log"
printf '  bun: ./src/a.test.ts\n 3 pass\n 0 fail\n  bun: ./src/empty.test.ts\n 0 pass\n 0 fail\n' > "$T/zero.log"
printf '  bun: ./src/a.test.ts\n 3 pass\n 0 fail\n  bun: ./tests/postgres/b.test.ts\n 4 pass\n 0 fail\n' > "$T/green.log"
check() { commit_hook_judge "$T/$1.log" "$T"; local got=$?; [ "$got" = "$2" ] || { echo "FAIL: $1: want $2 got $got"; fail=1; }; }
check red 1; grep -qx './tests/postgres/b.test.ts' "$T/hook-red.txt" || { echo "FAIL: the red file is not named"; fail=1; }
check zero 2; grep -qx './src/empty.test.ts' "$T/hook-zero.txt" || { echo "FAIL: the zero-test file is not named"; fail=1; }
check green 0
# A mapped pg suite that reads DATABASE_URL and skips without it: the hook shows 0 pass, 0 fail for it; the commit stops by name.
printf '  bun: ./src/a.test.ts\n 3 pass\n 0 fail\n  bun: ./tests/postgres/factory-gateway-process.test.ts\n 0 pass\n 5 skip\n 0 fail\n' > "$T/pgskip.log"
check pgskip 2; grep -qx './tests/postgres/factory-gateway-process.test.ts' "$T/hook-zero.txt" || { echo "FAIL: the skipped pg suite is not named"; fail=1; }
printf './src/a.test.ts\n./tests/postgres/b.test.ts\n' > "$T/mapped"; [ "$(commit_hook_pg_mode "$T/mapped")" = export ] || { echo "FAIL: a tests/postgres list must export"; fail=1; }
printf './src/a.test.ts\n' > "$T/unit"; [ "$(commit_hook_pg_mode "$T/unit")" = none ] || { echo "FAIL: a unit-only list must not export"; fail=1; }
: > "$T/none"; [ "$(commit_hook_pg_mode "$T/none")" = empty ] || { echo "FAIL: an empty list is empty, not a refusal"; fail=1; }
[ "$(commit_hook_pg_mode "$T/missing")" = empty ] || { echo "FAIL: a missing list is empty"; fail=1; }
[ "$fail" = 0 ] && echo "commit-hook-checks.test.sh: 10 of 10 pass"
exit "$fail"
