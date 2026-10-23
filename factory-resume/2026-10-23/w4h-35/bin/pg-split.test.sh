#!/usr/bin/env bash
# pg-split.test.sh (F2, team-lead 2026-10-20): pg_suite names the suites that need PostgreSQL; pg_split keeps every mapped suite in
# exactly one list; pg_each runs each pg suite in its own bun process with DATABASE_URL at start; unit_each runs each unit suite
# in its own bun process WITHOUT DATABASE_URL (team-lead (c): every mapped backend suite one per process, as the hook does). The red-first case is the session-5
# defect in small: a suite that mocks db/connection (test-pglite) and a pg suite that takes the migrate lock fail together in ONE
# process ("is not a function", src/db/connection.ts:593) and pass in the split form. PGlite only; no PostgreSQL, no lock.
set -u
. evidence/w4h-35/bin/list-guard.sh
. evidence/w4h-35/bin/pg-split.sh
W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
export PATH=/tmp/factory-tools/bun-1.4.2/bun-linux-x64:/tmp/factory-tools/node-24.14.1/bin:$PATH
export BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 FACTORY_TEST_POSTGRES_URL=postgres://u:p@127.0.0.1:9/never; unset DATABASE_URL
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0; n=0
ok() { n=$((n + 1)); [ "$1" = "$2" ] || { echo "FAIL: $3: want $2 got $1"; fail=1; }; }
# 1. pg_suite, by path and by content.
mkdir -p "$T/c/tests/postgres" "$T/c/src"; cd "$T/c" || exit 1
echo 'test("x", () => {});' > tests/postgres/by-path.test.ts
echo 'const url = process.env.FACTORY_TEST_POSTGRES_URL;' > src/env-url.test.ts
echo 'if (!process.env.DATABASE_URL) throw new Error("x");' > src/database-url.test.ts
echo 'import { setupFactoryPostgres } from "../tests/postgres/helpers/factory-test-database";' > src/helper.test.ts
echo 'const env = { FACTORY_TEST_POSTGRES_URL: "postgres://u:p@h/db" }; // a literal, not the process env' > src/literal.test.ts
echo 'test("plain", () => {});' > src/plain.test.ts
for f in tests/postgres/by-path.test.ts src/env-url.test.ts src/database-url.test.ts src/helper.test.ts; do pg_suite "./$f"; ok $? 0 "pg_suite $f"; done
for f in src/literal.test.ts src/plain.test.ts; do pg_suite "./$f"; ok $? 1 "pg_suite $f"; done
# 2. pg_split: every suite in exactly one list; a missing or empty list refused by name.
printf './%s\n' tests/postgres/by-path.test.ts src/env-url.test.ts src/literal.test.ts src/plain.test.ts > mapped.txt
pg_split mapped.txt unit.txt pg.txt "$T/log"; ok $? 0 "pg_split"
ok "$(tr '\n' ' ' < pg.txt)" "./tests/postgres/by-path.test.ts ./src/env-url.test.ts " "pg list"
ok "$(tr '\n' ' ' < unit.txt)" "./src/literal.test.ts ./src/plain.test.ts " "unit list"
: > empty.txt; pg_split empty.txt u2.txt p2.txt "$T/log"; ok $? 3 "pg_split of an empty list"
pg_split missing.txt u3.txt p3.txt "$T/log"; ok $? 3 "pg_split of a missing list"
# 3. The session-5 defect in small, and the split form.
mkdir -p "$T/leak"
cat > "$T/leak/a-mock.test.ts" << EOF
import { test } from "bun:test";
import { closeTestDb, mockDbConnection, setupTestDb } from "$W/src/__tests__/helpers/test-pglite";
mockDbConnection();
test("a suite that mocks db/connection", async () => { await setupTestDb(); await closeTestDb(); });
EOF
cat > "$T/leak/b-pg.test.ts" << EOF
import { expect, test } from "bun:test";
import { __test } from "$W/src/db/connection";
// A pg suite by pg_suite's rule: it reads process.env.FACTORY_TEST_POSTGRES_URL. The client is a Bun.SQL-like tag (no server).
test("the migrate lock uses the db that setState gave", async () => {
  expect(process.env.FACTORY_TEST_POSTGRES_URL).toBeTruthy();
  const client = async (_s: TemplateStringsArray, ..._v: unknown[]) => [{ locked: true, pid: null }];
  __test.setState({ \$client: client } as never, null);
  expect(await __test.withPostgresMigrateLock(async () => 1)).toBe(1);
});
EOF
cd "$W" || exit 1
bun test --timeout <PID> "$T/leak/a-mock.test.ts" "$T/leak/b-pg.test.ts" > "$T/one-process.log" 2>&1; ok $? 1 "one process: the leak fails the pg suite"
grep -q 'is not a function' "$T/one-process.log"; ok $? 0 "one process: the session-5 error text"
printf '%s\n' "$T/leak/a-mock.test.ts" "$T/leak/b-pg.test.ts" > "$T/leak/mapped.txt"
pg_split "$T/leak/mapped.txt" "$T/leak/unit.txt" "$T/leak/pg.txt" "$T/log"; ok $? 0 "split of the leak pair"
ok "$(cat "$T/leak/pg.txt")" "$T/leak/b-pg.test.ts" "the leak pair's pg list"
if list_nonempty "$T/leak/unit.txt" "$T/unit-guard.log" unit; then   # never a bare bun test (lesson 32)
  bun test --timeout <PID> $(cat "$T/leak/unit.txt") > "$T/unit.log" 2>&1; ok $? 0 "split form: the unit list"
