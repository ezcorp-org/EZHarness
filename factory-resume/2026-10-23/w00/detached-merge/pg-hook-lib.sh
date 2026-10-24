# detached-merge/pg-hook-lib.sh (integrator-5, 2026-10-17; team-lead's ruling after the W4H-34 prep error, where PG_HOOK=0 was written for a
# hook list with 6 tests/postgres suites): PG_HOOK is DERIVED from the mapped hook list, never set by hand. ONE rule, used by
# integrator-5/reprep.sh (writes it into config.sh) and detached-merge/commit.sh (refuses a mismatch, fail-closed, before any git step).
PG_HOOK_RE='^(\./)?tests/postgres/'
# pg_hook_needed <list>: 0 = the list maps a tests/postgres suite; 1 = it maps none; 2 = the list is missing or empty.
pg_hook_needed() { [ -s "${1:-}" ] || return 2; grep -qE "$PG_HOOK_RE" "$1"; }
# pg_hook_config <list> <config.sh>: writes PG_HOOK=1 on the config's "SKIP=<0|1> GATE_APPROVED=<0|1> PG_HOOK=<0|1>" line when the list
# needs it (a 1 is never lowered); prints the result. 2 = the list is missing or empty, or the config has no such line (nothing changed).
pg_hook_config() {
  local r; pg_hook_needed "$1"; r=$?
  [ $r = 2 ] && { echo "pg-hook: REFUSED: the hook list $1 is missing or empty"; return 2; }
  grep -qE '^SKIP=[01] GATE_APPROVED=[01] PG_HOOK=[01]$' "$2" || { echo "pg-hook: REFUSED: no PG_HOOK line in $2"; return 2; }
  [ $r = 0 ] && sed -i -E 's#^(SKIP=[01] GATE_APPROVED=[01]) PG_HOOK=0$#\1 PG_HOOK=1#' "$2"
  echo "pg-hook: $(grep -oE 'PG_HOOK=[01]' "$2") (the list maps $(grep -cE "$PG_HOOK_RE" "$1") tests/postgres suite(s))"
}
# pg_hook_guard <list> <PG_HOOK value>: 0 = consistent; 1 = the list maps a tests/postgres suite and the value is not 1; 2 = the list is
# missing or empty. PG_HOOK=1 with no tests/postgres suite stays allowed.
pg_hook_guard() { pg_hook_needed "$1"; case $? in 0) [ "${2:-0}" = 1 ] ;; 1) return 0 ;; *) return 2 ;; esac; }
# pg_hook_dburl_line <list> (team-lead's ruling B for staging item 3, d80a84782191d0bc): with PG_HOOK=1 commit.sh exports DATABASE_URL for
# the whole hook, so on a MIXED list (at least one tests/postgres suite AND at least one other mapped line) the other files also run with it.
# Prints the ruled commit.log line for a mixed list, nothing otherwise (also for a missing or empty list); always returns 0.
pg_hook_dburl_line() {
  [ -s "${1:-}" ] || return 0
  local n m; n=$(grep -cE "$PG_HOOK_RE" "$1"); m=$(grep -vE "$PG_HOOK_RE" "$1" | grep -c .)
  [ "$n" -gt 0 ] && [ "$m" -gt 0 ] && echo "db-url: exported for $n pg files; $m unit files ran with it; the hold's unit legs re-run them without"
  return 0
}
# The commit hook's red and zero checks, moved UNCHANGED from detached-merge/commit.sh 56859824a864872d (w4h-35's request after validator-8's
# S1 on merge13, 2026-10-18), so commit.sh and every locked commit script source one definition:
# hook_red_files <commit.log>: each mapped file whose hook run is red, by name, once (validator-8 after the W4H-34 hook red): a "  bun:" or
# "  node:" header starts a file; a non-zero " N fail" / " N error" line, "# Unhandled error between tests", or a non-zero node "ℹ fail" /
# "ℹ cancelled" line makes it red.
hook_red_files() { awk '/^  (bun|node): /{f=$0; sub(/^  (bun|node): /, "", f); next} f != "" && ((/^ [0-9]+ (fail|error)/ && $1 > 0) || /^# Unhandled error between tests/ || (/^ℹ (fail|cancelled) [0-9]+$/ && $3 > 0)) {if (!(f in s)) {s[f] = 1; print f}}' "$1"; }
# hook_zero_files <commit.log>: each mapped file whose hook run reports 0 tests or only skips (0 pass and 0 fail; team-lead's skips-only rule
# after the W4H-34 hook red: a masking class, a gated suite that silently skips); a file with no counts at all is listed too.
hook_zero_files() { awk 'function flush() { if (f != "" && p == 0 && x == 0) print f } /^  (bun|node): /{flush(); f=$0; sub(/^  (bun|node): /, "", f); p=0; x=0; next} f != "" && /^ [0-9]+ pass$/ {p+=$1} f != "" && /^ [0-9]+ fail$/ {x+=$1} f != "" && /^ℹ pass [0-9]+$/ {p+=$3} f != "" && /^ℹ fail [0-9]+$/ {x+=$3} END {flush()}' "$1"; }
