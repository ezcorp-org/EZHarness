#!/usr/bin/env bun
/** Convert Chromium precise coverage into AST-derived original-source LCOV. */
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Profiler } from "node:inspector";
import { BROWSER_V8_COVERAGE_PRODUCER, REPO_ROOT } from "./coverage-config.ts";

export type Range = Profiler.CoverageRange;
export type ScriptCoverage = Pick<Profiler.ScriptCoverage, "url" | "functions">;
export type RawCoverage = {
  result: ScriptCoverage[];
  expectedRouteFiles?: string[];
  expectedFiles?: string[];
  buildId?: string;
  sourceRevision?: string;
  testsWithApplicationScripts?: number;
  testsWithoutApplicationScripts?: number;
};
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
  decodeMappings: (mappings: string) => Segment[][];
  encodeMappings: (lines: Segment[][]) => string;
};

/** One decoded source-map segment: `[generatedColumn]` is an explicit unmapped segment. */
export type Segment = number[];

/** Load the browser-only transitive packages without making root typecheck
 * resolve deep web workspace paths, which have no declaration entry point. */
const browserCoverageModules: Promise<BrowserCoverageModules> = (async () => {
  const webModules = resolve(REPO_ROOT, "web/node_modules");
  const astModule = await import(pathToFileURL(resolve(webModules, "ast-v8-to-istanbul/dist/index.mjs")).href) as unknown as { default: AstConverter };
  const istanbulModule = await import(pathToFileURL(resolve(webModules, "istanbul-lib-coverage/index.js")).href) as unknown as { createCoverageMap: () => CoverageMap };
  const viteModule = await import(pathToFileURL(resolve(webModules, "vite/dist/node/index.js")).href) as unknown as { parseAstAsync: (code: string) => Promise<unknown> };
  const v8MergeModule = await import(pathToFileURL(resolve(webModules, "@bcoe/v8-coverage/src/lib/index.js")).href) as unknown as { mergeProcessCovs: (coverages: Array<{ result: ScriptCoverage[] }>) => { result: ScriptCoverage[] } };
  const codecModule = await import(pathToFileURL(resolve(webModules, "@jridgewell/sourcemap-codec/dist/sourcemap-codec.mjs")).href) as unknown as { decode: (mappings: string) => Segment[][]; encode: (lines: Segment[][]) => string };
  return {
    convert: astModule.default,
    createCoverageMap: istanbulModule.createCoverageMap,
    parseAstAsync: viteModule.parseAstAsync,
    mergeProcessCovs: v8MergeModule.mergeProcessCovs,
    decodeMappings: codecModule.decode,
    encodeMappings: codecModule.encode,
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
  // The fixture records routes and non-route browser sources independently.
  // Both are mandatory; `??` here would silently discard every route whenever
  // the canonical shared-source list is also present.
  return [...new Set([
    ...(raw.expectedRouteFiles ?? []),
    ...(raw.expectedFiles ?? []),
  ])].sort();
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
  const sourceRevisions = new Set(receipts.map((receipt) => receipt.sourceRevision).filter((revision): revision is string => Boolean(revision)));
  if (sourceRevisions.size > 1 || (sourceRevisions.size === 1 && receipts.some((receipt) => !receipt.sourceRevision))) {
    throw new Error("browser coverage: raw receipts must share one sourceRevision when provenance is present");
  }
  const { mergeProcessCovs } = await browserCoverageModules;
  // The library normalizes/mutates input ranges; keep the caller's receipts
  // intact because they are audit artifacts.
  const copies = receipts.map((receipt) => structuredClone({ result: receipt.result }));
  const expectedRouteFiles = [...new Set(receipts.flatMap((receipt) => receipt.expectedRouteFiles ?? []))].sort();
  const expectedFiles = [...new Set(receipts.flatMap((receipt) => receipt.expectedFiles ?? []))].sort();
  const testsWithApplicationScripts = receipts.reduce(
    (total, receipt) => total + (receipt.testsWithApplicationScripts ?? 0),
    0,
  );
  const testsWithoutApplicationScripts = receipts.reduce(
    (total, receipt) => total + (receipt.testsWithoutApplicationScripts ?? 0),
    0,
  );
  return {
    result: mergeProcessCovs(copies).result,
    buildId: [...buildIds][0],
    ...(sourceRevisions.size === 1 ? { sourceRevision: [...sourceRevisions][0] } : {}),
    ...(expectedRouteFiles.length ? { expectedRouteFiles } : {}),
    ...(expectedFiles.length ? { expectedFiles } : {}),
    ...(testsWithApplicationScripts || testsWithoutApplicationScripts
      ? { testsWithApplicationScripts, testsWithoutApplicationScripts }
      : {}),
  };
}
function outputLcov(coverage: CoverageMap): string {
  let output = "";
  for (const path of coverage.files().sort()) {
    const file = repoFile(path);
    if (!isBrowserSource(file)) continue;
    const lines = coverage.fileCoverageFor(path).getLineCoverage();
    if (Object.keys(lines).length === 0) continue;
    output += `TN:${BROWSER_V8_COVERAGE_PRODUCER}\nSF:${resolve(REPO_ROOT, file)}\n`;
    for (const [line, hits] of Object.entries(lines).sort(([a], [b]) => Number(a) - Number(b))) {
      output += `DA:${line},${hits}\n`;
    }
    output += "end_of_record\n";
  }
  return output;
}

/** AST node types whose location ast-v8-to-istanbul 1.0.7 looks up (its walker), plus the branch arms it locates. */
const LOCATED_NODE_TYPES = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "MethodDefinition", "Property",
  "ExpressionStatement", "BreakStatement", "ContinueStatement", "DebuggerStatement", "ReturnStatement",
  "ThrowStatement", "TryStatement", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement",
  "DoWhileStatement", "WithStatement", "LabeledStatement", "VariableDeclarator", "ClassBody", "IfStatement",
  "SwitchStatement", "SwitchCase", "ConditionalExpression", "LogicalExpression", "AssignmentPattern",
  "BlockStatement",
]);

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };

