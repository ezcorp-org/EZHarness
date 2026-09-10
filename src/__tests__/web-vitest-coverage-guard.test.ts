import { expect, test } from "bun:test";
import { lcovSourceFiles, missingWebLibCoverage } from "../../scripts/check-web-vitest-coverage";

test("normalizes relative and absolute Vitest LCOV source paths", () => {
  const files = lcovSourceFiles("SF:web/src/lib/a.ts\nDA:1,1\nend_of_record\nSF:/home/dev/work/EZCorp/testing-gaps-coverage/web/src/lib/b.ts\nDA:1,1");
  expect(files).toEqual(new Set(["web/src/lib/a.ts", "web/src/lib/b.ts"]));
});

test("requires records for executable files but permits declaration-only TypeScript", async () => {
  const missing = await missingWebLibCoverage(
    ["web/src/lib/covered.ts", "web/src/lib/types.ts", "web/src/lib/View.svelte"],
    new Set(["web/src/lib/covered.ts"]),
    async (file) => file.endsWith("types.ts") ? "export interface OnlyType { id: string }" : "<script>let visible = true;</script>",
  );
  expect(missing).toEqual(["web/src/lib/View.svelte"]);
});
