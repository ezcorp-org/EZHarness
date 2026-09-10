#!/usr/bin/env bun
/** Convert Chromium precise coverage plus Vite source maps into original-source LCOV. */
import { dirname, relative, resolve } from "node:path";
import { REPO_ROOT } from "./coverage-config.ts";

export type Range = { startOffset: number; endOffset: number; count: number };
export type ScriptCoverage = { url: string; functions: Array<{ ranges: Range[] }> };
export type RawCoverage = { result: ScriptCoverage[]; expectedRouteFiles?: string[] };
export type AssetReader = (url: string) => Promise<{ code: string; map: string | null }>;

type Lines = Map<string, Map<number, number>>;
type SourceMap = { version: 3; sources: string[]; sourceRoot?: string; mappings: string };
type Mapping = { generatedLine: number; generatedColumn: number; source: number; originalLine: number };

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function lineStarts(code: string): number[] {
  const starts = [0];
  for (let index = 0; index < code.length; index++) if (code[index] === "\n") starts.push(index + 1);
  return starts;
}
function offsetAt(starts: number[], line: number, column: number): number {
  return (starts[line - 1] ?? Number.MAX_SAFE_INTEGER) + column;
}
function hitAt(ranges: readonly Range[], offset: number): number {
  // Precise coverage ranges nest. A zero-hit child wins over a hit parent so
  // an unexecuted branch stays DA:0 instead of becoming fabricated coverage.
  const matches = ranges.filter((range) => range.startOffset <= offset && offset < range.endOffset);
  if (matches.length === 0) return 0;
  const narrowest = Math.min(...matches.map((range) => range.endOffset - range.startOffset));
  return matches.some((range) => range.endOffset - range.startOffset === narrowest && range.count === 0) ? 0 : 1;
}
function add(lines: Lines, file: string, line: number, hit: number) {
  const record = lines.get(file) ?? new Map<number, number>();
  lines.set(file, record);
  record.set(line, Math.max(record.get(line) ?? 0, hit));
}
function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const character of segment) {
    const digit = BASE64.indexOf(character);
    if (digit < 0) throw new Error(`invalid source-map VLQ character ${JSON.stringify(character)}`);
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    values.push((value & 1) === 1 ? -(value >> 1) : value >> 1);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) throw new Error("truncated source-map VLQ segment");
  return values;
}
/** Decode the standard v3 mapping stream without a second, unpinned dependency. */
function decodeMappings(map: SourceMap): Mapping[] {
  const decoded: Mapping[] = [];
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  for (const [lineIndex, encodedLine] of map.mappings.split(";").entries()) {
    let generatedColumn = 0;
    for (const segment of encodedLine.split(",")) {
      if (!segment) continue;
      const fields = decodeVlq(segment);
      generatedColumn += fields[0] ?? 0;
      if (fields.length === 1) continue;
      if (fields.length < 4) throw new Error("invalid source-map segment without an original position");
      source += fields[1]!;
      originalLine += fields[2]!;
      originalColumn += fields[3]!;
      if (source < 0 || source >= map.sources.length || originalLine < 0 || originalColumn < 0) throw new Error("invalid source-map original position");
      decoded.push({ generatedLine: lineIndex + 1, generatedColumn, source, originalLine: originalLine + 1 });
    }
  }
  return decoded;
}
function repoRouteFile(map: SourceMap, sourceIndex: number, scriptUrl: string): string | null {
  const sourceName = map.sources[sourceIndex]!;
  const withRoot = map.sourceRoot ? `${map.sourceRoot.replace(/\/$/, "")}/${sourceName}` : sourceName;
  const source = withRoot.startsWith("file:") ? new URL(withRoot).pathname : withRoot;
  // Source-map `sources` entries are relative to the generated asset/map,
  // rather than to the Vite project root. Resolve from the exact client asset
  // URL that Chromium executed, then reject anything outside a route source.
  const assetDirectory = dirname(new URL(scriptUrl).pathname);
  const absolute = resolve(REPO_ROOT, "web/build/client", assetDirectory.replace(/^\//, ""), source);
  const file = relative(REPO_ROOT, absolute).replaceAll("\\", "/");
  return file.startsWith("web/src/routes/") && file.endsWith(".svelte") ? file : null;
}
/**
 * Fail-closed conversion: every supplied application script needs an original
 * source map and every requested route needs a DA record. Application chunks
 * that contain only shared code are valid and add no route record. The
 * collector must supply only `/_app/` scripts, never vendor/CDN scripts.
 */
export async function coverageToLcov(raw: RawCoverage, readAsset: AssetReader): Promise<string> {
  const lines: Lines = new Map();
  for (const script of raw.result) {
    const { code, map: encodedMap } = await readAsset(script.url);
    if (!encodedMap) throw new Error(`browser coverage: ${script.url} has no source map`);
    let map: SourceMap;
    try {
      map = JSON.parse(encodedMap) as SourceMap;
    } catch {
      throw new Error(`browser coverage: ${script.url} has an invalid source map`);
    }
    if (map.version !== 3 || !Array.isArray(map.sources) || typeof map.mappings !== "string") throw new Error(`browser coverage: ${script.url} has an invalid source-map shape`);
    const starts = lineStarts(code);
    const ranges = script.functions.flatMap((func) => func.ranges);
    for (const mapping of decodeMappings(map)) {
      const file = repoRouteFile(map, mapping.source, script.url);
      if (!file) continue;
      add(lines, file, mapping.originalLine, hitAt(ranges, offsetAt(starts, mapping.generatedLine, mapping.generatedColumn)));
    }
    // A Vite application chunk may contain only runtime/shared modules. It is
    // source-mapped and therefore auditable, but it has no route DA to emit.
  }
  if (lines.size === 0) throw new Error("browser coverage: no original Svelte route records");
  for (const expected of raw.expectedRouteFiles ?? []) {
    if (!expected.startsWith("web/src/routes/") || !expected.endsWith(".svelte")) throw new Error(`browser coverage: invalid expected route ${expected}`);
    if (!lines.has(expected)) throw new Error(`browser coverage: expected route has no mapped DA record: ${expected}`);
  }
  let output = "";
  for (const [file, record] of [...lines].sort(([left], [right]) => left.localeCompare(right))) {
    output += `TN:\nSF:${resolve(REPO_ROOT, file)}\n`;
    for (const [line, hits] of [...record].sort(([left], [right]) => left - right)) output += `DA:${line},${hits}\n`;
    output += "end_of_record\n";
  }
  return output;
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("usage: browser-coverage-to-lcov.ts <raw.json> <output.lcov>");
  const raw = await Bun.file(input).json() as RawCoverage;
  const assetRoot = resolve(REPO_ROOT, "web/build/client");
  await Bun.write(output, await coverageToLcov(raw, async (url) => {
    const assetPath = new URL(url).pathname.replace(/^\//, "");
    const code = await Bun.file(resolve(assetRoot, assetPath)).text();
    const match = code.match(/sourceMappingURL=([^\s]+)/);
    const map = match ? await Bun.file(resolve(assetRoot, assetPath.replace(/[^/]+$/, match[1]!))).text() : null;
    return { code, map };
  }));
}