function locatedNodes(ast: unknown): AstNode[] {
  const nodes: AstNode[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as AstNode;
    if (typeof node.type === "string" && typeof node.start === "number" && typeof node.end === "number" && node.end > node.start) {
      if (LOCATED_NODE_TYPES.has(node.type)) nodes.push(node);
      // A branch arm is located even when its own type is not in the walker's list (`a ? b() : c`).
      for (const arm of [node.consequent, node.alternate]) {
        if (arm && typeof arm === "object" && (node.type === "ConditionalExpression" || node.type === "IfStatement")) nodes.push(arm as AstNode);
      }
      if (node.type === "LogicalExpression") for (const side of [node.left, node.right]) nodes.push(side as AstNode);
    }
    for (const [key, child] of Object.entries(node)) if (key !== "parent") visit(child);
  };
  visit(ast);
  return nodes;
}

/**
 * ast-v8-to-istanbul resolves a node's start and its end-1 with the nearest source-map segment at or before that
 * position, and when that one is unmapped, with the first segment after it. Rolldown (vite 8.3.3+) writes explicit
 * unmapped segments at many statement boundaries. When a node's last character starts one, the end lookup returns
 * nothing, the walk back finds no mapped line end in a one-line chunk, and the converter DROPS the node although it
 * ran (#357: the `row` snippet of ActiveAgentsList.svelte, count 5).
 *
 * This repairs only that failing end lookup, and only for a node whose start is mapped inside the node: it inserts
 * a copy of the node's last MAPPED segment at end-1, then an unmapped segment right after it, so no position after
 * the node changes. When nodes share the end, the copy comes from the intersection of their ranges, so it lies
 * inside each of them. Every lookup that resolves today is left exactly as it is, and a node with an unmapped start
 * stays dropped, so the repair only restores a node at the line where its own code starts.
 */
