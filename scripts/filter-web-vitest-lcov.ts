#!/usr/bin/env bun
/**
 * Keep only the Node/V8 producer's configured product-source records.
 *
 * Vitest's `coverage.include=src/lib/**` correctly asks V8 to discover every
 * shared library, but its LCOV also contains imported test fixtures, CSS, and
 * source-map assets. Those are not product sources and must not change a
 * product threshold's denominator. The allowed set comes from the same full
 * manifest that the fail-closed source guard expands; this is not a legacy
 * allowlist. Zero-hit DA records are retained so uncovered product code
 * remains visible to check-coverage.
 */
import { filterLcovSources } from "./filter-lcov-sources.ts";
import { canonicalWebVitestSources } from "./check-web-vitest-coverage.ts";

/** Preserve complete LCOV records only for product sources in `allowed`. */
export function filterWebVitestLcov(lcov: string, allowed: ReadonlySet<string>): string {
  return filterLcovSources(lcov, allowed);
}

async function main(args: string[]): Promise<void> {
  if (args.length < 1 || args.length > 3 || (args.length === 3 && args[1] !== "--output")) {
    throw new Error("usage: filter-web-vitest-lcov.ts <input.lcov> [--output <output.lcov>]");
  }
  const input = args[0]!;
  const output = args[1] === "--output" ? args[2]! : input;
  const allowed = new Set(await canonicalWebVitestSources());
  const filtered = filterWebVitestLcov(await Bun.file(input).text(), allowed);
  if (!filtered) throw new Error("Node/V8 LCOV has no configured product-source records");
  await Bun.write(output, filtered);
  console.log(`kept ${[...filtered.matchAll(/^SF:/gm)].length} configured Node/V8 product-source records → ${output}`);
}

if (import.meta.main) await main(process.argv.slice(2));
