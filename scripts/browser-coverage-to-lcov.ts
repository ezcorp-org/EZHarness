#!/usr/bin/env bun
/** Convert Chromium precise coverage into AST-derived original-source LCOV. */
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import convert from "../web/node_modules/ast-v8-to-istanbul/dist/index.mjs";
import { createCoverageMap } from "../web/node_modules/istanbul-lib-coverage/index.js";
import { parseAstAsync } from "../web/node_modules/vite/dist/node/index.js";
import { REPO_ROOT } from "./coverage-config.ts";

export type Range = { startOffset: number; endOffset: number; count: number };
export type ScriptCoverage = { url: string; functions: Array<{ ranges: Range[] }> };
export type RawCoverage = { result: ScriptCoverage[]; expectedRouteFiles?: string[]; expectedFiles?: string[] };
export type AssetReader = (url: string) => Promise<{ code: string; map: string | null }>;
type SourceMap = { version: 3; sources: string[]; sourcesContent?: Array<string | null>; mappings: string; names?: string[] };

function repoFile(path: string): string {
  return relative(REPO_ROOT, path).replaceAll("\\", "/");
}
function isBrowserSource(file: string): boolean {
  return (file.startsWith("web/src/routes/") && file.endsWith(".svelte")) ||
    file.startsWith("web/src/lib/");
}
function expectedSources(raw: RawCoverage): string[] {
  return raw.expectedFiles ?? raw.expectedRouteFiles ?? [];
}
function outputLcov(coverage: ReturnType<typeof createCoverageMap>): string {
  let output = "";
  for (const path of coverage.files().sort()) {
    const file = repoFile(path);
    if (!isBrowserSource(file)) continue;
    const lines = coverage.fileCoverageFor(path).getLineCoverage();
    if (Object.keys(lines).length === 0) continue;
    output += `TN:\nSF:${resolve(REPO_ROOT, file)}\n`;
    for (const [line, hits] of Object.entries(lines).sort(([a], [b]) => Number(a) - Number(b))) {
      output += `DA:${line},${hits}\n`;
    }
    output += "end_of_record\n";
  }
  return output;
}

/**
 * Uses the same AST-aware V8-to-Istanbul converter that Vitest uses. It maps
 * executable statements, functions, and branches, rather than marking every
 * source-map point hit merely because its generated root range executed.
 */
export async function coverageToLcov(raw: RawCoverage, readAsset: AssetReader): Promise<string> {
  const coverage = createCoverageMap({});
  for (const script of raw.result) {
    const { code, map: encodedMap } = await readAsset(script.url);
    if (!encodedMap) throw new Error(`browser coverage: ${script.url} has no source map`);
    let sourceMap: SourceMap;
    try {
      sourceMap = JSON.parse(encodedMap) as SourceMap;
    } catch {
      throw new Error(`browser coverage: ${script.url} has an invalid source map`);
    }
    if (sourceMap.version !== 3 || !Array.isArray(sourceMap.sources) || typeof sourceMap.mappings !== "string") {
      throw new Error(`browser coverage: ${script.url} has an invalid source-map shape`);
    }
    const asset = resolve(REPO_ROOT, "web/build/client", new URL(script.url).pathname.replace(/^\//, ""));
    let converted: Record<string, unknown>;
    try {
      converted = await convert({
        ast: parseAstAsync(code),
        code,
        coverage: { url: pathToFileURL(asset).href, functions: script.functions },
        sourceMap,
      }) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`browser coverage: ${script.url} cannot be AST-remapped: ${error instanceof Error ? error.message : String(error)}`);
    }
    coverage.merge(converted);
  }
  const lcov = outputLcov(coverage);
  if (!lcov) throw new Error("browser coverage: no original Svelte route or shared-library records");
  const files = new Set([...lcov.matchAll(/^SF:(.+)$/gm)].map((match) => repoFile(match[1]!)));
  for (const expected of expectedSources(raw)) {
    if (!isBrowserSource(expected)) throw new Error(`browser coverage: invalid expected source ${expected}`);
    if (!files.has(expected)) throw new Error(`browser coverage: expected source has no mapped DA record: ${expected}`);
  }
  return lcov;
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
