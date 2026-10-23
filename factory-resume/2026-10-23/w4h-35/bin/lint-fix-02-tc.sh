#!/usr/bin/env bash
# lint-fix-02: backend typecheck of the scratch tree (b701cf0e2 + the void->undefined change) under the tc-gate, lock-free.
S=evidence/w4h-35/merge-prep/lint-fix-02-scratch
L=evidence/w4h-35/merge-prep/lint-fix-02.typecheck.log
. evidence/w00/tc-gate.sh
cd "$S" || exit 2
tc_run lint-fix-02-backend "$L" bash -c 'node_modules/.bin/tsc --noEmit -p tsconfig.typecheck.json >> "$1" 2>&1' _ "$L"
echo "backend rc=$?" >> "$L"
# Leg 2 (as scripts/typecheck.sh): the backend test files, after svelte-kit sync for the web aliases.
(cd "$S/web" && node_modules/.bin/svelte-kit sync > /dev/null 2>&1) || true
tc_run lint-fix-02-tests "$L" bash -c '/tmp/factory-tools/bun-1.4.2/bun-linux-x64/bun scripts/typecheck-tests.ts >> "$1" 2>&1' _ "$L"
echo "tests rc=$?" >> "$L"
