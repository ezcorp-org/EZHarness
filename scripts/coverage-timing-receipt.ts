import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TimingsManifest } from "./shard-plan";

export interface CoverageTimingReceipt extends TimingsManifest {
  /** Wall-clock phases of one full local coverage run. */
  phasesMs: Record<string, number>;
}

function validDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertDurations(kind: string, values: Record<string, number>): void {
  for (const [name, duration] of Object.entries(values)) {
    if (!name || !validDuration(duration)) {
      throw new Error(
        `${kind} entry ${JSON.stringify(name)} must be a non-negative integer ms value`,
      );
    }
  }
}

/**
 * Uses the same `version`/`source`/`timingsMs` envelope as CI shard timing
 * artifacts. `phasesMs` is additive diagnostic data; shard-plan ignores it.
 */
export function buildCoverageTimingReceipt(
  source: string,
  timingsMs: Record<string, number>,
  phasesMs: Record<string, number>,
): CoverageTimingReceipt {
  if (!source.trim())
    throw new Error("coverage timing receipt source must be non-empty");
  assertDurations("timingsMs", timingsMs);
  assertDurations("phasesMs", phasesMs);
  return { version: 1, source, timingsMs, phasesMs };
}

/** Write a stable, reviewable receipt without changing coverage inputs. */
export async function writeCoverageTimingReceipt(
  path: string,
  receipt: CoverageTimingReceipt,
): Promise<void> {
  await Bun.write(path, `${JSON.stringify(receipt, null, "\t")}\n`);
}

function parseTsv(text: string, kind: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    const tab = line.lastIndexOf("\t");
    if (tab <= 0 || tab === line.length - 1) {
      throw new Error(`${kind} receipt line must be key<TAB>milliseconds`);
    }
    const name = line.slice(0, tab);
    const duration = Number(line.slice(tab + 1));
    if (name in values)
      throw new Error(
        `${kind} receipt contains duplicate ${JSON.stringify(name)}`,
      );
    values[name] = duration;
  }
  assertDurations(kind, values);
  return values;
}

async function main(): Promise<void> {
  const [outputPath, source, phasesPath, timingsPath] = process.argv.slice(2);
  if (!outputPath || !source || !phasesPath || !timingsPath) {
    throw new Error(
      "usage: coverage-timing-receipt.ts OUTPUT SOURCE PHASES_TSV TIMINGS_TSV",
    );
  }
  const [phasesText, timingsText] = await Promise.all([
    Bun.file(phasesPath).text(),
    Bun.file(timingsPath).text(),
  ]);
  const receipt = buildCoverageTimingReceipt(
    source,
    parseTsv(timingsText, "timingsMs"),
    parseTsv(phasesText, "phasesMs"),
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeCoverageTimingReceipt(outputPath, receipt);
}

if (import.meta.main) await main();
