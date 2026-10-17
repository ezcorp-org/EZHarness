/**
 * W4H-27: ci.yml builds the factory image and runs the shipped-isolation guard on that very image.
 *
 * The W16 G7 Compose proof passed on an image whose SWC addon needed no cache; nothing started a later
 * image under the shipped flags, so the 1.16.13 carrier broke every installation unseen. This keeps the
 * guard on every change: the job must build deploy/factory/Dockerfile, run the guard against the tag it
 * built, and stay bounded. The guard itself reads the flags (scripts/check-factory-image-shipped-config.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const JOB = "factory-image-shipped-isolation";

interface Job { readonly "runs-on"?: unknown; readonly "timeout-minutes"?: unknown; readonly steps?: readonly { readonly run?: string; readonly uses?: string }[] }

export function shippedIsolationJobIssues(workflow: string): string[] {
  const job = (Bun.YAML.parse(workflow) as { jobs?: Record<string, Job> }).jobs?.[JOB];
  if (!job) return [`no ${JOB} job`];
  const runs = (job.steps ?? []).map((step) => step.run ?? "");
  const build = runs.map((run) => /^podman build -f deploy\/factory\/Dockerfile .* -t (\S+) \.$/.exec(run.trim())).find((match) => match !== null);
  const checked = runs.map((run) => /^bun scripts\/check-factory-image-shipped-config\.ts (\S+)$/.exec(run.trim())).find((match) => match !== null);
  const issues: string[] = [];
  if (!build) issues.push("the job does not build deploy/factory/Dockerfile with podman");
  if (!checked) issues.push("the job does not run the shipped-isolation guard");
  if (build && checked && build[1] !== checked[1]) issues.push("the guard runs on another image than the one the job built");
  if (build && checked && runs.findIndex((run) => run.startsWith("bun scripts/check-factory-image-shipped-config.ts")) < runs.findIndex((run) => run.startsWith("podman build"))) issues.push("the guard runs before the build");
  if (!(job.steps ?? []).some((step) => step.uses === "./.github/actions/setup")) issues.push("the job does not install the pinned Bun and dependencies");
  if (job["runs-on"] !== "ubuntu-latest") issues.push("the job does not run on a hosted runner");
  if (!Number.isSafeInteger(job["timeout-minutes"]) || (job["timeout-minutes"] as number) > 60) issues.push("the job has no bound of at most 60 minutes");
  return issues;
}

describe("the shipped-isolation job", () => {
  test("ci.yml builds the factory image and runs the guard on it, bounded", async () => {
    expect(shippedIsolationJobIssues(await readFile(".github/workflows/ci.yml", "utf8"))).toEqual([]);
  });

  test("fails closed by name when the job, the build, the guard, the tag, the order, the setup or the bound drifts", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(shippedIsolationJobIssues(workflow.replace(`  ${JOB}:\n`, "  renamed-job:\n"))).toEqual([`no ${JOB} job`]);
    expect(shippedIsolationJobIssues(workflow.replace("podman build -f deploy/factory/Dockerfile", "podman build -f Dockerfile"))).toContain("the job does not build deploy/factory/Dockerfile with podman");
    expect(shippedIsolationJobIssues(workflow.replace("run: bun scripts/check-factory-image-shipped-config.ts", "run: echo"))).toContain("the job does not run the shipped-isolation guard");
    expect(shippedIsolationJobIssues(workflow.replace("check-factory-image-shipped-config.ts localhost/ezcorp-factory:shipped-isolation", "check-factory-image-shipped-config.ts localhost/ezcorp-factory:other"))).toContain("the guard runs on another image than the one the job built");
    const swapped = workflow.replace(/( {6}- name: Build the factory image\n {8}run: [^\n]+\n)( {6}- name: Run the orchestrator's workflow path under the shipped isolation\n {8}run: [^\n]+\n)/, "$2$1");
    expect(swapped).not.toBe(workflow);
    expect(shippedIsolationJobIssues(swapped)).toContain("the guard runs before the build");
    const job = workflow.slice(workflow.indexOf(`  ${JOB}:\n`));
    const mutate = (from: string, to: string) => workflow.replace(job, job.replace(from, to));
    expect(shippedIsolationJobIssues(mutate("uses: ./.github/actions/setup", "uses: ./.github/actions/other"))).toContain("the job does not install the pinned Bun and dependencies");
    expect(shippedIsolationJobIssues(mutate("runs-on: ubuntu-latest", "runs-on: [self-hosted]"))).toContain("the job does not run on a hosted runner");
    expect(shippedIsolationJobIssues(mutate("timeout-minutes: 45", "timeout-minutes: 600"))).toContain("the job has no bound of at most 60 minutes");
  });
});
