import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { referenceCodeLaunchRepository } from "../../factory/reference-code/fixtures";

/** Runs git in a fixture repository with no ambient configuration and a fixed identity and clock. */
export function fixtureGit(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "1790000000 +0000", GIT_COMMITTER_DATE: "1790000000 +0000" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * The reference-code launch repository as a real git repository (W4H-28): one base commit holding the
 * fixture's exact files (plus any extra), and one later commit on top. The caller removes `root`.
 */
export async function referenceCodeGitRepository(extra: Readonly<Record<string, string>> = {}): Promise<{ readonly root: string; readonly base: string; readonly later: string }> {
  const root = await mkdtemp(join(tmpdir(), "repository-source-"));
  fixtureGit(root, "init", "--quiet", "-b", "main");
  for (const file of referenceCodeLaunchRepository()) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.content);
  }
  for (const [path, text] of Object.entries(extra)) await writeFile(join(root, path), text);
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "--quiet", "-m", "base");
  const base = fixtureGit(root, "rev-parse", "HEAD");
  await writeFile(join(root, "later.txt"), "later\n");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "--quiet", "-m", "later");
  return { root, base, later: fixtureGit(root, "rev-parse", "HEAD") };
}
