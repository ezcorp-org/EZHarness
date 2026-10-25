import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFactoryTempPrivateRoot } from "../src/__tests__/helpers/factory-private-root";
import { runConfiguredFactorySupervisor, factorySupervisorProductionDependencies } from "../src/factory/runner/supervisor-process";

/**
 * W4H-5: hosted CI run 37138524741 failed 12 tests of the factory run lifecycle suite (coverage shard 11 and
 * the external-postgres job) with "Factory storage credential set 'publication' is missing or malformed". The
 * suite wrote that set below a temporary root under $HOME. On the hosted runner $HOME is an owned 0755
 * directory, and the private reader (src/factory/private-files.ts) refuses a private file below it, by design.
 * W4G-4 moved the other suites to makeFactoryTempPrivateRoot (src/__tests__/helpers/factory-private-root.ts);
 * this one was missed, because nothing named the rule. This gate names it: no test source under src/, tests/ or web/e2e/factory-services/
 * makes a temporary root under the home directory.
 */
const HOME_TEMP_ROOT = /mkdtemp\(\s*(?:join\(\s*)?[`'"]?(?:\$\{\s*)?(?:process\.env\.HOME\b|(?:os\.)?homedir\(\))/g;

/** Each `path:line` in `text` that makes a temporary root under the home directory. */
export function homeTempRoots(path: string, text: string): string[] {
  return [...text.matchAll(HOME_TEMP_ROOT)].map((match) => `${path}:${text.slice(0, match.index).split("\n").length}`);
}

async function testSources(): Promise<string[]> {
  const files = ["src", "tests", "web/e2e/factory-services"].flatMap((root) => [...new Glob("**/*.ts").scanSync({ cwd: root })].map((name) => `${root}/${name}`));
  return files.sort();
}

describe("factory private roots are never made under the home directory", () => {
  test("a root under $HOME or homedir() is found by file and line; a root under the temp helper is not", () => {
    const text = [
      'const a = await mkdtemp(join(process.env.HOME!, ".x-"));',
      // A template-literal root; the "$" + "{" split keeps this sample a plain string.
      "const b = await mkdtemp(`$" + "{process.env.HOME}/y-`);",
      "const c = await mkdtemp(join(homedir(), 'z-'));",
      "const d = await mkdtemp(\n  join(os.homedir(), 'w-'));",
      'const e = await mkdtemp(join(tmpdir(), "ok-"));',
      'const f = await makeFactoryTempPrivateRoot("ok-");',
      "const g = process.env.HOME;",
    ].join("\n");
    expect(homeTempRoots("sample.ts", text)).toEqual(["sample.ts:1", "sample.ts:2", "sample.ts:3", "sample.ts:4"]);
    expect(homeTempRoots("clean.ts", 'await mkdtemp(join(tmpdir(), "a-"));')).toEqual([]);
  });

  test("no factory test source makes a temporary root under the home directory", async () => {
    const files = await testSources();
    expect(files).toContain("src/__tests__/helpers/factory-run-lifecycle-suite.ts");
    const findings = (await Promise.all(files.map(async (path) => homeTempRoots(path, await readFile(path, "utf8"))))).flat();
    expect(findings).toEqual([]);
  });
});


test("the actual stack root passes the supervisor private config reader with normal HOME modes", async () => {
  const source = await readFile("web/e2e/factory-services/stack.ts", "utf8");
  const expression = source.match(/^const root = (.+);$/m)?.[1];
  expect(expression).toBeDefined();
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const createStackRoot = new AsyncFunction("mkdtemp", "join", "homedir", "makeFactoryTempPrivateRoot", `return ${expression};`);
  const parent = await makeFactoryTempPrivateRoot("factory-home-boundary-");
  try {
    for (const mode of [0o750, 0o755]) {
      const home = join(parent, `home-${mode}`);
      await mkdir(home, { mode }); await chmod(home, mode);
      const root: string = await createStackRoot(mkdtemp, join, () => home, makeFactoryTempPrivateRoot);
      try {
        const path = join(root, "supervisor.json");
        await writeFile(path, JSON.stringify({ schemaVersion: "factory.supervisor-process.v1", installationId: "installation-01", hostId: "host-01", hostKeyPath: join(root, "host.key"), hostKeyId: "host-key-1", runnerRoot: join(root, "runner"), readinessFilePath: join(root, "ready.json"), readinessHeartbeatMs: 1000 }), { mode: 0o600 });
        // Real private reader and real schema parser run before this first injected boundary.
        // No listener, key read, runner, database or host service can start.
        await expect(runConfiguredFactorySupervisor(path, new AbortController().signal, {
          ...factorySupervisorProductionDependencies,
          createReadiness: () => { throw new Error("supervisor-config-accepted"); },
        })).rejects.toThrow("supervisor-config-accepted");
        expect(root.startsWith(`${home}/`)).toBe(false);
        expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect((await stat(home)).mode & 0o777).toBe(mode);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});
