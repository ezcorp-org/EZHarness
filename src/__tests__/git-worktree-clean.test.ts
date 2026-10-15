import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isExcluded, isSourceFile } from "../../scripts/coverage-config.ts";
import { assertCleanGitWorktree, runCleanGitWorktreeCli } from "../../scripts/git-worktree-clean.ts";

import { createSourceRepository, git, gitWithEnv } from "./helpers/source-repository.ts";

function withRepository(check: (root: string) => void): void {
  const root = createSourceRepository(["web/build/", "tasks/testing-gaps/"]);
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

// item C2 (W18 hygiene), validator-3 M3: prove class B (this script keeps
// the invoking git context) actually needs it, not merely a claim in a
// comment. A caller may itself run from inside a hook, where
// GIT_INDEX_FILE points at a scratch index that differs from the real
// `.git/index` (the pre-commit hook's staged, not-yet-committed view).
// Seed a SEPARATE scratch index from HEAD, then stage a new file into ONLY
// that scratch index -- the real .git/index, and HEAD, never change.
test("keeps the invoking git context: reads a hook-like GIT_INDEX_FILE's staged content, not the real index", () => {
  withRepository((root) => {
    const scratchIndex = join(root, ".git", "scratch-index");
    gitWithEnv(root, { GIT_INDEX_FILE: scratchIndex }, ["read-tree", "HEAD"]);
    writeFileSync(join(root, "hook-staged.ts"), "export const hookStaged = true;\n");
    gitWithEnv(root, { GIT_INDEX_FILE: scratchIndex }, ["add", "hook-staged.ts"]);

    const previousIndexFile = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = scratchIndex;
    let message = "";
    try {
      assertCleanGitWorktree(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      if (previousIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previousIndexFile;
    }
    // Staged in the SCRATCH index -> git status reports "A  hook-staged.ts"
    // (a staged addition), never "?? hook-staged.ts" (untracked -- what the
    // REAL index, which has never seen this file, would report). RED when
    // the script strips GIT_* (currentRepositoryGitContext swapped for
    // withoutGitContext): GIT_INDEX_FILE would never reach the spawned git,
    // which would fall back to the real .git/index and report "??" instead,
    // failing this exact assertion.
    expect(message).toContain("A  hook-staged.ts");
  });
});

test("source attestation reports a failed Git inspection", () => {
  expect(() => assertCleanGitWorktree("/missing", {
    status: () => ({ exitCode: 2, stdout: "", stderr: "not a Git repository\n" }),
  })).toThrow("could not inspect Git worktree at /missing: not a Git repository");
});
