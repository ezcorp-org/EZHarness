import { expect, test } from "bun:test";
import { coverageToLcov } from "../../scripts/browser-coverage-to-lcov";

const route = "web/src/routes/+page.svelte";
const routeMap = JSON.stringify({
  version: 3,
  file: "route.js",
  sources: ["../../../src/routes/+page.svelte"],
  names: [],
  // Generated lines 1 and 2 map to original Svelte lines 3 and 4.
  mappings: "AAEA;AACA",
});

test("browser converter preserves an unexecuted mapped line as DA:0", async () => {
  const lcov = await coverageToLcov({
    result: [{ url: "http://app/_app/route.js", functions: [{ ranges: [{ startOffset: 0, endOffset: 10, count: 1 }, { startOffset: 5, endOffset: 10, count: 0 }] }] }],
    expectedRouteFiles: [route],
  }, async () => ({ code: "aaaa\nbbbb\n", map: routeMap }));
  expect(lcov).toContain("DA:3,1");
  expect(lcov).toContain("DA:4,0");
});

test("browser converter rejects a missing source map", async () => {
  await expect(coverageToLcov({ result: [{ url: "http://app/route.js", functions: [] }] }, async () => ({ code: "", map: null }))).rejects.toThrow("no source map");
});

test("browser converter rejects a raw set with no original route source", async () => {
  const map = JSON.stringify({ version: 3, sources: ["src/lib/test.ts"], names: [], mappings: "AAAA" });
  await expect(coverageToLcov({ result: [{ url: "http://app/route.js", functions: [] }] }, async () => ({ code: "", map }))).rejects.toThrow("no original Svelte route records");
});

test("browser converter rejects a requested route absent from the raw browser records", async () => {
  await expect(coverageToLcov({
    result: [{ url: "http://app/_app/route.js", functions: [] }],
    expectedRouteFiles: ["web/src/routes/missing/+page.svelte"],
  }, async () => ({ code: "aaaa\n", map: routeMap }))).rejects.toThrow("expected route has no mapped DA record");
});
