/**
 * Classify a source line as non-executable "noise" for coverage purposes.
 *
 * Bun's coverage instrumentation emits `DA:<line>,<hits>` records by mapping
 * compiled JS bytecode back to original TypeScript source lines via sourcemap.
 * Source-only lines that have no emitted JS — pure comments, blanks, lone
 * braces, TypeScript type annotations, type-literal field declarations,
 * type-only generic continuations, and string literals inside multi-line
 * expressions — receive no instrumentation but still show up in lcov with
 * `,0` hit counts because bun fills the line range from each function's
 * span. The result: TypeScript-heavy files report 75–84 % "coverage" even
 * when every executable branch is exercised by tests.
 *
 * This filter is intentionally **opt-in for zero-hit lines only**: when a
 * `DA:<line>,0` entry is emitted for a line whose source text matches one
 * of the patterns below, we drop the entry. Lines with `hits > 0` are
 * never stripped — if bun thought a noise line ran, we keep that data.
 * This means the per-file percentage can only increase (or stay equal),
 * never decrease, after filtering.
 *
 * Patterns matched:
 *   - Blank / whitespace-only lines
 *   - Pure comment lines (`//`, `/* `, ` * `, `*\/`, `**`)
 *   - Lines containing only punctuation: `{`, `}`, `[`, `]`, `(`, `)`,
 *     `,`, `;`, `:`, `>`, `?` (closing braces, generic-terminator, etc.)
 *   - TypeScript type-field lines:  `foo: T;`  or  `bar?: T,`  or  `: U;`
 *     ending with `;` or `,` and containing no `=` outside `=>`.
 *   - Return-type continuation:  `): Promise<{` etc.
 *   - Standalone generic types:  `Array<{ id: string }>`, `Promise<X>`, …
 *   - String literals as standalone expression elements:  `"…",` or `"…"`
 *   - Backtick template literals on their own line, optionally trailed
 *     with `+`, `;`, or `,` (string-concat continuations)
 *   - SQL keyword fragments inside `sql\`…\`` tagged templates
 *     (`SELECT`, `FROM`, `WHERE`, …, `) AS …`)
 *   - SQL SELECT-list column aliases (`mc.id AS message_id,`) — the
 *     uppercase `AS` keyword is the discriminator (TS casts are lowercase)
 *   - Lone template-interpolation close (`}\`;` / `}\`,`)
 *
 * Concerns about false positives are mitigated by the zero-hit guard: a
 * line that bun did instrument and saw run will keep its DA record.
 */

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*\/|\*\s|\*$|\*\*\s*$)/;
const BRACE_PUNCT_ONLY = /^\s*[{}\[\]\(\),;:>?]+\s*$/;
const BLANK = /^\s*$/;

// TS type-annotation continuation: ` foo: T;`, ` foo?: T,`, `: T;`.
const TS_FIELD_START = /^\s*(\)?\s*:|\w+\??:)\s/;
const ENDS_WITH_TYPE_TERMINATOR = /[;,]\s*$/;

// TS class MEMBER declaration with access/`readonly`/`static` modifiers and
// NO initializer: `private readonly maxEntries: number;`, `public foo?: T;`,
// `protected static bar: () => void;`. Unlike TS_FIELD_START (which requires
// the property name to sit immediately before the `:`), these carry modifier
// keywords, so the name isn't adjacent to the `:`. A modifier-only,
// initializer-free member declaration emits no standalone JS — the property
// only materialises when assigned (in the constructor, on its own credited
// line). Bun's sourcemap fallback still emits a phantom `DA:<decl>,0` for a
// module that's imported but never constructed. Guarded below to reject a
// value initializer (`=` outside `=>`). Zero-hit-only, so a member bun did
// credit is never stripped.
const TS_MEMBER_DECL =
  /^\s*(?:(?:public|private|protected|readonly|static|declare|abstract|override)\s+)+\w+\??\s*:\s/;

