#!/usr/bin/env bun
/**
 * Merge per-shard lcov.info files into a single coverage/lcov.info.
 *
 * Usage: bun scripts/merge-lcov.ts <glob-for-lcov-files> <output-path>
 * Sums DA per (SF,line) and FNDA per (SF,name); re-emits SF/FNF/FNH/LF/LH.
 * Bun 1.3.x emits no BRDA records, so branch data is intentionally not handled.
 * (Measured on bun 1.3.x: a `bun test --coverage --coverage-reporter=lcov` run
 * emits SF/FNF/FNH/LF/LH/DA and ZERO `FN:` / `FNDA:` / `BRDA:` records, so no
 * per-function name or entry count is available from a bun shard at all. The
 * FN/FNDA handling below exists for the node/vitest (V8) leg, which does emit
 * them.)
 *
 * NO-EVIDENCE ZEROS (see `absorbBlock`): a shard that merely IMPORTS a module
 * gets its unexecuted functions span-filled with a flat `DA:<line>,0` block,
 * while the shard that EXECUTES them emits a sparse, line-shifted record set
 * that skips real statements. Summing per (SF,line) then let the importing
 * shard's flat zero outvote the executing shard's evidence. Those zeros are
 * now dropped as "no evidence" instead of counted as misses.
 *
 * SF path canonicalisation: Bun's lcov reporter writes `SF:` paths relative
 * to whatever `process.cwd()` is at flush time. Tests that call
 * `process.chdir(...)` (21 callsites at time of writing) cause subsequent
 * coverage to be emitted with paths like
 *   SF:../home/dev/work/EZCorp/ez-corp-ai/src/runtime/goal-host.ts
 * instead of
 *   SF:src/runtime/goal-host.ts
 * Both refer to the same source file. We resolve every incoming SF to an
 * absolute path (interpreting non-absolute strings as relative to the repo
 * root), then key by repo-root-relative path so the hit counts merge into
 * one record per source file.
 */
import { Glob } from "bun";
import { resolve, relative, isAbsolute } from "node:path";
import { filterNoiseDA, isNoiseLine, readSourceLines } from "./lcov-noise-filter.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Normalise an incoming SF path to a repo-root-relative key. Robust to:
 *  - Plain absolute paths (`/home/dev/.../src/foo.ts`).
 *  - Bun's chdir artefacts. When a test calls `process.chdir("/tmp/xyz")`,
 *    bun emits SF paths as `../home/dev/work/EZCorp/ez-corp-ai/src/foo.ts`
 *    (relative-to-chdir'd-CWD, with leading `../` segments hopping up to
 *    `/` and then descending the absolute path with leading slash dropped).
 *    We detect this by stripping leading `../` segments and checking
 *    whether the remainder, when prefixed with `/`, is an absolute path
 *    that lives under the repo root.
 *  - Already-relative paths (`src/foo.ts`, `web/src/...`).
 *  - Paths outside the repo (kept as-is so they don't collide with repo
 *    files of the same suffix).
 */
function canonicaliseSF(sf: string): string {
  // Strip leading `../` segments — these come from chdir'd shards.
  let stripped = sf;
  while (stripped.startsWith("../")) stripped = stripped.slice(3);

  // Promote a now-rootless absolute path (e.g. `home/dev/work/...` after
  // strip) back to absolute IF the original had a `..` prefix AND the
  // result lives under the repo.
  if (stripped !== sf) {
    const promoted = "/" + stripped;
    if (promoted.startsWith(REPO_ROOT + "/") || promoted === REPO_ROOT) {
      return relative(REPO_ROOT, promoted);
    }
    // Otherwise: still climbing out of the repo — keep promoted as absolute key.
    return promoted;
  }

  const abs = isAbsolute(sf) ? sf : resolve(REPO_ROOT, sf);
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith("..")) return abs;
  return rel;
}

/** Absolute on-disk path for a canonicalised (repo-relative or absolute) SF key. */
function absSourcePath(sf: string): string {
  return isAbsolute(sf) ? sf : resolve(REPO_ROOT, sf);
}

