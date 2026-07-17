#!/usr/bin/env bun
/**
 * Merge per-shard lcov.info files into a single coverage/lcov.info.
 *
 * Usage: bun scripts/merge-lcov.ts <glob-for-lcov-files> <output-path>
 * Sums DA per (SF,line) and FNDA per (SF,name); re-emits SF/FNF/FNH/LF/LH.
 * Bun 1.3.x emits no BRDA records, so branch data is intentionally not handled.
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
import { filterNoiseDA } from "./lcov-noise-filter.ts";

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

type FileRec = {
  fn: Map<string, number>; // fn name -> declared line
  fnda: Map<string, number>; // fn name -> summed hits
  da: Map<number, number>; // line -> summed hits
};

const [globPat, outPath] = Bun.argv.slice(2);
if (!globPat || !outPath) {
  console.error("usage: merge-lcov.ts <glob> <output>");
  process.exit(2);
}

const files = new Map<string, FileRec>();
const rec = (sf: string): FileRec => {
  const existing = files.get(sf);
  if (existing) return existing;
  const r: FileRec = { fn: new Map(), fnda: new Map(), da: new Map() };
  files.set(sf, r);
  return r;
};

const glob = new Glob(globPat);
for await (const path of glob.scan({ absolute: true })) {
  const text = await Bun.file(path).text();
  let cur: FileRec | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      cur = rec(canonicaliseSF(line.slice(3)));
    } else if (!cur || line === "end_of_record") {
      cur = null;
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
      cur.da.set(n, (cur.da.get(n) ?? 0) + Number(hits));
    }
  }
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
  const absSrcPath = isAbsolute(sf) ? sf : resolve(REPO_ROOT, sf);
  const sortedDa = [...r.da.entries()].sort((a, b) => a[0] - b[0]);
  const filteredDa = await filterNoiseDA(absSrcPath, sortedDa);
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
