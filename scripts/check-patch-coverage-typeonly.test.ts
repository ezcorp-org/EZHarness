/**
 * End-to-end proof of the type-only LCOV correction (`b6cfa4798`).
 *
 * That commit exempts declaration-only TypeScript from the patch gate's
 * "changed source file has NO lcov data" rule, because a file that compiles to
 * nothing has no line lcov could ever record. Its unit tests pin the
 * `shouldFailOnLcovAbsence` predicate. This file drives `main()` instead,
 * through a real git diff in a sandbox, because the predicate is only half the
 * path: main() must also READ the file and decide whether to consult it at all.
 *
 * The negative case is the point. A widened exemption would quietly un-gate
 * every new `.ts` file that no test loads, so each runtime-bearing shape below
 * must still FAIL: an enum, a value export, and a class all emit JavaScript.
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GATE_SCRIPTS = [
  "check-patch-coverage.ts",
  "coverage-config.ts",
  "git-output.ts",
  "unified-diff.ts",
] as const;

type Sandbox = { root: string; base: string; cleanup: () => void };

async function run(cwd: string, command: readonly string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([...command], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** A real git repository carrying the real gate scripts, rebased onto itself. */
async function makeSandbox(): Promise<Sandbox> {
  const root = mkdtempSync(join(tmpdir(), "patchcov-typeonly-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "coverage"), { recursive: true });
  mkdirSync(join(root, "src/factory"), { recursive: true });
  for (const script of GATE_SCRIPTS) copyFileSync(join(REPO_ROOT, "scripts", script), join(root, "scripts", script));
  await Bun.write(join(root, "src/factory/anchor.ts"), "export const anchor = 1;\n");
  await run(root, ["git", "init", "--initial-branch=main"]);
  await run(root, ["git", "config", "user.email", "gate@example.test"]);
  await run(root, ["git", "config", "user.name", "Gate Sandbox"]);
  await run(root, ["git", "add", "-A"]);
  await run(root, ["git", "commit", "-m", "base"]);
  const base = (await run(root, ["git", "rev-parse", "HEAD"])).stdout.trim();
  expect(base, "sandbox base commit is missing").toMatch(/^[0-9a-f]{40}$/);
  return { root, base, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Add one source file (and optional lcov), then run the real gate over the diff. */
async function gateAfterAdding(
  sandbox: Sandbox,
  relPath: string,
  source: string,
  lcov = "",
): Promise<{ exitCode: number; output: string }> {
  await Bun.write(join(sandbox.root, relPath), source);
  await Bun.write(join(sandbox.root, "coverage/lcov.info"), lcov);
  await run(sandbox.root, ["git", "add", "-A"]);
  const committed = await run(sandbox.root, ["git", "commit", "-m", `add ${relPath}`]);
  expect(committed.exitCode, committed.stderr).toBe(0);
  const result = await run(sandbox.root, ["bun", join(sandbox.root, "scripts/check-patch-coverage.ts")], {
    BASE_REF: sandbox.base,
  });
  // Roll back so each case starts from the same base diff.
  await run(sandbox.root, ["git", "reset", "--hard", sandbox.base]);
  return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
}

/** LCOV covering every line of a source, so "has data" is never the variable under test. */
function fullyCoveredLcov(root: string, relPath: string, source: string): string {
  const lines = source.split("\n").map((_, index) => `DA:${index + 1},1`).join("\n");
  return `TN:\nSF:${join(root, relPath)}\n${lines}\nend_of_record\n`;
}

describe("patch coverage: type-only exemption end to end", () => {
  test("a declaration-only TypeScript file with NO lcov passes", async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await gateAfterAdding(
        sandbox,
        "src/factory/type-only.ts",
        "export interface Receipt {\n  id: string;\n}\nexport type ReceiptId = Receipt['id'];\n",
      );
      expect(result.output).not.toContain("type-only.ts");
      expect(result.exitCode, result.output).toBe(0);
    } finally {
      sandbox.cleanup();
    }
  });

  test.each([
    ["an enum", "src/factory/runtime-enum.ts", "export enum Verdict {\n  Accepted,\n  Rejected,\n}\n"],
    ["a value export", "src/factory/runtime-const.ts", "export const VERDICTS = ['accepted', 'rejected'];\n"],
    ["a class", "src/factory/runtime-class.ts", "export class Receipt {\n  readonly id = 'r';\n}\n"],
  ])("%s with NO lcov still FAILS", async (_label, relPath, source) => {
    const sandbox = await makeSandbox();
    try {
      const result = await gateAfterAdding(sandbox, relPath, source);
      expect(result.exitCode, result.output).toBe(1);
      expect(result.output).toContain(`${relPath}: changed source file has NO lcov data`);
    } finally {
      sandbox.cleanup();
    }
  });

  test("the same enum file passes once a producer measures it, so the failure was about coverage", async () => {
    const sandbox = await makeSandbox();
    const relPath = "src/factory/runtime-enum.ts";
    const source = "export enum Verdict {\n  Accepted,\n  Rejected,\n}\n";
    try {
      const result = await gateAfterAdding(sandbox, relPath, source, fullyCoveredLcov(sandbox.root, relPath, source));
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).not.toContain("NO lcov data");
    } finally {
      sandbox.cleanup();
    }
  });

  test("a Svelte component keeps its own separate carve-out, so the exemption did not widen", async () => {
    const sandbox = await makeSandbox();
    try {
      mkdirSync(join(sandbox.root, "web/src/lib"), { recursive: true });
      const result = await gateAfterAdding(sandbox, "web/src/lib/Panel.svelte", "<script lang=\"ts\">\n  let open = true;\n</script>\n");
      expect(result.exitCode, result.output).toBe(0);
    } finally {
      sandbox.cleanup();
    }
  });

  test("an enum whose lcov MISSES a changed line fails on that line, not on absence", async () => {
    const sandbox = await makeSandbox();
    const relPath = "src/factory/runtime-enum.ts";
    const source = "export enum Verdict {\n  Accepted,\n  Rejected,\n}\n";
    try {
      const partial = `TN:\nSF:${join(sandbox.root, relPath)}\nDA:1,1\nDA:2,0\nDA:3,0\nend_of_record\n`;
      const result = await gateAfterAdding(sandbox, relPath, source, partial);
      expect(result.exitCode, result.output).toBe(1);
      expect(result.output).toContain("changed line(s) uncovered");
      expect(result.output).not.toContain("NO lcov data");
    } finally {
      sandbox.cleanup();
    }
  });
});