// `): Promise<{` and variants — return-type opener on its own line.
const RETURN_TYPE_OPEN = /^\s*\)\s*:\s*[A-Z]\w*<?[{<\[]?\s*$/;

// Standalone generic type continuation.
const TYPE_GENERIC_LINE =
  /^\s*(Array|Promise|Record|Map|Set|Partial|Readonly|Pick|Omit|Awaited)<.*>\s*$/;

// String literal as the entire line, optional trailing comma / concat `+`
// / semicolon (string-concatenation continuation inside a multi-line
// expression, e.g. a `throw new Error("…" + "…" + "…")`).
const STRING_LITERAL_ELEMENT = /^\s*"(?:[^"\\]|\\.)*"\s*[+,;]?\s*$/;

// Leading-`|` type-union continuation: ` | Record<string, unknown>`,
// ` | undefined;`, ` | "react" | "svelte" | "vue" | "html";`. These are
// pure type annotations split across lines after an `as`/return-type/union;
// they emit no JS. Guarded below to reject value expressions containing `=`.
const UNION_CONTINUATION = /^\s*\|\s/;

// Type-alias declaration: `type Foo = …` / `export type Foo = …`. The
// declaration itself is erased at compile time (no runtime JS).
const TYPE_DECL = /^\s*(export\s+)?type\s+\w+\s*=/;

// Backtick template literal on its own line.
const TEMPLATE_LITERAL_LINE = /^\s*`(?:[^`\\]|\\.)*`\s*[+;,]?\s*$/;

// SQL keyword fragments inside tagged template strings. DDL keywords
// (CREATE/ALTER/DROP/ADD/CONSTRAINT) are included: a multi-line
// `sql\`CREATE TABLE …\`` body executes as ONE statement credited to the
// `db.execute(...)` line — when the migration actually runs, bun emits DA
// only for that line (verified: a real migrate() run credits the await
// line and the next statement, never the body). The body lines only ever
// appear as phantom zero-hit span-fill from shards that import migrate.ts
// without executing it.
//
// SOUNDNESS: matching is case-SENSITIVE (uppercase SQL only, consistent with
// SQL_COLUMN_DEF / SQL_SELECT_ALIAS — the repo's SQL templates are uppercase,
// TS code is not), and each statement keyword must be followed by
// whitespace/EOL. The previous case-insensitive `\b` form stripped real
// zero-hit TS code lines from denominators: `set(key, entry);`,
// `update(newText);`, `on(event, cb);`, `delete cache[key];`,
// `group.diffs.push(d);`, `limit: 10,`, `count = 0;` all matched. A call
// shape like `set(` / `SET(` must NEVER match. The aggregate/function
// keywords (COALESCE/SUM/COUNT/MAX/MIN) instead require their genuine SQL
// call shape `FUNC(` — e.g. `COALESCE(SUM(cost_usd), 0)::float AS total`.
const SQL_FRAGMENT =
  /^\s*(?:(?:SELECT|FROM|WHERE|JOIN|GROUP|ORDER|LIMIT|HAVING|UNION|INSERT|UPDATE|DELETE|VALUES|SET|RETURNING|WITH|ON|AND|OR|AS|CREATE|ALTER|DROP|ADD|CONSTRAINT)(?:\s|$)|(?:COALESCE|SUM|COUNT|MAX|MIN)\()/;
// Case-SENSITIVE like SQL_SELECT_ALIAS: the uppercase `AS` is the SQL
// discriminator — a TS multi-line cast `) as HTMLElement;` must never match.
const SQL_CLOSE = /^\s*\),?\s*0?\)?\s*AS\b/;

// SQL column-definition line inside a multi-line DDL template:
// `id TEXT PRIMARY KEY,` / `poll_interval_sec INTEGER NOT NULL DEFAULT 60,` /
// `created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),`. The
// UPPERCASE type keyword is the discriminator — a TS line can't have two
// bare identifiers in a row, and the type list is matched case-SENSITIVE so
// prose or lowercase identifiers never hit it. Zero-hit-only like the rest.
const SQL_COLUMN_DEF =
  /^\s*"?[A-Za-z_][A-Za-z0-9_]*"?\s+(TEXT|INTEGER|BIGINT|SMALLINT|BOOLEAN|TIMESTAMP|TIMESTAMPTZ|JSONB|JSON|UUID|SERIAL|BIGSERIAL|NUMERIC|DECIMAL|REAL|VARCHAR|CHAR|DATE|TIME|BYTEA|INTERVAL)\b/;

