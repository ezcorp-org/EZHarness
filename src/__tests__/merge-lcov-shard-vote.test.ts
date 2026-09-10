/**
 * scripts/merge-lcov.ts — how the merge weighs one shard's evidence against
 * another's for the SAME (SF, line).
 *
 * WHY THIS FILE EXISTS (issue #207, reproduced at da364de6)
 *   Two real bun shards over `src/runtime/mention-wiring.ts`:
 *     - mention-wiring.test.ts EXECUTES `wireMentionedExtensions` and bun
 *       emits a SPARSE, sourcemap-shifted record set — hits of 30–79 on most
 *       lines of the function and NO `DA` record at all for the statements on
 *       1032, 1033, 1037, 1042, 1058, 1076.
 *     - mention-wiring-workflow.test.ts only IMPORTS the module, and bun
 *       span-fills the function's whole line range with `DA:<line>,0` — 60
 *       consecutive zeros, blanks and comments included.
 *   Summing per (SF, line) let the importing shard's flat zero stand for the
 *   six lines the executing shard never named, so the patch-coverage gate
 *   reported six uncovered lines inside a function that ran 40+ times.
 *
 * THE RULE UNDER TEST (`isNoEvidenceZero`) drops a merged zero only when all
 * three hold: some shard executed straight ACROSS the line, some shard
 * reported it inside a span-fill block, and NO shard measured it
 * per-statement. Each test below pins one conjunct, in BOTH directions —
 * a false miss must disappear, and a real miss must survive.
 *
 * WHY NOT `max` PER LINE (the issue's second suggestion): sum and max agree
 * exactly at the 0-vs-nonzero boundary, which is all the coverage percentage
 * and the patch gate observe. The reported misses are lines the executing
 * shard emits NO record for, so `max({0}) === 0` — a sum→max swap is a no-op
 * for this bug. `sums both shards` below pins the arithmetic that is kept.
 *
 * WHY NOT `FNDA`-BASED ("zero function entries for the enclosing function"):
 * measured on bun 1.3.x, a `bun test --coverage --coverage-reporter=lcov` run
 * emits SF/FNF/FNH/LF/LH/DA and ZERO `FN:` / `FNDA:` / `BRDA:` records. A bun
 * shard names no function and reports no per-function entry count, so there is
 * nothing to key that rule on. (`FNF`/`FNH` are per-FILE totals, and an
 * importing-only shard still executes module top level.)
 *
 * STRATEGY: merge-lcov.ts takes CLI args and resolves nothing against the
 * repo, so it runs from the real path against sandbox fixtures — same
 * spawn-not-import approach as src/__tests__/coverage-gate.test.ts. The
 * fixture SOURCE files are real files on disk because the span-fill
 * classifier and the noise filter both read the source text.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const MERGE_SCRIPT = join(REPO_ROOT, "scripts/merge-lcov.ts");

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "merge-vote-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Fixture source #1 — one function a shard executes (`ran`) and one no shard
 * ever calls (`neverRan`). Line numbers are load-bearing and referenced by
 * every fixture below:
 *   2  signature      3  statement   4  blank      5  comment
 *   6  for            7  statement   8  brace      9  return    10 brace
 *   12 signature     13  statement  14  blank     15  comment
 *   16 for           17  statement  18  brace     19  return    20 brace
 */
const TWO_FUNCS = `// fixture module
export function ran(input: string[]): string[] {
  const out: string[] = [];

  // a comment inside the executed function
  for (const item of input) {
    out.push(item.trim());
  }
  return out;
}

export function neverRan(input: string[]): number {
  let total = 0;

  // nobody calls this one
  for (const item of input) {
    total += item.length;
  }
  return total;
}
`;

/**
 * Fixture source #2 — an early return leaves a genuinely-uncovered tail.
 *   1 signature   2 if   3 return   4 brace
 *   5 statement   6 blank   7 return   8 brace   9 blank   10 export const
 */
