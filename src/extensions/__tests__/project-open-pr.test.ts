import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectPullRequest, type ProjectCommandRunner } from "../project-open-pr";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function git(root: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "extension-pr-test-"));
  directories.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "remote", "add", "origin", "https://github.com/example/project.git");
  await writeFile(join(root, "tracked.txt"), "before\n");
  await writeFile(join(root, ".gitignore"), ".ezcorp/\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  const commands: string[][] = [];
  let committed = "";
  const run: ProjectCommandRunner = async (argv, cwd, input) => {
    commands.push(argv);
    if (argv[0] === "gh") return { exitCode: 0, stdout: "https://github.com/example/project/pull/1\n", stderr: "" };
    if (argv[1] === "push") {
      committed = await readFile(join(cwd, "tracked.txt"), "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...argv.slice(1)], { cwd, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  };
  return { root, commands, run, committed: () => committed };
}

describe("host pull request capability", () => {
  test("copies pending changes, preserves source, and removes the temporary worktree", async () => {
    const fixtureData = await fixture();
    await writeFile(join(fixtureData.root, "tracked.txt"), "after\n");
    await writeFile(join(fixtureData.root, "new.txt"), "added\n");
    const result = await openProjectPullRequest({ projectRoot: fixtureData.root, runId: "run-1", title: "Change", body: "Details" }, { run: fixtureData.run });
    expect(result).toEqual({ ok: true, url: "https://github.com/example/project/pull/1" });
    expect(fixtureData.committed()).toBe("after\n");
    expect(await git(fixtureData.root, "branch", "--show-current")).toBe("main\n");
    expect(await git(fixtureData.root, "status", "--porcelain")).toContain("tracked.txt");
    expect((await git(fixtureData.root, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
    expect(fixtureData.commands.find((argv) => argv[1] === "push")?.[2]).toBe("https://github.com/example/project.git");
  });

  test("rejects repository execution hooks before worktree creation", async () => {
    const fixtureData = await fixture();
    await git(fixtureData.root, "config", "filter.evil.smudge", "touch /tmp/should-not-run");
    const result = await openProjectPullRequest({ projectRoot: fixtureData.root, runId: "run-2", title: "Change", body: "" }, { run: fixtureData.run });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("hooks, filters");
    expect(fixtureData.commands.some((argv) => argv[1] === "worktree")).toBe(false);
  });

  test("rejects untracked links and cleans up after failure", async () => {
    const fixtureData = await fixture();
    await symlink("/etc/passwd", join(fixtureData.root, "leak"));
    const result = await openProjectPullRequest({ projectRoot: fixtureData.root, runId: "run-3", title: "Change", body: "" }, { run: fixtureData.run });
    expect(result.ok).toBe(false);
    expect(fixtureData.commands.some((argv) => argv[1] === "push")).toBe(false);
    expect((await git(fixtureData.root, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
  });

  test("rejects tracked platform data and non-GitHub remotes", async () => {
    const fixtureData = await fixture();
    await mkdir(join(fixtureData.root, ".ezcorp"));
    await writeFile(join(fixtureData.root, ".ezcorp", "secret"), "secret");
    await git(fixtureData.root, "add", "-f", ".ezcorp/secret");
    expect((await openProjectPullRequest({ projectRoot: fixtureData.root, runId: "run-4", title: "Change", body: "" }, { run: fixtureData.run })).error).toContain("Platform data");
    await git(fixtureData.root, "remote", "set-url", "origin", "https://127.0.0.1/private");
    expect((await openProjectPullRequest({ projectRoot: fixtureData.root, runId: "run-5", title: "Change", body: "" }, { run: fixtureData.run })).error).toContain("github.com");
  });
});