// SQL SELECT-list column alias on its own line inside a multi-line query
// template: `mc.message_id AS message_id,` / `c.title AS conversation_title,` /
// `NULL::bigint AS rank_v,` / `mc.content AS matched_content`. These are string
// content of a `sql\`…\`` (or plain template) SELECT list — no JS. Bun credits
// the query to the `db.execute(...)` line; when a shard LOADS the query module
// but never calls that particular leg, its function body is span-filled with
// phantom zero-hit DA for every select-list line. The uppercase `AS` keyword is
// the discriminator (TS's cast operator is lowercase `as`), matched
// case-SENSITIVE so a value expression never hits it. Left side is a bare
// column ref (`ident(.ident)*` with an optional `::type` cast); right side is a
// bare alias identifier. Zero-hit-only, like the rest.
const SQL_SELECT_ALIAS = /^\s*[\w.]+(?:::\w+)?\s+AS\s+\w+\s*,?\s*$/;

// Lone template-interpolation close: `}\`;` / `}\`,` — the tail of a multi-line
// template literal whose `${…}` interpolation and closing backtick land on
// their own line (e.g. the `EXPLAIN` string builder in message-search.ts). The
// interpolation expression is credited to the statement's opening line; this
// closer emits no standalone JS, so a shard that loads-but-never-runs the
// builder span-fills it with a phantom zero-hit DA. Zero-hit-only.
const TEMPLATE_INTERP_CLOSE = /^\s*\}`[;,]?\s*$/;

// Interface declaration header: `interface Foo {`, `export interface Foo
// extends Bar {`. Interfaces are erased at compile time → no JS.
const INTERFACE_DECL = /^\s*(export\s+)?interface\s+\w+/;

// Class declaration HEADER on its own line: `class Foo {`,
// `export class Bar extends Baz {`, `export abstract class Qux implements I {`,
// `export default class {` (anonymous), `class Container<T extends Base> {`.
// Bun's coverage emitter assigns a phantom zero-hit DA to the class-header line
// via sourcemap fallback when a module that DECLARES the class is loaded but
// the class is never instantiated in that shard; when the class IS exercised
// Bun credits the constructor / surrounding scope, never the header — so a
// header never carries a positive DA even under full coverage. Zero-hit-only,
// so this can only strip phantom records, never real hits.
//
// The `[^=({]*\{?\s*$` tail is load-bearing: it matches a BARE header opener
// (named OR anonymous, optionally ending in `{`, brace allowed on the next
// line) but rejects any line carrying executable code — a field initializer
// (`export class Foo { count = 0; }` has `=`), a decorator/registration call
// (`registerClass(class Foo {` has `(`), or content past the `{`. Such lines
// emit real JS and must keep their DA record.
const CLASS_DECL =
  /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\b[^=({]*\{?\s*$/;

// Declaration-only class field with access/modifier prefix and a TYPE
// annotation but NO initializer: `private readonly maxEntries: number;`,
// `public foo: () => void;`, `protected static bar?: T,`. The TYPE is erased
// at compile time and the field is only assigned in the constructor, so the
// declaration line emits no JS — yet Bun fills it with a phantom zero-hit DA
// when the declaring module is loaded without the class being constructed.
// Requires at least one of private/public/protected/readonly/static so a
// value-initialized field (`map = new Map()`, which DOES emit JS) is never
// matched: those carry a `=` and are additionally guarded below.
const MODIFIER_FIELD_DECL =
  /^\s*(declare\s+)?((private|public|protected|readonly|static|override)\s+)+\w+\??\s*:/;

// Interface METHOD signature: `read(): Promise<string | null>;` /
// `write(text: string): Promise<void>;`. Matched only when the line is a
// `name(params): ReturnType;` with NO `{` body and NO value `=` — i.e. a
// pure type signature inside an `interface`/type-literal, erased at
// compile time. An executable method would carry a `{` body or `=>`, so
// the no-brace + no-`=` guard keeps this from ever matching real code.
const METHOD_SIGNATURE = /^\s*\w+\s*\([^{]*\)\s*:\s*[^={]+;\s*$/;

// Bare switch-case label on its own line: `case "applied":`, `default:`.
// The dispatch is a single operation on the `switch (...)` line; the label
// position itself compiles to no standalone JS, so bun's sourcemap
// fallback emits a phantom zero-hit DA for it even when the arm runs (the
// hit lands on the body statement below). A label line ends in `:` and
// carries no body brace / arrow / statement. Zero-hit-only, so a label
// bun *did* credit with a hit is never stripped.
const SWITCH_LABEL = /^\s*(case\s+.+|default)\s*:\s*$/;

/**
 * Identify lines that fall ENTIRELY inside a multi-line template literal's
 * string content — the pure-prose body of a `` `…` `` that spans several
 * lines (e.g. an LLM prompt builder: `Context:` / `Rules:` / `- do X`).
 *
 * Such a line is string data, not code: it compiles to no standalone JS, so
 * when a shard imports the module but never runs the builder, bun span-fills
 * the whole template body with phantom `DA:<line>,0`. A single-line filter
 * can't catch these (they have no distinguishing token — they're free prose),
 * so this is a STATEFUL scan across the file.
 *
 * The scanner is quote/comment/interpolation aware — it tracks `"`, `'`,
 * `` ` ``, `//`, `/* *​/`, and `${…}` interpolation nesting (an interpolation
 * is real CODE, so a `${expr}` line is NOT flagged) — and marks a line only
 * when it BEGINS in template string content AND never leaves it for the whole
 * line (no closing backtick, no interpolation opener). A line that opens an
 * interpolation, closes the template, or starts the template all carry code
 * and are left to `isNoiseLine` + the zero-hit guard. Because a fully-inside-
 * a-template line is *definitionally* string content with no JS, flagging it
 * is sound; the caller still restricts stripping to zero-hit entries, so this
 * can only raise a file's coverage, never lower it.
 *
 * Not modelled: a backtick inside a regex literal (`/`/`) — the scanner has no
 * regex-literal state, so such a backtick is read as a template delimiter. The
 * zero-hit guard still bounds any misclassification to lines bun never ran.
 */
export function templateInteriorProseLines(lines: string[]): Set<number> {
  const out = new Set<number>();
  let state: "code" | "dq" | "sq" | "template" | "block" = "code";
  const interp: number[] = []; // brace depth within each active `${…}`
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const startedInTemplate = state === "template";
    let stayedInTemplate = startedInTemplate;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      const nx = line[c + 1];
      if (state === "code") {
        stayedInTemplate = false;
        if (ch === "/" && nx === "/") break; // line comment → rest of line is inert
        if (ch === "/" && nx === "*") {
          state = "block";
          c++;
        } else if (ch === '"') state = "dq";
        else if (ch === "'") state = "sq";
        else if (ch === "`") state = "template";
        else if (interp.length > 0) {
          const top = interp.length - 1;
          const depth = interp[top] ?? 0;
          if (ch === "{") interp[top] = depth + 1;
          else if (ch === "}") {
            if (depth === 0) {
              interp.pop();
              state = "template";
            } else interp[top] = depth - 1;
          }
        }
      } else if (state === "template") {
        if (ch === "\\") c++; // escape
        else if (ch === "`") {
          state = "code";
          stayedInTemplate = false;
        } else if (ch === "$" && nx === "{") {
          interp.push(0);
          state = "code";
          stayedInTemplate = false;
          c++;
        }
      } else if (state === "dq") {
        stayedInTemplate = false;
        if (ch === "\\") c++;
        else if (ch === '"') state = "code";
      } else if (state === "sq") {
        stayedInTemplate = false;
        if (ch === "\\") c++;
        else if (ch === "'") state = "code";
      } else if (state === "block") {
        stayedInTemplate = false;
        if (ch === "*" && nx === "/") {
          state = "code";
          c++;
        }
      }
    }
    if (startedInTemplate && stayedInTemplate && state === "template") out.add(i + 1);
  }
  return out;
}

/**
 * Return true if the line text is non-executable noise per the criteria
 * above. The caller is responsible for restricting strip decisions to
 * zero-hit DA entries.
 */
export function isNoiseLine(text: string): boolean {
  if (BLANK.test(text)) return true;
  if (COMMENT_LINE.test(text)) return true;
  if (BRACE_PUNCT_ONLY.test(text)) return true;
  if (RETURN_TYPE_OPEN.test(text)) return true;
  if (TYPE_GENERIC_LINE.test(text)) return true;
  if (STRING_LITERAL_ELEMENT.test(text)) return true;
  if (TEMPLATE_LITERAL_LINE.test(text)) return true;
  if (SQL_FRAGMENT.test(text)) return true;
  if (SQL_CLOSE.test(text)) return true;
  if (SQL_COLUMN_DEF.test(text)) return true;
  if (SQL_SELECT_ALIAS.test(text)) return true;
  if (TEMPLATE_INTERP_CLOSE.test(text)) return true;
  if (TYPE_DECL.test(text)) return true;
  if (INTERFACE_DECL.test(text)) return true;
  if (CLASS_DECL.test(text)) return true;
  if (METHOD_SIGNATURE.test(text)) return true;
  if (MODIFIER_FIELD_DECL.test(text) && ENDS_WITH_TYPE_TERMINATOR.test(text)) {
    // Reject if there's a value assignment (`=` outside an `=>` arrow) — a
    // modifier-prefixed field WITH an initializer (`private x = foo();`)
    // emits real JS and must keep its DA record.
    const stripped = text.replace(/=>/g, "");
    if (!stripped.includes("=")) return true;
  }
  if (SWITCH_LABEL.test(text)) return true;
  if (UNION_CONTINUATION.test(text)) {
    // Guard: a line beginning with `|` that contains a value-level `=`
    // (outside `=>`) or a call `(` is not a type union — keep it.
    const stripped = text.replace(/=>/g, "");
    if (!stripped.includes("=") && !stripped.includes("(")) return true;
  }
  if (TS_FIELD_START.test(text) && ENDS_WITH_TYPE_TERMINATOR.test(text)) {
    // Reject if there's a `=` outside `=>` arrow syntax — that would be
    // a value-assignment, not a type continuation.
    const stripped = text.replace(/=>/g, "");
    if (!stripped.includes("=")) return true;
  }
  if (TS_MEMBER_DECL.test(text) && ENDS_WITH_TYPE_TERMINATOR.test(text)) {
    // Same `=`-guard: an initialized member (`private x = 0;`) IS executable.
    const stripped = text.replace(/=>/g, "");
    if (!stripped.includes("=")) return true;
  }
  return false;
}

/**
 * Cache source-file lookups so a multi-pass merge doesn't re-read each
 * file for every DA record.
 */
const srcCache = new Map<string, string[] | null>();
/** Per-file cache of the template-interior prose line numbers (computed once
 *  from the source, reused across every DA record in a multi-pass merge). */
const proseCache = new Map<string, Set<number>>();

async function readSrcLines(path: string): Promise<string[] | null> {
  const cached = srcCache.get(path);
  if (cached !== undefined) return cached;
  try {
    const text = await Bun.file(path).text();
    const lines = text.split("\n");
    srcCache.set(path, lines);
    return lines;
  } catch {
    srcCache.set(path, null);
    return null;
  }
}

/**
 * Filter a sorted `(line, hits)` array, dropping zero-hit entries that
 * point at noise lines in the source file at `absSrcPath`. If the source
 * file can't be read (excluded path, generated file, etc.) the input is
 * returned unchanged.
 */
export async function filterNoiseDA(
  absSrcPath: string,
  entries: Array<[number, number]>,
): Promise<Array<[number, number]>> {
  const src = await readSrcLines(absSrcPath);
  if (!src) return entries;
  let prose = proseCache.get(absSrcPath);
  if (prose === undefined) {
    prose = templateInteriorProseLines(src);
    proseCache.set(absSrcPath, prose);
  }
  const kept: Array<[number, number]> = [];
  for (const [lineNo, hits] of entries) {
    if (hits === 0) {
      const text = src[lineNo - 1] ?? "";
      // Strip a zero-hit line that is either single-line noise OR pure prose
      // inside a multi-line template literal (both compile to no JS).
      if (isNoiseLine(text) || prose.has(lineNo)) continue;
    }
    kept.push([lineNo, hits]);
  }
  return kept;
}
