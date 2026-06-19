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
 *
 * All checks are DIFF-SCOPED (only what the PR adds is judged) so the 19
 * pre-existing `.skip`s and 365 mock files in the tree don't false-positive.
 *
 * ESCAPE HATCH: a maintainer who legitimately needs to change the gate sets
 * GATE_CHANGE_APPROVED=1 (wired in CI from a maintainer-only label that an
 * agent's token cannot apply). It bypasses the checks but logs loudly.
 *
 * The pure detection helpers are exported for unit testing; main() only wires
 * git + the filesystem.
 */
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

export type DiffFile = { file: string; addedLines: Set<number>; addedTexts: string[] };

/**
 * Parse `git diff --unified=0` output into per-file added line numbers
 * (new-side) and the added text lines.
 */
export function parseUnifiedDiff(diff: string): Map<string, DiffFile> {
  const files = new Map<string, DiffFile>();
  let cur: DiffFile | null = null;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const file = line.slice(6);
      cur = { file, addedLines: new Set(), addedTexts: [] };
      files.set(file, cur);
    } else if (line.startsWith("@@")) {
      // @@ -a,b +c,d @@  → new-side starts at c
      const m = line.match(/\+(\d+)/);
      newLine = m?.[1] ? Number(m[1]) : 0;
    } else if (cur && line.startsWith("+") && !line.startsWith("+++")) {
      cur.addedLines.add(newLine);
      cur.addedTexts.push(line.slice(1));
      newLine++;
    } else if (cur && !line.startsWith("-") && !line.startsWith("\\")) {
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

/** Forbidden patterns added to a test file (skip/only/todo + empty catch). */
export function forbiddenTestAdditions(addedTexts: string[]): string[] {
  const out: string[] = [];
  for (const text of addedTexts) {
    // stripNoise removes BOTH line comments and string/template literals, so a
    // skip/only/todo or empty-catch that only appears INSIDE a quoted string
    // (e.g. the fixtures in this gate's own test, src/__tests__/gate-scripts.test.ts)
    // is not mistaken for a real, executable cheat. A genuine `it.skip(...)` keeps
    // its keyword outside the quotes, so it is still caught.
    const stripped = stripNoise(text);
    if (ALWAYS_FORBIDDEN.test(stripped) || STATIC_SKIP.test(stripped)) {
      out.push(`added skip/only/todo: ${text.trim()}`);
    }
    if (EMPTY_CATCH.test(stripped)) out.push(`added empty catch{}: ${text.trim()}`);
  }
  return out;
}

// `expect(` plus Playwright's chained assertion forms `expect.poll(...)` /
// `expect.soft(...)` (both produce real assertions; the bare `expect(` branch
// alone misses them and flags a genuinely-asserting test as vacuous).
const ASSERTION =
	/\bexpect\s*\(|\bexpect\s*\.\s*(?:poll|soft)\b|\bassert\b|\.\s*(?:rejects|resolves)\b|\btoThrow\b|\bexpectTypeOf\b/;
const TEST_OPENER = /(?:^|[^.\w])(?:test|it)\s*\(/;

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
 * Find `test()/it()` blocks in `fileContent` that overlap any added line and
 * contain no assertion. Returns a short label per offending block.
 *
 * Heuristic brace-matcher: starts at the first `{` after a test opener and
 * scans to the matching close, ignoring braces inside strings/comments.
 */
export function unassertedAddedBlocks(fileContent: string, addedLines: Set<number>): string[] {
  const lines = fileContent.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!TEST_OPENER.test(stripNoise(raw))) continue;
    // Find opening brace of the callback, from this line forward.
    let depth = 0;
    let started = false;
    let endLine = i;
    let hasAssertion = false;
    let foundOpen = false;
    for (let j = i; j < lines.length; j++) {
      const code = stripNoise(lines[j]!);
      if (ASSERTION.test(lines[j]!)) hasAssertion = true;
      for (const ch of code) {
        if (ch === "{") {
          depth++;
          started = true;
          foundOpen = true;
        } else if (ch === "}") {
          depth--;
        }
      }
      if (started && depth <= 0) {
        endLine = j;
        break;
      }
      endLine = j;
    }
    if (!foundOpen) continue;
    // 1-based line range [i+1, endLine+1].
    let touched = false;
    for (let ln = i + 1; ln <= endLine + 1; ln++) {
      if (addedLines.has(ln)) {
        touched = true;
        break;
      }
    }
    if (touched && !hasAssertion) {
      out.push(`vacuous test (no assertion) near line ${i + 1}: ${raw.trim().slice(0, 80)}`);
    }
    i = endLine; // skip past this block
  }
  return out;
}

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.ts$/.test(path);
}

// ── git wiring + main() ────────────────────────────────────────────────────

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out : "";
}

async function showAtBase(base: string, path: string): Promise<string> {
  return git(["show", `${base}:${path}`]);
}

async function main(): Promise<void> {
  const base = process.env.BASE_REF || "origin/main";
  const approved = !!process.env.GATE_CHANGE_APPROVED;

  const violations: string[] = [];

  // 6. Staged/committed lcov report.
  const changed = (await git(["diff", "--name-only", `${base}...HEAD`]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (changed.includes("coverage/lcov.info")) {
    violations.push("coverage/lcov.info is committed — the report must be generated in CI, never checked in");
  }

  // 1. EXCLUDES growth.
  if (changed.includes("scripts/coverage-config.ts")) {
    let baseSrc = await showAtBase(base, "scripts/coverage-config.ts");
    // Bootstrap: coverage-config.ts is the shared module the EXCLUDES list was
    // refactored OUT of scripts/check-coverage.ts into. On a base that predates
    // that split there is no coverage-config.ts, so fall back to the EXCLUDES at
    // their old inline home — otherwise a verbatim move reads as 100% "growth".
    if (!baseSrc) baseSrc = await showAtBase(base, "scripts/check-coverage.ts");
    const headSrc = await Bun.file(resolve(REPO_ROOT, "scripts/coverage-config.ts")).text();
    for (const p of addedExcludes(baseSrc, headSrc)) {
      violations.push(`EXCLUDES grew: "${p}" — un-gating a file needs the gate-change-approved label`);
    }
  }

  // 2. Threshold ratchet.
  if (changed.includes("scripts/coverage-thresholds.json")) {
    const baseJson = await showAtBase(base, "scripts/coverage-thresholds.json");
    const headJson = await Bun.file(resolve(REPO_ROOT, "scripts/coverage-thresholds.json")).text();
    violations.push(...thresholdRatchetViolations(baseJson, headJson));
  }

  // 3/4/5. Test-file cheats — diff-scoped.
  const testDiff = await git(["diff", "--unified=0", `${base}...HEAD`, "--", "*.test.ts", "*.spec.ts"]);
  const perFile = parseUnifiedDiff(testDiff);
  for (const [file, info] of perFile) {
    if (!isTestFile(file)) continue;
    for (const v of forbiddenTestAdditions(info.addedTexts)) violations.push(`${file}: ${v}`);
    const content = await Bun.file(resolve(REPO_ROOT, file))
      .text()
      .catch(() => "");
    if (content) {
      for (const v of unassertedAddedBlocks(content, info.addedLines)) violations.push(`${file}: ${v}`);
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
  await main();
}
