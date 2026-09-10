import { expect, test } from "bun:test";
import { coverageToLcov } from "../../scripts/browser-coverage-to-lcov";

const route = "web/src/routes/+page.svelte";
const code = "const rendered = true;\nfunction unclicked() { return false; }\n";
const routeMap = JSON.stringify({
  version: 3,
  file: "route.js",
  sources: ["../../../src/routes/+page.svelte"],
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
  map.sources = ["../../../src/routes/+page.svelte"];
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
