import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMPTY_TREE_SHA,
  isZeroSHA,
  shortSHA,
  GitError,
  makeGit,
  type Git,
} from "./git";
import { productionHostRunner, type ShellRunner, type ShellResult } from "./shell";

// ── pure helpers ────────────────────────────────────────────────────

describe("pure helpers", () => {
  test("EMPTY_TREE_SHA is git's well-known empty tree", () => {
    expect(EMPTY_TREE_SHA).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });
  test("isZeroSHA: empty + all-zero (40/64) → true; real → false", () => {
    expect(isZeroSHA("")).toBe(true);
    expect(isZeroSHA("0".repeat(40))).toBe(true);
    expect(isZeroSHA("0".repeat(64))).toBe(true);
    expect(isZeroSHA("deadbeef")).toBe(false);
  });
  test("shortSHA truncates to 12", () => {
    expect(shortSHA("abc")).toBe("abc");
    expect(shortSHA("0123456789abcdef")).toBe("0123456789ab");
  });
});

// ── real git against a throwaway repo ───────────────────────────────

describe("makeGit against real git", () => {
  let dir: string;
  let remoteDir: string;
  let g: Git;

  const sh = (args: string[], cwd: string) => productionHostRunner(args, cwd);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ezcf-git-"));
    await sh(["git", "init", "-b", "main"], dir);
    await sh(["git", "config", "user.email", "t@t.com"], dir);
    await sh(["git", "config", "user.name", "t"], dir);
    await sh(["git", "config", "commit.gpgsign", "false"], dir);
    writeFileSync(join(dir, "a.txt"), "one\n");
    await sh(["git", "add", "-A"], dir);
    await sh(["git", "commit", "-m", "c1"], dir);
    g = makeGit(productionHostRunner, dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (remoteDir) rmSync(remoteDir, { recursive: true, force: true });
  });

  test("run / try / ok", async () => {
    expect((await g.run("rev-parse", "--abbrev-ref", "HEAD"))).toBe("main");
    expect((await g.try("rev-parse", "HEAD")).exitCode).toBe(0);
    expect(await g.ok("cat-file", "-e", "HEAD")).toBe(true);
    expect(await g.ok("rev-parse", "--verify", "does-not-exist")).toBe(false);
  });

  test("run throws GitError with exitCode on failure", async () => {
    let err: unknown;
    try {
      await g.run("rev-parse", "--verify", "nonexistent-ref");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).exitCode).not.toBe(0);
  });

  test("headSha + revParseVerify", async () => {
    const head = await g.headSha();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(await g.revParseVerify("HEAD")).toBe(head);
    expect(await g.revParseVerify("no-such-ref")).toBeNull();
  });

  test("statusPorcelain reflects working-tree state", async () => {
    expect(await g.statusPorcelain()).toBe("");
    writeFileSync(join(dir, "b.txt"), "new\n");
    expect((await g.statusPorcelain()).trim()).toContain("b.txt");
  });

  test("ancestry yes/no on real commits", async () => {
    const c1 = await g.headSha();
    writeFileSync(join(dir, "a.txt"), "two\n");
    await sh(["git", "commit", "-am", "c2"], dir);
    const c2 = await g.headSha();
    expect(await g.ancestry(c1, c2)).toBe("yes");
    expect(await g.ancestry(c2, c1)).toBe("no");
  });

  test("diff + diffNameOnly across commits", async () => {
    const c1 = await g.headSha();
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "c.txt"), "c\n");
    await sh(["git", "add", "-A"], dir);
    await sh(["git", "commit", "-m", "c2"], dir);
    expect(await g.diff(c1, "HEAD")).toContain("two");
    expect((await g.diffNameOnly(c1, "HEAD")).sort()).toEqual(["a.txt", "c.txt"]);
  });

  test("lsRemoteSHA, fetchRemoteBranch, push against a bare remote", async () => {
    remoteDir = mkdtempSync(join(tmpdir(), "ezcf-remote-"));
    await sh(["git", "init", "--bare", "-b", "main", remoteDir], remoteDir);
    await sh(["git", "remote", "add", "origin", remoteDir], dir);
    // Missing ref → "".
    expect(await g.lsRemoteSHA(remoteDir, "refs/heads/main")).toBe("");
    // Push then read it back.
    await g.push(remoteDir, "refs/heads/main", "", false);
    const head = await g.headSha();
    expect(await g.lsRemoteSHA(remoteDir, "refs/heads/main")).toBe(head);
    // Fetch the pushed branch into origin's tracking ref.
    const fetched = await g.fetchRemoteBranch("origin", "main");
    expect(fetched.exitCode).toBe(0);
    expect(await g.revParseVerify("refs/remotes/origin/main")).toBe(head);
  });

  test("fetchRemoteBranchToRef writes an explicit local ref", async () => {
    remoteDir = mkdtempSync(join(tmpdir(), "ezcf-remote2-"));
    await sh(["git", "init", "--bare", "-b", "main", remoteDir], remoteDir);
    await g.push(remoteDir, "refs/heads/main", "", false);
    const res = await g.fetchRemoteBranchToRef(remoteDir, "main", "refs/ezcf/lastseen");
    expect(res.exitCode).toBe(0);
    expect(await g.revParseVerify("refs/ezcf/lastseen")).toBe(await g.headSha());
  });
});

// ── fake-runner branches ────────────────────────────────────────────

/** A runner that returns a scripted result and records the argv it saw. */
function scriptRunner(result: ShellResult): { runner: ShellRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ShellRunner = async (cmd) => {
    calls.push(cmd);
    return result;
  };
  return { runner, calls };
}

describe("exit-code + argv branches (fake runner)", () => {
  test("ancestry returns 'error' for a non-0/1 exit", async () => {
    const { runner } = scriptRunner({ exitCode: 128, stdout: "", stderr: "fatal" });
    const g = makeGit(runner, "/wt");
    expect(await g.ancestry("a", "b")).toBe("error");
  });

  test("lsRemoteSHA rejects (GitError) when ls-remote fails", async () => {
    const { runner } = scriptRunner({ exitCode: 128, stdout: "", stderr: "no remote" });
    const g = makeGit(runner, "/wt");
    await expect(g.lsRemoteSHA("origin", "refs/heads/x")).rejects.toBeInstanceOf(GitError);
  });

  test("push builds an anchored lease when expectedSHA is set", async () => {
    const { runner, calls } = scriptRunner({ exitCode: 0, stdout: "", stderr: "" });
    const g = makeGit(runner, "/wt");
    await g.push("origin", "refs/heads/feat", "abc123", true);
    expect(calls[0]).toEqual([
      "git",
      "-C",
      "/wt",
      "push",
      "origin",
      "--force-with-lease=refs/heads/feat:abc123",
      "HEAD:refs/heads/feat",
    ]);
  });

  test("push builds a bare lease when expectedSHA is empty", async () => {
    const { runner, calls } = scriptRunner({ exitCode: 0, stdout: "", stderr: "" });
    const g = makeGit(runner, "/wt");
    await g.push("origin", "refs/heads/feat", "", true);
    expect(calls[0]).toContain("--force-with-lease");
    expect(calls[0]).not.toContain("--force-with-lease=refs/heads/feat:");
  });

  test("run surfaces stdout in the GitError when stderr is empty", async () => {
    const { runner } = scriptRunner({ exitCode: 2, stdout: "some detail", stderr: "" });
    const g = makeGit(runner, "/wt");
    await expect(g.run("whatever")).rejects.toThrow("some detail");
  });
});
