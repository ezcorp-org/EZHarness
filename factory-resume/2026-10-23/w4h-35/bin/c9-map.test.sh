#!/usr/bin/env bash
# c9-map.test.sh (D4a): on a temp repository with the worktree's hook library, c9_mapped keeps the hook's name mapping and adds every
# suite that only IMPORTS a changed source (the session-6 gap: tests/postgres/factory-metrics-scrape.test.ts); it leaves out a suite
# that imports nothing changed, a web/ (vitest) suite, and the PostgreSQL provisioning suite.
set -u
. evidence/w4h-35/bin/c9-map.sh
W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0; n=0
g() { git -C "$T/r" -c rerere.enabled=false -c user.name=t -c user.email=<EMAIL> "$@" > /dev/null 2>&1; }
has() { n=$((n + 1)); grep -qx "$1" "$T/out" || { echo "FAIL: $2: $1 is not mapped"; fail=1; }; }
lacks() { n=$((n + 1)); ! grep -qx "$1" "$T/out" || { echo "FAIL: $2: $1 is mapped"; fail=1; }; }
mkdir -p "$T/r/scripts/lib" "$T/r/src/obs" "$T/r/tests/postgres" "$T/r/web/src"; cp "$W/scripts/lib/hook-lib.sh" "$T/r/scripts/lib/"
cd "$T/r" || exit 1
echo 'export const a = 1;' > src/obs/registry.ts; echo 'export const b = 1;' > src/obs/other.ts; echo 'export const c = 1;' > src/obs/index.ts
echo 'import { a } from "./registry"; test("own", () => {});' > src/obs/registry.test.ts
echo 'import { a } from "../../src/obs/registry"; test("scrape", () => {});' > tests/postgres/scrape.test.ts
echo 'const m = await import("../src/obs/registry.ts"); test("dyn", () => {});' > tests/dynamic.test.ts
echo 'import { c } from "../src/obs"; test("folder", () => {});' > tests/folder.test.ts
echo 'import { b } from "../src/obs/other"; test("other", () => {});' > tests/other.test.ts
echo 'import { a } from "../../src/obs/registry"; test("web", () => {});' > web/src/registry.test.ts
echo 'import { a } from "../../src/obs/registry"; test("prov", () => {});' > tests/postgres/factory-provisioning.test.ts
git init -q -b main . && g add -A && g commit -m base; base=$(git rev-parse HEAD)
echo 'export const a = 2;' > src/obs/registry.ts; echo 'export const c = 2;' > src/obs/index.ts; g commit -am change
c9_mapped "$base" "$T/out"
has ./src/obs/registry.test.ts "the hook's name mapping"
has ./tests/postgres/scrape.test.ts "a suite that only imports a changed source"
has ./tests/dynamic.test.ts "a dynamic import with the extension"
has ./tests/folder.test.ts "a folder import of a changed index"
lacks ./tests/other.test.ts "a suite that imports nothing changed"
lacks ./web/src/registry.test.ts "a web (vitest) suite"
lacks ./tests/postgres/factory-provisioning.test.ts "the pg-cov leg's suite"
[ "$(sort -u "$T/out" | wc -l)" = "$(wc -l < "$T/out")" ] || { echo "FAIL: a suite is listed twice"; fail=1; }
[ "$fail" = 0 ] && echo "c9-map.test.sh: $n of $n pass"
exit "$fail"
