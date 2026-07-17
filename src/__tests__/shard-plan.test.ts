/**
 * Unit tests for the LPT shard planner (scripts/shard-plan.ts) — wave 3,
 * CI audit item 3.2. Pure-function tests plus a CLI-level check of the
 * missing-manifest stride fallback (the seam scripts/lib/test-file-sets.sh's
 * shard_slice actually exercises in CI).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { median, parseManifest, planShards, strideSlice } from "../../scripts/shard-plan.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("median", () => {
  test("odd + even counts", () => {
    expect(median([5])).toBe(5);
    expect(median([1, 9, 5])).toBe(5);
    expect(median([1, 2, 3, 100])).toBe(2.5);
  });

  test("does not mutate its input", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("planShards — known weights", () => {
  test("classic LPT assignment: heaviest first, always to the least-loaded bin", () => {
    // Weights 10,9,8,3,2,1 over 2 shards: LPT gives {10,3,2,1}? No —
    // 10→s0, 9→s1, 8→s1? loads: s0=10, s1=9 → 8→s1(17)? least-loaded is s1
    // at 9 → s1=17; 3→s0(13); 2→s0(15); 1→s0(16). Bins: s0={a,d,e,f}=16,
    // s1={b,c}=17.
    const weights = { a: 10, b: 9, c: 8, d: 3, e: 2, f: 1 };
    const bins = planShards(["a", "b", "c", "d", "e", "f"], weights, 2);
    expect(bins[0]).toEqual(["a", "d", "e", "f"]);
    expect(bins[1]).toEqual(["b", "c"]);
  });

  test("equal weights tie-break: path asc, lowest shard index first", () => {
    const bins = planShards(["d", "c", "b", "a"], { a: 1, b: 1, c: 1, d: 1 }, 2);
    // Sorted a,b,c,d; a→s0, b→s1, c→s0, d→s1.
    expect(bins[0]).toEqual(["a", "c"]);
    expect(bins[1]).toEqual(["b", "d"]);
  });

  test("deterministic under input permutation", () => {
    const files = ["x", "y", "z", "w", "v"];
    const weights = { x: 7, y: 7, z: 2, w: 9, v: 4 };
    const a = planShards(files, weights, 3);
    const b = planShards([...files].reverse(), weights, 3);
    expect(a).toEqual(b);
  });

  test("partition: every file in exactly one bin", () => {
    const files = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    const weights = Object.fromEntries(files.map((f, i) => [f, (i * 37) % 11]));
    const bins = planShards(files, weights, 8);
    expect(bins.length).toBe(8);
    const all = bins.flat().sort();
    expect(all).toEqual([...files].sort());
  });

  test("balances measurably better than stride on a skewed distribution", () => {
    // One pathological 100ms file + many 1ms files: stride pins the heavy
    // file plus a full stripe on one shard; LPT isolates it.
    const files = Array.from({ length: 32 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    const weights: Record<string, number> = Object.fromEntries(files.map((f) => [f, 1]));
    weights.f00 = 100;
    const bins = planShards(files, weights, 4);
    const loads = bins.map((bin) => bin.reduce((s, f) => s + (weights[f] ?? 0), 0));
    // Heaviest shard carries the 100ms file and nothing else.
    expect(Math.max(...loads)).toBe(100);
    const strideLoads = [0, 1, 2, 3].map((idx) =>
      strideSlice(files, idx, 4).reduce((s, f) => s + (weights[f] ?? 0), 0),
    );
    expect(Math.max(...strideLoads)).toBeGreaterThan(100);
  });

  test("rejects a non-positive or non-integer total", () => {
    expect(() => planShards(["a"], {}, 0)).toThrow(/positive integer/);
    expect(() => planShards(["a"], {}, 2.5)).toThrow(/positive integer/);
  });
});

describe("planShards — unknown files get the median known weight", () => {
  test("an unknown file lands as if it weighed the median", () => {
    // Known: 10, 4, 2 (median 4). Unknown 'u' behaves exactly like weight 4.
    const files = ["a", "b", "c", "u"];
    const bins = planShards(files, { a: 10, b: 4, c: 2 }, 2);
    const expected = planShards(files, { a: 10, b: 4, c: 2, u: 4 }, 2);
    expect(bins).toEqual(expected);
  });

  test("no known weights at all degenerates to a balanced count split", () => {
    const bins = planShards(["a", "b", "c", "d"], {}, 2);
    expect(bins[0]!.length).toBe(2);
    expect(bins[1]!.length).toBe(2);
  });

  test("negative / non-finite manifest entries are treated as unknown", () => {
    const files = ["a", "b"];
    const bins = planShards(files, { a: -5, b: Number.NaN }, 2);
    expect(bins.flat().sort()).toEqual(["a", "b"]);
  });
});

describe("strideSlice", () => {
  test("matches the historical awk mapping (NR 1-based: NR % tot == idx)", () => {
    const files = ["a", "b", "c", "d", "e"];
    // awk NR%2==0 → lines 2,4; NR%2==1 → lines 1,3,5.
    expect(strideSlice(files, 0, 2)).toEqual(["b", "d"]);
    expect(strideSlice(files, 1, 2)).toEqual(["a", "c", "e"]);
  });

  test("slices partition the input", () => {
    const files = Array.from({ length: 13 }, (_, i) => `f${i}`);
    const all = [0, 1, 2].flatMap((idx) => strideSlice(files, idx, 3)).sort();
    expect(all).toEqual([...files].sort());
  });
});

describe("parseManifest", () => {
  test("accepts the committed envelope", () => {
    const m = parseManifest('{"version":1,"source":"x","timingsMs":{"a":12}}');
    expect(m?.timingsMs.a).toBe(12);
  });

  test("rejects junk, empty timings, and non-JSON", () => {
    expect(parseManifest("")).toBeNull();
    expect(parseManifest("not json")).toBeNull();
    expect(parseManifest("null")).toBeNull();
    expect(parseManifest('{"version":1,"source":"x","timingsMs":{}}')).toBeNull();
    expect(parseManifest('{"version":1,"source":"x"}')).toBeNull();
  });
});

describe("CLI — the seam shard_slice runs", () => {
  function runCli(stdin: string, args: string[]): { out: string; err: string; code: number } {
    const proc = Bun.spawnSync(["bun", "scripts/shard-plan.ts", ...args], {
      cwd: REPO_ROOT,
      stdin: Buffer.from(stdin),
    });
    return { out: proc.stdout.toString(), err: proc.stderr.toString(), code: proc.exitCode };
  }

  test("missing manifest → stride fallback, exit 0, stderr note", () => {
    const { out, err, code } = runCli("b\na\nc\n", ["0", "2", "/nonexistent/manifest.json"]);
    expect(code).toBe(0);
    expect(err).toContain("stride fallback");
    // Input is sorted first (a,b,c); stride idx 0 of 2 → line 2 → "b".
    expect(out.trim().split("\n")).toEqual(["b"]);
  });

  test("with a manifest → LPT plan for the requested shard", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-plan-test-"));
    const manifest = join(dir, "timings.json");
    writeFileSync(
      manifest,
      JSON.stringify({ version: 1, source: "test", timingsMs: { a: 10, b: 9, c: 8, d: 3, e: 2, f: 1 } }),
    );
    const zero = runCli("a\nb\nc\nd\ne\nf\n", ["0", "2", manifest]);
    const one = runCli("a\nb\nc\nd\ne\nf\n", ["1", "2", manifest]);
    expect(zero.code).toBe(0);
    expect(zero.out.trim().split("\n")).toEqual(["a", "d", "e", "f"]);
    expect(one.out.trim().split("\n")).toEqual(["b", "c"]);
  });

  test("bad args → exit 2 (lets shard_slice's bash stride fallback engage)", () => {
    expect(runCli("a\n", ["7", "4"]).code).toBe(2);
    expect(runCli("a\n", ["x", "4"]).code).toBe(2);
    expect(runCli("a\n", ["0"]).code).toBe(2);
  });
});
