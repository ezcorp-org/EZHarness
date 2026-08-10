#!/usr/bin/env bun
/**
 * Gate-integrity meta-check — the anti-tamper / anti-cheat backstop.
 *
 * Runs against a PR diff (HEAD vs origin/main) and FAILS (exit 1) if the
 * change tries to weaken the coverage/test gate or fake its way green:
 *
 *   1. EXCLUDES grew — a new un-gating pattern was added to
 *      scripts/coverage-config.ts.
 *   2. Coverage ratchet broken — a key was removed from
 *      scripts/coverage-thresholds.json, or a threshold value decreased.
 *   3. A test file ADDED `.skip` / `.only` / `.todo` (dodging a failing test).
 *   4. A test file ADDED an empty `catch {}` (swallowing failures).
 *   5. A newly-touched `test()` / `it()` block has NO assertion
 *      (`expect` / `assert` / `.rejects` / `.resolves`) — vacuous test.
 *   6. coverage/lcov.info is staged in the diff (hand-doctored report).
 *   7. A `*.test.ts` / `*.spec.ts` file was DELETED or RENAMED (even R100 —
 *      content-identical): the P/C/CRIT test sets are find-pattern-built, so
 *      a rename can silently de-gate a file without touching its content.
 *   8. A MODIFIED test file was GUTTED in place: the diff removes more
 *      assertion/test-opener lines than it adds AND the net loss exceeds
 *      half the file's base assertion count. Catches the M-status dodge the
 *      D/R check can't see (delete the bodies, keep the file). Legit
 *      refactors MOVE assertions (net count roughly preserved) and don't
 *      trip it.
 *   9. biome.json was WEAKENED — a new `"!<path>"` in files.includes, a new
 *      or widened override that disarms a rule, or a severity lowered out of
 *      `error`. biome.json is to LINT what EXCLUDES is to coverage.
 *  10. The biome CONFIG FILE itself moved — root biome.json deleted/renamed
 *      (biome falls back to its built-in defaults), or a NESTED biome config
 *      added (biome resolves the nearest config, so one can un-lint a whole
 *      subtree without the root diff showing anything).
 *
 * All checks are DIFF-SCOPED (only what the PR adds is judged) so the 19
 * pre-existing `.skip`s and 365 mock files in the tree don't false-positive.
 *
 * BASE PINNING: every comparison reads the MERGE-BASE of $BASE_REF and HEAD —
 * the same commit the `BASE...HEAD` changed-file list is computed against.
 * Reading the base TIP instead produced a proven false positive (run
 * 29527620867: a threshold key added on main after the branch point read as
 * "removed" here).
 *
 * FAIL-CLOSED: a git invocation error (shallow clone, bad rev) is a hard
 * error (exit 1), never "no data → zero violations". Only a path genuinely
 * absent at the merge-base is treated as legitimately missing.
 *
 * ESCAPE HATCH: a maintainer who legitimately needs to change the gate sets
 * GATE_CHANGE_APPROVED=1 (wired in CI from a maintainer-only label that an
 * agent's token cannot apply). It bypasses the checks but logs loudly.
 *
 * The pure detection helpers are exported for unit testing; main() only wires
 * git + the filesystem.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./coverage-config.ts";

// ── Pure detection helpers (unit-tested) ───────────────────────────────────

/**
 * Extract the literal entries of the `EXCLUDES` array from coverage-config.ts
 * source text. Returns the set of quoted string patterns (comments ignored).
 */
