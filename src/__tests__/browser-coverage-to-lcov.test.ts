import { expect, test } from "bun:test";
import { coverageToLcov } from "../../scripts/browser-coverage-to-lcov";

const route = "web/src/routes/+page.svelte";
const code = "const rendered = true;\nfunction unclicked() { return false; }\n";
const routeMap = JSON.stringify({
  version: 3,
  file: "route.js",
  sources: ["../../../../src/routes/+page.svelte"],
  sourcesContent: [code],
  names: [],
  mappings: "AAAA;AACA",
});
const covered = [
  { functionName: "root", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }] },
  { functionName: "unclicked", isBlockCoverage: true, ranges: [{ startOffset: 23, endOffset: code.length - 1, count: 0 }] },
];

test("AST conversion preserves an unexecuted original handler as DA:0", async () => {
  const lcov = await coverageToLcov({
    result: [{ url: "http://app/_app/route.js", functions: covered }],
    expectedRouteFiles: [route],
  }, async () => ({ code, map: routeMap }));
  expect(lcov).toContain("DA:1,1");
  expect(lcov).toContain("DA:2,0");
});

test("AST conversion distinguishes a loaded Svelte template from an unexecuted handler", async () => {
  type CompileResult = { js: { code: string; map: { toString(): string } } };
  type SvelteCompiler = { compile(source: string, options: { filename: string; generate: "client"; dev: boolean }): CompileResult };
  const compiler = await import(new URL("../../web/node_modules/svelte/compiler/index.js", import.meta.url).href) as SvelteCompiler;
  const { compile } = compiler;
  const source = `<script>\nlet clicked = false;\nfunction unclicked() {\n  clicked = true;\n}\n</script>\n<button onclick={unclicked}>Click</button>`;
  const compiled = compile(source, { filename: "+page.svelte", generate: "client", dev: false });
  const map = JSON.parse(compiled.js.map.toString());
  map.sources = ["../../../../src/routes/+page.svelte"];
  const start = compiled.js.code.indexOf("function unclicked");
  const end = compiled.js.code.indexOf("\n\t}\n\n\tvar button", start) + 3;
  const lcov = await coverageToLcov({
    result: [{ url: "http://app/_app/compiled-route.js", functions: [{ functionName: "root", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: compiled.js.code.length, count: 1 }] }, { functionName: "unclicked", isBlockCoverage: true, ranges: [{ startOffset: start, endOffset: end, count: 0 }] }] }],
    expectedRouteFiles: [route],
  }, async () => ({ code: compiled.js.code, map: JSON.stringify(map) }));
  expect(lcov).toContain("DA:2,1");
  expect(lcov).toContain("DA:4,0");
  expect(lcov).toContain("DA:7,1");
});

test("browser converter rejects a missing source map", async () => {
  await expect(coverageToLcov({ result: [{ url: "http://app/_app/route.js", functions: [] }] }, async () => ({ code: "", map: null }))).rejects.toThrow("no source map");
});

test("browser converter rejects a raw set with no original browser source", async () => {
  const map = JSON.stringify({ version: 3, sources: ["../../../src/other.ts"], sourcesContent: ["const x = 1"], names: [], mappings: "AAAA" });
  await expect(coverageToLcov({ result: [{ url: "http://app/_app/route.js", functions: [] }] }, async () => ({ code: "const x = 1", map }))).rejects.toThrow("no original Svelte route or shared-library records");
});

test("browser converter rejects a requested source absent from raw browser records", async () => {
  await expect(coverageToLcov({
    result: [{ url: "http://app/_app/route.js", functions: covered }],
    expectedFiles: ["web/src/routes/missing/+page.svelte"],
  }, async () => ({ code, map: routeMap }))).rejects.toThrow("expected source has no mapped DA record");
});

