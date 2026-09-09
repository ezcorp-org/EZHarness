import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readGitHead, readCommitSubjects, readOriginUrl, parseOriginUrl } from "../../../../docs/extensions/examples/docs-updater/index";

// ── readGitHead / readCommitSubjects (real throwaway repo) ───────────

describe("git readers (real repo)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = join(tmpdir(), `du-git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(repo, { recursive: true });
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", "-C", repo, ...args], {
        stdout: "pipe", stderr: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
      await p.exited;
    };
    await git("init", "-q");
    await git("config", "user.email", "probe@example.test");
    await git("config", "user.name", "Probe");
    writeFileSync(join(repo, "README.md"), "# probe\n");
    await git("add", "README.md");
    await git("commit", "-q", "-m", "feat: initial");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("readGitHead reads HEAD hash + subject", async () => {
    const head = await readGitHead(repo);
    expect(head!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(head!.subject).toBe("feat: initial");
  });
  test("readGitHead on a non-repo → null", async () => {
    expect(await readGitHead(join(tmpdir(), `du-nope-${Date.now()}`))).toBeNull();
  });
  test("readCommitSubjects with no since → just HEAD subject", async () => {
    expect(await readCommitSubjects(repo, undefined)).toEqual(["feat: initial"]);
  });
  test("readCommitSubjects over a range returns the new subjects", async () => {
    const first = (await readGitHead(repo))!.hash;
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", "-C", repo, ...args], {
        stdout: "pipe", stderr: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
      await p.exited;
    };
    writeFileSync(join(repo, "docs.md"), "docs\n");
    await git("add", "docs.md");
    await git("commit", "-q", "-m", "docs: add");
    expect(await readCommitSubjects(repo, first)).toEqual(["docs: add"]);
  });
  test("readOriginUrl → null with no origin remote", async () => {
    expect(await readOriginUrl(repo)).toBeNull();
  });
  test("readOriginUrl reads the configured origin remote", async () => {
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", "-C", repo, ...args], {
        stdout: "pipe", stderr: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
      await p.exited;
    };
    await git("remote", "add", "origin", "git@github.com:o/r.git");
    expect(await readOriginUrl(repo)).toBe("git@github.com:o/r.git");
    expect(parseOriginUrl((await readOriginUrl(repo))!)).toEqual({ owner: "o", repo: "r" });
  });
});