else ok 3 0 "split form: the unit list exists"; fi
mkdir -p "$T/out/lcov"; pg_each "$T/leak/pg.txt" "$T/out" pgm "$T/legs.log" --coverage; ok $? 0 "split form: pg_each"
grep -q "^pgm-1 $T/leak/b-pg.test.ts exit 0 " "$T/legs.log"; ok $? 0 "pg_each names the suite and its exit"
[ -s "$T/out/lcov/pgm-1.lcov" ]; ok $? 0 "pg_each keeps the suite's lcov for the merge"
# 4. unit_each: the same leak pair, each suite in its own process, is green; a unit suite never sees DATABASE_URL; an empty list
#    is refused by name (never a bare bun test).
echo 'import { expect, test } from "bun:test"; test("no DATABASE_URL", () => { expect(process.env.DATABASE_URL).toBeUndefined(); });' > "$T/leak/c-env.test.ts"
printf '%s\n' "$T/leak/a-mock.test.ts" "$T/leak/b-pg.test.ts" "$T/leak/c-env.test.ts" > "$T/leak/all.txt"
DATABASE_URL=postgres://u:p@127.0.0.1:9/never unit_each "$T/leak/all.txt" "$T/out" unit "$T/legs.log" --coverage; ok $? 0 "unit_each: the leak pair and the env suite, one process each"
ok "$(grep -c '^unit-[123] .* exit 0 ' "$T/legs.log")" 3 "unit_each names three green suites"
[ -s "$T/out/lcov/unit-3.lcov" ]; ok $? 0 "unit_each keeps each suite's lcov for the merge"
: > "$T/leak/none.txt"; unit_each "$T/leak/none.txt" "$T/out" unitx "$T/legs.log"; ok $? 3 "unit_each of an empty list"
unset FACTORY_TEST_POSTGRES_URL; pg_each "$T/leak/pg.txt" "$T/out" pgx "$T/legs.log"; ok $? 3 "pg_each without the own-pg URL"
[ "$(grep -c '^STOP: ' "$T/log" "$T/legs.log" | awk -F: '{s += $2} END {print s}')" = 4 ] || { echo "FAIL: four named refusals expected"; fail=1; }
[ "$fail" = 0 ] && echo "pg-split.test.sh: $n of $n pass"
exit "$fail"