test("checks missing routes even when a canonical shared source has mapped DA", async () => {
  const sharedSource = "web/src/lib/empty-node-shim.ts";
  const sharedMap = JSON.stringify({
    ...JSON.parse(routeMap),
    sources: ["../../../../src/lib/empty-node-shim.ts"],
  });
  await expect(coverageToLcov({
    result: [{ url: "http://app/_app/shared.js", functions: covered }],
    expectedFiles: [sharedSource],
    expectedRouteFiles: ["web/src/routes/missing/+page.svelte"],
  }, async () => ({ code, map: sharedMap }))).rejects.toThrow(
    "expected source has no mapped DA record: web/src/routes/missing/+page.svelte",
  );
});

test("rejects an expected route with mapped but only zero-hit DA records", async () => {
  const noHit = [{
    functionName: "root",
    isBlockCoverage: true,
    ranges: [{ startOffset: 0, endOffset: code.length, count: 0 }],
  }];
  await expect(coverageToLcov({
    result: [{ url: "http://app/_app/unvisited-route.js", functions: noHit }],
    expectedRouteFiles: [route],
  }, async () => ({ code, map: routeMap }))).rejects.toThrow(
    "expected source has only zero-hit DA records",
  );
});

test("resolves nested Vite map sources against the emitted chunk", async () => {
  const nestedMap = JSON.stringify({
    ...JSON.parse(routeMap),
    sources: ["../../../../../../src/routes/+page.svelte"],
  });
  const lcov = await coverageToLcov({
    result: [{ url: "http://app/_app/immutable/nodes/route.js", functions: covered }],
    expectedRouteFiles: [route],
  }, async () => ({ code, map: nestedMap }));
  expect(lcov).toContain(`SF:${process.cwd()}/${route}`);
});

import { BROWSER_CANONICAL_SOURCES, BROWSER_V8_COVERAGE_PRODUCER, isExcluded } from "../../scripts/coverage-config";
import { assertBrowserCanonicalSources, assertCompleteRouteInventory, currentBrowserCoverageExpectation, scriptedRouteFiles } from "../../scripts/browser-route-coverage-manifest";

test("final browser manifests must enumerate every scripted Svelte route", () => {
	const routes = scriptedRouteFiles();
	expect(currentBrowserCoverageExpectation()).toEqual({
		routes,
		files: [...BROWSER_CANONICAL_SOURCES],
	});
	// 64 at the merge base 31052930d, plus one route from each side: the wave's and main's settings/github page.
	expect(routes).toHaveLength(66);
  expect(routes).toContain("web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte");
  expect(() => assertCompleteRouteInventory(routes.slice(1))).toThrow("browser coverage route inventory is incomplete");
  expect(() => assertCompleteRouteInventory([...routes, "web/src/routes/removed/+page.svelte"])).toThrow("extra=");
	expect(() => assertBrowserCanonicalSources([])).toThrow("browser coverage source inventory is incomplete");
	expect(() => assertBrowserCanonicalSources(BROWSER_CANONICAL_SOURCES)).not.toThrow();
});

test("browser converter marks AST receipts with the shared browser producer", async () => {
  const lcov = await coverageToLcov({
    result: [{ url: "http://app/_app/route.js", functions: covered }],
    expectedRouteFiles: [route],
  }, async () => ({ code, map: routeMap }));
  expect(lcov).toStartWith(`TN:${BROWSER_V8_COVERAGE_PRODUCER}`);
});

test("every scripted route has an enforced per-file floor", async () => {
  const thresholds = await Bun.file(new URL("../../scripts/coverage-thresholds.json", import.meta.url)).json() as Record<string, number>;
  const exactHundred = new Set([
    "web/src/routes/(app)/factories/+page.svelte",
    "web/src/routes/(app)/extensions/[id]/preview/+page.svelte",
    "web/src/routes/(app)/extensions/import-source/+page.svelte",
    "web/src/routes/(app)/extensions/project-proposals/[id]/+page.svelte",
    "web/src/routes/(app)/settings/github/+page.svelte",
  ]);

  for (const route of scriptedRouteFiles()) {
    expect(isExcluded(route)).toBe(false);
    expect(thresholds[route]).toBe(exactHundred.has(route) ? 100 : 80);
  }
});

