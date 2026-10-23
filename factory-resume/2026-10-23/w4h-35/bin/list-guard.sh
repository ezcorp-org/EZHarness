# list-guard.sh (sourced): list_nonempty <list file> <log> <label>: true only when the list file exists and holds at least one
# non-blank line; otherwise it names the refusal in the log and returns 3. Every list-driven `bun test $(cat list)` calls it first,
# so a missing or empty list can never become a bare `bun test` at a worktree root (lesson 32; validator-8 condition 3).
list_nonempty() {
  local list=$1 log=$2 label=$3
  if [ -f "$list" ] && grep -q '[^[:space:]]' "$list"; then return 0; fi
  echo "STOP: $label: the test list $list is missing or empty; no test runs" >> "$log"
  return 3
}
