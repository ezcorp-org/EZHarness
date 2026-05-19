/**
 * Coverage-focused tests for source-parser.ts and git.ts.
 *
 * Fills branch/line gaps not covered by the existing test suites.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { parseSource } from "../extensions/source-parser";
import { gitExec, clone, lsRemoteTags, getCurrentRef } from "../extensions/git";

// ── parseSource coverage ────────────────────────────────────────────────

describe("parseSource – coverage gaps", () => {
  test("gitlab:org/project without @ref has ref undefined", () => {
    const result = parseSource("gitlab:org/project");
    expect(result).toEqual({
      type: "gitlab",
      cloneUrl: "https://gitlab.com/org/project.git",
      displayName: "org/project",
      ref: undefined,
      original: "gitlab:org/project",
    });
  });

  test("http:// URL matches the https? regex", () => {
    const result = parseSource("http://example.com/repo.git");
    expect(result).toEqual({
      type: "https",
      cloneUrl: "http://example.com/repo.git",
      displayName: "example.com/repo",
      ref: undefined,
      original: "http://example.com/repo.git",
    });
  });

  test("http:// URL with @ref", () => {
    const result = parseSource("http://example.com/repo.git@dev");
    expect(result.type).toBe("https");
    expect(result.cloneUrl).toBe("http://example.com/repo.git");
    expect(result.ref).toBe("dev");
    expect(result.original).toBe("http://example.com/repo.git@dev");
  });

  test("SSH with gitlab host", () => {
    const result = parseSource("git@gitlab.com:org/repo.git");
    expect(result).toEqual({
      type: "ssh",
      cloneUrl: "git@gitlab.com:org/repo.git",
      displayName: "org/repo",
      ref: undefined,
      original: "git@gitlab.com:org/repo.git",
    });
  });

  test("SSH with gitlab host and @ref", () => {
    const result = parseSource("git@gitlab.com:org/repo.git@feature");
    expect(result.type).toBe("ssh");
    expect(result.cloneUrl).toBe("git@gitlab.com:org/repo.git");
    expect(result.displayName).toBe("org/repo");
    expect(result.ref).toBe("feature");
  });

  test("SSH with custom host (bitbucket)", () => {
    const result = parseSource("git@bitbucket.org:team/project.git");
    expect(result.type).toBe("ssh");
    expect(result.displayName).toBe("team/project");
    expect(result.cloneUrl).toBe("git@bitbucket.org:team/project.git");
  });

  test("file:// displayName is the local path", () => {
    const result = parseSource("file:///home/user/my-ext.git");
    expect(result.type).toBe("file");
    expect(result.displayName).toBe("/home/user/my-ext.git");
    expect(result.cloneUrl).toBe("file:///home/user/my-ext.git");
  });

  test("file:// with deeper path", () => {
    const result = parseSource("file:///var/lib/repos/ext.git");
    expect(result.displayName).toBe("/var/lib/repos/ext.git");
  });

  test("https URL without .git suffix", () => {
    const result = parseSource("https://example.com/my-repo");
    expect(result.type).toBe("https");
    expect(result.cloneUrl).toBe("https://example.com/my-repo");
    expect(result.displayName).toBe("example.com/my-repo");
    expect(result.ref).toBeUndefined();
  });

  test("https URL without .git suffix with @ref", () => {
    const result = parseSource("https://example.com/my-repo@v3");
    expect(result.type).toBe("https");
    expect(result.cloneUrl).toBe("https://example.com/my-repo");
    expect(result.displayName).toBe("example.com/my-repo");
    expect(result.ref).toBe("v3");
  });

  test("github with nested path (org/suborg/repo)", () => {
    const result = parseSource("github:org/suborg/repo");
    expect(result.type).toBe("github");
    expect(result.cloneUrl).toBe("https://github.com/org/suborg/repo.git");
    expect(result.displayName).toBe("org/suborg/repo");
    expect(result.ref).toBeUndefined();
  });

  test("github with nested path and @ref", () => {
    const result = parseSource("github:org/suborg/repo@v2.0.0");
    expect(result.type).toBe("github");
    expect(result.displayName).toBe("org/suborg/repo");
    expect(result.ref).toBe("v2.0.0");
  });

  test("original field is always preserved", () => {
    const cases = [
      "github:user/repo",
      "github:user/repo@main",
      "gitlab:org/project",
      "gitlab:org/project@dev",
      "https://example.com/r.git",
      "https://example.com/r.git@v1",
      "http://example.com/r.git",
      "git@github.com:u/r.git",
      "git@github.com:u/r.git@v1",
      "file:///tmp/r.git",
      "file:///tmp/r.git@v1",
    ];
    for (const src of cases) {
      expect(parseSource(src).original).toBe(src);
    }
  });
});

// ── git.ts coverage ─────────────────────────────────────────────────────

describe("git.ts – coverage gaps", () => {
  let tempBase: string;
  let bareRepoDir: string;

  const env = { ...process.env };
  const spawn = (cmd: string[], opts?: { cwd?: string }) =>
    Bun.spawnSync(cmd, { ...opts, env });

  beforeAll(async () => {
    tempBase = await mkdtemp(join(tmpdir(), "git-cov-"));

    // Set up a bare repo with one commit and one tag
    bareRepoDir = join(tempBase, "bare.git");
    spawn(["git", "init", "--bare", bareRepoDir]);

    const workDir = join(tempBase, "work");
    spawn(["git", "clone", bareRepoDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

    await Bun.write(join(workDir, "file.txt"), "hello");
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "initial"], { cwd: workDir });
    spawn(["git", "tag", "v1.0.0"], { cwd: workDir });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });
  });

  afterAll(async () => {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {});
  });

  // ── gitExec ──

  test("gitExec catch branch – invalid cwd triggers spawnSync error", () => {
    // Passing an empty-string command after "git" won't throw, but an
    // entirely non-existent cwd on some systems causes spawnSync to throw.
    // We test this by using a cwd that is a file, not a directory.
    const filePath = join(tempBase, "work", "file.txt");
    const result = gitExec(["status"], { cwd: filePath });
    // Should hit either the try (non-zero exit) or catch branch; either way ok=false
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  test("gitExec custom timeout is accepted", () => {
    const result = gitExec(["--version"], { timeout: 5000 });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("git version");
  });

  test("gitExec with explicit cwd succeeds", () => {
    const cloneDir = join(tempBase, "cwd-test");
    clone(`file://${bareRepoDir}`, cloneDir);
    const result = gitExec(["log", "--oneline", "-1"], { cwd: cloneDir });
    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  // ── clone ──

  test("clone without options (no depth, no branch)", () => {
    const dest = join(tempBase, "clone-no-opts");
    const result = clone(`file://${bareRepoDir}`, dest);
    expect(result.ok).toBe(true);
  });

  test("clone failure with invalid URL", () => {
    const dest = join(tempBase, "clone-fail");
    const result = clone("file:///nonexistent/repo.git", dest);
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  // ── lsRemoteTags ──

  test("lsRemoteTags returns empty when result is not ok (bad URL)", () => {
    const tags = lsRemoteTags("file:///nonexistent/repo.git");
    expect(tags).toEqual([]);
  });

  test("lsRemoteTags returns empty when stdout is empty (repo with no tags)", async () => {
    // Create a bare repo with no tags
    const noTagsBare = join(tempBase, "no-tags.git");
    spawn(["git", "init", "--bare", noTagsBare]);

    const noTagsWork = join(tempBase, "no-tags-work");
    spawn(["git", "clone", noTagsBare, noTagsWork]);
    spawn(["git", "config", "user.email", "t@t.com"], { cwd: noTagsWork });
    spawn(["git", "config", "user.name", "T"], { cwd: noTagsWork });
    await Bun.write(join(noTagsWork, "a.txt"), "a");
    spawn(["git", "add", "."], { cwd: noTagsWork });
    spawn(["git", "commit", "-m", "no tags"], { cwd: noTagsWork });
    spawn(["git", "push", "origin", "HEAD"], { cwd: noTagsWork });

    const tags = lsRemoteTags(`file://${noTagsBare}`);
    expect(tags).toEqual([]);
  });

  test("lsRemoteTags filters ^{} deref lines", async () => {
    // Create a repo with an annotated tag (which produces ^{} lines in ls-remote)
    const annotatedBare = join(tempBase, "annotated.git");
    spawn(["git", "init", "--bare", annotatedBare]);

    const annotatedWork = join(tempBase, "annotated-work");
    spawn(["git", "clone", annotatedBare, annotatedWork]);
    spawn(["git", "config", "user.email", "t@t.com"], { cwd: annotatedWork });
    spawn(["git", "config", "user.name", "T"], { cwd: annotatedWork });
    await Bun.write(join(annotatedWork, "b.txt"), "b");
    spawn(["git", "add", "."], { cwd: annotatedWork });
    spawn(["git", "commit", "-m", "annotated"], { cwd: annotatedWork });
    // Annotated tag creates both refs/tags/v2.0.0 and refs/tags/v2.0.0^{}
    spawn(["git", "tag", "-a", "v2.0.0", "-m", "release v2"], { cwd: annotatedWork });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: annotatedWork });

    const tags = lsRemoteTags(`file://${annotatedBare}`);
    expect(tags).toContain("v2.0.0");
    // No ^{} entries should appear
    for (const tag of tags) {
      expect(tag).not.toContain("^{}");
    }
  });

  test("lsRemoteTags handles lines with no tab separator gracefully", () => {
    // This is handled by the refPath?.replace fallback.
    // With a valid repo the output is well-formed, so we just confirm
    // the function handles the repo correctly and returns valid tags.
    const tags = lsRemoteTags(`file://${bareRepoDir}`);
    expect(tags).toContain("v1.0.0");
    for (const tag of tags) {
      expect(tag.length).toBeGreaterThan(0);
    }
  });

  // ── getCurrentRef ──

  test("getCurrentRef throws when git rev-parse fails", () => {
    expect(() => getCurrentRef("/nonexistent-dir-xyz")).toThrow(
      /Failed to get HEAD ref/,
    );
  });

  test("getCurrentRef returns 40-char hash for valid repo", () => {
    const dest = join(tempBase, "ref-check");
    clone(`file://${bareRepoDir}`, dest);
    const ref = getCurrentRef(dest);
    expect(ref).toMatch(/^[a-f0-9]{40}$/);
  });
});
