#!/usr/bin/env bun
/** Convert Chromium precise coverage into AST-derived original-source LCOV. */
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Profiler } from "node:inspector";
import { REPO_ROOT } from "./coverage-config.ts";

export type Range = Profiler.CoverageRange;
export type ScriptCoverage = Pick<Profiler.ScriptCoverage, "url" | "functions">;
export type RawCoverage = { result: ScriptCoverage[]; expectedRouteFiles?: string[]; expectedFiles?: string[]; buildId?: string };
export type AssetReader = (url: string) => Promise<{ code: string; map: string | null }>;
type SourceMap = {
  version: 3;
  sources: string[];
  sourcesContent?: Array<string | null>;
  mappings: string;
  names: string[];
  sourceRoot?: string;
};
type CoverageMap = {
  files(): string[];
  fileCoverageFor(path: string): { getLineCoverage(): Record<string, number> };
  merge(data: Record<string, unknown>): void;
};
type AstConverter = (input: {
  ast: unknown;
  code: string;
  coverage: Pick<Profiler.ScriptCoverage, "url" | "functions">;
  sourceMap: SourceMap;
}) => Promise<Record<string, unknown>>;
type BrowserCoverageModules = {
  convert: AstConverter;
  createCoverageMap: () => CoverageMap;
  parseAstAsync: (code: string) => Promise<unknown>;
  mergeProcessCovs: (coverages: Array<{ result: ScriptCoverage[] }>) => { result: ScriptCoverage[] };
};

/** Load the browser-only transitive packages without making root typecheck
 * resolve deep web workspace paths, which have no declaration entry point. */
const browserCoverageModules: Promise<BrowserCoverageModules> = (async () => {
  const webModules = resolve(REPO_ROOT, "web/node_modules");
  const astModule = await import(pathToFileURL(resolve(webModules, "ast-v8-to-istanbul/dist/index.mjs")).href) as unknown as { default: AstConverter };
  const istanbulModule = await import(pathToFileURL(resolve(webModules, "istanbul-lib-coverage/index.js")).href) as unknown as { createCoverageMap: () => CoverageMap };
  const viteModule = await import(pathToFileURL(resolve(webModules, "vite/dist/node/index.js")).href) as unknown as { parseAstAsync: (code: string) => Promise<unknown> };
  const v8MergeModule = await import(pathToFileURL(resolve(webModules, "@bcoe/v8-coverage/src/lib/index.js")).href) as unknown as { mergeProcessCovs: (coverages: Array<{ result: ScriptCoverage[] }>) => { result: ScriptCoverage[] } };
  return {
    convert: astModule.default,
    createCoverageMap: istanbulModule.createCoverageMap,
    parseAstAsync: viteModule.parseAstAsync,
    mergeProcessCovs: v8MergeModule.mergeProcessCovs,
  };
})();

function repoFile(path: string): string {
  return relative(REPO_ROOT, path).replaceAll("\\", "/");
}

/** Vite writes map `sources` relative to the emitted chunk. ast-v8-to-istanbul
 * preserves those paths, so make their original-source location explicit before
 * conversion; otherwise nested `/_app/immutable/**` chunks disappear at output. */
function resolveSourceMapSources(sourceMap: SourceMap, asset: string): SourceMap {
  const root = sourceMap.sourceRoot
    ? (isAbsolute(sourceMap.sourceRoot) ? sourceMap.sourceRoot : resolve(dirname(asset), sourceMap.sourceRoot))
    : dirname(asset);
  return {
    ...sourceMap,
    sources: sourceMap.sources.map((source) =>
      isAbsolute(source) ? source : resolve(root, source),
    ),
    sourceRoot: undefined,
  };
}
function isBrowserSource(file: string): boolean {
  return (file.startsWith("web/src/routes/") && file.endsWith(".svelte")) ||
    file.startsWith("web/src/lib/");
}
function expectedSources(raw: RawCoverage): string[] {
  return raw.expectedFiles ?? raw.expectedRouteFiles ?? [];
}

