import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface WorkflowJob {
  env?: Record<string, string>;
  needs?: string[];
  outputs?: Record<string, string>;
  strategy?: { matrix?: string };
  if?: string;
  steps?: Array<{ id?: string; name?: string; run?: string }>;
}

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../.github/workflows/mutation-nightly.yml", import.meta.url)).text(),
) as { jobs: Record<string, WorkflowJob> };

const gha = (expression: string) => `\${{ ${expression} }}`;

test("nightly mutation derives its shard matrix and merge count from one value", () => {
  const planner = workflow.jobs["shard-plan"];
  const shard = workflow.jobs["mutation-shard"];
  const summary = workflow.jobs.summary;
  const plannerScript = planner?.steps?.find((step) => step.id === "shards")?.run;
  const mutationCommand = shard?.steps?.find((step) => step.name === "Mutate shard")?.run;

  expect(planner?.env?.MUTATION_SHARDS).toBe("6");
  expect(planner?.outputs).toEqual({
    count: gha("steps.shards.outputs.count"),
    matrix: gha("steps.shards.outputs.matrix"),
  });
  expect(plannerScript).toContain("range(0; $count)");

  const outputDir = mkdtempSync(join(tmpdir(), "mutation-shard-plan-"));
  try {
    const outputPath = join(outputDir, "outputs");
    const plan = Bun.spawnSync(["bash", "-euc", plannerScript ?? "exit 1"], {
      env: { ...process.env, MUTATION_SHARDS: "4", GITHUB_OUTPUT: outputPath },
    });
    expect(plan.exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe('count=4\nmatrix={"shard":[0,1,2,3]}\n');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }

  expect(shard?.needs).toEqual(["shard-plan"]);
  expect(shard?.strategy?.matrix).toBe(gha("fromJSON(needs.shard-plan.outputs.matrix)"));
  expect(mutationCommand).toContain('"$SHARD/$SHARD_TOTAL"');
  expect(summary?.needs).toEqual(["shard-plan", "mutation-shard"]);
  expect(summary?.if).toBe("always()");
  expect(summary?.env?.MUTATION_SHARDS).toBe(gha("needs.shard-plan.outputs.count"));
});
