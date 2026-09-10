import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** A committed source file plus ignored artifacts for provenance checks. */
export function createSourceRepository(ignoredPaths: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "coverage-source-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Browser receipt fixture");
    git(root, "config", "user.email", "browser-receipt@example.invalid");
    writeFileSync(join(root, ".gitignore"), ignoredPaths.join("\n") + "\n");
    writeFileSync(join(root, "source.ts"), "export const source = true;\n");
    git(root, "add", ".gitignore", "source.ts");
    git(root, "commit", "-qm", "fixture");
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
