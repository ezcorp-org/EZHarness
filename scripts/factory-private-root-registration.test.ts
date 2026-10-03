import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";

/**
 * W4H-5: hosted CI run 37138524741 failed 12 tests of the factory run lifecycle suite (coverage shard 11 and
 * the external-postgres job) with "Factory storage credential set 'publication' is missing or malformed". The
 * suite wrote that set below a temporary root under $HOME. On the hosted runner $HOME is an owned 0755
 * directory, and the private reader (src/factory/private-files.ts) refuses a private file below it, by design.
 * W4G-4 moved the other suites to makeFactoryTempPrivateRoot (src/__tests__/helpers/factory-private-root.ts);
 * this one was missed, because nothing named the rule. This gate names it: no test source under src/ or tests/
 * makes a temporary root under the home directory.
 */
const HOME_TEMP_ROOT = /mkdtemp\(\s*(?:join\(\s*)?[`'"]?(?:\$\{\s*)?(?:process\.env\.HOME\b|(?:os\.)?homedir\(\))/g;

/** Each `path:line` in `text` that makes a temporary root under the home directory. */
export function homeTempRoots(path: string, text: string): string[] {
  return [...text.matchAll(HOME_TEMP_ROOT)].map((match) => `${path}:${text.slice(0, match.index).split("\n").length}`);
}

async function testSources(): Promise<string[]> {
  const files = ["src", "tests"].flatMap((root) => [...new Glob("**/*.ts").scanSync({ cwd: root })].map((name) => `${root}/${name}`));
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

  test("no test source under src/ or tests/ makes a temporary root under the home directory", async () => {
    const files = await testSources();
    expect(files).toContain("src/__tests__/helpers/factory-run-lifecycle-suite.ts");
    const findings = (await Promise.all(files.map(async (path) => homeTempRoots(path, await readFile(path, "utf8"))))).flat();
    expect(findings).toEqual([]);
  });
});
