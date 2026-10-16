/**
 * scripts/merge-lcov.ts — nothing outside the repository enters the merge (W4H-28 follow-up).
 *
 * WHY THIS FILE EXISTS
 *   A test may write a bundle into a temporary folder and import it
 *   (src/__tests__/credential-store-bundled.test.ts builds the credential store
 *   the way the web build does). Bun instruments that bundle like any loaded
 *   module, so its lcov carries a record for `/tmp/credential-store-bundle-*`:
 *   in the hosted run ci 38887660827 it was 76,700 lines at 11.2%, and it alone
 *   took the global floor from about 98.6% to 75.91%. A file outside the
 *   repository is not source: no threshold names it and no reviewer reads it.
 *   The merge is the one funnel every producer passes through, so it drops such
 *   records there, and the rule holds for every test that does this.
 *
 *   Bun's coveragePathIgnorePatterns cannot do it: Bun matches them against the
 *   path relative to the working folder at flush time, and a test that leaves
 *   the process in another folder makes EVERY record climb out — measured: 529
 *   records with no pattern, 0 with `../**`.
 *
 *   `--source-root <dir>` lets the merge's own fixture tests (sources in a
 *   temporary folder) declare their sandbox as source; a real merge never
 *   passes it.
 *
 * WHAT MUST NOT HAPPEN: a repository source is dropped with them. Every case
 * asserts both directions.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const MERGE_SCRIPT = join(REPO_ROOT, "scripts/merge-lcov.ts");
const SOURCE = "packages/@ezcorp/factory-sdk/src/index.ts";

let root = "";
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "merge-outside-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** Merge every `*.info` under `dir/in`; return the exit code, stderr and merged SF paths. */
async function merge(dir: string, ...extra: string[]): Promise<{ code: number; stderr: string; paths: string[] }> {
  const out = join(dir, "merged.info");
  const run = Bun.spawn([process.execPath, MERGE_SCRIPT, join(dir, "in", "*.info"), out, ...extra], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  const paths = code === 0 ? readFileSync(out, "utf8").split("\n").filter(line => line.startsWith("SF:")).map(line => line.slice(3)) : [];
  return { code, stderr, paths };
}
const outside = (paths: string[]) => paths.filter(path => isAbsolute(path) || path.startsWith(".."));
const record = (sf: string) => `TN:\nSF:${sf}\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n`;

/** A sandbox with one bundle a test "wrote" outside the repository; returns its absolute path. */
function sandbox(name: string): { dir: string; bundle: string } {
  const dir = join(root, name);
  mkdirSync(join(dir, "in"), { recursive: true });
  mkdirSync(join(dir, "credential-store-bundle-x"), { recursive: true });
  const bundle = join(dir, "credential-store-bundle-x", "bundled-oauth-entry.js");
  writeFileSync(bundle, "export const a = 1;\nexport const b = 2;\n");
  return { dir, bundle };
}

describe("merge-lcov: no path outside the repository root", () => {
  test("a bundle a test wrote to a temporary folder is dropped, by absolute or by climbing path; the repository source stays", async () => {
    const { dir, bundle } = sandbox("synthetic");
    const climbing = `${"../".repeat(REPO_ROOT.split("/").length)}${bundle.slice(1)}`;
    writeFileSync(join(dir, "in", "a.info"), record(bundle) + record(SOURCE));
    writeFileSync(join(dir, "in", "b.info"), record(climbing));
    const { code, paths } = await merge(dir);
    expect(code).toBe(0);
    expect(outside(paths)).toEqual([]);
    expect(paths).toEqual([SOURCE]);
  });

  test("a declared --source-root keeps its own files and nothing else outside the repository", async () => {
    const { dir, bundle } = sandbox("declared");
    const elsewhere = join(root, "elsewhere.js");
    writeFileSync(elsewhere, "export const c = 3;\n");
    writeFileSync(join(dir, "in", "a.info"), record(bundle) + record(elsewhere) + record(SOURCE));
    const { code, paths } = await merge(dir, "--source-root", dir);
    expect(code).toBe(0);
    expect(paths.sort()).toEqual([bundle, SOURCE].sort());
  });

  test("--source-root without a folder is refused with the usage line, and writes nothing", async () => {
    const { dir, bundle } = sandbox("refused");
    writeFileSync(join(dir, "in", "a.info"), record(bundle) + record(SOURCE));
    const { code, stderr } = await merge(dir, "--source-root");
    expect(code).not.toBe(0);
    expect(stderr).toContain("usage: merge-lcov.ts <glob> <output> [--source-root <dir>]...");
  });

  test("end to end: the bundled credential-store test's lcov merges with no path outside the repository, and keeps the repository's", async () => {
    const dir = join(root, "e2e");
    mkdirSync(join(dir, "in"), { recursive: true });
    const cov = join(dir, "cov");
    const run = Bun.spawn([process.execPath, "test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${cov}`, "./src/__tests__/credential-store-bundled.test.ts"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
    if (code !== 0) throw new Error(`the bundled credential-store test failed (${code}): ${stderr.slice(-2000)}`);
    const raw = readFileSync(join(cov, "lcov.info"), "utf8");
    // The producer does record the bundle: the merge is what must drop it.
    expect(raw).toContain("bundled-oauth-entry.js");
    writeFileSync(join(dir, "in", "shard.info"), raw);
    const merged = await merge(dir);
    expect(merged.code).toBe(0);
    expect(outside(merged.paths)).toEqual([]);
    expect(merged.paths).toContain("src/providers/credential-store.ts");
  }, 180_000);
});
