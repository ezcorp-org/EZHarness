import { expect, test } from "bun:test";
import { REPO_ROOT } from "../../scripts/coverage-config";
import { configuredWebVitestSources, lcovSourceFiles, missingWebLibCoverage, webVitestIncludePatterns } from "../../scripts/check-web-vitest-coverage";

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
