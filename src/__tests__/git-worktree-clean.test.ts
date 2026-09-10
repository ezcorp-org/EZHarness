import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExcluded, isSourceFile } from "../../scripts/coverage-config.ts";
import { assertCleanGitWorktree, runCleanGitWorktreeCli } from "../../scripts/git-worktree-clean.ts";

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "clean-worktree-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Browser receipt fixture");
  git(root, "config", "user.email", "browser-receipt@example.invalid");
  writeFileSync(join(root, ".gitignore"), "web/build/\ntasks/testing-gaps/\n");
  writeFileSync(join(root, "source.ts"), "export const source = true;\n");
  git(root, "add", ".gitignore", "source.ts");
  git(root, "commit", "-qm", "fixture");
  return root;
}

function withRepository(check: (root: string) => void): void {
  const root = createRepository();
  try {
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("clean source checkout permits ignored browser build and receipt artifacts", () => {
  withRepository((root) => {
    mkdirSync(join(root, "web", "build", "client"), { recursive: true });
    mkdirSync(join(root, "tasks", "testing-gaps"), { recursive: true });
    writeFileSync(join(root, "web", "build", "client", "manifest.json"), "{}\n");
    writeFileSync(join(root, "tasks", "testing-gaps", "receipt.json"), "{}\n");

    expect(() => assertCleanGitWorktree(root)).not.toThrow();
  });
});

test("source attestation helper has an exact 100 percent coverage gate", async () => {
  const path = "scripts/git-worktree-clean.ts";
  const thresholds = await Bun.file(join(import.meta.dir, "..", "..", "scripts", "coverage-thresholds.json"))
    .json() as Record<string, number>;
  expect(isSourceFile(path)).toBe(true);
  expect(isExcluded(path)).toBe(false);
  expect(thresholds[path]).toBe(100);
});

test("CLI helper uses an explicit path or its supplied working directory", () => {
  withRepository((root) => {
    const output: string[] = [];
    runCleanGitWorktreeCli([root], "/not-used", (message) => output.push(message));
    runCleanGitWorktreeCli([], root, (message) => output.push(message));
    expect(output).toEqual([
      "verified clean Git worktree: " + root,
      "verified clean Git worktree: " + root,
    ]);
  });
});

test("CLI entrypoint accepts a clean source checkout", () => {
  withRepository((root) => {
    const script = join(import.meta.dir, "..", "..", "scripts", "git-worktree-clean.ts");
    const result = Bun.spawnSync(["bun", script, root], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("verified clean Git worktree: " + root);
  });
});

test("source attestation rejects tracked, staged, and nonignored untracked paths", () => {
  withRepository((root) => {
    writeFileSync(join(root, "source.ts"), "export const source = false;\n");
    writeFileSync(join(root, "staged.ts"), "export const staged = true;\n");
    writeFileSync(join(root, "untracked.ts"), "export const untracked = true;\n");
    git(root, "add", "staged.ts");

    expect(() => assertCleanGitWorktree(root)).toThrow("clean Git worktree");
    try {
      assertCleanGitWorktree(root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(" M source.ts");
      expect(message).toContain("A  staged.ts");
      expect(message).toContain("?? untracked.ts");
    }
  });
});

test("source attestation reports a failed Git inspection", () => {
  expect(() => assertCleanGitWorktree("/missing", {
    status: () => ({ exitCode: 2, stdout: "", stderr: "not a Git repository\n" }),
  })).toThrow("could not inspect Git worktree at /missing: not a Git repository");
});
