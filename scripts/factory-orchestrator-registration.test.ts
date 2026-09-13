import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { DESIRED_REQUIRED_CHECKS } from "./check-required-checks";
import { SOURCE_GLOBS, V8_CANONICAL_SOURCES } from "./coverage-config";

describe("factory Temporal gate registration", () => {
  test("owns every Node orchestrator source with one canonical producer", async () => {
    const thresholds = JSON.parse(await readFile("scripts/coverage-thresholds.json", "utf8"));
    const sources = ["contracts", "definition-pages", "dispatcher", "gateway-activities", "inbox", "index", "validation", "worker", "workflow"].map((name) => `packages/@ezcorp/factory-orchestrator/src/${name}.ts`);
    expect(SOURCE_GLOBS).toContain("packages/@ezcorp/factory-orchestrator/src/**/*.ts");
    for (const source of sources) {
      expect(thresholds[source]).toBe(100);
      expect(V8_CANONICAL_SOURCES).toContain(source);
    }
  });

  test("runs the pinned real Temporal lane before accepting its coverage", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("name: Factory Temporal integration");
    expect(workflow).toContain("temporal-test-server_1.38.0_linux_amd64.tar.gz");
    expect(workflow).toContain("41df834fe8e1ac59619e13908f41b63e4d1054f37634a2f89033d8cf6af71b96");
    expect(workflow).toContain("FACTORY_TEMPORAL_TEST_SERVER: /tmp/factory-tools/temporal-test-server/temporal-test-server_1.38.0_linux_amd64/temporal-test-server");
    expect(workflow).toContain("bash scripts/factory-orchestrator-coverage.sh");
    expect(workflow).toContain("needs.factory-temporal.result");
    expect(DESIRED_REQUIRED_CHECKS).toContain("Factory Temporal integration");
  });
});
