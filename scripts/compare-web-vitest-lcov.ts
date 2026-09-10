#!/usr/bin/env bun
/**
 * Prove a full Vitest V8 receipt supersedes the selected receipt before the
 * selected suite can be removed. It compares source records and DA boundaries:
 * each prior source/line stays present, and every prior covered line remains
 * covered. A wider full producer may add lines or hits, never erase evidence.
 */
import { relative, resolve } from "node:path";
import { BROWSER_CANONICAL_SOURCES, isDeclarationOnlyTypeScript, isExcluded, isSourceFile, REPO_ROOT } from "./coverage-config.ts";

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

export type ReceiptAudit = {
  sourceRecords: number;
  validDaRecords: number;
  malformedDaRecords: string[];
  zeroDaSources: string[];
};

export function auditLcovReceipt(lcov: string): ReceiptAudit {
  let current: string | null = null;
  let sourceRecords = 0;
  let validDaRecords = 0;
  let currentHasDa = false;
  const malformedDaRecords: string[] = [];
  const zeroDaSources: string[] = [];
  const finish = () => {
    if (current && !currentHasDa && isSourceFile(current) && !isExcluded(current)) {
      zeroDaSources.push(current);
    }
    current = null;
    currentHasDa = false;
  };
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      finish();
      current = sourceKey(line.slice(3));
      sourceRecords++;
      continue;
    }
    if (line === "end_of_record") {
      finish();
      continue;
    }
    if (!current || !line.startsWith("DA:")) continue;
    const [numberText, hitsText] = line.slice(3).split(",", 2);
    if (!/^[1-9]\d*$/.test(numberText ?? "") || !/^\d+$/.test(hitsText ?? "")) {
      malformedDaRecords.push(`${current}: ${line}`);
      continue;
    }
    currentHasDa = true;
    validDaRecords++;
  }
  finish();
  return { sourceRecords, validDaRecords, malformedDaRecords, zeroDaSources };
}

export async function receiptProblems(lcov: string, name: string): Promise<string[]> {
  const audit = auditLcovReceipt(lcov);
  const problems: string[] = [];
  if (audit.sourceRecords === 0) problems.push(`${name}: no SF records`);
  if (audit.validDaRecords === 0) problems.push(`${name}: no valid DA records`);
  for (const malformed of audit.malformedDaRecords) problems.push(`${name}: malformed DA record ${malformed}`);
  for (const source of audit.zeroDaSources) {
    if (BROWSER_CANONICAL_SOURCES.includes(source)) continue;
    const file = Bun.file(resolve(REPO_ROOT, source));
    if (await file.exists() && source.endsWith(".ts") && isDeclarationOnlyTypeScript(await file.text())) continue;
    problems.push(`${name}: executable source has no DA record: ${source}`);
  }
  return problems;
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
  const selectedText = await Bun.file(selectedPath).text();
  const fullText = await Bun.file(fullPath).text();
  const selected = parseLcovLines(selectedText);
  const full = parseLcovLines(fullText);
  const failures = [
    ...(await receiptProblems(selectedText, "selected receipt")),
    ...(await receiptProblems(fullText, "full-pool receipt")),
    ...missingSelectedEvidence(selected, full),
  ];
  if (failures.length > 0) {
    console.error(`full Vitest receipt does not yet supersede selected receipt (${failures.length} gap(s)):`);
    for (const failure of failures.slice(0, 100)) console.error(`  ${failure}`);
    if (failures.length > 100) console.error(`  ... ${failures.length - 100} more`);
    process.exit(1);
  }
  console.log(`full Vitest receipt supersedes selected receipt: ${selected.size} source records, ${full.size} full records`);
}
