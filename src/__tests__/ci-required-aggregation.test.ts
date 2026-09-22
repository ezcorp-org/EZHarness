import { describe, expect, test } from "bun:test";

interface Job {
  uses?: string;
  if?: string;
  needs?: string[];
  "timeout-minutes"?: number;
  steps?: Array<{ name?: string; run?: string; uses?: string }>;
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

test("Apple Bash setup installs the root workspace before running the behavior suite", async () => {
  const job = workflow.jobs["setup-podman-bash32"];
  expect(job?.["timeout-minutes"]).toBe(5);
  expect(job?.steps).toHaveLength(3);
  expect(job?.steps?.[0]?.uses).toMatch(/^actions\/checkout@/);
  expect(job?.steps?.[1]?.uses).toBe("./.github/actions/setup");
  expect(job?.steps?.[2]).toMatchObject({
    name: "Run setup behavior under Apple Bash 3.2",
    run: "bun test --timeout 30000 ./src/__tests__/setup-podman.test.ts",
  });
  expect(job?.steps?.some((step) => step.uses?.startsWith("oven-sh/setup-bun@"))).toBe(false);

  const setup = Bun.YAML.parse(
    await Bun.file(new URL("../../.github/actions/setup/action.yml", import.meta.url)).text(),
  ) as { runs?: { steps?: Array<{ run?: string }> } };
  expect(setup.runs?.steps?.some((step) => step.run === "bun install --frozen-lockfile")).toBe(true);
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