import { mergeRawCoverage } from "../../scripts/browser-coverage-to-lcov";

test("merges same-build CDP ranges before one AST conversion", async () => {
  const first = {
    buildId: "immutable-build-a",
    result: [{ url: "http://app/_app/chunk.js", functions: [{ functionName: "root", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] }] }],
    expectedRouteFiles: [route],
    testsWithApplicationScripts: 1,
  };
  const second = {
    buildId: "immutable-build-a",
    result: [{ url: "http://app/_app/chunk.js", functions: [{ functionName: "root", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 10, count: 2 }] }] }],
    expectedFiles: ["web/src/lib/empty-node-shim.ts"],
    testsWithApplicationScripts: 1,
    testsWithoutApplicationScripts: 2,
  };
  const merged = await mergeRawCoverage([first, second]);
  expect(merged.result).toHaveLength(1);
  expect(merged.result[0]!.functions[0]!.ranges[0]!.count).toBe(3);
  expect(merged.expectedRouteFiles).toEqual([route]);
  expect(merged.expectedFiles).toEqual(["web/src/lib/empty-node-shim.ts"]);
  expect(merged.testsWithApplicationScripts).toBe(2);
  expect(merged.testsWithoutApplicationScripts).toBe(2);
});

test("keeps expected sources from a zero-script checkpoint", async () => {
  const merged = await mergeRawCoverage([
    {
      buildId: "immutable-build-a",
      result: [],
      expectedRouteFiles: [route],
      expectedFiles: ["web/src/lib/empty-node-shim.ts"],
      testsWithoutApplicationScripts: 1,
    },
    {
      buildId: "immutable-build-a",
      result: [{ url: "http://app/_app/chunk.js", functions: [] }],
      testsWithApplicationScripts: 1,
    },
  ]);
  expect(merged.expectedRouteFiles).toEqual([route]);
  expect(merged.expectedFiles).toEqual(["web/src/lib/empty-node-shim.ts"]);
  expect(merged.testsWithApplicationScripts).toBe(1);
  expect(merged.testsWithoutApplicationScripts).toBe(1);
  await expect(coverageToLcov(merged, async () => ({ code: "", map: null }))).rejects.toThrow("no source map");
});

test("refuses browser raw coverage from different or unnamed builds", async () => {
  await expect(mergeRawCoverage([{ buildId: "a", result: [] }, { buildId: "b", result: [] }])).rejects.toThrow("buildId");
  await expect(mergeRawCoverage([{ result: [] }, { result: [] }])).rejects.toThrow("buildId");
});

test("preserves matching source revisions and refuses mixed provenance", async () => {
  const first = { buildId: "a", sourceRevision: "a".repeat(40), result: [] };
  const second = { buildId: "a", sourceRevision: "a".repeat(40), result: [] };
  expect((await mergeRawCoverage([first, second])).sourceRevision).toBe("a".repeat(40));
  await expect(mergeRawCoverage([first, { ...second, sourceRevision: "b".repeat(40) }])).rejects.toThrow("sourceRevision");
  await expect(mergeRawCoverage([first, { buildId: "a", result: [] }])).rejects.toThrow("sourceRevision");
});

import { repairUnmappedLookups } from "../../scripts/browser-coverage-to-lcov";
import realChunk from "./fixtures/browser-coverage-unmapped-end/active-agents-chunk.json" with { type: "json" };

type ViteParser = { parseAstAsync(code: string): Promise<unknown> };
const parseAst = async (code: string) =>
  ((await import(new URL("../../web/node_modules/vite/dist/node/index.js", import.meta.url).href)) as ViteParser).parseAstAsync(code);

