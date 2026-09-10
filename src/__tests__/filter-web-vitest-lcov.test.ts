import { expect, test } from "bun:test";
import { filterWebVitestLcov } from "../../scripts/filter-web-vitest-lcov.ts";
import { filterLcovSources } from "../../scripts/filter-lcov-sources.ts";
import { REPO_ROOT } from "../../scripts/coverage-config.ts";

const allowed = new Set(["web/src/lib/covered.ts", "web/src/lib/uncovered.svelte"]);

test("retains configured product records, including a real zero-hit DA", () => {
  const result = filterWebVitestLcov([
    "TN:ezcorp-node-v8",
    `SF:${REPO_ROOT}/web/src/lib/covered.ts`,
    "DA:1,1",
    "end_of_record",
    "TN:ezcorp-node-v8",
    `SF:${REPO_ROOT}/web/src/lib/uncovered.svelte`,
    "DA:20,0",
    "end_of_record",
    "TN:ezcorp-node-v8",
    `SF:${REPO_ROOT}/web/src/lib/__tests__/fixture.ts`,
    "DA:1,0",
    "end_of_record",
    "TN:ezcorp-node-v8",
    `SF:${REPO_ROOT}/web/src/lib/styles.css`,
    "DA:1,0",
    "end_of_record",
  ].join("\n"), allowed);

  expect(result).toContain(`SF:${REPO_ROOT}/web/src/lib/covered.ts`);
  expect(result).toContain(`SF:${REPO_ROOT}/web/src/lib/uncovered.svelte\nDA:20,0`);
  expect(result).not.toContain("fixture.ts");
  expect(result).not.toContain("styles.css");
});

test("normalizes relative source paths before deciding product ownership", () => {
  const result = filterWebVitestLcov("SF:web/src/lib/covered.ts\nDA:1,1\nend_of_record\n", allowed);
  expect(result).toContain("SF:web/src/lib/covered.ts");
});

test("generic source filter preserves the trusted producer tag", () => {
  const result = filterLcovSources("TN:ezcorp-node-v8\nSF:worker/src/index.ts\nDA:1,1\nend_of_record\n", new Set(["worker/src/index.ts"]));
  expect(result).toBe("TN:ezcorp-node-v8\nSF:worker/src/index.ts\nDA:1,1\nend_of_record\n");
});
