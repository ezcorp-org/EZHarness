/**
 * A CI step that runs a Podman-guest test must run where the extension runner is provisioned (W4H-12).
 *
 * The runner starts every guest with `--pull=never` (packages/@ezcorp/extension-runner/src/podman.ts), so a host
 * needs the pinned image, the pinned conmon, cgroup delegation and a user session before the first guest:
 * `bash scripts/setup-extension-runner-ci.sh --install` does all four. Hosted run 37383355593 ran
 * tests/postgres/factory-host-launch.test.ts in db-postgres.yml's external-postgres job, which never ran that
 * script; the test failed on podman's "image not known" behind a hidden rejection. This guard reads what each step
 * RUNS: every `./…test.ts` file a step names, followed through its relative imports, and it fails by name when a
 * file that starts a Podman guest runs in a job that did not provision the runner first, or when a job runs the
 * setup after its factory-storage start. Fixture: scripts/fixtures/podman-guest-jobs/base (db-postgres.yml at 1bc5f63c7).
 *
 * Its reach: test files a workflow step names. Suites a step runs through a pool script (scripts/test-coverage.sh
 * with EZCORP_RUN_PODMAN_TESTS) are not named in the workflow, and those jobs already provision the runner.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Workflow, type WorkflowStep, readWorkflows, stepsNeedingPreparation, workflowCommands } from "./lib/ci-registration.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const RUNNER_SETUP = "bash scripts/setup-extension-runner-ci.sh --install";
const STORAGE_ACTION = "./.github/actions/factory-storage";
const FIXTURES = join(REPO_ROOT, "scripts/fixtures/podman-guest-jobs");
/** A source that constructs a Podman runner, or defines one. */
const STARTS_GUEST = /\bnew \w*PodmanRunner\(|\bextends PodmanRunner\b/;
/** Relative static and dynamic import specifiers. Bare package specifiers are not followed. */
const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

type Read = (path: string) => string | undefined;
const readRepo: Read = (path) => (existsSync(join(REPO_ROOT, path)) ? readFileSync(join(REPO_ROOT, path), "utf8") : undefined);

/** The repository file a relative specifier names, as a repo-relative path, if one exists. */
function resolveImport(from: string, specifier: string, read: Read): string | undefined {
  const base = join(dirname(from), specifier);
  return [base, `${base}.ts`, join(base, "index.ts")].find((candidate) => candidate.endsWith(".ts") && read(candidate) !== undefined);
}

/** Whether `file`, or any repository file it reaches through relative imports, starts a Podman guest. */
export function startsPodmanGuest(file: string, read: Read = readRepo): boolean {
  const seen = new Set<string>();
  const pending = [file];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const source = read(current);
    if (source === undefined) continue;
    if (STARTS_GUEST.test(source)) return true;
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const next = resolveImport(current, match[1]!, read);
      if (next !== undefined) pending.push(next);
    }
  }
  return false;
}

