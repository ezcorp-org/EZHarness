# pg-split.sh (sourced; F2, team-lead 2026-10-20): the C9 unit leg runs its mapped suites in ONE bun process, where a suite that
# mocks db/connection (test-pglite's mockDbConnection) leaks into a later PostgreSQL suite (session 5, R2). A PostgreSQL suite
# therefore runs in its own process with DATABASE_URL at start, as CI runs them (.github/workflows/db-postgres.yml).
#   pg_suite <file>: true when the suite needs PostgreSQL: under tests/postgres/, or it reads process.env.FACTORY_TEST_POSTGRES_URL
#     or process.env.DATABASE_URL, or it uses the factory test database helper (setupFactoryPostgres).
#   pg_split <mapped> <unit out> <pg out> <log>: every mapped suite in exactly one list, in mapped order; 3 = refused by name.
#   pg_each <list> <dir> <label> <log> [--coverage]: each suite in its own process with DATABASE_URL=FACTORY_TEST_POSTGRES_URL;
#     one log per suite (<dir>/<label>-<n>.log), one line per suite in <log>, with --coverage its lcov in <dir>/lcov/<label>-<n>.lcov
#     for the merge; 1 when any suite is red, 3 when FACTORY_TEST_POSTGRES_URL is unset or the list is empty.
#   unit_each <list> <dir> <label> <log> [--coverage]: the same for unit suites, each in its own process WITHOUT DATABASE_URL
#     (team-lead (c): one process per backend suite, as the hook runs them, so no module mock leaks between suites).
pg_suite() {
  case "${1#./}" in tests/postgres/*) return 0 ;; esac
  grep -qE 'process\.env\.(FACTORY_TEST_POSTGRES_URL|DATABASE_URL)\b|setupFactoryPostgres|helpers/factory-test-database' "$1"
}
pg_split() {
  local mapped=$1 unit=$2 pg=$3 log=$4 f
  [ -f "$mapped" ] && grep -q '[^[:space:]]' "$mapped" || { echo "STOP: pg-split: the mapped list $mapped is missing or empty" >> "$log"; return 3; }
  : > "$unit"; : > "$pg"
  while IFS= read -r f; do [ -n "$f" ] || continue; if pg_suite "$f"; then echo "$f" >> "$pg"; else echo "$f" >> "$unit"; fi; done < "$mapped"
  [ "$(sort "$unit" "$pg")" = "$(grep -v '^$' "$mapped" | sort)" ] && [ -z "$(comm -12 <(sort "$unit") <(sort "$pg"))" ] \
    || { echo "STOP: pg-split: the unit and pg lists are not exactly the mapped list" >> "$log"; return 3; }
}
pg_each() {
  [ -n "${FACTORY_TEST_POSTGRES_URL:-}" ] || { echo "STOP: pg-each $3: FACTORY_TEST_POSTGRES_URL is unset; no suite runs" >> "$4"; return 3; }
  suite_each pg "$@"
}
unit_each() { suite_each unit "$@"; }
suite_each() {
  local mode=$1 list=$2 dir=$3 label=$4 log=$5 cov=${6:-} n=0 st=0 f r args
  [ -f "$list" ] && grep -q '[^[:space:]]' "$list" || { echo "STOP: $mode-each $label: the list $list is missing or empty; no suite runs" >> "$log"; return 3; }
  while IFS= read -r f; do
    [ -n "$f" ] || continue; n=$((n + 1)); args=(--timeout <PID>)
    [ "$cov" = --coverage ] && args+=(--coverage --coverage-reporter=lcov "--coverage-dir=$dir/cov-$label-$n")
    if [ "$mode" = pg ]; then DATABASE_URL=$FACTORY_TEST_POSTGRES_URL bun test "${args[@]}" "$f" > "$dir/$label-$n.log" 2>&1
    else env -u DATABASE_URL bun test "${args[@]}" "$f" > "$dir/$label-$n.log" 2>&1; fi; r=$?
    echo "$label-$n $f exit $r $(grep -E '^ *[0-9]+ (pass|fail)$' "$dir/$label-$n.log" | tr '\n' ' ')" >> "$log"
    [ "$cov" = --coverage ] && cp "$dir/cov-$label-$n/lcov.info" "$dir/lcov/$label-$n.lcov" 2> /dev/null
    [ "$r" = 0 ] || st=1
  done < "$list"
  return "$st"
}
