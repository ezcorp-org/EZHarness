# c9-map.sh (sourced; D4a, team-lead 2026-10-20): c9_mapped <base> <out>: in the current repository, the C9 suite list for
# <base>..HEAD, one "./<path>" per line, sorted and unique: the hook's name mapping (staged_test_targets) of the changed files, plus
# every suite that directly imports a changed source (import-map.py; the hook maps by name only, so session 6 never ran
# tests/postgres/factory-metrics-scrape.test.ts). The PostgreSQL provisioning suite is left out: the pg-cov leg runs it.
c9_mapped() {
  local base=$1 out=$2
  { bash -c 'source scripts/lib/hook-lib.sh >/dev/null 2>&1; staged_test_targets $(git diff --name-only "$0" HEAD)' "$base"
    python3 -I evidence/w4h-35/bin/import-map.py "$PWD" "$base"; } \
    | sort -u | grep -v '^tests/postgres/factory-provisioning.test.ts$' | sed 's#^#./#' > "$out"
}
