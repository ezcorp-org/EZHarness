/**
 * Tests for source-parser and git operations modules.
 *
 * Covers:
 * 1. parseSource() for github:, gitlab:, https://, git@, file:// formats with @ref
 * 2. Error cases (invalid input, empty string)
 * 3. Git wrapper functions (clone, lsRemoteTags, getCurrentRef) using local bare repos
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { parseSource } from "../extensions/source-parser";
import { clone, lsRemoteTags, getCurrentRef, gitExec } from "../extensions/git";
import { fixtureGitEnv } from "./helpers/git-fixture-env";

test("gitExec selects its cwd repository while preserving caller config", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-exec-context-"));
  const parent = join(root, "caller");
  const target = join(root, "target");
  const clean = fixtureGitEnv();
  const ambient = { ...process.env };
  try {
    for (const repo of [parent, target]) {
      expect(Bun.spawnSync(["git", "init", repo], { env: clean }).exitCode).toBe(0);
    }
    const parentConfig = join(parent, ".git", "config");
    const original = await Bun.file(parentConfig).text();
    process.env = {
      ...clean,
      GIT_DIR: join(parent, ".git"),
      GIT_WORK_TREE: parent,
      GIT_COMMON_DIR: join(parent, ".git"),
      GIT_INDEX_FILE: join(parent, ".git", "index"),
      GIT_PREFIX: "caller/",
      GIT_OBJECT_DIRECTORY: join(parent, ".git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(root, "missing-objects"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "fixture.auth",
      GIT_CONFIG_VALUE_0: "preserved",
    };
    expect(gitExec(["config", "--local", "user.name", "Target"], { cwd: target }).ok).toBe(true);
    expect(gitExec(["config", "--local", "--get", "user.name"], { cwd: target }).stdout).toBe("Target");
    expect(gitExec(["config", "--get", "fixture.auth"], { cwd: target }).stdout).toBe("preserved");
    expect(gitExec(["rev-parse", "--git-dir"], { cwd: target }).stdout).toBe(".git");
    await Bun.write(join(target, "file.txt"), "target content");
    expect(gitExec(["add", "file.txt"], { cwd: target }).ok).toBe(true);
    expect(gitExec(["ls-files"], { cwd: target }).stdout).toBe("file.txt");
    expect(await Bun.file(parentConfig).text()).toBe(original);
    expect(await Bun.file(join(parent, ".git", "index")).exists()).toBe(false);
    expect(gitExec(["count-objects"], { cwd: target }).stdout).toMatch(/^1 objects/);
  } finally {
    process.env = ambient;
    await rm(root, { recursive: true, force: true });
  }
});

test("Git fixture suites preserve the caller repository under inherited Git context", async () => {
  const parent = await mkdtemp(join(tmpdir(), "source-parser-parent-"));
  const clean = fixtureGitEnv();
  try {
    expect(Bun.spawnSync(["git", "init", parent], { env: clean }).exitCode).toBe(0);
    const config = join(parent, ".git", "config");
    const original = await Bun.file(config).text();
    const suites = [
      ["source-parser.test.ts", "gitExec runs git commands"],
      ["source-parser-git-coverage.test.ts", "gitExec catch branch"],
    ];
    for (const [file, pattern] of suites) {
      const child = Bun.spawnSync([
        process.execPath, "test", "--timeout", "30000",
        join(import.meta.dir, file), "--test-name-pattern", pattern,
      ], {
        env: {
          ...clean,
          GIT_DIR: join(parent, ".git"),
          GIT_INDEX_FILE: join(parent, ".git", "index"),
          GIT_PREFIX: "caller/",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(child.stderr.toString()).toContain("1 pass");
      expect(await Bun.file(config).text(), file).toBe(original);
      expect(await Bun.file(join(parent, ".git", "index")).exists(), file).toBe(false);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 30_000);

// ── 1. parseSource tests ──────────────────────────────────────────────

describe("parseSource", () => {
  test("github:user/repo", () => {
    const result = parseSource("github:user/repo");
    expect(result).toEqual({
      type: "github",
      cloneUrl: "https://github.com/user/repo.git",
      displayName: "user/repo",
      ref: undefined,
      original: "github:user/repo",
    });
  });

  test("github:user/repo@v1.2.0", () => {
    const result = parseSource("github:user/repo@v1.2.0");
    expect(result).toEqual({
      type: "github",
      cloneUrl: "https://github.com/user/repo.git",
      displayName: "user/repo",
      ref: "v1.2.0",
      original: "github:user/repo@v1.2.0",
    });
  });

  test("gitlab:org/project@main", () => {
    const result = parseSource("gitlab:org/project@main");
    expect(result).toEqual({
      type: "gitlab",
      cloneUrl: "https://gitlab.com/org/project.git",
      displayName: "org/project",
      ref: "main",
      original: "gitlab:org/project@main",
    });
  });

  test("https://example.com/repo.git", () => {
    const result = parseSource("https://example.com/repo.git");
    expect(result).toEqual({
      type: "https",
      cloneUrl: "https://example.com/repo.git",
      displayName: "example.com/repo",
      ref: undefined,
      original: "https://example.com/repo.git",
    });
  });

  test("https://example.com/repo.git@v2.0.0", () => {
    const result = parseSource("https://example.com/repo.git@v2.0.0");
    expect(result).toEqual({
      type: "https",
      cloneUrl: "https://example.com/repo.git",
      displayName: "example.com/repo",
      ref: "v2.0.0",
      original: "https://example.com/repo.git@v2.0.0",
    });
  });

  test("git@github.com:user/repo.git", () => {
    const result = parseSource("git@github.com:user/repo.git");
    expect(result).toEqual({
      type: "ssh",
      cloneUrl: "git@github.com:user/repo.git",
      displayName: "user/repo",
      ref: undefined,
      original: "git@github.com:user/repo.git",
    });
  });

  test("git@github.com:user/repo.git@v1.0.0", () => {
    const result = parseSource("git@github.com:user/repo.git@v1.0.0");
    expect(result).toEqual({
      type: "ssh",
      cloneUrl: "git@github.com:user/repo.git",
      displayName: "user/repo",
      ref: "v1.0.0",
      original: "git@github.com:user/repo.git@v1.0.0",
    });
  });

  test("file:///tmp/repo.git (for testing)", () => {
    const result = parseSource("file:///tmp/repo.git");
    expect(result.type).toBe("file");
    expect(result.cloneUrl).toBe("file:///tmp/repo.git");
    expect(result.ref).toBeUndefined();
  });

  test("file:///tmp/repo.git@v1.0.0", () => {
    const result = parseSource("file:///tmp/repo.git@v1.0.0");
    expect(result.type).toBe("file");
    expect(result.cloneUrl).toBe("file:///tmp/repo.git");
    expect(result.ref).toBe("v1.0.0");
  });

  test("throws on invalid source", () => {
    expect(() => parseSource("invalid")).toThrow(/Unrecognized source format/);
  });

  test("throws on empty string", () => {
    expect(() => parseSource("")).toThrow();
  });

  test("trailing @ with empty ref throws", () => {
    expect(() => parseSource("github:user/repo@")).toThrow(
      /Unrecognized source format/,
    );
  });
});

// ── 1b. ref validation (F1: git argument injection) ───────────────────

describe("parseSource ref validation", () => {
  test("rejects ref with leading dash (option injection)", () => {
    expect(() =>
      parseSource("github:user/repo@--upload-pack=/tmp/evil"),
    ).toThrow(/Invalid git ref/);
  });

  test("rejects ref with leading dash on ssh source", () => {
    expect(() =>
      parseSource("git@github.com:user/repo.git@--mirror"),
    ).toThrow(/Invalid git ref/);
  });

  test("rejects ref with shell metacharacters", () => {
    expect(() => parseSource("github:user/repo@v1.0.0;rm -rf ~")).toThrow(
      /Invalid git ref/,
    );
    expect(() => parseSource("github:user/repo@$(whoami)")).toThrow(
      /Invalid git ref/,
    );
    expect(() => parseSource("github:user/repo@main branch")).toThrow(
      /Invalid git ref/,
    );
  });

  test("rejects option-shaped ref on https source", () => {
    expect(() =>
      parseSource("https://example.com/repo.git@--config=core.fsmonitor=x"),
    ).toThrow(/Invalid git ref/);
  });

  test("accepts valid tag, branch, slash-branch, and sha refs", () => {
    expect(parseSource("github:user/repo@v1.2.3").ref).toBe("v1.2.3");
    expect(parseSource("github:user/repo@main").ref).toBe("main");
    expect(parseSource("github:user/repo@feature/x").ref).toBe("feature/x");
    expect(parseSource("github:user/repo@a1b2c3d").ref).toBe("a1b2c3d");
  });
});

// ── 2. Git wrapper function tests ─────────────────────────────────────

describe("git operations", () => {
  let bareRepoDir: string;
  let tempBase: string;
  const tempDirs: string[] = [];

  const env = fixtureGitEnv();
  const spawn = (cmd: string[], opts?: { cwd?: string }) =>
    Bun.spawnSync(cmd, { ...opts, env });

  beforeAll(async () => {
    tempBase = await mkdtemp(join(tmpdir(), "git-ops-"));
    tempDirs.push(tempBase);

    // Create a bare repo with a commit and tag
    bareRepoDir = join(tempBase, "bare.git");
    spawn(["git", "init", "--bare", bareRepoDir]);

    // Create a work tree to make commits
    const workDir = join(tempBase, "work");
    spawn(["git", "clone", bareRepoDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

    // Create an ezcorp.config.ts and commit
    await Bun.write(join(workDir, "ezcorp.config.ts"), `export default ${JSON.stringify({
      schemaVersion: 2,
      name: "test-ext",
      version: "1.0.0",
      description: "Test",
      author: { name: "Test" },
      permissions: {},
    })};\n`);
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "initial"], { cwd: workDir });
    spawn(["git", "tag", "v1.0.0"], { cwd: workDir });

    // Push to bare repo (use HEAD to avoid branch name assumptions)
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });
  });

  afterAll(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("gitExec runs git commands", () => {
    const result = gitExec(["--version"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("git version");
    expect(result.exitCode).toBe(0);
  });

  test("gitExec returns failure for bad commands", () => {
    const result = gitExec(["status"], { cwd: "/nonexistent-dir-xyz" });
    expect(result.ok).toBe(false);
  });

  test("clone into temp dir", async () => {
    const dest = join(tempBase, "clone1");

    const result = clone(`file://${bareRepoDir}`, dest, { depth: 1 });
    expect(result.ok).toBe(true);

    // Check config exists in cloned dir
    const configExists = await Bun.file(join(dest, "ezcorp.config.ts")).exists();
    expect(configExists).toBe(true);
  });

  test("clone with branch ref", () => {
    const dest = join(tempBase, "clone2");

    const result = clone(`file://${bareRepoDir}`, dest, { depth: 1, branch: "v1.0.0" });
    expect(result.ok).toBe(true);
  });

  test("lsRemoteTags returns tag names", () => {
    const tags = lsRemoteTags(`file://${bareRepoDir}`);
    expect(tags).toContain("v1.0.0");
  });

  test("getCurrentRef returns a commit hash", () => {
    const dest = join(tempBase, "clone3");
    clone(`file://${bareRepoDir}`, dest, { depth: 1 });

    const ref = getCurrentRef(dest);
    expect(ref).toMatch(/^[a-f0-9]{40}$/);
  });

  test("clone failure with bad URL", () => {
    const dest = join(tempBase, "clone-bad-url");
    const result = clone(
      "https://invalid-url-that-doesnt-exist.example.com/repo.git",
      dest,
    );
    expect(result.ok).toBe(false);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("clone treats option-shaped url as a path, not a git option", () => {
    const dest = join(tempBase, "clone-option-url");
    // With the `--` end-of-options separator, an option-shaped positional
    // arg must be interpreted literally as a (nonexistent) repo path.
    const result = clone("--upload-pack=/bin/true", dest);
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/does not exist/);
  });

  test("lsRemoteTags with no tags returns empty array", () => {
    const emptyBare = join(tempBase, "empty-bare.git");
    spawn(["git", "init", "--bare", emptyBare]);

    const tags = lsRemoteTags(`file://${emptyBare}`);
    expect(tags).toEqual([]);
  });

  test("getCurrentRef throws for nonexistent dir", () => {
    expect(() => getCurrentRef("/nonexistent-dir-xyz")).toThrow(
      /Failed to get HEAD ref/,
    );
  });

  test("gitExec respects cwd option", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "git-cwd-"));
    tempDirs.push(repoDir);
    spawn(["git", "init", repoDir]);

    const result = gitExec(["rev-parse", "--git-dir"], { cwd: repoDir });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(".git");
  });
});
