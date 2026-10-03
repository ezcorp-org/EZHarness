import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { isSourceFile } from "../../scripts/coverage-config";

const root = resolve(import.meta.dir, "../..");

function shellSet(functionName: "passfail_files" | "coverage_host_files"): Set<string> {
  const result = Bun.spawnSync(["bash", "-lc", `source scripts/lib/test-file-sets.sh; ${functionName}`], { cwd: root });
  expect(result.exitCode).toBe(0);
  return new Set(result.stdout.toString().trim().split("\n").filter(Boolean));
}

describe("factory CI registration", () => {
  test("every factory SDK and host test has pass/fail and coverage ownership", async () => {
    const expected = [
      ...new Bun.Glob("packages/@ezcorp/factory-sdk/src/**/*.test.ts").scanSync({ cwd: root }),
      ...new Bun.Glob("src/factory/**/*.test.ts").scanSync({ cwd: root }),
      ...new Bun.Glob("src/delivery-queue/**/*.test.ts").scanSync({ cwd: root }),
      ...new Bun.Glob("scripts/check-factory-*.test.ts").scanSync({ cwd: root }),
      "scripts/check-required-checks.test.ts",
    ];
    const passFail = shellSet("passfail_files");
    const coverage = shellSet("coverage_host_files");
    for (const path of expected) {
      expect(passFail.has(path)).toBe(true);
      expect(coverage.has(path)).toBe(true);
    }
  });

  test("every factory executable source is classified and pinned at 100 percent", async () => {
    const thresholds = await Bun.file(resolve(root, "scripts/coverage-thresholds.json")).json() as Record<string, number>;
    const sources = [
      ...new Bun.Glob("packages/@ezcorp/factory-sdk/src/**/*.ts").scanSync({ cwd: root }),
      ...new Bun.Glob("src/factory/**/*.ts").scanSync({ cwd: root }),
      ...new Bun.Glob("src/delivery-queue/**/*.ts").scanSync({ cwd: root }),
    ].filter(path => !path.endsWith(".test.ts") && !path.endsWith(".d.ts"));
    for (const path of sources) {
      expect(isSourceFile(path)).toBe(true);
      expect(thresholds[path] ?? thresholds["packages/@ezcorp/factory-sdk/src/**"]).toBe(100);
    }
  });

  test("the required stage one job invokes the canonical build, boundary and test wrappers", async () => {
    const workflow = await Bun.file(resolve(root, ".github/workflows/ci.yml")).text();
    const job = workflow.slice(workflow.indexOf("  factory-schema-kernel:"), workflow.indexOf("\n  typecheck:"));
    expect(job).toContain("name: Factory schema and kernel");
    expect(job).toContain("bun run --cwd packages/@ezcorp/factory-sdk build");
    expect(job).toContain("bun scripts/check-factory-boundaries.ts");
    expect(job).toContain('FACTORY_ONLY: "1"');
    expect(job).toContain("bash scripts/test.sh");
    expect(job).not.toContain("continue-on-error");
  });
});