function lineHits(lcov: string, sourceSuffix: string): Map<number, number> {
  const record = lcov.split("end_of_record").find((entry) => entry.includes(sourceSuffix)) ?? "";
  return new Map([...record.matchAll(/^DA:(\d+),(\d+)$/gm)].map(([, line, hits]) => [Number(line), Number(hits)]));
}

test("a function whose last character starts an unmapped segment keeps its statement (rolldown 1.2.15 chunk)", async () => {
  // The `row` snippet of ActiveAgentsList.svelte ran 5 times in CI, but its end-1 lookup lands on the unmapped
  // segment rolldown writes at its closing brace, so the converter used to drop it: no DA:79 at all.
  const lcov = await coverageToLcov({ result: [{ url: realChunk.url, functions: realChunk.functions }] }, async () => ({
    code: realChunk.code,
    map: JSON.stringify(realChunk.map),
  }));
  const hits = lineHits(lcov, "web/src/lib/components/ActiveAgentsList.svelte");
  expect(hits.get(79)).toBe(5);
  // Lines V8 proves never ran (count 0 at every generated position) must stay misses: no borrowed hit comes back.
  for (const line of [111, 136, 137, 138]) expect(hits.get(line)).toBe(0);
});

test("repairs an unmapped end lookup with the node's own last mapped segment and closes the range after it", async () => {
  // As in rolldown's chunks, the line ends on an unmapped segment, so today's walk back finds nothing either and
  // the converter drops `f`.
  const code = "function f(){b()} x; ";
  const lines = [[[0, 0, 0, 0], [13, 0, 1, 2], [16], [18, 0, 2, 0], [20]]];
  const { lines: repaired, repaired: count } = repairUnmappedLookups(code, lines, await parseAst(code));
  expect(count).toBe(1);
  // `}` (16) now resolves to `b()` inside the function; 17 is unmapped again, so `x` and the space keep today's lookup.
  expect(repaired).toEqual([[[0, 0, 0, 0], [13, 0, 1, 2], [16, 0, 1, 2], [17], [18, 0, 2, 0], [20]]]);
  expect(lines[0]![2]).toEqual([16]);
});

test("leaves a lookup that resolves today alone, even when it resolves past the node", async () => {
  // Today's walk back resolves `f`'s end to `x` (the line's last segment is mapped), so `f` is kept: no repair.
  const code = "function f(){b()} x;";
  const lines = [[[0, 0, 0, 0], [13, 0, 1, 2], [16], [18, 0, 2, 0]]];
  expect(repairUnmappedLookups(code, lines, await parseAst(code))).toEqual({ lines, repaired: 0 });
});

test("closes a repaired range that ends the mapped line", async () => {
  const code = "function f(){b()} ";
  const { lines: repaired } = repairUnmappedLookups(code, [[[0, 0, 0, 0], [13, 0, 1, 2], [16]]], await parseAst(code));
  expect(repaired).toEqual([[[0, 0, 0, 0], [13, 0, 1, 2], [16, 0, 1, 2], [17]]]);
});

test("never borrows a mapping from outside the node and leaves resolving lookups alone", async () => {
  // `g` has no mapped segment of its own: today's lookup fails and the repair must not invent one from `x()` or `y()`.
  const code = "x();function g(){}y();";
  const lines = [[[0, 0, 0, 0], [4], [18, 0, 1, 0]]];
  const result = repairUnmappedLookups(code, lines, await parseAst(code));
  expect(result.repaired).toBe(0);
  expect(result.lines).toEqual(lines);
  // A node whose start and end-1 already resolve to mapped segments is untouched.
  const plain = "a();b();";
  const mapped = [[[0, 0, 0, 0], [4, 0, 1, 0]]];
  expect(repairUnmappedLookups(plain, mapped, await parseAst(plain))).toEqual({ lines: mapped, repaired: 0 });
});
