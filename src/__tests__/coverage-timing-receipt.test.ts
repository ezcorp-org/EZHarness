import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildCoverageTimingReceipt,
  writeCoverageTimingReceipt,
} from "../../scripts/coverage-timing-receipt";
import { parseManifest, planShards } from "../../scripts/shard-plan";

describe("full coverage timing receipt", () => {
  test("keeps the shard timing envelope while adding named phase costs", () => {
    const receipt = buildCoverageTimingReceipt(
      "full local coverage run",
      { "src/example.test.ts": 123 },
      { hostPool: 456, producers: 789, security: 12 },
    );

    expect(receipt).toEqual({
      version: 1,
      source: "full local coverage run",
      timingsMs: { "src/example.test.ts": 123 },
      phasesMs: { hostPool: 456, producers: 789, security: 12 },
    });
    const parsed = parseManifest(JSON.stringify(receipt));
    expect(parsed?.timingsMs).toEqual({ "src/example.test.ts": 123 });
    expect(
      planShards(["src/example.test.ts"], parsed?.timingsMs ?? {}, 1),
    ).toEqual([["src/example.test.ts"]]);
  });

  test("writes the receipt to a new output directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "coverage-timing-receipt-"));
    const path = join(root, "nested", "timings-full.json");
    try {
      await writeCoverageTimingReceipt(
        path,
        buildCoverageTimingReceipt(
          "full",
          { "src/a.test.ts": 4 },
          { hostPool: 5 },
        ),
      );
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        version: 1,
        source: "full",
        timingsMs: { "src/a.test.ts": 4 },
        phasesMs: { hostPool: 5 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an invalid timing instead of writing misleading performance data", () => {
    expect(() =>
      buildCoverageTimingReceipt("run", { "a.test.ts": -1 }, { hostPool: 1 }),
    ).toThrow("timingsMs entry");
    expect(() =>
      buildCoverageTimingReceipt("run", { "a.test.ts": 1 }, { hostPool: 1.5 }),
    ).toThrow("phasesMs entry");
  });
});
