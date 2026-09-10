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

import { assertBrowserCanonicalSources, assertCompleteRouteInventory, currentBrowserCoverageExpectation, scriptedRouteFiles } from "../../scripts/browser-route-coverage-manifest";

test("final browser manifests must enumerate every scripted Svelte route", () => {
	const routes = scriptedRouteFiles();
	expect(currentBrowserCoverageExpectation()).toEqual({
		routes,
		files: [],
	});
	expect(routes).toHaveLength(64);
  expect(routes).toContain("web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte");
  expect(() => assertCompleteRouteInventory(routes.slice(1))).toThrow("browser coverage route inventory is incomplete");
  expect(() => assertCompleteRouteInventory([...routes, "web/src/routes/removed/+page.svelte"])).toThrow("extra=");
	expect(() => assertBrowserCanonicalSources([])).not.toThrow();
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
