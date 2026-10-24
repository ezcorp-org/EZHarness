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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
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

/** Execute the real composite shell; only its engine-backed storage helper is a fixture. */
function storageActionFixture(userRuntime: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), "factory-storage-action-"));
  const runnerTemp = join(root, "runner temp");
  const githubEnv = join(root, "github-env");
  const log = join(root, "calls");
  mkdirSync(join(root, "scripts"));
  mkdirSync(runnerTemp, { mode: 0o700 });
  writeFileSync(githubEnv, "");
  writeFileSync(join(root, SCRIPT), `#!/usr/bin/env bash
set -euo pipefail
[[ -d "$XDG_RUNTIME_DIR" && $(stat -c '%a:%u' "$XDG_RUNTIME_DIR") == "700:$UID" ]]
printf '%s\\t%s\\n' "$1" "$XDG_RUNTIME_DIR" >> "$FIXTURE_LOG"
[[ "$FAIL_COMMAND" != "$1" ]] || exit 42
case "$1" in
  up)
    actual=$(mktemp -d "$XDG_RUNTIME_DIR/ezcorp-factory-storage.XXXXXXXX")
    printf 'owned\\n' > "$actual/owner"
    printf 'Factory local storage is ready. Credentials are in %s below mode-0700 XDG_RUNTIME_DIR.\\n' "$actual"
    ;;
  down)
    [[ $(dirname -- "$EZCORP_FACTORY_STORAGE_SECRETS_DIR") == "$XDG_RUNTIME_DIR" ]]
    [[ $(cat "$EZCORP_FACTORY_STORAGE_SECRETS_DIR/owner") == owned ]]
    rm -- "$EZCORP_FACTORY_STORAGE_SECRETS_DIR/owner"
    rmdir -- "$EZCORP_FACTORY_STORAGE_SECRETS_DIR"
    ;;
esac
`, { mode: 0o755 });
  const parsed = Bun.YAML.parse(read(".github/actions/factory-storage/action.yml")) as { runs: { steps: Step[] } };
  const body = parsed.runs.steps[0].run;
  if (!body) throw new Error("Storage action shell is missing");
  const env = { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_ENV: githubEnv, FIXTURE_LOG: log, FAIL_COMMAND: "", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/test/bus", XDG_RUNTIME_DIR: userRuntime };
  const run = (mode: string, extra: Record<string, string> = {}) => spawnSync("bash", ["--noprofile", "--norc", "-c", body], { cwd: root, env: { ...env, FACTORY_STORAGE_COMMAND: mode, ...extra }, encoding: "utf8" });
  const exported = () => Object.fromEntries(readFileSync(githubEnv, "utf8").trim().split("\n").filter(Boolean).map(line => {
    const equals = line.indexOf("=");
    return [line.slice(0, equals), line.slice(equals + 1)];
  }));
  return { root, runnerTemp, githubEnv, log, env, run, exported, close: () => rmSync(root, { recursive: true, force: true }) };
}

describe("factory storage action runtime boundaries", () => {
  test.each(["/run/user/1001", undefined])("up/down preserve the job runtime (%s) while sharing owned storage", (runtime) => {
    const fixture = storageActionFixture(runtime);
    try {
      const up = fixture.run("up");
      expect(up.status).toBe(0);
      expect(up.stderr).toBe("");
      const exports = fixture.exported();
      expect(Object.keys(exports)).toEqual(["EZCORP_FACTORY_STORAGE_SECRETS_DIR"]);
      const jobEnv = { ...fixture.env, ...exports };
      expect(jobEnv.XDG_RUNTIME_DIR).toBe(runtime);
      expect(jobEnv.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/test/bus");
      const secrets = exports.EZCORP_FACTORY_STORAGE_SECRETS_DIR;
      expect(existsSync(join(secrets, "owner"))).toBe(true);
      const down = fixture.run("down", exports);
      expect(down.status).toBe(0);
      expect(down.stderr).toBe("");
      expect(existsSync(secrets)).toBe(false);
      const storageRuntime = join(fixture.runnerTemp, "factory-storage-runtime");
      expect(readFileSync(fixture.log, "utf8")).toBe(`up\t${storageRuntime}\ndown\t${storageRuntime}\n`);
    } finally {
      fixture.close();
    }
  });

  test("a failed start exports no partial storage state", () => {
    const fixture = storageActionFixture("/run/user/1001");
    try {
      expect(fixture.run("up", { FAIL_COMMAND: "up" }).status).toBe(42);
      expect(fixture.exported()).toEqual({});
    } finally {
      fixture.close();
    }
  });

  test("a failed stop preserves owned state and reports its failure", () => {
    const fixture = storageActionFixture("/run/user/1001");
    try {
      expect(fixture.run("up").status).toBe(0);
      const exports = fixture.exported();
      expect(fixture.run("down", { ...exports, FAIL_COMMAND: "down" }).status).toBe(42);
      expect(existsSync(join(exports.EZCORP_FACTORY_STORAGE_SECRETS_DIR, "owner"))).toBe(true);
    } finally {
      fixture.close();
    }
  });
});
