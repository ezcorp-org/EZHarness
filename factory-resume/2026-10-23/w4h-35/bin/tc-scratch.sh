#!/usr/bin/env bash
# tc-scratch.sh <scratch tree> <log> <label>: the backend and backend-tests typecheck legs of scripts/typecheck.sh on a scratch tree,
# each under the tc-gate (lock-free). Generalises lint-fix-02-tc.sh (4d019fe185aade56).
S=${1:?scratch} L=${2:?log} N=${3:?label}
. evidence/w00/tc-gate.sh
cd "$S" || exit 2
tc_run "$N-backend" "$L" bash -c 'node_modules/.bin/tsc --noEmit -p tsconfig.typecheck.json >> "$1" 2>&1' _ "$L"; echo "backend rc=$?" >> "$L"
(cd "$S/web" && node_modules/.bin/svelte-kit sync > /dev/null 2>&1) || true
tc_run "$N-tests" "$L" bash -c '/tmp/factory-tools/bun-1.4.2/bun-linux-x64/bun scripts/typecheck-tests.ts >> "$1" 2>&1' _ "$L"; echo "tests rc=$?" >> "$L"
