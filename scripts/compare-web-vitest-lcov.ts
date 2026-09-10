#!/usr/bin/env bun
/**
 * Prove a full Vitest V8 receipt supersedes the selected receipt before the
 * selected suite can be removed. It compares source records and DA boundaries:
 * each prior source/line stays present, and every prior covered line remains
 * covered. A wider full producer may add lines or hits, never erase evidence.
 */
import { relative, resolve } from "node:path";
import { REPO_ROOT } from "./coverage-config.ts";

type LineHits = Map<number, number>;
export type LcovLines = Map<string, LineHits>;

function sourceKey(source: string): string {
  const absolute = source.startsWith("/") ? source : resolve(REPO_ROOT, source);
  const rel = relative(REPO_ROOT, absolute).replaceAll("\\", "/");
  // CI receipts can come from another worktree. The first-party web path is
  // stable across worktrees, while absolute checkout prefixes are not.
  const web = rel.indexOf("web/");
  return web >= 0 ? rel.slice(web) : rel;
}

export function parseLcovLines(lcov: string): LcovLines {
  const records: LcovLines = new Map();
  let current: LineHits | null = null;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      const key = sourceKey(line.slice(3));
      current = records.get(key) ?? new Map();
      records.set(key, current);
      continue;
    }
    if (line === "end_of_record") {
      current = null;
      continue;
    }
    if (!current || !line.startsWith("DA:")) continue;
    const [numberText, hitsText] = line.slice(3).split(",", 2);
    if (!/^[1-9]\d*$/.test(numberText ?? "") || !/^\d+$/.test(hitsText ?? "")) continue;
    const number = Number(numberText);
    const hits = Number(hitsText);
    current.set(number, (current.get(number) ?? 0) + hits);
  }
  return records;
}

export function missingSelectedEvidence(selected: LcovLines, full: LcovLines): string[] {
  const failures: string[] = [];
  for (const [source, selectedLines] of selected) {
    const fullLines = full.get(source);
    if (!fullLines) {
      failures.push(`${source}: no full-pool SF record`);
      continue;
    }
    for (const [line, selectedHits] of selectedLines) {
      const fullHits = fullLines.get(line);
      if (fullHits === undefined) {
        failures.push(`${source}:${line}: full-pool receipt has no DA record`);
      } else if (selectedHits > 0 && fullHits === 0) {
        failures.push(`${source}:${line}: selected receipt covered it but full-pool receipt did not`);
      }
    }
  }
  return failures;
}

if (import.meta.main) {
  const [selectedPath, fullPath] = process.argv.slice(2);
  if (!selectedPath || !fullPath) {
    throw new Error("usage: compare-web-vitest-lcov.ts <selected-lcov.info> <full-lcov.info>");
  }
  const selected = parseLcovLines(await Bun.file(selectedPath).text());
  const full = parseLcovLines(await Bun.file(fullPath).text());
  const failures = missingSelectedEvidence(selected, full);
  if (failures.length > 0) {
    console.error(`full Vitest receipt does not yet supersede selected receipt (${failures.length} gap(s)):`);
    for (const failure of failures.slice(0, 100)) console.error(`  ${failure}`);
    if (failures.length > 100) console.error(`  ... ${failures.length - 100} more`);
    process.exit(1);
  }
  console.log(`full Vitest receipt supersedes selected receipt: ${selected.size} source records, ${full.size} full records`);
}
