/**
 * Unit tests for scripts/lcov-noise-filter.ts — the classifier that
 * decides whether a zero-hit DA record points at a non-executable
 * source line (comment, blank, brace-only, TS type continuation, SQL
 * fragment, etc.) so it can be stripped from the merged lcov denominator.
 *
 * Strategy: in-process tests of the pure classifier (`isNoiseLine`).
 * Filter-pipeline behaviour is exercised indirectly via merge-lcov's
 * own tests; the contract here is: every pattern documented in the
 * filter's header must be matched, and every non-noise sample must
 * NOT be matched.
 */
import { test, expect, describe } from "bun:test";
import { isNoiseLine } from "../../scripts/lcov-noise-filter.ts";

describe("isNoiseLine — positive matches (noise)", () => {
  test("blank lines", () => {
    expect(isNoiseLine("")).toBe(true);
    expect(isNoiseLine("   ")).toBe(true);
    expect(isNoiseLine("\t")).toBe(true);
  });

  test("pure-comment lines", () => {
    expect(isNoiseLine("// single-line comment")).toBe(true);
    expect(isNoiseLine("  // indented comment")).toBe(true);
    expect(isNoiseLine("/* opening block comment")).toBe(true);
    expect(isNoiseLine(" * jsdoc continuation")).toBe(true);
    expect(isNoiseLine(" */")).toBe(true);
    expect(isNoiseLine("  **")).toBe(true);
  });

  test("brace/punct-only lines", () => {
    expect(isNoiseLine("}")).toBe(true);
    expect(isNoiseLine("  })")).toBe(true);
    expect(isNoiseLine("};")).toBe(true);
    expect(isNoiseLine("  ],")).toBe(true);
    expect(isNoiseLine("  >")).toBe(true);
    expect(isNoiseLine("  ),")).toBe(true);
  });

  test("TypeScript field continuation lines (no value assignment)", () => {
    expect(isNoiseLine("  foo: string;")).toBe(true);
    expect(isNoiseLine("  bar?: number,")).toBe(true);
    expect(isNoiseLine("  systemPrompt?: string;")).toBe(true);
    expect(isNoiseLine(
      "  messages: Array<{ role: \"system\"; content: string }>;",
    )).toBe(true);
    // Arrow-type field (function-type member, no value assign).
    expect(isNoiseLine(
      "    complete: (...args: unknown[]) => Promise<unknown>;",
    )).toBe(true);
  });

  test("return-type opener lines", () => {
    expect(isNoiseLine("): Promise<{")).toBe(true);
    expect(isNoiseLine("  ): Array<{")).toBe(true);
    expect(isNoiseLine("): Map<")).toBe(true);
  });

  test("standalone generic type continuation", () => {
    expect(isNoiseLine(
      "  Array<{ id: string; persisted: PersistedGoal }>",
    )).toBe(true);
    expect(isNoiseLine("Promise<MyType>")).toBe(true);
  });

  test("string literal as standalone element", () => {
    expect(isNoiseLine('"a literal string element",')).toBe(true);
    expect(isNoiseLine('  "Send another message to resume",')).toBe(true);
    expect(isNoiseLine('"trailing comma optional"')).toBe(true);
  });

  test("backtick template literal on its own line", () => {
    expect(isNoiseLine("`hello world`;")).toBe(true);
    expect(isNoiseLine("  `concat continuation` +")).toBe(true);
    expect(isNoiseLine("  `final segment`,")).toBe(true);
  });

  test("SQL keyword fragments inside tagged template", () => {
    expect(isNoiseLine("    SELECT id, metadata")).toBe(true);
    expect(isNoiseLine("    FROM conversations")).toBe(true);
    expect(isNoiseLine("    WHERE metadata ? 'goal'")).toBe(true);
    expect(isNoiseLine("    COALESCE(SUM(usage_cost), 0) AS total")).toBe(true);
  });
});

describe("isNoiseLine — negative matches (real executable code)", () => {
  test("function call lines", () => {
    expect(isNoiseLine("  throw new Error('bad');")).toBe(false);
    expect(isNoiseLine("  return calculateTax(amount, rate);")).toBe(false);
    expect(isNoiseLine("  await store.save(record);")).toBe(false);
  });

  test("variable assignment lines", () => {
    expect(isNoiseLine("  const x = 42;")).toBe(false);
    expect(isNoiseLine("  let total: number = 0;")).toBe(false);
    expect(isNoiseLine("  this.foo = bar;")).toBe(false);
  });

  test("control-flow lines", () => {
    expect(isNoiseLine("  if (x > 0) {")).toBe(false);
    expect(isNoiseLine("  for (const item of items) {")).toBe(false);
    expect(isNoiseLine("  } else if (y) {")).toBe(false);
  });

  test("method invocation chains", () => {
    expect(isNoiseLine("  .then((r) => r.json())")).toBe(false);
    expect(isNoiseLine("  bus.emit('goal:update', payload);")).toBe(false);
  });

  test("string-with-call (not a bare literal)", () => {
    expect(isNoiseLine('console.log("hello");')).toBe(false);
    expect(isNoiseLine('return "valid"; // trailing comment')).toBe(false);
  });

  test("type-field with value assignment is NOT noise", () => {
    // A `=` outside `=>` means it's an initializer, which IS executable.
    expect(isNoiseLine("  foo: string = 'default';")).toBe(false);
  });

  test("interface declarations + method signatures are noise (erased at compile time)", () => {
    expect(isNoiseLine("export interface ProposalsIO {")).toBe(true);
    expect(isNoiseLine("  interface Foo extends Bar {")).toBe(true);
    expect(isNoiseLine("  read(): Promise<string | null>;")).toBe(true);
    expect(isNoiseLine("  write(text: string): Promise<void>;")).toBe(true);
  });

  test("real method bodies + arrows + value calls are NOT mistaken for signatures", () => {
    // A `{` body, a `=>` arrow, or a value `=` keeps the line executable.
    expect(isNoiseLine("  async write(p, c) { await fsWrite(p, c); }")).toBe(false);
    expect(isNoiseLine("  doThing(): void {")).toBe(false);
    expect(isNoiseLine("  handler(): number => 1;")).toBe(false);
    expect(isNoiseLine("  const x = foo(a): number;")).toBe(false);
  });

  test("bare switch-case labels are noise (the dispatch is on the switch line)", () => {
    expect(isNoiseLine("      default:")).toBe(true);
    expect(isNoiseLine('    case "applied":')).toBe(true);
    expect(isNoiseLine("  case 1:")).toBe(true);
  });

  test("a switch label with an inline body statement stays via SWITCH_LABEL", () => {
    // SWITCH_LABEL only matches a label ALONE on its line (`:` at EOL).
    // An inline `case x: doThing(); break;` carries executable code, so
    // SWITCH_LABEL does NOT strip it.
    expect(/^\s*(case\s+.+|default)\s*:\s*$/.test("  case x: doThing(); break;")).toBe(false);
  });
});