const EARLY_RETURN = `export function tail(flag: boolean): string {
  if (flag) {
    return "early";
  }
  const value = "late";

  return value.trim();
}

export const marker = "m";
`;

type Shard = { name: string; records: string[] };

/** Write a source file into the sandbox and return its absolute path. */
function writeSource(relPath: string, text: string): string {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}

/** Write one shard lcov per entry into `<sandbox>/<dir>/<name>/lcov.info`. */
function writeShards(dir: string, srcAbs: string, shards: readonly Shard[]): string {
  for (const shard of shards) {
    const shardDir = join(root, dir, shard.name);
    mkdirSync(shardDir, { recursive: true });
    writeFileSync(
      join(shardDir, "lcov.info"),
      ["TN:", `SF:${srcAbs}`, ...shard.records, "end_of_record", ""].join("\n"),
    );
  }
  return join(root, dir, "*", "lcov.info");
}

/** Parse `DA:` records out of a merged lcov. */
function parseDA(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("DA:")) continue;
    const [lineNo, hits] = line.slice(3).split(",");
    if (lineNo === undefined || hits === undefined) continue;
    out.set(Number(lineNo), Number(hits));
  }
  return out;
}

/** Spawn the merge and return its parsed DA map plus the raw text. */
async function merge(
  globPat: string,
  outName: string,
): Promise<{ da: Map<number, number>; text: string }> {
  const outPath = join(root, outName);
  const proc = Bun.spawnSync(["bun", MERGE_SCRIPT, globPat, outPath], { cwd: root });
  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
  const text = await Bun.file(outPath).text();
  return { da: parseDA(text), text };
}