export function repairUnmappedLookups(code: string, lines: Segment[][], ast: unknown): { lines: Segment[][]; repaired: number } {
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") lineStarts.push(i + 1);
  const position = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low, column: offset - lineStarts[low]! };
  };
  const offsetOf = (line: number, column: number) => lineStarts[line]! + column;
  const segmentsOf = (line: number) => lines[line] ?? [];
  // Today's lookup (ast-v8-to-istanbul getPosition): the segment at or before the position; when that one is
  // unmapped, the first segment at or after it. Null when neither is mapped.
  const resolves = (line: number, column: number): boolean => {
    let before: Segment | undefined;
    let after: Segment | undefined;
    for (const segment of segmentsOf(line)) {
      if (segment[0]! <= column) before = segment;
      else if (!after) after = segment;
    }
    if (before && before.length >= 4) return true;
    const retry = before?.[0] === column ? before : after;
    return !!retry && retry.length >= 4;
  };
  const mappedIn = (start: number, end: number, last: boolean): Segment | undefined => {
    let found: Segment | undefined;
    const from = position(start).line;
    const to = position(end - 1).line;
    for (let line = from; line <= to; line++) {
      for (const segment of segmentsOf(line)) {
        const offset = offsetOf(line, segment[0]!);
        if (offset < start || offset >= end || segment.length < 4) continue;
        if (!last) return segment;
        found = segment;
      }
    }
    return found;
  };

  // Repair only an END lookup that fails today (end-1 does not resolve, and neither does the walk back with column
  // Infinity from the end's line to the start's), and only for a node whose start resolves today to a mapped segment
  // INSIDE the node. A node whose start is unmapped stays dropped: its next mapped segment can lie in code that
  // never ran, and restoring the node would put its count on that line.
  const startMappedInside = (node: AstNode) => {
    const { line, column } = position(node.start);
    let before: Segment | undefined;
    for (const segment of segmentsOf(line)) if (segment[0]! <= column) before = segment;
    return !!before && before.length >= 4 && offsetOf(line, before[0]!) >= node.start;
  };
  const endFails = (node: AstNode) => {
    const { line, column } = position(node.end - 1);
    if (resolves(line, column)) return false;
    for (let back = line; back >= position(node.start).line; back--) if (resolves(back, Number.POSITIVE_INFINITY)) return false;
    return true;
  };

  // Every repairable node, grouped by its end-1 position. The copy must lie inside ALL of them, so it comes from the
  // intersection of their ranges: the last mapped segment there.
  const failing = new Map<number, { start: number; end: number }>();
  for (const node of locatedNodes(ast)) {
    if (!startMappedInside(node) || !endFails(node)) continue;
    const offset = node.end - 1;
    const group = failing.get(offset) ?? { start: node.start, end: node.end };
    group.start = Math.max(group.start, node.start);
    group.end = Math.min(group.end, node.end);
    failing.set(offset, group);
  }

  const repaired = lines.map((line) => line.map((segment) => [...segment]));
  const insert = (offset: number, segment: Segment) => {
    const { line, column } = position(offset);
    const target = (repaired[line] ??= []);
    const index = target.findIndex((existing) => existing[0]! >= column);
    if (index === -1) target.push(segment);
    else if (target[index]![0] === column) target[index] = segment;
    else target.splice(index, 0, segment);
  };
  const segmentStartsAt = (offset: number) => {
    const { line, column } = position(offset);
    return (repaired[line] ?? []).some((segment) => segment[0] === column);
  };
  let count = 0;
  for (const [offset, group] of [...failing].sort((a, b) => a[0] - b[0])) {
    const source = mappedIn(group.start, group.end, true);
    if (!source) continue;
    insert(offset, [position(offset).column, source[1]!, source[2]!, source[3]!]);
    if (group.end < code.length && !segmentStartsAt(group.end)) insert(group.end, [position(group.end).column]);
    count++;
  }
  return { lines: repaired, repaired: count };
}

/**
 * Uses the same AST-aware V8-to-Istanbul converter that Vitest uses. It maps
 * executable statements, functions, and branches, rather than marking every
 * source-map point hit merely because its generated root range executed.
 */
export async function coverageToLcov(raw: RawCoverage, readAsset: AssetReader): Promise<string> {
  const { convert, createCoverageMap, parseAstAsync, decodeMappings, encodeMappings } = await browserCoverageModules;
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
        const ast = await parseAstAsync(code);
        const { lines } = repairUnmappedLookups(code, decodeMappings(sourceMap.mappings), ast);
        return { code, sourceMap: resolveSourceMapSources({ ...sourceMap, mappings: encodeMappings(lines) }, sourceMapAsset), ast };
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
  const recordEvidence = new Map<string, { hasDa: boolean; hasHit: boolean }>();
  for (const record of lcov.split("end_of_record")) {
    const source = record.match(/^SF:(.+)$/m)?.[1];
    if (!source) continue;
    const evidence = {
      hasDa: /^DA:\d+,\d+$/m.test(record),
      hasHit: /^DA:\d+,[1-9]\d*$/m.test(record),
    };
    recordEvidence.set(repoFile(source), evidence);
  }
  const missing: string[] = [];
  const zeroOnly: string[] = [];
  for (const expected of expectedSources(raw)) {
    if (!isBrowserSource(expected)) throw new Error(`browser coverage: invalid expected source ${expected}`);
    const evidence = recordEvidence.get(expected);
    if (!evidence?.hasDa) missing.push(expected);
    else if (!evidence.hasHit) zeroOnly.push(expected);
  }
  if (missing.length) throw new Error(`browser coverage: expected source has no mapped DA record: ${missing.join(", ")}`);
  if (zeroOnly.length) throw new Error(`browser coverage: expected source has only zero-hit DA records: ${zeroOnly.join(", ")}`);
  return lcov;
}

/** Convert a receipt against the current adapter-bun build assets. */
export async function coverageToLcovFromBuild(raw: RawCoverage): Promise<string> {
  const assetRoot = resolve(REPO_ROOT, "web/build/client");
  return coverageToLcov(raw, async (url) => {
    const assetPath = new URL(url).pathname.replace(/^\//, "");
    const code = await Bun.file(resolve(assetRoot, assetPath)).text();
    const match = code.match(/sourceMappingURL=([^\s]+)/);
    const map = match ? await Bun.file(resolve(assetRoot, assetPath.replace(/[^/]+$/, match[1]!))).text() : null;
    return { code, map };
  });
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
  await Bun.write(output, await coverageToLcovFromBuild(raw));
}