type FileRec = {
  fn: Map<string, number>; // fn name -> declared line
  fnda: Map<string, number>; // fn name -> summed hits
  da: Map<number, number>; // line -> summed hits
  /** Zero-hit lines that at least one input reported inside a SPAN-FILL block. */
  spanFillZero: Set<number>;
  /** Zero-hit lines at least one input reported as a per-statement measurement. */
  measuredZero: Set<number>;
  /** Lines an input executed ACROSS without ever naming (see `absorbBlock`). */
  straddled: Set<number>;
  /** Source lines, for the span-fill discriminator. `null` when unreadable. */
  src: string[] | null;
};

/**
 * Fewest consecutive zero-hit records treated as a span fill. Bun fills a
 * whole unexecuted function span, so real fills are dozens of records
 * (measured on `src/runtime/mention-wiring.ts`: runs of 5–65). A one- or
 * two-record zero run is far more likely to be a genuine per-statement miss,
 * and this floor keeps the classifier away from it.
 */
const SPAN_FILL_MIN_RECORDS = 3;

/**
 * Fold ONE input record block (the DA records between an `SF:` line and its
 * `end_of_record`) into the accumulated evidence for that source file. Called
 * once per (input file, source file) pair, so per-shard structure is read
 * while it still exists and only per-line booleans are retained.
 *
 * Two structural signals, both derived from THIS block alone:
 *
 * 1. STRADDLED lines — a line that falls in a gap between two records of this
 *    block that BOTH have hits, with no record of any kind in between. The
 *    shard demonstrably executed the code on either side and its instrumenter
 *    never named the line, so this block holds no verdict on it: either the
 *    line is not a separately-measurable statement (a comment, a blank, a
 *    brace — bun omits those inside an executed span, and V8 omits them
 *    always), or bun's sourcemap attribution shifted its hits onto a
 *    neighbour. Both anchors must have hits: a gap bounded by a zero-hit
 *    record is a stretch this shard reported as missed, which IS a verdict.
 *
 * 2. SPAN-FILL zeros — a maximal run of consecutive zero-hit records, at least
 *    `SPAN_FILL_MIN_RECORDS` long, whose LINE RANGE contains a line the noise
 *    filter classifies as non-executable. Bun's emitter reaches a blank or
 *    comment line only by filling a function's whole line RANGE (the premise
 *    `lcov-noise-filter.ts` is built on), so such a run is a range fill for a
 *    function this shard never entered — not a per-line measurement. Every
 *    other zero record is banked as `measuredZero`, and `measuredZero` always
 *    wins: one shard that genuinely measured a miss outvotes any number of
 *    span fills.
 *
 *    Both halves of that test are deliberately insensitive to a previous merge
 *    generation, because CI merges TWICE (each shard pre-merges ~200 per-file
 *    lcovs; the gate then merges the ~8 artifacts). A merged artifact has
 *    already had its noise lines and no-evidence zeros stripped, so the run is
 *    no longer contiguous in LINE numbers and no longer *contains a record
 *    for* a noise line. Requiring record-adjacency (not line-adjacency) and
 *    testing the noise predicate over the run's line RANGE (not its recorded
 *    lines) keeps a fill recognisable as a fill after that strip — the
 *    line-contiguous, recorded-lines-only form of this test classified every
 *    pre-merged artifact's fill as a per-statement measurement, whose
 *    `measuredZero` veto then resurrected the very misses this drop removes.
 *    Measured on the real 4-shard fixture: the strict form made a 2+2
 *    pre-merge disagree with the direct merge on 16 lines; this form is
 *    byte-identical.
 */
