import { describe, expect, test } from "bun:test";

interface Job {
  uses?: string;
  if?: string;
  needs?: string[];
  steps?: Array<{ run?: string }>;
}

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../.github/workflows/ci.yml", import.meta.url)).text(),
) as { jobs: Record<string, Job> };

test("external Postgres runs through the required Backend tests check", async () => {
  expect(workflow.jobs["external-postgres"]?.uses).toBe("./.github/workflows/db-postgres.yml");
  expect(workflow.jobs["backend-tests"]?.needs).toContain("external-postgres");
  const postgres = Bun.YAML.parse(
    await Bun.file(new URL("../../.github/workflows/db-postgres.yml", import.meta.url)).text(),
  ) as { on: Record<string, unknown> };
  expect(Object.keys(postgres.on)).toEqual(["workflow_call"]);
});

for (const name of ["backend-tests", "e2e-mock"]) {
  describe(`${name} required result aggregation`, () => {
    const job = workflow.jobs[name];
    const dependencies = job?.needs ?? [];
    const commands = job?.steps?.flatMap((step) => step.run ? [step.run] : []) ?? [];

    test("runs even when a dependency fails", () => {
      expect(job?.if).toBe("always()");
      expect(dependencies.length).toBeGreaterThan(0);
      expect(commands.length).toBeGreaterThan(0);
    });

    function run(results: Record<string, string>): number {
      const script = commands.join("\n").replace(
        /\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}/g,
        (_expression, dependency: string) => {
          if (!(dependency in results)) throw new Error(`Unknown dependency ${dependency}`);
          return results[dependency]!;
        },
      );
      // Execute the actual workflow shell, including its failure branch.
      const process = Bun.spawnSync(["bash", "-e", "-c", script]);
      return process.exitCode;
    }

    const success = Object.fromEntries(dependencies.map((dependency) => [dependency, "success"]));
    test("all successful dependencies allow success", () => {
      expect(run(success)).toBe(0);
    });

    for (const dependency of dependencies) {
      test.each(["failure", "cancelled", "skipped"])(`${dependency}=%s fails the required check`, (result) => {
        expect(run({ ...success, [dependency]: result })).toBe(1);
      });
    }
  });
}
