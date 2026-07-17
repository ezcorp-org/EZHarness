/**
 * LPT (longest-processing-time) shard planner for the CI coverage shards
 * (wave 3, CI audit item 3.2).
 *
 * The old stride slice (`NR % total == index`) ignored per-file cost and
 * structurally overloaded shards 1+3 by ~35-40s. This planner assigns files
 * to shards greedily by measured duration: sort by weight descending, always
 * give the next file to the least-loaded shard. Weights come from
 * scripts/shard-timings.json (regenerate: see that file's `source` field);
 * files absent from the manifest get the MEDIAN known weight, so a brand-new
 * test file lands sensibly instead of skewing a shard.
 *
 * Deterministic by construction: input is buffered + sorted, ties break on
 * (weight desc, path asc) for ordering and lowest-shard-index for placement.
 * Every caller on every shard therefore computes the SAME global plan and
 * takes its own row — no coordination needed.
 *
 * CLI: `some_files | bun scripts/shard-plan.ts INDEX TOTAL [MANIFEST]`.
 * A missing/unparseable/empty manifest falls back to the stride slice
 * (stderr note, exit 0) so a manifest problem can never zero out a shard;
 * scripts/lib/test-file-sets.sh's shard_slice adds a bash-side stride
 * fallback for the only remaining failure mode (bun itself crashing).
 */

export interface TimingsManifest {
  version: number;
  /** Human note: where/when the numbers came from. */
  source: string;
  /** Repo-relative test file path → wall-clock ms (per-file isolated run). */
  timingsMs: Record<string, number>;
}

/** Median of a non-empty number list (average of the two middles for even n). */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Greedy LPT over the whole file list. Returns all `total` bins so callers
 * (and tests) can assert the full partition; the CLI prints one bin.
 * `weights` maps file → ms; files not in the map weigh the median of the
 * known weights among `files` (or 1 when nothing is known — degenerating to
 * a deterministic balanced-count split).
 */
export function planShards(
  files: string[],
  weights: Record<string, number>,
  total: number,
): string[][] {
  if (!Number.isInteger(total) || total <= 0) {
    throw new Error(`shard total must be a positive integer, got ${total}`);
  }
  const known = files.map((f) => weights[f]).filter((w): w is number => typeof w === "number" && Number.isFinite(w) && w >= 0);
  const fallback = known.length > 0 ? median(known) : 1;
  const weighted = files.map((file) => ({
    file,
    w: typeof weights[file] === "number" && Number.isFinite(weights[file]) && weights[file]! >= 0 ? weights[file]! : fallback,
  }));
  // Stable, input-order-independent ordering: weight desc, then path asc.
  weighted.sort((a, b) => b.w - a.w || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const bins: string[][] = Array.from({ length: total }, () => []);
  const loads = new Array<number>(total).fill(0);
  for (const { file, w } of weighted) {
    let target = 0;
    for (let i = 1; i < total; i++) {
      if (loads[i]! < loads[target]!) target = i; // strict < → lowest index wins ties
    }
    bins[target]!.push(file);
    loads[target]! += w;
  }
  // Each bin sorted for stable, diff-friendly output.
  for (const bin of bins) bin.sort();
  return bins;
}

/** The legacy stride slice (`i % total == index` over the sorted list) —
 *  kept as the fallback when no usable manifest exists. */
export function strideSlice(files: string[], index: number, total: number): string[] {
  // awk's NR is 1-based; preserve the exact historical mapping.
  return files.filter((_, i) => (i + 1) % total === index);
}

export function parseManifest(text: string): TimingsManifest | null {
  try {
    const parsed = JSON.parse(text) as TimingsManifest;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.timingsMs !== "object" ||
      parsed.timingsMs === null ||
      Object.keys(parsed.timingsMs).length === 0
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const [indexArg, totalArg, manifestArg] = process.argv.slice(2);
  const index = Number(indexArg);
  const total = Number(totalArg);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total <= 0 || index >= total) {
    console.error(`shard-plan: bad args (index=${indexArg} total=${totalArg})`);
    process.exit(2);
  }
  const manifestPath = manifestArg || "scripts/shard-timings.json";

  const files = (await new Response(Bun.stdin.stream()).text())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();

  const manifest = parseManifest(await Bun.file(manifestPath).text().catch(() => ""));
  let slice: string[];
  if (manifest === null) {
    console.error(`shard-plan: no usable timings manifest at ${manifestPath} — stride fallback`);
    slice = strideSlice(files, index, total);
  } else {
    slice = planShards(files, manifest.timingsMs, total)[index]!;
  }
  for (const f of slice) console.log(f);
}

if (import.meta.main) {
  await main();
}