function absorbBlock(r: FileRec, block: Array<[number, number]>): void {
  if (block.length === 0) return;
  const recs = [...block].sort((a, b) => a[0] - b[0]);

  for (let i = 1; i < recs.length; i++) {
    const prev = recs[i - 1];
    const next = recs[i];
    if (!prev || !next || prev[1] <= 0 || next[1] <= 0) continue;
    for (let line = prev[0] + 1; line < next[0]; line++) r.straddled.add(line);
  }

  let i = 0;
  while (i < recs.length) {
    const start = recs[i];
    if (!start || start[1] !== 0) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < recs.length && recs[end + 1]?.[1] === 0) end++;
    const last = recs[end];
    const target =
      last && isSpanFill(r, start[0], last[0], end - i + 1)
        ? r.spanFillZero
        : r.measuredZero;
    for (let k = i; k <= end; k++) {
      const entry = recs[k];
      if (entry) target.add(entry[0]);
    }
    i = end + 1;
  }
}

/**
 * True if a zero-hit run of `records` records spanning lines `[a,b]` looks
 * like an emitter range fill rather than a per-statement measurement.
 */
function isSpanFill(r: FileRec, a: number, b: number, records: number): boolean {
  if (records < SPAN_FILL_MIN_RECORDS) return false;
  const src = r.src;
  // No source to read (generated / deleted / outside the repo) → never
  // classify as a fill, so nothing is dropped on a guess.
  if (!src) return false;
  for (let line = a; line <= b; line++) {
    if (isNoiseLine(src[line - 1] ?? "")) return true;
  }
  return false;
}

/**
 * True when the merged zero at `line` is NO EVIDENCE rather than a miss: an
 * importing-only shard span-filled it, no shard measured it as a miss, and
 * some shard executed straight across it. Such a record is dropped from the
 * merge — it leaves both LH and LF, exactly like a noise-filtered line.
 *
 * The three conjuncts are what keep the failure direction right. Drop the
 * straddle requirement and a function NO shard ever runs would vanish from
 * the denominator (its span fills would be dropped everywhere and the file
 * would report ~100 %). Drop the `measuredZero` veto and a shard's real
 * per-statement miss could be erased by another shard's fill. Drop the
 * span-fill requirement and a genuine 3-statement miss reported by the one
 * shard that ran the enclosing code could be erased by a second shard whose
 * line map merely skipped those statements.
 */
function isNoEvidenceZero(r: FileRec, line: number): boolean {
  return r.straddled.has(line) && r.spanFillZero.has(line) && !r.measuredZero.has(line);
}

const [globPat, outPath] = Bun.argv.slice(2);
if (!globPat || !outPath) {
  console.error("usage: merge-lcov.ts <glob> <output>");
  process.exit(2);
}

const files = new Map<string, FileRec>();
const rec = async (sf: string): Promise<FileRec> => {
  const existing = files.get(sf);
  if (existing) return existing;
  const r: FileRec = {
    fn: new Map(),
    fnda: new Map(),
    da: new Map(),
    spanFillZero: new Set(),
    measuredZero: new Set(),
    straddled: new Set(),
    // Read through lcov-noise-filter's cache: the emit pass reads the same
    // path for the noise strip, so this costs no extra file read.
    src: await readSourceLines(absSourcePath(sf)),
  };
  files.set(sf, r);
  return r;
};

const glob = new Glob(globPat);
for await (const path of glob.scan({ absolute: true })) {
  const text = await Bun.file(path).text();
  let cur: FileRec | null = null;
  // DA records of the block being parsed, folded into `cur` on block end.
  let block: Array<[number, number]> = [];
  const endBlock = (): void => {
    if (cur) absorbBlock(cur, block);
    cur = null;
    block = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      endBlock();
      cur = await rec(canonicaliseSF(line.slice(3)));
    } else if (!cur || line === "end_of_record") {
      endBlock();
    } else if (line.startsWith("FN:")) {
      const [lineNo, name] = line.slice(3).split(",");
      if (lineNo && name) cur.fn.set(name, Number(lineNo));
    } else if (line.startsWith("FNDA:")) {
      const [hits, name] = line.slice(5).split(",");
      if (hits === undefined || name === undefined) continue;
      cur.fnda.set(name, (cur.fnda.get(name) ?? 0) + Number(hits));
    } else if (line.startsWith("DA:")) {
      const [lineNo, hits] = line.slice(3).split(",");
      if (lineNo === undefined || hits === undefined) continue;
      const n = Number(lineNo);
      const h = Number(hits);
      cur.da.set(n, (cur.da.get(n) ?? 0) + h);
      block.push([n, h]);
    }
  }
  // Trailing block with no `end_of_record` (truncated input).
  endBlock();
}