// ---------------------------------------------------------------------------
// 1. The reproduction: an importing-only shard's flat zero block must not
//    create misses on lines the executing shard covered or never named.
// ---------------------------------------------------------------------------
describe("merge-lcov: an importing-only shard's span fill is not a vote", () => {
  test("statements the executing shard never named are dropped, not counted as misses", async () => {
    const src = writeSource("case1/two-funcs.ts", TWO_FUNCS);
    // Executing shard: `ran` ran. Hits land on 2, 6, 7, 9 — line 3 (a real
    // statement), 4 (blank) and 5 (comment) get NO record, exactly like bun's
    // shifted attribution on mention-wiring.ts. `neverRan` is span-filled.
    const executing: Shard = {
      name: "cov_0",
      records: [
        "DA:2,40",
        "DA:6,75",
        "DA:7,38",
        "DA:9,40",
        "DA:12,0",
        "DA:13,0",
        "DA:14,0",
        "DA:15,0",
        "DA:16,0",
        "DA:17,0",
        "DA:18,0",
        "DA:19,0",
      ],
    };
    // Importing-only shard: flat zero over BOTH functions' whole line ranges.
    const importing: Shard = {
      name: "cov_1",
      records: Array.from({ length: 19 }, (_, i) => `DA:${i + 2},0`),
    };
    const glob = writeShards("case1", src, [executing, importing]);
    const { da } = await merge(glob, "case1.info");

    // The executing shard's hits survive untouched.
    expect(da.get(2)).toBe(40);
    expect(da.get(6)).toBe(75);
    expect(da.get(7)).toBe(38);
    expect(da.get(9)).toBe(40);

    // Line 3 is a real statement inside the function that ran, straddled by
    // the executing shard (hits at 2 and 6, no record between) and only ever
    // span-filled at zero. It must not be reported as a miss.
    expect(da.has(3)).toBe(false);

    // `neverRan` (12–19) is span-filled by BOTH shards and no shard executed
    // across it, so every measurable line stays a miss.
    expect(da.get(13)).toBe(0);
    expect(da.get(16)).toBe(0);
    expect(da.get(17)).toBe(0);
    expect(da.get(19)).toBe(0);
  });

  test("a lone importing-only shard keeps its zeros (nothing contradicts them)", async () => {
    const src = writeSource("case2/two-funcs.ts", TWO_FUNCS);
    const importing: Shard = {
      name: "cov_0",
      records: Array.from({ length: 19 }, (_, i) => `DA:${i + 2},0`),
    };
    const glob = writeShards("case2", src, [importing]);
    const { da } = await merge(glob, "case2.info");
    // Nothing executed anything: the module must read as uncovered, or an
    // untested file would report ~100 % on the handful of lines that remain.
    expect(da.get(3)).toBe(0);
    expect(da.get(7)).toBe(0);
    expect(da.get(13)).toBe(0);
    expect(da.get(17)).toBe(0);
    expect([...da.values()].some((hits) => hits > 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The other direction: a real miss survives a fill plus a straddle.
// ---------------------------------------------------------------------------
describe("merge-lcov: a measured miss outvotes a span fill", () => {
  test("per-statement zeros survive a span fill and a straddling shard", async () => {
    const src = writeSource("case3/early-return.ts", EARLY_RETURN);
    // Shard that took the early return AND measured the tail per statement:
    // its zero run is 2 records, below the span-fill floor, so lines 5 and 7
    // are banked as measured misses.
    const measured: Shard = {
      name: "cov_0",
      records: ["DA:1,3", "DA:2,3", "DA:3,3", "DA:5,0", "DA:7,0", "DA:10,3"],
    };
    // Shard that executed the same early return but whose line map skips the
    // tail entirely: hits at 3 and 10 straddle lines 4–9.
    const straddling: Shard = { name: "cov_1", records: ["DA:1,2", "DA:3,2", "DA:10,2"] };
    // Importing-only shard: flat zero fill over the whole file.
    const filling: Shard = {
      name: "cov_2",
      records: Array.from({ length: 10 }, (_, i) => `DA:${i + 1},0`),
    };
    const glob = writeShards("case3", src, [measured, straddling, filling]);
    const { da } = await merge(glob, "case3.info");

    // Straddled AND span-filled — but one shard MEASURED them at zero, and a
    // measurement outvotes a fill. Uncovered stays uncovered.
    expect(da.get(5)).toBe(0);
    expect(da.get(7)).toBe(0);
    // The covered lines still carry the summed hits.
    expect(da.get(1)).toBe(5);
    expect(da.get(3)).toBe(5);
  });

  test("a straddle needs two hit-bearing anchors, not one", async () => {
    const src = writeSource("case4/early-return.ts", EARLY_RETURN);
    // Hits stop at line 3; the record at 10 is a ZERO, so the gap 4–9 is a
    // stretch this shard reported as missed — a verdict, not a blind spot.
    const halfAnchored: Shard = {
      name: "cov_0",
      records: ["DA:1,4", "DA:2,4", "DA:3,4", "DA:10,0"],
    };
    const filling: Shard = {
      name: "cov_1",
      records: Array.from({ length: 10 }, (_, i) => `DA:${i + 1},0`),
    };
    const glob = writeShards("case4", src, [halfAnchored, filling]);
    const { da } = await merge(glob, "case4.info");
    expect(da.get(5)).toBe(0);
    expect(da.get(7)).toBe(0);
    expect(da.get(10)).toBe(0);
  });

  // The "measured" verdict has to be STICKY, not last-writer-wins: whether the
  // filling shard is folded in before or after the measuring one is decided by
  // `Glob.scan` order, which nothing in the pipeline controls. Two record
  // BLOCKS for the same SF inside one input file pin both orders
  // deterministically (each block is folded independently, so this is the same
  // code path a two-shard scan takes, minus the ordering coin flip).
  for (const order of ["measured-first", "fill-first"] as const) {
    test(`the measured verdict wins when the fill is folded ${order === "measured-first" ? "second" : "first"}`, async () => {
      const src = writeSource(`order-${order}/early-return.ts`, EARLY_RETURN);
      const measuredBlock = [
        "TN:",
        `SF:${src}`,
        "DA:1,3",
        "DA:2,3",
        "DA:3,3",
        "DA:5,0",
        "DA:7,0",
        "DA:10,3",
        "end_of_record",
      ];
      const fillBlock = [
        "TN:",
        `SF:${src}`,
        ...Array.from({ length: 10 }, (_, i) => `DA:${i + 1},0`),
        "end_of_record",
      ];
      const blocks =
        order === "measured-first"
          ? [...measuredBlock, ...fillBlock]
          : [...fillBlock, ...measuredBlock];
      const shardDir = join(root, `order-${order}`, "cov_0");
      mkdirSync(shardDir, { recursive: true });
      writeFileSync(join(shardDir, "lcov.info"), [...blocks, ""].join("\n"));
      // A straddling shard, so the drop is otherwise armed for lines 4–9.
      writeShards(`order-${order}`, src, [
        { name: "cov_1", records: ["DA:3,9", "DA:10,9"] },
      ]);
      const { da } = await merge(
        join(root, `order-${order}`, "*", "lcov.info"),
        `order-${order}.info`,
      );
      expect(da.get(5)).toBe(0);
      expect(da.get(7)).toBe(0);
    });
  }

  test("a short zero run is a measurement, not a fill", async () => {
    const src = writeSource("case5/early-return.ts", EARLY_RETURN);
    // Two-record zero run (5, 7) inside a file another shard straddles: below
    // SPAN_FILL_MIN_RECORDS, so it can never be classified as a range fill
    // even though its line range contains the blank on 6.
    const shortRun: Shard = { name: "cov_0", records: ["DA:5,0", "DA:7,0"] };
    const straddling: Shard = { name: "cov_1", records: ["DA:3,9", "DA:10,9"] };
    const glob = writeShards("case5", src, [shortRun, straddling]);
    const { da } = await merge(glob, "case5.info");
    expect(da.get(5)).toBe(0);
    expect(da.get(7)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Arithmetic and record kinds the drop must leave alone.
// ---------------------------------------------------------------------------
describe("merge-lcov: untouched merge semantics", () => {
  test("sums hits per (SF,line) where both shards executed", async () => {
    const src = writeSource("case6/two-funcs.ts", TWO_FUNCS);
    const a: Shard = { name: "cov_0", records: ["DA:2,5", "DA:7,3", "DA:9,0"] };
    const b: Shard = { name: "cov_1", records: ["DA:2,7", "DA:7,0", "DA:9,0"] };
    const glob = writeShards("case6", src, [a, b]);
    const { da } = await merge(glob, "case6.info");
    // SUM, not max (max would be 7) and not first-wins.
    expect(da.get(2)).toBe(12);
    // One shard's hit still wins over the other's zero at the boundary.
    expect(da.get(7)).toBe(3);
    // Agreed-zero stays zero.
    expect(da.get(9)).toBe(0);
  });

  test("FN/FNDA records (the V8 leg's shape) still merge and count", async () => {
    const src = writeSource("case7/two-funcs.ts", TWO_FUNCS);
    const a: Shard = {
      name: "cov_0",
      records: ["FN:2,ran", "FN:12,neverRan", "FNDA:4,ran", "FNDA:0,neverRan", "DA:2,4"],
    };
    const b: Shard = {
      name: "cov_1",
      records: ["FN:2,ran", "FN:12,neverRan", "FNDA:3,ran", "FNDA:0,neverRan", "DA:2,3"],
    };
    const glob = writeShards("case7", src, [a, b]);
    const { da, text } = await merge(glob, "case7.info");
    expect(text).toContain("FN:2,ran");
    expect(text).toContain("FN:12,neverRan");
    expect(text).toContain("FNDA:7,ran");
    expect(text).toContain("FNDA:0,neverRan");
    expect(text).toContain("FNF:2");
    expect(text).toContain("FNH:1");
    expect(da.get(2)).toBe(7);
  });

  test("LF/LH count only the records that survive", async () => {
    const src = writeSource("case8/two-funcs.ts", TWO_FUNCS);
    const executing: Shard = { name: "cov_0", records: ["DA:2,40", "DA:6,75", "DA:7,38"] };
    const importing: Shard = {
      name: "cov_1",
      records: Array.from({ length: 6 }, (_, i) => `DA:${i + 2},0`),
    };
    const glob = writeShards("case8", src, [executing, importing]);
    const { da, text } = await merge(glob, "case8.info");
    const surviving = [...da.entries()];
    const covered = surviving.filter(([, hits]) => hits > 0);
    expect(text).toContain(`LF:${surviving.length}`);
    expect(text).toContain(`LH:${covered.length}`);
    // Nothing left uncovered here: 3 is dropped as no evidence, 4/5 are noise.
    expect(surviving.length).toBe(covered.length);
  });
});

// ---------------------------------------------------------------------------
// 4. CI merges TWICE (per-shard pre-merge, then merge-of-merges). The
//    classification has to survive a merge generation or the pre-merge's
//    stripped output would re-import the misses it just removed.
// ---------------------------------------------------------------------------
describe("merge-lcov: the drop survives a pre-merge", () => {
  test("merge-of-merges is byte-identical to the direct merge", async () => {
    const src = writeSource("case9/two-funcs.ts", TWO_FUNCS);
    const executing: Shard = {
      name: "cov_0",
      records: ["DA:2,40", "DA:6,75", "DA:7,38", "DA:9,40"],
    };
    const importingA: Shard = {
      name: "cov_1",
      records: Array.from({ length: 19 }, (_, i) => `DA:${i + 2},0`),
    };
    // A SECOND importing-only shard, placed in the other pre-merge group. Its
    // fill must still read as a fill after group 1 has been merged and
    // stripped, or its zero would veto the drop at stage 2.
    const importingB: Shard = {
      name: "cov_2",
      records: Array.from({ length: 19 }, (_, i) => `DA:${i + 2},0`),
    };
    const groupA = writeShards("case9/ga", src, [executing, importingA]);
    const groupB = writeShards("case9/gb", src, [importingB]);
    const direct = await merge(join(root, "case9", "g*", "*", "lcov.info"), "case9-direct.info");

    mkdirSync(join(root, "case9-stage1"), { recursive: true });
    await merge(groupA, "case9-stage1/a.info");
    await merge(groupB, "case9-stage1/b.info");
    const twoStage = await merge(
      join(root, "case9-stage1", "*.info"),
      "case9-twostage.info",
    );

    expect(twoStage.text).toBe(direct.text);
    // …and both agree on the substance: the straddled statement is gone, the
    // never-executed function is still a miss.
    expect(twoStage.da.has(3)).toBe(false);
    expect(twoStage.da.get(17)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Canonical V8 ownership for TypeScript-map conflicts.
// ---------------------------------------------------------------------------
describe("merge-lcov: V8 canonical source ownership", () => {
  const canonical = "web/src/lib/mention-logic.ts";

  test("uses V8 DA/FN evidence and discards incompatible Bun spans", async () => {
    const canonicalSource = join(REPO_ROOT, canonical);
    const unrelated = writeSource("case10/unrelated.ts", "export const marker = true;\n");
    const base = "case10";
    const bunDir = join(root, base, "cov_bun");
    const v8Dir = join(root, base, "cov_v8");
    const otherDir = join(root, base, "cov_other");
    mkdirSync(bunDir, { recursive: true });
    mkdirSync(v8Dir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(bunDir, "lcov.info"), [
      "TN:", `SF:${canonicalSource}`, "DA:80,0", "DA:82,0", "LF:2", "LH:0", "end_of_record", "",
    ].join("\n"));
    writeFileSync(join(v8Dir, "lcov.info"), [
      "TN:ezcorp-node-v8", `SF:${canonicalSource}`, "FN:80,v8Function", "FNDA:3,v8Function", "DA:80,3", "LF:2", "LH:1", "end_of_record", "",
    ].join("\n"));
    writeFileSync(join(otherDir, "lcov.info"), [
      "TN:", `SF:${unrelated}`, "DA:1,1", "LF:1", "LH:1", "end_of_record", "",
    ].join("\n"));

    const { text, da } = await merge(join(root, base, "*", "lcov.info"), "case10.info");
    expect(text).toContain(`SF:${canonical}`);
    expect(text).toContain("FN:80,v8Function");
    expect(text).toContain("FNDA:3,v8Function");
    expect(da.get(80)).toBe(3);
    expect(da.has(82)).toBe(false);
  });

  test("retains the trusted producer marker through a two-stage CI merge", async () => {
    const canonicalSource = join(REPO_ROOT, canonical);
    const unrelated = writeSource("case10-marker/unrelated.ts", "export const marker = true;\n");
    const base = "case10-marker";
    const bunDir = join(root, base, "bun", "cov_0");
    const otherDir = join(root, base, "bun", "cov_1");
    const v8Dir = join(root, base, "v8", "cov_0");
    mkdirSync(bunDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    mkdirSync(v8Dir, { recursive: true });
    writeFileSync(join(bunDir, "lcov.info"), [
      "TN:", `SF:${canonicalSource}`, "DA:80,0", "LF:1", "LH:0", "end_of_record", "",
    ].join("\n"));
    writeFileSync(join(otherDir, "lcov.info"), [
      "TN:", `SF:${unrelated}`, "DA:1,1", "LF:1", "LH:1", "end_of_record", "",
    ].join("\n"));
    writeFileSync(join(v8Dir, "lcov.info"), [
      "TN:ezcorp-node-v8", `SF:${canonicalSource}`, "FN:80,v8Function", "FNDA:1,v8Function", "DA:80,1", "LF:1", "LH:1", "end_of_record", "",
    ].join("\n"));

    const direct = await merge(join(root, base, "*", "*", "lcov.info"), "case10-marker-direct.info");
    const stage = join(root, "case10-marker-stage");
    mkdirSync(stage, { recursive: true });
    await merge(join(root, base, "bun", "*", "lcov.info"), "case10-marker-stage/bun.info");
    await merge(join(root, base, "v8", "*", "lcov.info"), "case10-marker-stage/v8.info");
    const twoStage = await merge(join(stage, "*.info"), "case10-marker-twostage.info");

    expect(twoStage.text).toBe(direct.text);
    expect(twoStage.text).toContain("TN:ezcorp-node-v8");
    expect(twoStage.da.get(80)).toBe(1);
  });

  test("drops Bun-only canonical evidence so the final exact threshold fails loud", async () => {
    const canonicalSource = join(REPO_ROOT, canonical);
    const unrelated = writeSource("case11/unrelated.ts", "export const marker = true;\n");
    const base = "case11";
    const bunDir = join(root, base, "cov_bun");
    const otherDir = join(root, base, "cov_other");
    mkdirSync(bunDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(bunDir, "lcov.info"), [
      "TN:", `SF:${canonicalSource}`, "DA:80,9", "LF:1", "LH:1", "end_of_record", "",
    ].join("\n"));
    writeFileSync(join(otherDir, "lcov.info"), [
      "TN:", `SF:${unrelated}`, "DA:1,1", "LF:1", "LH:1", "end_of_record", "",
    ].join("\n"));

    const { text } = await merge(join(root, base, "*", "lcov.info"), "case11.info");
    expect(text).not.toContain(`SF:${canonical}`);
    expect(text).toContain(`SF:${unrelated}`);
  });
});

describe("merge-lcov: Bun API canonical source ownership", () => {
  const canonical = "web/src/lib/api.ts";

  test("accepts only the marked Bun receipt through a two-stage merge", async () => {
    const source = join(REPO_ROOT, canonical);
    const base = "case12-api";
    const apiDir = join(root, base, "api", "cov_0");
    const blankDir = join(root, base, "blank", "cov_0");
    const nodeDir = join(root, base, "node", "cov_0");
    const browserDir = join(root, base, "browser", "cov_0");
    for (const dir of [apiDir, blankDir, nodeDir, browserDir]) mkdirSync(dir, { recursive: true });
    const record = (tag: string, hit: number) => [tag, `SF:${source}`, `DA:98,${hit}`, "LF:1", `LH:${hit > 0 ? 1 : 0}`, "end_of_record", ""].join("\n");
    const unrelatedRecord = (name: string) => {
      const unrelated = writeSource(`${base}/${name}.ts`, "export const receipt = true;\n");
      return ["TN:", `SF:${unrelated}`, "DA:1,1", "LF:1", "LH:1", "end_of_record", ""].join("\n");
    };
    writeFileSync(join(apiDir, "lcov.info"), record("TN:ezcorp-bun-api", 7) + unrelatedRecord("api"));
    writeFileSync(join(blankDir, "lcov.info"), record("TN:", 0) + unrelatedRecord("blank"));
    writeFileSync(join(nodeDir, "lcov.info"), record("TN:ezcorp-node-v8", 99) + unrelatedRecord("node"));
    writeFileSync(join(browserDir, "lcov.info"), record("TN:ezcorp-browser-v8", 99) + unrelatedRecord("browser"));
    const direct = await merge(join(root, base, "*", "*", "lcov.info"), "case12-api-direct.info");
    const stage = join(root, "case12-api-stage");
    mkdirSync(stage, { recursive: true });
    for (const [name, dir] of [["api", apiDir], ["blank", blankDir], ["node", nodeDir], ["browser", browserDir]] as const) {
      // Bun.Glob intentionally requires a pattern. Keep this one-record
      // pre-merge shaped exactly like CI's shard pre-merge.
      await merge(join(dir, "*.info"), `case12-api-stage/${name}.info`);
    }
    const twoStage = await merge(join(stage, "*.info"), "case12-api-twostage.info");
    expect(twoStage.text).toBe(direct.text);
    expect(twoStage.text).toContain("TN:ezcorp-bun-api");
    expect(twoStage.da.get(98)).toBe(7);
  });
});

describe("merge-lcov: Bun empty Node shim canonical source ownership", () => {
  const canonical = "web/src/lib/empty-node-shim.ts";

  test("accepts only the shim contract receipt through a two-stage merge", async () => {
    const source = join(REPO_ROOT, canonical);
    const base = "case13-shim";
    const shimDir = join(root, base, "shim", "cov_0");
    const wrongDir = join(root, base, "wrong", "cov_0");
    const browserDir = join(root, base, "browser", "cov_0");
    for (const dir of [shimDir, wrongDir, browserDir]) mkdirSync(dir, { recursive: true });
    const record = (tag: string, hit: number) => [tag, `SF:${source}`, `DA:1,${hit}`, "LF:1", `LH:${hit > 0 ? 1 : 0}`, "end_of_record", ""].join("\n");
    const unrelatedRecord = (name: string) => {
      const unrelated = writeSource(`${base}/${name}.ts`, "export const receipt = true;\n");
      return ["TN:", `SF:${unrelated}`, "DA:1,1", "LF:1", "LH:1", "end_of_record", ""].join("\n");
    };
    writeFileSync(join(shimDir, "lcov.info"), record("TN:ezcorp-bun-shim", 3));
    writeFileSync(join(wrongDir, "lcov.info"), record("TN:ezcorp-bun-api", 9) + unrelatedRecord("wrong"));
    writeFileSync(join(browserDir, "lcov.info"), record("TN:ezcorp-browser-v8", 9) + unrelatedRecord("browser"));
    const direct = await merge(join(root, base, "*", "*", "lcov.info"), "case13-shim-direct.info");
    const stage = join(root, "case13-shim-stage");
    mkdirSync(stage, { recursive: true });
    for (const [name, dir] of [["shim", shimDir], ["wrong", wrongDir], ["browser", browserDir]] as const) {
      await merge(join(dir, "*.info"), `case13-shim-stage/${name}.info`);
    }
    const twoStage = await merge(join(stage, "*.info"), "case13-shim-twostage.info");
    expect(twoStage.text).toBe(direct.text);
    expect(twoStage.text).toContain("TN:ezcorp-bun-shim");
    expect(twoStage.da.get(1)).toBe(3);
  });
});