export function parseExcludeEntries(src: string): Set<string> {
  // Anchor on the single-line declaration `EXCLUDES ... = [` (the `[^=\n]*`
  // can't cross a newline, so doc-comment mentions of "EXCLUDES" — which have
  // a newline before any `=` — don't match; only the real declaration does).
  // The trailing `\[` is the array opener, past the `[` in the `string[]` type.
  const decl = src.match(/EXCLUDES[^=\n]*=\s*\[/);
  if (!decl || decl.index === undefined) return new Set();
  const open = decl.index + decl[0].length - 1;
  // Find the matching close bracket for this array.
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return new Set();
  const block = src.slice(open + 1, close);
  const entries = new Set<string>();
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("//")) continue;
    // Capture the first quoted string literal on an entry line.
    const m = line.match(/^["'`]([^"'`]+)["'`]/);
    if (m?.[1]) entries.add(m[1]);
  }
  return entries;
}

/** Patterns present in HEAD's EXCLUDES but not in base's (the un-gating growth). */
export function addedExcludes(baseSrc: string, headSrc: string): string[] {
  const base = parseExcludeEntries(baseSrc);
  const head = parseExcludeEntries(headSrc);
  return [...head].filter((p) => !base.has(p));
}

/**
 * Coverage-ratchet violations between two coverage-thresholds.json texts:
 * a removed key, or a decreased value. Added keys / increases are allowed.
 */
export function thresholdRatchetViolations(baseJson: string, headJson: string): string[] {
  let base: Record<string, number> = {};
  let head: Record<string, number> = {};
  try {
    base = JSON.parse(baseJson) as Record<string, number>;
  } catch {
    return [];
  }
  try {
    head = JSON.parse(headJson) as Record<string, number>;
  } catch {
    return [`coverage-thresholds.json is not valid JSON in HEAD`];
  }
  const out: string[] = [];
  for (const [key, baseVal] of Object.entries(base)) {
    if (!(key in head)) {
      out.push(`threshold key removed: "${key}" (was ${baseVal}) — removing a key removes a gate`);
    } else if (head[key]! < baseVal) {
      out.push(`threshold lowered: "${key}" ${baseVal} → ${head[key]} — ratchet allows increases only`);
    }
  }
  return out;
}

export type DiffFile = {
  file: string;
  addedLines: Set<number>;
  addedTexts: string[];
  removedTexts: string[];
};

/**
 * Parse `git diff --unified=0` output into per-file added line numbers
 * (new-side), the added text lines, and the removed text lines (old-side,
 * consumed by the in-place-gutting check).
 *
 * A DELETED file's new-side header is `+++ /dev/null`, NOT `+++ b/<path>`.
 * Keying only off `+++ b/` therefore left `cur` pointing at the PREVIOUS
 * file in the diff and shovelled every deleted line into ITS `removedTexts`
 * — so any PR that deleted a test file accused whichever modified test file
 * happened to sort just before it of being "GUTTED in place". Observed
 * 2026-08-03 retiring `ez-code-factory`: five deleted
 * `web/e2e/ez-code-factory-*.spec.ts` specs landed 172 removed assertion
 * lines on `src/__tests__/extension-rbac-resolver.test.ts`, a file the same
 * diff only ADDS 130 lines to (+130 / -0).
 *
 * That false positive is a gate WEAKENING, not a nuisance: the only way past
 * it is `gate-change-approved`, which bypasses ALL SEVEN other checks. A
 * routine deletion should not be the thing that buys a PR a blanket bypass.
 *
 * The old side is tracked so a deleted file gets its OWN entry, keyed by its
 * old path. `deletedOrRenamedTests` (check 7) already flags the deletion
 * itself; keeping the lines attributed correctly just stops them being
 * counted against a bystander.
 */
export function parseUnifiedDiff(diff: string): Map<string, DiffFile> {
  const files = new Map<string, DiffFile>();
  let cur: DiffFile | null = null;
  let oldPath: string | null = null;
  let newLine = 0;
  // Returns the entry so the caller ASSIGNS `cur` — assigning inside the
  // helper would leave TS narrowing `cur` to `never` at the branches below.
  const startFile = (file: string): DiffFile => {
    const entry: DiffFile = { file, addedLines: new Set(), addedTexts: [], removedTexts: [] };
    files.set(file, entry);
    return entry;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      cur = startFile(line.slice(6));
    } else if (line === "+++ /dev/null") {
      // Deleted file: the new side is /dev/null, so the OLD path names it.
      // Without its own entry, everything below lands on the previous file.
      cur = startFile(oldPath ?? "/dev/null");
    } else if (line.startsWith("@@")) {
      // @@ -a,b +c,d @@  → new-side starts at c
      const m = line.match(/\+(\d+)/);
      newLine = m?.[1] ? Number(m[1]) : 0;
    } else if (line.startsWith("--- a/")) {
      // old-side file header — not a removed line (a REAL removed line whose
      // content begins with "-- " would be "--- " but never "--- a/")
      oldPath = line.slice(6);
    } else if (line === "--- /dev/null") {
      // Added file — the `+++ b/<path>` on the next line names it.
      oldPath = null;
    } else if (cur && line.startsWith("+") && !line.startsWith("+++")) {
      cur.addedLines.add(newLine);
      cur.addedTexts.push(line.slice(1));
      newLine++;
    } else if (cur && line.startsWith("-")) {
      cur.removedTexts.push(line.slice(1));
    } else if (cur && !line.startsWith("\\")) {
      // context line (unified=0 emits none, but be safe)
      newLine++;
    }
  }
  return files;
}

// Always a cheat: `.only` / `.todo` / `.failing`, the x*/f* focus/skip globals,
// and a STATIC suite skip (`describe.skip`). A test/it/bench `.skip` is handled
// separately (STATIC_SKIP) because the runtime-conditional form is legitimate.
const ALWAYS_FORBIDDEN =
	/\b(?:describe|test|it|bench)\s*\.\s*(?:only|todo|failing)\b|\b(?:xdescribe|xit|xtest|fdescribe|fit)\b|\bdescribe\s*\.\s*skip\b/;
// A STATIC or UNCONDITIONAL test/it/bench `.skip`: `.skip("name", fn)` — after
// stripNoise() removes the string literal the name slot collapses to `.skip( ,`
// — or `.skip()` with no args. A runtime CONDITIONAL skip `.skip(<condition>, …)`
// keeps a real first argument and is ALLOWED: it gates a test on an
// environment/data condition (e.g. a Docker-only suite, or "no real fixture on
// disk so skip honestly rather than fabricate"), which is NOT dodging a failing
// test. Maintainers can still spot an always-true condition in review.
const STATIC_SKIP = /\b(?:test|it|bench)\s*\.\s*skip\s*\(\s*[),]/;
const EMPTY_CATCH = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/;

/** Forbidden patterns added to a test file (skip/only/todo + empty catch).
 *
 * LAYOUT-INSENSITIVE, and that is the whole point. This used to test each added
 * LINE on its own, which made every pattern here trivially evadable by a line
 * break — the regexes already spell `\s*` between their tokens, but two halves
 * of one construct never met in the same string. Found for real: a formatter
 * broke a member chain as
 *
 *     test.describe
 *       .skip("Landing page", () => {
 *
 * which is semantically identical and became INVISIBLE to the gate. Three
 * existing suite skips stopped being counted (23 -> 20) — and a newly added
 * one would hide exactly as well. The same evasion works by hand: wrap a long
 * `describe.skip(...)` title past the margin and the suppression vanishes.
 *
 * So the scan now runs over the whole file with line structure preserved, and
 * a finding is reported when the MATCH intersects an added line — same
 * diff-scoping as {@link unassertedAddedBlocks}, no widening of what counts.
 *
 * Noise stripping is layered and load-bearing, because a looser matcher is
 * exactly how a scan like this starts crying wolf. Each pattern keeps the
 * scrubbing it had before, so this change alters LAYOUT SENSITIVITY ONLY and
 * not what counts as a violation:
 *
 *   - all three patterns get {@link stripBlockComments} then
 *     {@link stripNoise}. The block-comment pass is new, and it only ever
 *     REMOVES findings — prose like `flip \`test.describe.skip\` to …`, or the
 *     English word "fit" matching the `fdescribe|fit` alternation, no longer
 *     counts — so it cannot hide a real cheat.
 *   - `EMPTY_CATCH` must match in the scrubbed text AND in the RAW source.
 *     The scrubbed pass proves it is code rather than a `"catch {}"` string in
 *     a fixture; the raw pass proves the body is genuinely EMPTY. Without the
 *     raw check, comment-stripping turns the repo's ~180 documented swallows —
 *     `catch { /* best-effort *\/ }` and the multi-line `catch {\n // why\n}`
 *     — into "empty" and fires on every one of them. Whether a comment-only
 *     catch should count as empty is a fair question, but it is a change to
 *     the RULE, not to line-break tolerance, and does not belong in this PR.
 *
 * Both passes preserve newlines, so reported line numbers stay accurate.
 */
export function forbiddenTestAdditions(fileContent: string, addedLines: Set<number>): string[] {
  const rawLines = fileContent.split("\n");
  const scrubbed = stripBlockComments(fileContent).split("\n").map(stripNoise);

  const out: string[] = [];
  const scan = (scrubbed: string[], re: RegExp, label: string, alsoRaw = false): void => {
    const joined = scrubbed.join("\n");
    // Char offset -> 1-based line, for mapping a match back to its lines.
    const lineStart: number[] = [0];
    for (let i = 0; i < scrubbed.length; i++) {
      lineStart.push(lineStart[i]! + scrubbed[i]!.length + 1);
    }
    const lineAt = (idx: number): number => {
      let lo = 0;
      let hi = scrubbed.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStart[mid]! <= idx) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    for (const m of joined.matchAll(new RegExp(re.source, `${re.flags.replace("g", "")}g`))) {
      const from = lineAt(m.index!);
      const to = lineAt(m.index! + Math.max(m[0]!.length - 1, 0));
      let touchesAdded = false;
      for (let ln = from; ln <= to; ln++) {
        if (addedLines.has(ln)) {
          touchesAdded = true;
          break;
        }
      }
      if (!touchesAdded) continue;
      // Report the RAW source of the matched span, whitespace-collapsed, so a
      // construct split across lines reads as the one construct it is.
      const text = rawLines
        .slice(from - 1, to)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      // `alsoRaw`: the construct must survive in the UNSCRUBBED source too.
      // Only EMPTY_CATCH uses it — a body holding nothing but a comment is a
      // documented swallow, not an empty catch, and comment-stripping alone
      // cannot tell the two apart.
      if (alsoRaw && !re.test(rawLines.slice(from - 1, to).join("\n"))) continue;
      out.push(`${label}: ${text}`);
    }
  };

  scan(scrubbed, ALWAYS_FORBIDDEN, "added skip/only/todo");
  scan(scrubbed, STATIC_SKIP, "added skip/only/todo");
  scan(scrubbed, EMPTY_CATCH, "added empty catch{}", true);
  return out;
}

// `expect(` plus Playwright's chained assertion forms `expect.poll(...)` /
// `expect.soft(...)` (both produce real assertions; the bare `expect(` branch
// alone misses them and flags a genuinely-asserting test as vacuous).
const ASSERTION =
	/\bexpect\s*\(|\bexpect\s*\.\s*(?:poll|soft)\b|\bassert\b|\.\s*(?:rejects|resolves)\b|\btoThrow\b|\bexpectTypeOf\b/;
const TEST_OPENER = /(?:^|[^.\w])(?:test|it)\s*\(/;

/**
 * Blank out block comments (`/* … *\/`, including JSDoc `/** … *\/`) across the
 * whole file while PRESERVING newlines, so the per-line test-opener / assertion
 * scanners can't be fooled by prose. Without this a doc-comment phrase like
 * "e2e self-test (mockApi, no Docker)" matches the `TEST_OPENER` regex and is
 * mistaken for a vacuous (assertion-free) `test()` block. String- and
 * line-comment-aware: a `/*` inside a string literal or after `//` is left
 * untouched. Comment characters become spaces (newlines kept) so 1-based line
 * numbers reported downstream stay accurate.
 */
export function stripBlockComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (inBlock) {
      if (ch === "*" && next === "/") {
        out += "  ";
        i++;
        inBlock = false;
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (inLine) {
      out += ch; // leave line comments for stripNoise to handle per line
      if (ch === "\n") inLine = false;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      out += "  ";
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Strip line comments and string/template literals so brace counting and
 * assertion detection aren't fooled by braces/keywords inside strings.
 */
function stripNoise(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    out += ch;
  }
  return out;
}

/**
 * Per-character "is this CODE?" mask for a whole file — 1 outside strings,
 * template literals and comments, 0 inside them. Newlines are always 1 so line
 * arithmetic is unaffected.
 *
 * WHY A WHOLE-FILE PASS. {@link stripNoise} is per LINE, so its quote state
 * resets at every newline. A multi-line template literal therefore leaks its
 * insides back into "code" from line two onward, and the braces in
 * `` `${JSON.stringify({ … })}` `` get counted by the block matcher. Measured
 * on this tree: that mis-scoped 18 test blocks, ending them early so an
 * assertion that IS inside the block fell outside the scanned range and the
 * test was reported vacuous. Tracking state across the whole file removes that
 * class outright.
 *
 * Template interpolations are handled properly: the `${ … }` payload is real
 * code (it can contain calls, and `expect(` inside one is a genuine
 * assertion), so the mask re-enters code inside the braces and returns to
 * string afterwards, at any nesting depth.
 *
 * REGEX LITERALS ARE TRACKED, and they have to be. A regex routinely carries
 * both quotes and parens — `/from\s+["']\$server\/…["']/` and
 * `/color:(rgb\([^)]*\))/g` are real lines in this repo. Leaving them as code
 * lets a `"` inside one open a phantom string that desynchronises the mask for
 * the REST OF THE FILE. The previous per-line scanner was accidentally
 * insulated from this (its quote state reset at every newline, containing the
 * damage to one line); a whole-file pass is not, so the protection has to be
 * real. Measured: without this, two blocks that plainly contain `expect(`
 * (`feature-scan.test.ts:590`, `markdown-render.test.ts:317`) were reported
 * vacuous.
 *
 * `/` is divide-or-regex, so it is disambiguated by the previous significant
 * code character — the standard lexer rule: after a value (`)`, `]`, an
 * identifier, a number) it is division; after an operator, `(`, `,`, `=`, `:`,
 * `[`, `!`, `&`, `|`, `?`, `{`, `}`, `;`, or `return`/`typeof`/`case`, it
 * opens a regex.
 *
 * `scripts/gate-integrity.ts` runs in a CI job with NO dependencies installed
 * (ci.yml: "no deps needed"), so a real parser is not available here — this is
 * a lexer-grade approximation, and the tree-wide sweep in the PR body is the
 * evidence it holds on this codebase.
 */
export function codeMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length).fill(1);
  // Stack of template-literal depths so `${ }` nesting resolves correctly.
  const tmplBraceDepth: number[] = [];
  let i = 0;
  let quote: string | null = null;
  let inLine = false;
  let inBlock = false;
  let inRegex = false;
  let inClass = false; // inside a regex character class `[ … ]`
  // Last significant CODE character, for `/` divide-vs-regex disambiguation.
  let prev = "";
  const REGEX_PRECEDERS = new Set([
    "", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^",
  ]);
  const KEYWORD_BEFORE_REGEX = /\b(?:return|typeof|case|in|of|delete|void|instanceof|new|do|else|yield|await)$/;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (inRegex) {
      mask[i] = 0;
      if (ch === "\\") { if (i + 1 < src.length) mask[i + 1] = 0; i += 2; continue; }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) { inRegex = false; prev = "/"; }
      else if (ch === "\n") { inRegex = false; inClass = false; mask[i] = 1; } // unterminated: bail at EOL
      i++;
      continue;
    }
    if (ch === "\n") {
      inLine = false;
      i++;
      continue; // newline stays code(1)
    }
    if (inLine || inBlock) {
      mask[i] = 0;
      if (inBlock && ch === "*" && next === "/") {
        mask[i + 1] = 0;
        i += 2;
        inBlock = false;
        continue;
      }
      i++;
      continue;
    }
    if (quote) {
      mask[i] = 0;
      if (ch === "\\") {
        if (i + 1 < src.length) mask[i + 1] = 0;
        i += 2;
        continue;
      }
      // `${` opens a real-code interpolation inside a template literal.
      if (quote === "`" && ch === "$" && next === "{") {
        mask[i + 1] = 1;
        tmplBraceDepth.push(1);
        quote = null;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    // Inside a `${ … }` interpolation: track braces to find its end.
    if (tmplBraceDepth.length > 0) {
      if (ch === "{") tmplBraceDepth[tmplBraceDepth.length - 1]!++;
      else if (ch === "}") {
        tmplBraceDepth[tmplBraceDepth.length - 1]!--;
        if (tmplBraceDepth[tmplBraceDepth.length - 1] === 0) {
          tmplBraceDepth.pop();
          mask[i] = 0; // the closing `}` belongs to the literal
          quote = "`"; // back inside the template
          i++;
          continue;
        }
      }
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      mask[i] = 0;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      mask[i] = 0;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      mask[i] = 0;
      prev = ch;
      i++;
      continue;
    }
    if (ch === "/") {
      const before = src.slice(Math.max(0, i - 12), i);
      if (REGEX_PRECEDERS.has(prev) || KEYWORD_BEFORE_REGEX.test(before.trimEnd())) {
        inRegex = true;
        inClass = false;
        mask[i] = 0;
        i++;
        continue;
      }
    }
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return mask;
}

/**
 * Find `test()/it()` calls in `fileContent` that overlap any added line and
 * contain no assertion. Returns a short label per offending call.
 *
 * EXTENT IS THE WHOLE CALL, from `test(` to its matching `)`, measured with a
 * whole-file {@link codeMask} so strings/templates/comments can't shift it.
 * The previous version looked for the first `{` after the opener and matched
 * braces from there, which has two measured defects:
 *
 *   1. a multi-line template literal leaked braces into the count and ended
 *      the block early — 18 blocks on this tree contained an assertion that
 *      fell outside the scanned range and were reported vacuous;
 *   2. a CONCISE ARROW body has no `{` at all, so `foundOpen` stayed false and
 *      the block was SKIPPED ENTIRELY. `test("x", () => helper())` was never
 *      examined — about 14 such blocks on this tree, and a genuinely vacuous
 *      one was invisible to the gate.
 *
 * Matching parentheses instead of braces covers both shapes with one rule.
 *
 * What counts as an assertion is UNCHANGED — same {@link ASSERTION} pattern,
 * applied to the same code-only text. This commit fixes WHERE the gate looks,
 * never WHAT it accepts; helper-wrapped assertions (`expectFail(…)`) remain
 * flagged and are a separate, deliberate decision.
 *
 * Hooks were never in scope and still are not: {@link TEST_OPENER} requires
 * `test`/`it` immediately followed by `(`, so `test.beforeEach(`,
 * `test.describe(` and `describe(` do not match.
 */
export function unassertedAddedBlocks(fileContent: string, addedLines: Set<number>): string[] {
  const mask = codeMask(fileContent);
  // Code-only projection: non-code bytes become spaces, so offsets and line
  // numbers line up exactly with the original text.
  let code = "";
  for (let i = 0; i < fileContent.length; i++) {
    code += mask[i] ? fileContent[i]! : fileContent[i] === "\n" ? "\n" : " ";
  }
  const lineOf = (idx: number): number => {
    let n = 1;
    for (let i = 0; i < idx; i++) if (code[i] === "\n") n++;
    return n;
  };
  const rawLines = fileContent.split("\n");

  const out: string[] = [];
  const opener = new RegExp(TEST_OPENER.source, "g");
  for (const m of code.matchAll(opener)) {
    // TEST_OPENER may consume a LEADING non-word char (often the newline
    // before `test(`), so `m.index` can sit on the previous line. Report from
    // the keyword itself or the finding names the wrong line — the existing
    // doc-comment test catches exactly that.
    const kw = m.index! + (m[0]!.match(/(?:test|it)\s*\($/)?.index ?? 0);
    // The opener may include a leading non-word char; find its own `(`.
    const open = code.indexOf("(", kw);
    if (open < 0) continue;
    let depth = 0;
    let close = -1;
    for (let i = open; i < code.length; i++) {
      const c = code[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue; // unbalanced — leave it alone rather than guess
    const from = lineOf(kw);
    const to = lineOf(close);
    let touched = false;
    for (let ln = from; ln <= to; ln++) {
      if (addedLines.has(ln)) {
        touched = true;
        break;
      }
    }
    if (!touched) continue;
    if (ASSERTION.test(code.slice(kw, close + 1))) continue;
    out.push(
      `vacuous test (no assertion) near line ${from}: ${(rawLines[from - 1] ?? "").trim().slice(0, 80)}`,
    );
  }
  return out;
}

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.ts$/.test(path);
}

/** Count lines carrying an assertion or a test/it opener (comment/string-safe). */
function countAssertionLines(lines: string[]): number {
  let n = 0;
  for (const line of lines) {
    const code = stripNoise(line);
    if (ASSERTION.test(code) || TEST_OPENER.test(code)) n++;
  }
  return n;
}

/**
 * In-place test-GUTTING heuristic (check 8): a modified test file whose diff
 * removes more assertion/test-opener lines than it adds, where the net loss
 * exceeds HALF the file's base assertion count, is a violation. Both
 * conditions are required so legitimate refactors never trip it: moving
 * assertions removes and re-adds them (net ≈ 0), and trimming a few cases
 * from a large suite stays under the 50%-of-base bar. Returns a message or
 * null. Base content comes from the merge-base (block comments blanked so
 * commented-out fixtures don't count as base assertions).
 */
export function testGuttingViolation(
  addedTexts: string[],
  removedTexts: string[],
  baseContent: string,
): string | null {
  const baseCount = countAssertionLines(stripBlockComments(baseContent).split("\n"));
  if (baseCount === 0) return null;
  const removed = countAssertionLines(removedTexts);
  const added = countAssertionLines(addedTexts);
  const netLoss = removed - added;
  if (netLoss <= 0) return null;
  if (netLoss * 2 <= baseCount) return null;
  return (
    `test file GUTTED in place: removes ${removed} assertion/test line(s), adds ${added} ` +
    `(net -${netLoss} of ${baseCount} at base — >50% loss) — hollowing out a surviving ` +
    `test file needs the gate-change-approved label`
  );
}

/**
 * Defense in depth against git's C-quoting: with core.quotePath=true a path
 * containing non-ASCII/special bytes is emitted as `"src/…\303\244….test.ts"` —
 * the surrounding quotes would make a suffix match (`.test.ts`, `biome.json`)
 * miss. Every diff invocation here pins `-c core.quotePath=false`; this strip
 * catches any quoted path that reaches the parsers anyway (the escaped
 * interior still ends in the real suffix).
 */
function unquotePath(p: string | undefined): string | undefined {
  return p?.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

/**
 * Deleted or renamed test files from `git diff --name-status -M` output.
 * A deletion removes a gate outright; a RENAME — even R100, content-identical
 * — can silently de-gate a file because the P/C/CRIT test sets are built from
 * find patterns over paths and names. Both need the gate-change-approved
 * label. (A non-test file renamed TO a test file is an addition, not judged
 * here — the old-side path decides.)
 */
export function deletedOrRenamedTests(nameStatus: string): string[] {
  const out: string[] = [];
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [status, rawOld, rawNew] = line.split("\t");
    const oldPath = unquotePath(rawOld);
    const newPath = unquotePath(rawNew);
    if (!status || !oldPath || !isTestFile(oldPath)) continue;
    if (status.startsWith("D")) {
      out.push(`test file DELETED: ${oldPath} — removing a test removes a gate`);
    } else if (status.startsWith("R")) {
      out.push(
        `test file RENAMED (${status}): ${oldPath} → ${newPath ?? "?"} — renames can de-gate pattern-matched test sets`,
      );
    }
  }
  return out;
}

/**
 * True when a failed `git show <rev>:<path>` stderr means "path absent at
 * that revision" — a legitimate state (file added by this PR, or predates a
 * refactor). Anything else (bad rev, shallow clone, spawn failure) must FAIL
 * CLOSED: a git error must never read as "no violations".
 */
export function isPathAbsentAtRev(stderr: string): boolean {
  return /does not exist in|exists on disk, but not in/.test(stderr);
}

// ── biome.json: the LINT gate's un-gating surface ──────────────────────────
//
// `biome.json` is to lint exactly what `EXCLUDES` is to coverage — a place
// where one line silently removes enforcement — and it had zero coverage from
// this script (issue #143). Three edit shapes disarm it:
//
//   1. a `"!<path>"` added to `files.includes` un-lints that path for EVERY
//      rule, forever, with nowhere to write a reason;
//   2. a new or WIDENED `overrides[]` entry that sets a rule to `"off"`
//      un-lints that rule across a path set;
//   3. a severity lowered out of `"error"`. This is the nastiest: `ci.yml`
//      keeps biome warnings visible but NON-BLOCKING, so a rule flipped to
//      `"warn"` still appears in the config and in the lint output while
//      enforcing nothing, and the diff reads as a severity tweak.
//
// `src/__tests__/dependency-denylist.test.ts` pins some of this already, but
// it is an ordinary test: an author editing `biome.json` can edit the test in
// the same commit. An `EXCLUDES` addition cannot be self-approved. That
// asymmetry is what this closes — the same maintainer-only
// `gate-change-approved` label now governs both surfaces.
//
// DESIGN — what "weakening" means here, and what it deliberately does NOT:
//
// * The check judges the AUTHOR'S EDIT, not the resolved severity. That is the
//   answer to `recommended: true`: this script runs in a CI job with no deps
//   installed, so it cannot ask biome which rules the preset enables or at what
//   default severity. It does not need to. WRITING an explicit sub-`error`
//   severity into the config is an affirmative act of disarming — if the rule
//   were already off by default the line would be pointless. So a newly
//   spelled-out `"off"` / `"warn"` / `"info"` fires, whatever the preset does.
//   The known cost: adopting a brand-new rule at `"warn"` as a stepping stone
//   also fires. In a repo where warnings do not block, that is precisely the
//   edit worth a human look, and the label is the answer.
// * RAISING a severity, REMOVING an exclusion, ADDING a path to the linted set
//   and ADDING an override that sets a rule to `"error"` are all silent. A gate
//   that fires on strengthening gets routed around.
// * DELETING a rule that stood at `"error"` counts as a weakening, because the
//   rule then falls back to a default this file does not state and this script
//   cannot resolve — the same unknowable-baseline problem, and the same
//   fail-closed answer. It is NOT flagged when the rule is still pinned at
//   `error` somewhere that still covers it (dropping a redundant `web/**`
//   override that restates the root is a cleanup, not a hole). Deleting a rule
//   that stood BELOW error is allowed outright: it can only re-arm.
// * KNOWN LIMITS, stated rather than papered over: (a) `vcs.useIgnoreFile` is
//   on, so a `.gitignore` addition also un-lints — flagging every `.gitignore`
//   edit would drown the signal, and those edits are legible in review; (b)
//   two overrides that set the SAME rule at different severities resolve
//   last-one-wins, and a REORDER of such a pair is not modelled. No such pair
//   exists today, and `dependency-denylist.test.ts` drives the real biome
//   binary against probe files, which is the check that would catch it.

/** Only `error` BLOCKS — ci.yml keeps biome warnings non-blocking on purpose. */
const BIOME_SEVERITY_RANK = { off: 0, info: 1, warn: 2, on: 3, error: 4 } as const;
type BiomeSeverity = keyof typeof BIOME_SEVERITY_RANK;
const BIOME_ERROR_RANK = BIOME_SEVERITY_RANK.error;
const BIOME_ROOT_SCOPE = "<root>";
const BIOME_ALL_RULES = "<all rules>";

/**
 * Rank of a biome severity keyword, or null when the value isn't one.
 *
 * `"on"` ranks BELOW `"error"` on purpose: it means "run at the rule's own
 * default", which may resolve to `warn`/`info`. So `error` → `on` reads as a
 * lowering (fail-closed), while `on` → `error` is a raise and stays silent.
 */
function biomeSeverityRank(name: string): number | null {
  return name in BIOME_SEVERITY_RANK ? BIOME_SEVERITY_RANK[name as BiomeSeverity] : null;
}

type JsonObject = Record<string, unknown>;

function asJsonObject(v: unknown): JsonObject | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
}

/**
 * The severity NAME a biome rule value carries. Severity is expressible two
 * ways and both must be handled or the object form is a free bypass:
 * a bare string (`"error"`) or `{ "level": "error", "options": {…} }` —
 * `noRestrictedImports` on main uses the object form. An object with `options`
 * but no `level` runs the rule at its own default: same standing as `"on"`.
 */
function biomeRuleSeverity(value: unknown): string | null {
  if (typeof value === "string") return value;
  const obj = asJsonObject(value);
  if (!obj) return null;
  if (typeof obj.level === "string") return obj.level;
  return "on";
}

/**
 * Keys of a rule's `options.paths` denylist (biome's `noRestrictedImports`
 * shape). It is a pure DENYlist, so losing a key is a weakening — dropping
 * `express` from the map stops denying express while the rule still reads as
 * `"error"`. Rules without such a map yield `[]` and are unaffected.
 */
function biomeRuleDenyPaths(value: unknown): string[] {
  const paths = asJsonObject(asJsonObject(asJsonObject(value)?.options)?.paths);
  return paths ? Object.keys(paths).sort() : [];
}

/**
 * True when the rule PRESET is switched off — the blanket form of turning
 * every rule off at once. Biome 2.5 deprecates `recommended` in favour of
 * `preset`, so both are read: a `biome migrate` that swaps `recommended: true`
 * for `preset: "recommended"` reads as the no-op it is, while `preset: "none"`
 * still fires.
 */
function isBiomePresetDisabled(rules: JsonObject): boolean {
  if ("preset" in rules) {
    return rules.preset === false || rules.preset === "none" || rules.preset === "off";
  }
  return rules.recommended === false;
}

/**
 * One "rule R stands at severity S over path-scope P" fact, flattened out of
 * the root config and every `overrides[]` entry so base and head can be
 * compared by (scope, rule) rather than by array index — an override that
 * moves position must not read as removed-and-re-added.
 */
type BiomeRuleRecord = {
  /** An `includes` token with any leading `!` stripped, or `<root>`. */
  scope: string;
  /** The token was `!<scope>`: an EXEMPTION carved OUT of the override. */
  negated: boolean;
  /** `group/name`, `group/*` for a group-wide setting, or `<all rules>`. */
  rule: string;
  severity: string;
  level: number;
  denyPaths: string[];
  where: string;
};

type BiomeScope = { scope: string; negated: boolean };

function collectBiomeLinterRecords(
  out: BiomeRuleRecord[],
  linterNode: unknown,
  scopes: readonly BiomeScope[],
  where: string,
): void {
  const linter = asJsonObject(linterNode);
  if (!linter) return;
  const push = (rule: string, severity: string, denyPaths: string[]): void => {
    const level = biomeSeverityRank(severity);
    if (level === null) return;
    for (const s of scopes) out.push({ ...s, rule, severity, level, denyPaths, where });
  };
  // `linter.enabled: false` disarms every rule at once — the blanket form of a
  // per-rule "off", and the obvious way to route around a per-rule check.
  if (linter.enabled === false) push(BIOME_ALL_RULES, "off", []);
  const rules = asJsonObject(linter.rules);
  if (!rules) return;
  if (isBiomePresetDisabled(rules)) push(BIOME_ALL_RULES, "off", []);
  for (const [group, groupNode] of Object.entries(rules)) {
    if (group === "recommended" || group === "preset") continue;
    // A whole GROUP can be set at once (`"a11y": "off"`) — same disarm, one
    // level up, so it gets a `group/*` record rather than being skipped.
    if (typeof groupNode === "string") {
      push(`${group}/*`, groupNode, []);
      continue;
    }
    const groupRules = asJsonObject(groupNode);
    if (!groupRules) continue;
    for (const [name, value] of Object.entries(groupRules)) {
      const severity = biomeRuleSeverity(value);
      if (severity !== null) push(`${group}/${name}`, severity, biomeRuleDenyPaths(value));
    }
  }
}

/** Flatten a parsed biome config into its (scope, rule) → severity facts. */
function collectBiomeRecords(cfg: JsonObject): BiomeRuleRecord[] {
  const out: BiomeRuleRecord[] = [];
  collectBiomeLinterRecords(out, cfg.linter, [{ scope: BIOME_ROOT_SCOPE, negated: false }], "linter");
  const overrides = Array.isArray(cfg.overrides) ? cfg.overrides : [];
  for (let i = 0; i < overrides.length; i++) {
    const ov = asJsonObject(overrides[i]);
    if (!ov) continue;
    const tokens = asStringArray(ov.includes);
    // An override with no `includes` applies EVERYWHERE. An EMPTY one is read
    // the same way, fail-closed: this dep-free script cannot ask biome how it
    // resolves an empty glob list, and "matches nothing" is the exploitable
    // reading. The cost is a finding on a degenerate no-op override; the
    // benefit is that `includes: []` can never be a blanket disarm in disguise.
    const scopes: BiomeScope[] = (tokens.length > 0 ? tokens : ["**"]).map((t) =>
      t.startsWith("!") ? { scope: t.slice(1), negated: true } : { scope: t, negated: false },
    );
    collectBiomeLinterRecords(out, ov.linter, scopes, `overrides[${i}]`);
  }
  return out;
}

const biomeRecordKey = (r: BiomeRuleRecord): string =>
  `${r.negated ? "!" : ""}${r.scope} ${r.rule}`;

const biomeRecordAt = (r: BiomeRuleRecord): string =>
  r.scope === BIOME_ROOT_SCOPE ? "linter.rules" : `${r.where} (${r.negated ? "!" : ""}${r.scope})`;

/** Shape 1: `files.includes` gained an exclusion, or lost linted ground. */
function biomeFilesIncludesWeakenings(baseCfg: JsonObject, headCfg: JsonObject): string[] {
  const read = (cfg: JsonObject): string[] => asStringArray(asJsonObject(cfg.files)?.includes);
  const base = read(baseCfg);
  const head = read(headCfg);
  const baseSet = new Set(base);
  const headSet = new Set(head);
  const out: string[] = [];
  for (const token of head) {
    if (!token.startsWith("!") || baseSet.has(token)) continue;
    out.push(
      `biome files.includes gained the exclusion "${token}" — that un-lints ${token.slice(1)} ` +
        `for EVERY rule, forever, with nowhere to state a reason`,
    );
  }
  for (const token of base) {
    // A POSITIVE token is what biome is told to look AT; dropping one narrows
    // the linted set just as surely as adding a "!" exclusion (swapping "**"
    // for "src/**" un-lints web/ without a single "!" appearing in the diff).
    if (token.startsWith("!") || headSet.has(token)) continue;
    out.push(
      `biome files.includes lost "${token}" — narrowing what biome looks at un-lints ` +
        `everything that pattern used to reach`,
    );
  }
  return out;
}

/** Shapes 2 + 3: a rule disarmed, widened, lowered, or deleted out of error. */
function biomeRuleWeakenings(baseCfg: JsonObject, headCfg: JsonObject): string[] {
  const baseRecords = collectBiomeRecords(baseCfg);
  const headRecords = collectBiomeRecords(headCfg);
  const baseByKey = new Map(baseRecords.map((r) => [biomeRecordKey(r), r]));
  const headByKey = new Map(headRecords.map((r) => [biomeRecordKey(r), r]));
  const out: string[] = [];

  for (const head of headRecords) {
    const base = baseByKey.get(biomeRecordKey(head));
    if (!base) {
      // A NEW `!token` NARROWS an override's reach — a strengthening.
      if (head.negated) continue;
      // A new (scope, rule) pair at `error` only ever ADDS enforcement.
      if (head.level >= BIOME_ERROR_RANK) continue;
      out.push(
        `biome rule DISARMED: ${head.rule} set to "${head.severity}" at ${biomeRecordAt(head)} ` +
          `— spelling out a sub-"error" severity disarms the rule there (only "error" blocks)`,
      );
      continue;
    }
    if (head.level < base.level) {
      out.push(
        `biome rule DISARMED: ${head.rule} "${base.severity}" → "${head.severity}" at ` +
          `${biomeRecordAt(head)} — only "error" blocks, so this enforces nothing while still ` +
          `appearing in the config and in lint output`,
      );
      continue;
    }
    if (head.level < BIOME_ERROR_RANK) continue;
    for (const p of base.denyPaths) {
      if (head.denyPaths.includes(p)) continue;
      out.push(
        `biome rule ${head.rule} at ${biomeRecordAt(head)} stopped denying "${p}" — the rule ` +
          `still reads as "${head.severity}" but no longer covers that entry`,
      );
    }
  }

  const headErrorRules = new Set(
    headRecords.filter((r) => !r.negated && r.level >= BIOME_ERROR_RANK).map((r) => r.rule),
  );
  const headRootErrorRules = new Set(
    headRecords
      .filter((r) => r.scope === BIOME_ROOT_SCOPE && r.level >= BIOME_ERROR_RANK)
      .map((r) => r.rule),
  );
  for (const base of baseRecords) {
    if (headByKey.has(biomeRecordKey(base))) continue;
    if (base.negated) {
      // Losing an exemption WIDENS the disarm it used to carve out of — the
      // path set grows with no new array element to notice in review.
      if (base.level < BIOME_ERROR_RANK) {
        out.push(
          `biome override exemption REMOVED: "!${base.scope}" no longer carved out of ` +
            `${base.rule}="${base.severity}" (${base.where}) — the disarmed path set grew`,
        );
      }
      continue;
    }
    // Dropping a record that stood BELOW error can only re-arm the rule.
    if (base.level < BIOME_ERROR_RANK) continue;
    // A root pin must still be pinned at the ROOT; an override's pin may fall
    // back to any surviving `error` (dropping a redundant restatement of the
    // root is a cleanup, not a hole).
    const stillPinned =
      base.scope === BIOME_ROOT_SCOPE
        ? headRootErrorRules.has(base.rule)
        : headErrorRules.has(base.rule);
    if (stillPinned) continue;
    out.push(
      `biome rule DELETED while at "error": ${base.rule} (was ${biomeRecordAt(base)}) — a ` +
        `deleted rule falls back to a default this file no longer states`,
    );
  }
  return out;
}

/**
 * Gate-weakening edits between two `biome.json` texts. Mirrors
 * `addedExcludes()`: findings route through the same maintainer-only
 * `gate-change-approved` label, and only WEAKENING fires.
 *
 * An unparseable BASE yields no findings (nothing trustworthy to compare
 * against, same as `thresholdRatchetViolations`); an unparseable HEAD is
 * itself a finding — biome discards a config it cannot read and walks up to
 * whatever it finds next, which in an agent worktree means `Checked 0 files`
 * and a green exit (root-caused in PR #134).
 */
export function biomeGateWeakenings(baseJson: string, headJson: string): string[] {
  let baseCfg: JsonObject | null = null;
  try {
    baseCfg = asJsonObject(JSON.parse(baseJson));
  } catch {
    return [];
  }
  if (!baseCfg) return [];
  let headCfg: JsonObject | null = null;
  try {
    headCfg = asJsonObject(JSON.parse(headJson));
  } catch {
    return [
      "biome.json is not valid JSON in HEAD — biome silently discards a config it cannot " +
        "parse and lints against whatever it finds next (PR #134: `Checked 0 files`, exit 0)",
    ];
  }
  if (!headCfg) return ["biome.json is not a JSON object in HEAD"];
  return [
    ...new Set([
      ...biomeFilesIncludesWeakenings(baseCfg, headCfg),
      ...biomeRuleWeakenings(baseCfg, headCfg),
    ]),
  ];
}

/**
 * Config-FILE moves that route around the content diff entirely, read from the
 * same `git diff --name-status -M` output check 7 uses:
 *
 *   - the root `biome.json` DELETED or RENAMED — biome falls back to its
 *     built-in defaults, dropping every rule this repo pins;
 *   - a NESTED `biome.json` / `biome.jsonc` ADDED anywhere else — biome 2
 *     resolves the nearest config for a file, so a nested one can un-lint a
 *     whole subtree while the root config's diff shows nothing at all.
 */
export function biomeConfigFileViolations(nameStatus: string): string[] {
  const BIOME_CONFIG = /(^|\/)biome\.jsonc?$/;
  const out: string[] = [];
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [status, rawOld, rawNew] = line.split("\t");
    const oldPath = unquotePath(rawOld);
    if (!status || !oldPath) continue;
    // A/M/D emit two fields, so the new path IS the old path there.
    const newPath = unquotePath(rawNew) ?? oldPath;
    if (oldPath === "biome.json" && /^[DR]/.test(status)) {
      out.push(
        status.startsWith("D")
          ? `biome.json DELETED — biome falls back to its built-in defaults, dropping every rule this repo pins`
          : `biome.json RENAMED to ${newPath} — biome only auto-loads biome.json/biome.jsonc at the root`,
      );
      continue;
    }
    if (!/^[AR]/.test(status)) continue;
    const added = status.startsWith("A") ? oldPath : newPath;
    if (added === "biome.json" || !BIOME_CONFIG.test(added)) continue;
    out.push(
      `nested biome config ADDED: ${added} — biome resolves the NEAREST config, so this can ` +
        `un-lint its whole subtree without touching biome.json`,
    );
  }
  return out;
}

// ── git wiring + main() ────────────────────────────────────────────────────

async function gitRun(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/** Run git, FAIL CLOSED: any git error is a hard error, never "no data". */
async function git(args: string[]): Promise<string> {
  const { code, out, err } = await gitRun(args);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${code}): ${err.trim()}`);
  }
  return out;
}

/** Contents of `path` at `rev`, or null when the path doesn't exist there. */
async function showAtBase(rev: string, path: string): Promise<string | null> {
  const { code, out, err } = await gitRun(["show", `${rev}:${path}`]);
  if (code === 0) return out;
  if (isPathAbsentAtRev(err)) return null;
  throw new Error(`git show ${rev}:${path} failed (exit ${code}): ${err.trim()}`);
}

async function main(): Promise<void> {
  const base = process.env.BASE_REF || "origin/main";
  const approved = !!process.env.GATE_CHANGE_APPROVED;

  // Pin every base-side read to the MERGE-BASE — the same commit the
  // `BASE...HEAD` diff below compares against. See header (BASE PINNING).
  const mergeBase = (await git(["merge-base", base, "HEAD"])).trim();
  if (!mergeBase) throw new Error(`could not resolve merge-base of ${base} and HEAD`);

  const violations: string[] = [];

  // 6. Staged/committed lcov report.
  const changed = (await git(["diff", "--name-only", `${mergeBase}...HEAD`]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (changed.includes("coverage/lcov.info")) {
    violations.push("coverage/lcov.info is committed — the report must be generated in CI, never checked in");
  }

  // 1. EXCLUDES growth.
  if (changed.includes("scripts/coverage-config.ts")) {
    let baseSrc = await showAtBase(mergeBase, "scripts/coverage-config.ts");
    // Bootstrap: coverage-config.ts is the shared module the EXCLUDES list was
    // refactored OUT of scripts/check-coverage.ts into. On a base that predates
    // that split there is no coverage-config.ts, so fall back to the EXCLUDES at
    // their old inline home — otherwise a verbatim move reads as 100% "growth".
    if (baseSrc === null) baseSrc = await showAtBase(mergeBase, "scripts/check-coverage.ts");
    const headSrc = await Bun.file(resolve(REPO_ROOT, "scripts/coverage-config.ts")).text();
    for (const p of addedExcludes(baseSrc ?? "", headSrc)) {
      violations.push(`EXCLUDES grew: "${p}" — un-gating a file needs the gate-change-approved label`);
    }
  }

  // 2. Threshold ratchet. A file absent at the merge-base (bootstrap) means
  // every key is new — no ratchet to enforce.
  if (changed.includes("scripts/coverage-thresholds.json")) {
    const baseJson = await showAtBase(mergeBase, "scripts/coverage-thresholds.json");
    const headJson = await Bun.file(resolve(REPO_ROOT, "scripts/coverage-thresholds.json")).text();
    violations.push(...thresholdRatchetViolations(baseJson ?? "{}", headJson));
  }

  // 7. Deleted/renamed test files (rename detection on, R100 included).
  // core.quotePath=false: never C-quote paths — a quote-forcing filename
  // must not be able to dodge the .test.ts suffix match.
  const nameStatus = await git([
    "-c",
    "core.quotePath=false",
    "diff",
    "--name-status",
    "-M",
    `${mergeBase}...HEAD`,
  ]);
  for (const v of deletedOrRenamedTests(nameStatus)) {
    violations.push(`${v} — needs the gate-change-approved label`);
  }

  // 9. biome.json content — the LINT gate's un-gating surface.
  if (changed.includes("biome.json")) {
    const baseSrc = await showAtBase(mergeBase, "biome.json");
    const headPath = resolve(REPO_ROOT, "biome.json");
    // Absent at the merge-base = this PR INTRODUCES the lint config; there is
    // no prior enforcement to weaken. Absent in HEAD = deleted, which check 10
    // reports from the name-status (and reading it here would just throw).
    if (baseSrc !== null && existsSync(headPath)) {
      const headSrc = await Bun.file(headPath).text();
      for (const v of biomeGateWeakenings(baseSrc, headSrc)) {
        violations.push(`${v} — needs the gate-change-approved label`);
      }
    }
  }

  // 10. biome CONFIG FILE moves (root deleted/renamed, nested config added).
  for (const v of biomeConfigFileViolations(nameStatus)) {
    violations.push(`${v} — needs the gate-change-approved label`);
  }

  // 3/4/5. Test-file cheats — diff-scoped.
  const testDiff = await git([
    "diff",
    "--unified=0",
    `${mergeBase}...HEAD`,
    "--",
    "*.test.ts",
    "*.spec.ts",
  ]);
  const perFile = parseUnifiedDiff(testDiff);
  for (const [file, info] of perFile) {
    if (!isTestFile(file)) continue;
    const content = await Bun.file(resolve(REPO_ROOT, file))
      .text()
      .catch(() => "");
    if (content) {
      // Both scans are content-aware so a construct SPLIT ACROSS LINES is still
      // seen; each stays diff-scoped by intersecting `addedLines`.
      for (const v of forbiddenTestAdditions(content, info.addedLines)) {
        violations.push(`${file}: ${v}`);
      }
      for (const v of unassertedAddedBlocks(content, info.addedLines)) violations.push(`${file}: ${v}`);
    }
    // 8. In-place gutting — only meaningful for a file that EXISTED at the
    // merge-base (a brand-new file has no base assertions to gut) and STILL
    // EXISTS on the new side. Check 8's whole reason to exist is the M-status
    // dodge check 7 cannot see: "delete the bodies, keep the file". A file
    // that is genuinely GONE is check 7's finding, and reporting it twice
    // buries the real signal — retiring `ez-code-factory` produced 44
    // duplicate lines of it before this guard.
    if (!existsSync(resolve(REPO_ROOT, file))) continue;
    const baseContent = await showAtBase(mergeBase, file);
    if (baseContent !== null) {
      const v = testGuttingViolation(info.addedTexts, info.removedTexts, baseContent);
      if (v) violations.push(`${file}: ${v}`);
    }
  }

  if (violations.length === 0) {
    console.log("Gate integrity PASSED: no gate-weakening or test-cheating changes detected.");
    return;
  }

  if (approved) {
    console.warn(
      `Gate integrity: ${violations.length} finding(s) BYPASSED via GATE_CHANGE_APPROVED (maintainer label):`,
    );
    for (const v of violations) console.warn(`  (bypassed) ${v}`);
    return;
  }

  console.error(`Gate integrity FAILED (${violations.length} finding(s)):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nIf a change here is legitimate, a maintainer must apply the `gate-change-approved` label (sets GATE_CHANGE_APPROVED=1).",
  );
  process.exit(1);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    // FAIL CLOSED: an infrastructure/git error must red the check — it can
    // never be allowed to read as "no violations found".
    console.error(
      `Gate integrity ERROR (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
