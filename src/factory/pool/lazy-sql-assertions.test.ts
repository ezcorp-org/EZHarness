import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

/**
 * `Bun.sql` returns a lazy `SQLQuery`: nothing executes until something adopts
 * it. Handing one straight to `expect(...)` does not adopt it, and on Bun
 * 1.3.14 the assertion then busy-spins a core instead of blocking.
 *
 * Measured: `await expect(sql.unsafe("SELECT 1/0")).rejects.toThrow()` against
 * real PostgreSQL held state R at 100% CPU with CPU time tracking wall time one
 * for one and produced no output, while
 * `await Promise.resolve(sql.unsafe("SELECT 1/0")).then(ok, err)` rejected in
 * 6 ms. One such assertion burned its 300-second timeout at full CPU while
 * holding the shared heavy lock, and the orphaned process kept the inherited
 * lock descriptor for fifty minutes after its wrapper was killed.
 *
 * PGlite hands back a real promise, so this never reproduces there. This gate
 * is static precisely because the failure mode is a hang: a runtime guard would
 * have to race a clock, and a spinning test is worse than a failing one.
 */
const GUARDED_FILES = [
  "src/__tests__/helpers/factory-pool-suite.ts",
  "src/factory/pool/ledger.integration.test.ts",
  "src/factory/pool/client.test.ts",
  "src/factory/pool/service-routes.test.ts",
  "tests/postgres/factory-pool.test.ts",
] as const;

/** Query builders whose result is lazy and must be adopted before it is asserted. */
const LAZY_METHODS = new Set(["unsafe", "begin"]);

export interface UndrivenAssertion { readonly file: string; readonly line: number; readonly text: string }

/** Finds `expect(<something>.unsafe(...))`, which never runs the statement. */
export function undrivenLazyAssertions(file: string, source: string): UndrivenAssertion[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const found: UndrivenAssertion[] = [];
  const lazyCall = (node: ts.Node): boolean =>
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && LAZY_METHODS.has(node.expression.name.text);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "expect" && node.arguments.length === 1) {
      let argument: ts.Node = node.arguments[0]!;
      while (ts.isAwaitExpression(argument) || ts.isParenthesizedExpression(argument)) argument = argument.expression;
      if (lazyCall(argument)) {
        found.push({ file, line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1, text: node.getText(parsed).slice(0, 120) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

test("no pool assertion is made against an undriven lazy SQL query", async () => {
  const violations: UndrivenAssertion[] = [];
  for (const file of GUARDED_FILES) violations.push(...undrivenLazyAssertions(file, await readFile(file, "utf8")));
  expect(violations).toEqual([]);
});

test("the guard recognizes the pattern that spun, and the adopted form that did not", () => {
  const spinning = 'test("x", async () => { await expect(poolDatabase.unsafe("INSERT")).rejects.toThrow(); });';
  expect(undrivenLazyAssertions("probe.ts", spinning)).toEqual([{ file: "probe.ts", line: 1, text: 'expect(poolDatabase.unsafe("INSERT"))' }]);
  const adopted = 'test("x", async () => { expect(await Promise.resolve(poolDatabase.unsafe("INSERT")).then(() => "accepted", () => "rejected")).toBe("rejected"); });';
  expect(undrivenLazyAssertions("probe.ts", adopted)).toEqual([]);
  const transaction = 'test("x", async () => { await expect(poolDatabase.begin(async () => {})).rejects.toThrow(); });';
  expect(undrivenLazyAssertions("probe.ts", transaction)).toHaveLength(1);
  // An assertion on an already-settled value is untouched.
  expect(undrivenLazyAssertions("probe.ts", 'expect(rows(await database.unsafe("SELECT 1"))).toEqual([]);')).toEqual([]);
  expect(undrivenLazyAssertions("probe.ts", 'expect(await pool.status("a")).toBeUndefined();')).toEqual([]);
});