/** The test files a step's command names (`./path.test.ts`), repo-relative. */
export function namedTestFiles(run: string): string[] {
  return [...run.matchAll(/(?:^|[\s'"])\.\/([\w@./-]+\.test\.ts)\b/g)].map((match) => match[1]!);
}

/** A step that runs the runner setup as a command; a `#` comment that only mentions it does not count. */
export function runsRunnerSetup(step: WorkflowStep): boolean {
  return step.run !== undefined && workflowCommands(step.run).includes(RUNNER_SETUP);
}

/** Every step that runs a Podman-guest test, with whether the runner setup ran before it in its job. */
export function podmanGuestSteps(workflows: readonly Workflow[], read: Read = readRepo) {
  return stepsNeedingPreparation(workflows, runsRunnerSetup, (run) => namedTestFiles(run).some((file) => startsPodmanGuest(file, read)));
}

/** Every unprepared Podman-guest step, by name. */
export function unpreparedGuestSteps(workflows: readonly Workflow[], read: Read = readRepo): string[] {
  return podmanGuestSteps(workflows, read).filter((step) => !step.preceded).map((step) => `${step.where}: runs a Podman-guest test before '${RUNNER_SETUP}'`);
}

/**
 * Jobs that start the factory storage AND run the runner setup must run the setup first. Both write XDG_RUNTIME_DIR to
 * the job environment: the storage action its private directory, the setup the user session's. A setup after the
 * storage start leaves the session's directory in force, and the storage stop's `down` then refuses the credential
 * directory ("Credential directory must be generated directly below XDG_RUNTIME_DIR", setup-factory-storage.sh:44).
 * The other order is proven green (W4H-12 r6-xdg): the setup's explicit D-Bus address keeps podman on its session.
 */
export function setupAfterStorage(workflows: readonly Workflow[]): string[] {
  const findings: string[] = [];
  for (const { file, jobs } of workflows) {
    for (const [id, job] of Object.entries(jobs)) {
      const steps = job.steps ?? [];
      const storage = steps.findIndex((step) => step.uses === STORAGE_ACTION && step.with?.command === "up");
      const setup = steps.findIndex(runsRunnerSetup);
      if (storage >= 0 && setup > storage) findings.push(`${file} ${id}: '${RUNNER_SETUP}' runs after the factory-storage start`);
    }
  }
  return findings;
}

/** Everything the guard refuses in a set of workflows. */
export function podmanGuestFindings(workflows: readonly Workflow[], read: Read = readRepo): string[] {
  return [...unpreparedGuestSteps(workflows, read), ...setupAfterStorage(workflows)];
}

describe("Podman-guest tests run only where the runner is provisioned (W4H-12)", () => {
  const workflows = readWorkflows(join(REPO_ROOT, ".github/workflows"));

  test("every step that runs a Podman-guest test runs after the runner setup in its job, and the setup precedes storage", () => {
    expect(podmanGuestFindings(workflows)).toEqual([]);
  });

  test("the base workflow of hosted run 37383355593 is red by name; the committed one is green", () => {
    // The fixture is db-postgres.yml at 1bc5f63c7, byte for byte.
    expect(podmanGuestFindings(readWorkflows(join(FIXTURES, "base")))).toEqual([
      `db-postgres.yml external-postgres (External Postgres (Bun.sql)): Run factory storage and private services on Postgres and S3: runs a Podman-guest test before '${RUNNER_SETUP}'`,
    ]);
    expect(podmanGuestFindings(workflows.filter(({ file }) => file === "db-postgres.yml"))).toEqual([]);
  });

  test("the committed workflow with the setup moved after the storage start, or only in a comment, is red by name", () => {
    const committed = workflows.find(({ file }) => file === "db-postgres.yml")!;
    const job = committed.jobs["external-postgres"]!;
    const steps = job.steps ?? [];
    const setup = steps.findIndex(runsRunnerSetup);
    const storage = steps.findIndex((step) => step.uses === STORAGE_ACTION && step.with?.command === "up");
    expect(setup).toBeGreaterThan(-1);
    expect(storage).toBeGreaterThan(setup);
    const without = steps.filter((_, index) => index !== setup);
    const moved = [...without.slice(0, storage), steps[setup]!, ...without.slice(storage)];
    const late: Workflow = { ...committed, jobs: { "external-postgres": { ...job, steps: moved } } };
    expect(podmanGuestFindings([late])).toEqual([
      `db-postgres.yml external-postgres: '${RUNNER_SETUP}' runs after the factory-storage start`,
    ]);
    const commented = steps.map((step, index) => (index === setup ? { ...step, run: `# ${RUNNER_SETUP}\necho provisioned` } : step));
    expect(podmanGuestFindings([{ ...committed, jobs: { "external-postgres": { ...job, steps: commented } } }])).toEqual([
      `db-postgres.yml external-postgres (External Postgres (Bun.sql)): Run factory storage and private services on Postgres and S3: runs a Podman-guest test before '${RUNNER_SETUP}'`,
    ]);
  });

  test("the guard sees the step that failed in hosted run 37383355593", () => {
    // Not vacuous: the storage step names factory-host-launch, whose helper starts a real guest.
    expect(startsPodmanGuest("tests/postgres/factory-host-launch.test.ts")).toBe(true);
    expect(podmanGuestSteps(workflows).map((step) => step.where)).toContain(
      "db-postgres.yml external-postgres (External Postgres (Bun.sql)): Run factory storage and private services on Postgres and S3",
    );
  });

  test("a guest reached through a helper counts; a type-only mention, a bare package import and a cycle do not", () => {
    const files: Record<string, string> = {
      "t/direct.test.ts": "const r = new PodmanRunner({ root });",
      "t/subclass.ts": "export class Probe extends PodmanRunner {}",
      "t/via-helper.test.ts": 'import { world } from "./helpers/world";',
      "t/helpers/world.ts": 'export * from "../deep";',
      "t/deep/index.ts": 'const runner = new PythonPodmanRunner(options);',
      "t/types-only.test.ts": 'import type { PodmanRunner } from "@ezcorp/extension-runner";\nlet r: PodmanRunner;',
      "t/bare.test.ts": 'import { PodmanRunner } from "@ezcorp/extension-runner";',
      "t/cycle-a.test.ts": 'import "./cycle-b";',
      "t/cycle-b.ts": 'import "./cycle-a.test";',
      "t/dynamic.test.ts": 'await import("./subclass");',
      "t/missing.test.ts": 'import { gone } from "./not-there";',
    };
    const read: Read = (path) => files[path];
    expect(startsPodmanGuest("t/direct.test.ts", read)).toBe(true);
    expect(startsPodmanGuest("t/via-helper.test.ts", read)).toBe(true);
    expect(startsPodmanGuest("t/dynamic.test.ts", read)).toBe(true);
    expect(startsPodmanGuest("t/types-only.test.ts", read)).toBe(false);
    expect(startsPodmanGuest("t/bare.test.ts", read)).toBe(false);
    expect(startsPodmanGuest("t/cycle-a.test.ts", read)).toBe(false);
    expect(startsPodmanGuest("t/missing.test.ts", read)).toBe(false);
    expect(startsPodmanGuest("t/absent.test.ts", read)).toBe(false);
  });

  test("a step names its test files by ./path, in any position of a multi-line command", () => {
    expect(namedTestFiles('FACTORY_TEST_POSTGRES_URL="$DATABASE_URL" bun test --timeout 30000 ./tests/postgres/a.test.ts\n./tests/postgres/b.test.ts')).toEqual(["tests/postgres/a.test.ts", "tests/postgres/b.test.ts"]);
    expect(namedTestFiles("bun test src/__tests__/c.test.ts ./packages/@ezcorp/x/tests/d.test.ts")).toEqual(["packages/@ezcorp/x/tests/d.test.ts"]);
    expect(namedTestFiles("bash scripts/test-coverage.sh")).toEqual([]);
  });

  test("a job that runs a guest test before, or without, the runner setup is named", () => {
    const read: Read = (path) => (path === "tests/guest.test.ts" ? "new PodmanRunner({})" : path === "tests/plain.test.ts" ? "expect(1).toBe(1)" : undefined);
    const workflows: Workflow[] = [{
      file: "w.yml",
      text: "",
      jobs: {
        provisioned: { steps: [{ run: RUNNER_SETUP }, { name: "Guest", run: "bun test ./tests/guest.test.ts" }] },
        late: { name: "Late", steps: [{ name: "Guest", run: "bun test ./tests/guest.test.ts" }, { run: RUNNER_SETUP }] },
        missing: { steps: [{ name: "Guest", run: "bun test ./tests/plain.test.ts ./tests/guest.test.ts" }] },
        plain: { steps: [{ name: "Plain", run: "bun test ./tests/plain.test.ts" }] },
      },
    }];
    expect(podmanGuestSteps(workflows, read)).toEqual([
      { where: "w.yml provisioned (provisioned): Guest", preceded: true },
      { where: "w.yml late (Late): Guest", preceded: false },
      { where: "w.yml missing (missing): Guest", preceded: false },
    ]);
  });
});
