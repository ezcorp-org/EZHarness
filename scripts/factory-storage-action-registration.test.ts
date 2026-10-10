/**
 * Every CI job that needs factory object storage starts and stops it through ONE composite action (W4H-5).
 *
 * Three jobs (ci.yml factory-deployment-operations; db-postgres.yml external-postgres and factory-assurance-release)
 * each carried a copy of the same start script. The action now holds it, and the image pin and the ports stay in the
 * one committed recipe: scripts/setup-factory-storage.sh and compose.factory-storage.local.yml. Hosted run
 * 37138524741 also showed the stop step running `down` in external-postgres when the start step never ran (an
 * earlier step had failed), which failed the job a second time with "Set the generated credential directory before
 * stop." A stop step therefore runs only when its job's start step ran.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ACTION = "./.github/actions/factory-storage";
const SCRIPT = "scripts/setup-factory-storage.sh";
const RECIPE = "compose.factory-storage.local.yml";
const START_ID = "factory-storage-up";
const STOP_IF = `always() && steps.${START_ID}.outcome != 'skipped'`;

interface Step { readonly id?: string; readonly uses?: string; readonly run?: string; readonly name?: string; readonly shell?: string; readonly if?: string; readonly with?: Record<string, string> }
interface Job { readonly steps?: readonly Step[] }

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function workflows(): { file: string; text: string; jobs: Record<string, Job> }[] {
  return readdirSync(join(REPO_ROOT, ".github/workflows")).filter((file) => /\.ya?ml$/.test(file)).sort().map((file) => {
    const text = read(`.github/workflows/${file}`);
    return { file, text, jobs: (Bun.YAML.parse(text) as { jobs?: Record<string, Job> }).jobs ?? {} };
  });
}

/** Each job that uses the action, with its storage steps in order. */
function storageJobs(): { where: string; steps: Step[] }[] {
  return workflows().flatMap(({ file, jobs }) => Object.entries(jobs)
    .map(([id, job]) => ({ where: `${file} ${id}`, steps: (job.steps ?? []).filter((step) => step.uses === ACTION) }))
    .filter((job) => job.steps.length > 0));
}

/** What is wrong with one job's storage steps; empty when it starts once, with the id, and stops once after, guarded. */
export function storageStepFindings(where: string, steps: readonly Step[]): string[] {
  const commands = steps.map((step) => step.with?.command);
  if (commands.join(",") !== "up,down") return [`${where}: storage commands ${JSON.stringify(commands)}, expected up then down`];
  const [start, stop] = steps;
  const findings: string[] = [];
  if (start.id !== START_ID) findings.push(`${where}: the start step's id is ${JSON.stringify(start.id)}, expected ${START_ID}`);
  if (stop.if !== STOP_IF) findings.push(`${where}: the stop step's condition is ${JSON.stringify(stop.if)}, expected ${STOP_IF}`);
  return findings;
}

describe("factory object storage in CI (W4H-5)", () => {
  test("the action runs the committed script and holds no image or port of its own", () => {
    const action = read(".github/actions/factory-storage/action.yml");
    const parsed = Bun.YAML.parse(action) as { inputs: Record<string, { required?: boolean }>; runs: { using: string; steps: Step[] } };
    expect(parsed.runs.using).toBe("composite");
    expect(parsed.inputs.command.required).toBe(true);
    expect(parsed.runs.steps).toHaveLength(1);
    const [step] = parsed.runs.steps;
    expect(step.shell).toBe("bash");
    expect(step.run).toContain(`${SCRIPT} up)`);
    expect(step.run).toContain(`${SCRIPT} down ;;`);
    // The image digest and the ports live in the compose recipe only.
    expect(action).not.toMatch(/seaweedfs|sha256:|\b1[89]33[34]\b/);
    expect(read(SCRIPT)).toContain(`compose_file="$repo_root/${RECIPE}"`);
    const services = (Bun.YAML.parse(read(RECIPE)) as { services: Record<string, { image: string }> }).services;
    expect(Object.values(services).map((service) => service.image)).toEqual(Array(2).fill(expect.stringMatching(/^docker\.io\/chrislusf\/seaweedfs@sha256:[0-9a-f]{64}$/)));
  });

  test("the three storage jobs use the action, and no workflow runs the script itself", () => {
    expect(storageJobs().map((job) => job.where)).toEqual([
      "ci.yml factory-deployment-operations",
      "db-postgres.yml external-postgres",
      "db-postgres.yml factory-assurance-release",
    ]);
    expect(workflows().filter(({ text }) => text.includes(SCRIPT)).map(({ file }) => file)).toEqual([]);
  });

  test("each job starts storage once and stops it once, only when the start step ran", () => {
    expect(storageJobs().flatMap((job) => storageStepFindings(job.where, job.steps))).toEqual([]);
  });

  test("a job without the guard, without the id, or with a stray command is named", () => {
    const up = { uses: ACTION, id: START_ID, with: { command: "up" } };
    const down = { uses: ACTION, if: STOP_IF, with: { command: "down" } };
    expect(storageStepFindings("j", [up, down])).toEqual([]);
    expect(storageStepFindings("j", [up, { ...down, if: "always()" }])).toEqual([`j: the stop step's condition is "always()", expected ${STOP_IF}`]);
    expect(storageStepFindings("j", [{ ...up, id: undefined }, down])).toEqual([`j: the start step's id is undefined, expected ${START_ID}`]);
    expect(storageStepFindings("j", [down, up])).toEqual(['j: storage commands ["down","up"], expected up then down']);
    expect(storageStepFindings("j", [up])).toEqual(['j: storage commands ["up"], expected up then down']);
  });
});
