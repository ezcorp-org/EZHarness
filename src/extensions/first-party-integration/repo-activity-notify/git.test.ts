import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readGitHead } from "../../../../docs/extensions/examples/repo-activity-notify/index";

describe("readGitHead", () => {
  let repo: string;

  beforeEach(async () => {
    repo = join(tmpdir(), `ran-git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(repo, { recursive: true });
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", "-C", repo, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
      await p.exited;
    };
    await git("init", "-q");
    await git("config", "user.email", "probe@example.test");
    await git("config", "user.name", "Probe");
    writeFileSync(join(repo, "a.txt"), "hello\n");
    await git("add", "a.txt");
    await git("commit", "-q", "-m", "feat: initial commit");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("reads HEAD hash + subject from a real repo", async () => {
    const head = await readGitHead(repo);
    expect(head).not.toBeNull();
    expect(head!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(head!.subject).toBe("feat: initial commit");
  });

  test("a non-repo path → null (git exits non-zero)", async () => {
    const missing = join(tmpdir(), `ran-nope-${Date.now()}`);
    expect(await readGitHead(missing)).toBeNull();
  });
});
