#!/usr/bin/env bun
/** Keep complete LCOV records for an explicit, repository-relative source set. */
import { relative, resolve } from "node:path";
import { REPO_ROOT } from "./coverage-config.ts";

export function lcovRepositoryPath(source: string): string {
  const absolute = source.startsWith("/") ? source : resolve(REPO_ROOT, source);
  return relative(REPO_ROOT, absolute).replaceAll("\\", "/");
}

export function filterLcovSources(lcov: string, allowed: ReadonlySet<string>): string {
  const kept: string[] = [];
  for (const rawRecord of lcov.split(/end_of_record\r?\n?/)) {
    if (!rawRecord.trim()) continue;
    const lines = rawRecord.split("\n").filter((line) => line.length > 0);
    const source = lines.find((line) => line.startsWith("SF:"));
    if (!source || !allowed.has(lcovRepositoryPath(source.slice(3)))) continue;
    kept.push(`${lines.join("\n")}\nend_of_record\n`);
  }
  return kept.join("");
}

async function main(args: string[]): Promise<void> {
  const marker = args.indexOf("--output");
  if (marker !== 1 || !args[0] || !args[2] || args.length < 4) {
    throw new Error("usage: filter-lcov-sources.ts <input.lcov> --output <output.lcov> <source> [...source]");
  }
  const input = args[0];
  const output = args[2];
  const allowed = new Set(args.slice(3));
  const filtered = filterLcovSources(await Bun.file(input).text(), allowed);
  if (!filtered) throw new Error("LCOV has no requested source records");
  await Bun.write(output, filtered);
  console.log(`kept ${[...filtered.matchAll(/^SF:/gm)].length} requested LCOV source records → ${output}`);
}

if (import.meta.main) await main(process.argv.slice(2));