/**
 * Merge precise CDP ranges once per immutable browser build, before expensive
 * AST/source-map conversion. @bcoe/v8-coverage preserves nested range counts
 * by script URL. A build ID is mandatory for multi-receipt merges so coverage
 * from different generated assets can never be attributed to one source map.
 */
export async function mergeRawCoverage(receipts: readonly RawCoverage[]): Promise<RawCoverage> {
  if (receipts.length === 0) throw new Error("browser coverage: no raw receipts to merge");
  if (receipts.length === 1) return receipts[0]!;
  const buildIds = new Set(receipts.map((receipt) => receipt.buildId).filter((id): id is string => Boolean(id)));
  if (buildIds.size !== 1 || receipts.some((receipt) => !receipt.buildId)) {
    throw new Error("browser coverage: raw receipts must share one non-empty immutable buildId before merge");
  }
  const { mergeProcessCovs } = await browserCoverageModules;
  // The library normalizes/mutates input ranges; keep the caller's receipts
  // intact because they are audit artifacts.
  const copies = receipts.map((receipt) => structuredClone({ result: receipt.result }));
  const expectedRouteFiles = [...new Set(receipts.flatMap((receipt) => receipt.expectedRouteFiles ?? []))].sort();
  const expectedFiles = [...new Set(receipts.flatMap((receipt) => receipt.expectedFiles ?? []))].sort();
  return {
    result: mergeProcessCovs(copies).result,
    buildId: [...buildIds][0],
    ...(expectedRouteFiles.length ? { expectedRouteFiles } : {}),
    ...(expectedFiles.length ? { expectedFiles } : {}),
  };
}
function outputLcov(coverage: CoverageMap): string {
  let output = "";
  for (const path of coverage.files().sort()) {
    const file = repoFile(path);
    if (!isBrowserSource(file)) continue;
    const lines = coverage.fileCoverageFor(path).getLineCoverage();
    if (Object.keys(lines).length === 0) continue;
    output += `TN:ezcorp-browser-v8\nSF:${resolve(REPO_ROOT, file)}\n`;
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
  const { convert, createCoverageMap, parseAstAsync } = await browserCoverageModules;
  const coverage = createCoverageMap();
  const assets = new Map<string, Promise<{ code: string; sourceMap: SourceMap; ast: unknown }>>();
  for (const script of raw.result) {
    const assetPath = new URL(script.url).pathname.replace(/^\//, "");
    // adapter-bun copies `.svelte-kit/output/client` into `build/client`, but
    // Vite's map paths remain relative to the pre-copy source directory.
    const generatedAsset = resolve(REPO_ROOT, "web/build/client", assetPath);
    const sourceMapAsset = resolve(REPO_ROOT, "web/.svelte-kit/output/client", assetPath);
    let cached = assets.get(script.url);
    if (!cached) {
      cached = (async () => {
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
        return { code, sourceMap: resolveSourceMapSources(sourceMap, sourceMapAsset), ast: await parseAstAsync(code) };
      })();
      assets.set(script.url, cached);
    }
    const { code, sourceMap, ast } = await cached;
    let converted: Record<string, unknown>;
    try {
      converted = await convert({
        ast,
        code,
        coverage: { url: pathToFileURL(generatedAsset).href, functions: script.functions },
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
  const [first, ...rest] = process.argv.slice(2);
  if (first === "--merge-raw") {
    const [output, ...inputs] = rest;
    if (!output || inputs.length === 0) throw new Error("usage: browser-coverage-to-lcov.ts --merge-raw <output.json> <raw.json>...");
    const receipts = await Promise.all(inputs.map(async (input) => Bun.file(input).json() as Promise<RawCoverage>));
    await Bun.write(output, JSON.stringify(await mergeRawCoverage(receipts)) + "\n");
    console.log(`merged ${receipts.length} browser raw receipt(s) → ${output}`);
    process.exit(0);
  }
  const input = first;
  const output = rest[0];
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
