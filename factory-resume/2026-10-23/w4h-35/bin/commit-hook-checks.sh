# commit-hook-checks.sh (sourced; validator-8 S1): the hook rules of the shared w00/detached-merge/pg-hook-lib.sh for an owner's commit.
# Sources the INSTALLED library (no copy of its functions) and refuses by name, return 1, when it lacks a needed function.
# commit_hook_judge <commit.log> <dir>: 0 = no mapped file red or empty; 1 = a red file (names in <dir>/hook-red.txt); 2 = a file that
# ran 0 tests or only skips (names in <dir>/hook-zero.txt).
. evidence/w00/detached-merge/pg-hook-lib.sh || { echo "REFUSED: pg-hook-lib.sh not readable"; return 1; }
declare -F hook_red_files hook_zero_files pg_hook_needed pg_hook_dburl_line > /dev/null || { echo "REFUSED: pg-hook-lib.sh lacks hook_red_files, hook_zero_files, pg_hook_needed or pg_hook_dburl_line"; return 1; }
# commit_hook_pg_mode <mapped list>: the shared pg_hook_needed rule as one word: "export" (a tests/postgres suite is mapped: the caller
# exports DATABASE_URL to its own server), "none" (no pg suite), "empty" (a missing or empty list, as for a docs-only commit: no export,
# not a refusal).
commit_hook_pg_mode() { pg_hook_needed "$1"; case $? in 0) echo export ;; 1) echo none ;; *) echo empty ;; esac; }
commit_hook_judge() {
  hook_red_files "$1" > "$2/hook-red.txt"; [ -s "$2/hook-red.txt" ] && return 1
  hook_zero_files "$1" > "$2/hook-zero.txt"; [ -s "$2/hook-zero.txt" ] && return 2
  return 0
}
