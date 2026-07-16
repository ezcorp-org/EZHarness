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
import { isNoiseLine, templateInteriorProseLines } from "../../scripts/lcov-noise-filter.ts";

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

  test("modifier-prefixed class member declarations (no initializer) are noise", () => {
    expect(isNoiseLine("  private readonly maxEntries: number;")).toBe(true);
    expect(isNoiseLine("  private readonly now: () => number;")).toBe(true);
    expect(isNoiseLine("  public foo?: string;")).toBe(true);
    expect(isNoiseLine("  protected static bar: Map<string, number>;")).toBe(true);
    expect(isNoiseLine("  readonly id: string,")).toBe(true);
  });

  test("an initialized class member (value `=`) is NOT noise", () => {
    expect(isNoiseLine("  private count: number = 0;")).toBe(false);
    expect(isNoiseLine("  readonly map = new Map<string, Entry>();")).toBe(false);
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

  test("SQL DDL fragments inside tagged template", () => {
    expect(isNoiseLine("    CREATE TABLE IF NOT EXISTS extension_secrets (")).toBe(true);
    expect(isNoiseLine("    ALTER TABLE github_projects_links")).toBe(true);
    expect(isNoiseLine("    DROP CONSTRAINT IF EXISTS github_projects_links_project_id_key")).toBe(true);
    expect(isNoiseLine("    ADD COLUMN IF NOT EXISTS default_model TEXT")).toBe(true);
  });

  test("SQL column-definition lines (uppercase type keyword)", () => {
    expect(isNoiseLine("      id TEXT PRIMARY KEY,")).toBe(true);
    expect(isNoiseLine("      extension_id TEXT NOT NULL REFERENCES extensions(name) ON DELETE CASCADE,")).toBe(true);
    expect(isNoiseLine("      poll_interval_sec INTEGER NOT NULL DEFAULT 60,")).toBe(true);
    expect(isNoiseLine("      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),")).toBe(true);
    expect(isNoiseLine("      enabled BOOLEAN NOT NULL DEFAULT TRUE,")).toBe(true);
    expect(isNoiseLine("      status_options JSONB NOT NULL DEFAULT '[]',")).toBe(true);
  });

  test("SQL SELECT-list column alias lines (bare `col AS alias`)", () => {
    expect(isNoiseLine("      mc.message_id AS message_id,")).toBe(true);
    expect(isNoiseLine("      mc.content AS matched_content")).toBe(true);
    expect(isNoiseLine("        c.title AS conversation_title,")).toBe(true);
    expect(isNoiseLine("        NULL::bigint AS rank_v,")).toBe(true);
    expect(isNoiseLine("        NULL::text AS matched_content,")).toBe(true);
  });

  test("lone template-interpolation close (`}` + backtick)", () => {
    expect(isNoiseLine("        }`;")).toBe(true);
    expect(isNoiseLine("      }`,")).toBe(true);
    expect(isNoiseLine("}`")).toBe(true);
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

  test("lowercase two-identifier prose is NOT a column def (case-sensitive type)", () => {
    expect(isNoiseLine("  const text = row.text;")).toBe(false);
    expect(isNoiseLine("  await db.execute(sql`")).toBe(false);
    expect(isNoiseLine("  createTable(schema);")).toBe(false);
  });

  test("lowercase `as`-cast expressions are NOT a SQL alias (case-sensitive AS)", () => {
    // TS's cast operator is lowercase `as` — must never match SQL_SELECT_ALIAS.
    expect(isNoiseLine("  const search = ctx.search as SearchFn;")).toBe(false);
    expect(isNoiseLine("  return value as string;")).toBe(false);
    expect(isNoiseLine("  const row = result as RawRow,")).toBe(false);
    // A `}` + backtick line carrying executable code past the backtick is not
    // a lone interpolation close.
    expect(isNoiseLine("  }`.trim();")).toBe(false);
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

  test("class declaration headers are noise (phantom zero-hit from non-constructing importers)", () => {
    // Bun never credits the class-HEADER line with a positive hit; a shard
    // that imports the module without constructing the class emits a phantom
    // DA:<header>,0 that the merge can never offset. See CLASS_DECL rationale.
    expect(isNoiseLine("export class SearchCache {")).toBe(true);
    expect(isNoiseLine("class Foo {")).toBe(true);
    expect(isNoiseLine("  export class Bar extends Base {")).toBe(true);
    expect(isNoiseLine("export default class {")).toBe(true);
    expect(isNoiseLine("export abstract class Widget implements Drawable {")).toBe(true);
  });

  test("class lines carrying executable code are NOT mistaken for bare headers", () => {
    // A decorator call `(`, a field initializer `=`, or anything past the
    // opening `{` keeps the line out of CLASS_DECL.
    expect(isNoiseLine("const C = class extends Base {")).toBe(false);
    expect(isNoiseLine("export class Foo { count = 0; }")).toBe(false);
    expect(isNoiseLine("registerClass(class Foo {")).toBe(false);
  });

  test("real method bodies + arrows + value calls are NOT mistaken for signatures", () => {
    // A `{` body, a `=>` arrow, or a value `=` keeps the line executable.
    expect(isNoiseLine("  async write(p, c) { await fsWrite(p, c); }")).toBe(false);
    expect(isNoiseLine("  doThing(): void {")).toBe(false);
    expect(isNoiseLine("  handler(): number => 1;")).toBe(false);
    expect(isNoiseLine("  const x = foo(a): number;")).toBe(false);
  });

  test("class declaration headers are noise (header never carries a positive DA)", () => {
    expect(isNoiseLine("export class SearchCache {")).toBe(true);
    expect(isNoiseLine("class Foo {")).toBe(true);
    expect(isNoiseLine(
      "export abstract class Bar extends Baz implements I {",
    )).toBe(true);
    expect(isNoiseLine("export default class Widget {")).toBe(true);
    expect(isNoiseLine("class Container<T extends Base> {")).toBe(true);
  });

  test("a field named with a `class` prefix is NOT a class declaration", () => {
    // `class\s+\w+` requires whitespace after `class`; `classRoom` has none,
    // so CLASS_DECL never fires. (It IS still noise via TS_FIELD_START as a
    // declaration-only field — that's correct and intentional.)
    expect(/^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+\s*(<[^>]*>)?\s*(extends\s|implements\s|\{|$)/.test(
      "  classRoom: string;",
    )).toBe(false);
    // `classify(x)` is a function, not a class declaration.
    expect(/^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+\s*(<[^>]*>)?\s*(extends\s|implements\s|\{|$)/.test(
      "function classify(x) {",
    )).toBe(false);
  });

  test("modifier-prefixed declaration-only fields are noise (type erased, no JS)", () => {
    // The cache.ts lines that triggered the gate regression: a typed field
    // with an access/readonly modifier and NO initializer compiles to nothing
    // (assignment happens in the constructor).
    expect(isNoiseLine("  private readonly maxEntries: number;")).toBe(true);
    expect(isNoiseLine("  private readonly now: () => number;")).toBe(true);
    expect(isNoiseLine("  protected static count: number;")).toBe(true);
    expect(isNoiseLine("  public name?: string,")).toBe(true);
    expect(isNoiseLine("  override foo: Bar;")).toBe(true);
    expect(isNoiseLine("  declare private x: number;")).toBe(true);
  });

  test("modifier-prefixed field WITH an initializer is NOT noise (emits JS)", () => {
    // `map = new Map()` is a real field initializer — keep its DA record.
    expect(isNoiseLine("  private readonly map = new Map<string, Entry>();")).toBe(false);
    expect(isNoiseLine("  static instance = new Foo();")).toBe(false);
    expect(isNoiseLine("  private x = computeDefault();")).toBe(false);
    // An arrow-VALUE field (value `=`) is executable too.
    expect(isNoiseLine("  readonly handler = () => doStuff();")).toBe(false);
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

describe("templateInteriorProseLines — pure-prose inside multi-line templates", () => {
  test("flags free-prose body lines, not the opener/closer/interpolation lines", () => {
    const src = [
      "const prompt =",                          // 1 code
      "  `Review the code changes and return.",  // 2 opener (code→template) — NOT flagged
      "Context:",                                // 3 pure prose — FLAGGED
      "- branch: ${branch}",                     // 4 interpolation — NOT flagged
      "Rules:",                                  // 5 pure prose — FLAGGED
      "- Be concise.",                           // 6 pure prose — FLAGGED
      "`;",                                      // 7 closer (template→code) — NOT flagged
      "doWork();",                               // 8 code
    ];
    const got = templateInteriorProseLines(src);
    expect([...got].sort((a, b) => a - b)).toEqual([3, 5, 6]);
  });

  test("does not flag lines outside any template", () => {
    const src = [
      "function f() {",
      "  const x = 1;",
      "  return x + 2;",
      "}",
    ];
    expect(templateInteriorProseLines(src).size).toBe(0);
  });

  test("a backtick inside a double-quoted string does not open a template", () => {
    const src = [
      'const s = "a backtick ` here";', // the ` is string content, not a template opener
      "const y = 2;",                    // must NOT be flagged as template interior
    ];
    expect(templateInteriorProseLines(src).size).toBe(0);
  });

  test("a backtick inside a line comment does not open a template", () => {
    const src = [
      "// example: `foo`",  // comment — the backticks are inert
      "const z = 3;",        // must NOT be flagged
    ];
    expect(templateInteriorProseLines(src).size).toBe(0);
  });

  test("single-line template on one line flags nothing (never spans a full line as interior)", () => {
    const src = ["const one = `all on one line`;", "next();"];
    expect(templateInteriorProseLines(src).size).toBe(0);
  });

  test("nested ${} interpolation returns to template string content correctly", () => {
    const src = [
      "const p = `head",             // 1 opener
      "prose one",                   // 2 prose — FLAGGED
      "${obj.method({ a: 1 })} mid", // 3 interpolation with nested braces — NOT flagged
      "prose two",                   // 4 prose — FLAGGED (back in template after interp closed)
      "`;",                          // 5 closer
    ];
    expect([...templateInteriorProseLines(src)].sort((a, b) => a - b)).toEqual([2, 4]);
  });

  test("escaped backtick inside a template does not close it", () => {
    const src = [
      "const e = `line",   // 1 opener
      "has a \\` escaped",  // 2 prose with escaped backtick — still template interior, FLAGGED
      "still inside",       // 3 prose — FLAGGED
      "`;",                 // 4 closer
    ];
    expect([...templateInteriorProseLines(src)].sort((a, b) => a - b)).toEqual([2, 3]);
  });
});