// Defense-in-depth: an input glob that matched nothing (e.g. a wildcard-free
// pattern handed to Bun.Glob) or matched only SF-less files must not write an
// empty merged lcov — downstream check-coverage would then fail with the
// opaque "no files matched any threshold rule" instead of naming the real
// producer problem. All shipped call sites pass wildcards; this guard exists
// for the miswired one.
if (files.size === 0) {
  console.error(
    `merge-lcov: glob '${globPat}' matched no lcov input (or inputs contained no SF records) — refusing to write an empty ${outPath}`,
  );
  process.exit(1);
}

// Deterministic output order (records sorted by SF; FN by declared line then
// name; FNDA by name): input Maps are insertion-ordered by glob-scan
// encounter, which differs between a direct merge of N files and a merge of
// pre-merged halves. Sorting makes the merge associative BYTE-for-byte, so a
// per-shard pre-merge followed by the gate's merge-of-merges is provably
// identical to one big merge. Consumers (parseLcov/parseHitLines) are
// order-insensitive.
//
// The no-evidence drop preserves that property on real inputs because it is
// re-derivable from a merged record set: dropping a straddled zero LEAVES the
// gap between its positive anchors, so a merge-of-merges reaches the same
// classification (pinned on the real two-shard fixture by
// merge-lcov-shard-vote.test.ts). It is not a proof for adversarial groupings
// — evidence that splits across group boundaries in a specific way (one input
// straddling a line while a sibling in the SAME group names it, so the
// pre-merge hides the gap) can move a line between "counted as a miss" and
// "not counted". Both sides of that are zero-hit lines: no grouping can
// fabricate a hit or drop a line any shard executed.
const out: string[] = [];
const sortedFiles = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
for (const [sf, r] of sortedFiles) {
  out.push("TN:");
  out.push(`SF:${sf}`);
  const fnSorted = [...r.fn.entries()].sort(
    (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  for (const [name, lineNo] of fnSorted) out.push(`FN:${lineNo},${name}`);
  let fnh = 0;
  const fndaSorted = [...r.fnda.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, hits] of fndaSorted) {
    out.push(`FNDA:${hits},${name}`);
    if (hits > 0) fnh++;
  }
  out.push(`FNF:${r.fn.size}`);
  out.push(`FNH:${fnh}`);
  // Strip zero-hit DA entries that point at non-executable source lines
  // (comments, blanks, brace-only, TS type-annotation continuations,
  // string-literal elements, SQL template fragments). Bun's coverage
  // emitter assigns DA records to these via sourcemap fallback even
  // though they have no compiled JS — inflating denominator on
  // TypeScript-heavy files. See lcov-noise-filter.ts for the rationale
  // and full pattern list. Strip is zero-hit-only, so percentages never
  // regress.
  const absSrcPath = absSourcePath(sf);
  const sortedDa = [...r.da.entries()].sort((a, b) => a[0] - b[0]);
  // Drop the no-evidence zeros BEFORE the noise strip (see isNoEvidenceZero):
  // a flat span fill from a shard that only imported the module must not
  // outvote the shard that executed it. Zero-hit-only, like the noise strip.
  const evidencedDa = sortedDa.filter(
    ([lineNo, hits]) => hits > 0 || !isNoEvidenceZero(r, lineNo),
  );
  const filteredDa = await filterNoiseDA(absSrcPath, evidencedDa);
  let lh = 0;
  for (const [lineNo, hits] of filteredDa) {
    out.push(`DA:${lineNo},${hits}`);
    if (hits > 0) lh++;
  }
  out.push(`LF:${filteredDa.length}`);
  out.push(`LH:${lh}`);
  out.push("end_of_record");
}

await Bun.write(outPath, out.join("\n") + "\n");
console.log(`merged ${files.size} source files → ${outPath}`);
