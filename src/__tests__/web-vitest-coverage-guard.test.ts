import { Glob } from "bun";
import { expect, test } from "bun:test";
import { dirname, relative, resolve } from "node:path";
import { BROWSER_CANONICAL_SOURCES, REPO_ROOT, WEB_VITEST_CANONICAL_SOURCES } from "../../scripts/coverage-config";
import { scriptedRouteFiles } from "../../scripts/browser-route-coverage-manifest";
import { canonicalWebVitestSources, configuredWebVitestSources, lcovSourceFiles, missingWebLibCoverage, webVitestIncludePatterns } from "../../scripts/check-web-vitest-coverage";

test("normalizes relative and absolute Vitest LCOV source paths", () => {
  const files = lcovSourceFiles(`SF:web/src/lib/a.ts\nDA:1,1\nend_of_record\nSF:${REPO_ROOT}/web/src/lib/b.ts\nDA:1,1`);
  expect(files).toEqual(new Set(["web/src/lib/a.ts", "web/src/lib/b.ts"]));
});

test("requires a syntactically valid DA record before accepting an SF block", () => {
  const files = lcovSourceFiles([
    "SF:web/src/lib/empty.ts",
    "end_of_record",
    "SF:web/src/lib/malformed-line.ts",
    "DA:zero,1",
    "end_of_record",
    "SF:web/src/lib/malformed-hits.ts",
    "DA:1,nope",
    "end_of_record",
    "SF:web/src/lib/real.ts",
    "DA:1,0",
    "end_of_record",
  ].join("\n"));
  expect(files).toEqual(new Set(["web/src/lib/real.ts"]));
});

test("requires records for executable files but permits declaration-only TypeScript", async () => {
  const missing = await missingWebLibCoverage(
    ["web/src/lib/covered.ts", "web/src/lib/types.ts", "web/src/lib/View.svelte"],
    new Set(["web/src/lib/covered.ts"]),
    async (file) => file.endsWith("types.ts") ? "export interface OnlyType { id: string }" : "<script>let visible = true;</script>",
  );
  expect(missing).toEqual(["web/src/lib/View.svelte"]);
});


test("expands the shared V8 manifest routes and shared libraries", () => {
  const includes = webVitestIncludePatterns(`
    "--coverage.include=src/lib/**"
    "--coverage.include=src/routes/api/projects/[id]/+server.ts"
  `);
  expect(includes).toEqual(["src/lib/**", "src/routes/api/projects/[id]/+server.ts"]);
  const sources = configuredWebVitestSources(includes);
  expect(sources).toContain("web/src/lib/mention-logic.ts");
  expect(sources).toContain("web/src/routes/api/projects/[id]/+server.ts");
});

// The manifest is an allowlist, so a tested route left off it is executed but
// never recorded, and every coverage gate then reads it as untested (W18c,
// 2026-09-27: 15 factory API routes that factories.server.test.ts calls). Each
// factory API route a Vitest server test imports must be in the manifest.
test("every factory API route a Vitest server test imports is in the coverage manifest", async () => {
  const manifest = await Bun.file(resolve(REPO_ROOT, "scripts/web-vitest-coverage-includes.sh")).text();
  const configured = new Set(configuredWebVitestSources(webVitestIncludePatterns(manifest)));
  const imported = new Set<string>();
  for (const test of new Glob("web/src/**/*.server.test.ts").scanSync({ cwd: REPO_ROOT })) {
    const text = await Bun.file(resolve(REPO_ROOT, test)).text();
    for (const match of text.matchAll(/(?:import\(|from )\s*"(\.{1,2}\/[^"]*\+server)(?:\.ts)?"/g)) {
      const target = relative(REPO_ROOT, resolve(dirname(resolve(REPO_ROOT, test)), `${match[1]}.ts`));
      if (target.startsWith("web/src/routes/api/factories/")) imported.add(target);
    }
  }
  expect(imported.size).toBeGreaterThan(30);
  expect([...imported].filter((route) => !configured.has(route)).sort()).toEqual([]);
});

test("assigns scripted routes to browser coverage while node omissions still fail", async () => {
  const previewRoute = "web/src/routes/(app)/extensions/[id]/preview/+page.svelte";
  expect(scriptedRouteFiles()).toContain(previewRoute);
  const manifest = await Bun.file(resolve(REPO_ROOT, "scripts/web-vitest-coverage-includes.sh")).text();
  expect(configuredWebVitestSources(webVitestIncludePatterns(manifest))).toContain(previewRoute);
  expect(await canonicalWebVitestSources()).not.toContain(previewRoute);
  const missingIfNodeOwned = await missingWebLibCoverage(
    [previewRoute],
    new Set(),
    async () => "<script>const preview = true;</script>",
  );
  expect(missingIfNodeOwned).toEqual([previewRoute]);
});

test("removes every browser-canonical shared UI source from the Node/V8 manifest", async () => {
  const manifest = await Bun.file(resolve(REPO_ROOT, "scripts/web-vitest-coverage-includes.sh")).text();
  const configured = configuredWebVitestSources(webVitestIncludePatterns(manifest));
  const canonicalNode = await canonicalWebVitestSources();
  for (const source of BROWSER_CANONICAL_SOURCES) {
    expect(configured).toContain(source);
    expect(canonicalNode).not.toContain(source);
  }
});

test("every Web V8-owned source is measured by the standard Web producer", async () => {
  const measured = new Set(await canonicalWebVitestSources());
  expect(WEB_VITEST_CANONICAL_SOURCES.filter((source) => !measured.has(source))).toEqual([]);
});
