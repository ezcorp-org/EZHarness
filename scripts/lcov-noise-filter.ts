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

// SQL keyword fragments inside tagged template strings.
const SQL_FRAGMENT =
  /^\s*(SELECT|FROM|WHERE|JOIN|GROUP|ORDER|LIMIT|HAVING|UNION|INSERT|UPDATE|DELETE|VALUES|SET|RETURNING|WITH|ON|AND|OR|AS|COALESCE|SUM|COUNT|MAX|MIN)\b/i;
const SQL_CLOSE = /^\s*\),?\s*0?\)?\s*AS\b/i;

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
  if (TYPE_DECL.test(text)) return true;
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
  return false;
}

/**
 * Cache source-file lookups so a multi-pass merge doesn't re-read each
 * file for every DA record.
 */
const srcCache = new Map<string, string[] | null>();

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
  const kept: Array<[number, number]> = [];
  for (const [lineNo, hits] of entries) {
    if (hits === 0) {
      const text = src[lineNo - 1] ?? "";
      if (isNoiseLine(text)) continue;
    }
    kept.push([lineNo, hits]);
  }
  return kept;
}
