#!/usr/bin/env bash
# Coverage producers print their test totals to their OWN stdout, in a shape the
# shared zero-test counter reads. A producer whose log shows no count is red:
# a leg that ran zero tests must never read as a pass, and a count that sits
# only in a side file (node's reporter destination) or is swallowed (security
# shards captured and printed only on failure) cannot be read from the log.
# Source this file; the functions only print, they never change an exit code.

# print_node_totals <spec-reporter-file>: node --test's own "ℹ tests N",
# "ℹ pass N", "ℹ fail N" and "ℹ cancelled N" lines, copied to stdout. A timed-out
# test counts as cancelled, not failed, so without that line a hang reads "fail 0".
print_node_totals() {
  local report=$1
  if [ ! -s "$report" ]; then
    echo "test totals: node reporter file $report is missing or empty" >&2
    return 0
  fi
  grep -aE '^ℹ (tests|pass|fail|cancelled) [0-9]+$' "$report" || echo "test totals: no node totals in $report" >&2
}

# print_bun_totals <label> <bun-output-file>...: one line "  N pass | M fail | <label>",
# summed over every bun test output file given.
print_bun_totals() {
  local label=$1 pass=0 fail=0 n file
  shift
  for file in "$@"; do
    [ -f "$file" ] || continue
    while read -r n; do pass=$((pass + n)); done < <(grep -aoE '^ *[0-9]+ pass$' "$file" | grep -aoE '[0-9]+')
    while read -r n; do fail=$((fail + n)); done < <(grep -aoE '^ *[0-9]+ fail$' "$file" | grep -aoE '[0-9]+')
  done
  echo "  $pass pass | $fail fail | $label"
}
