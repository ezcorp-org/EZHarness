// ── Test-evidence location — unit tests (evidence.go port) ──────────

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionHostRunner, type ShellRunner } from "../shell";
import type { RepoEvidence } from "../repo-config";
import {
  testEvidenceDir,
  hasPathRootPrefix,
  hasWindowsDrivePrefix,
  safeRepoSubdir,
  sanitizeEvidenceSegment,
  evidenceBranchSlug,
  repoPathHasSymlink,
  resolveTestEvidenceLocation,
} from "./evidence";

describe("pure path helpers", () => {
  test("testEvidenceDir joins the renamed root + run id", () => {
    expect(testEvidenceDir("/tmp/ext", "run_1")).toBe("/tmp/ext/ez-code-factory-evidence/run_1");
  });

  test("hasPathRootPrefix", () => {
    expect(hasPathRootPrefix("/abs")).toBe(true);
    expect(hasPathRootPrefix("\\abs")).toBe(true);
    expect(hasPathRootPrefix("rel")).toBe(false);
  });

  test("hasWindowsDrivePrefix", () => {
    expect(hasWindowsDrivePrefix("C:\\x")).toBe(true);
    expect(hasWindowsDrivePrefix("z:/x")).toBe(true);
    expect(hasWindowsDrivePrefix("ab")).toBe(false);
    expect(hasWindowsDrivePrefix("1:x")).toBe(false);
    expect(hasWindowsDrivePrefix("a")).toBe(false);
  });

  test("safeRepoSubdir accepts a clean relative subdir", () => {
    expect(safeRepoSubdir("evidence/dir")).toBe("evidence/dir");
    expect(safeRepoSubdir("  evidence  ")).toBe("evidence");
    expect(safeRepoSubdir("a/./b")).toBe("a/b");
  });

  test("safeRepoSubdir rejects empty, absolute, drive, escaping, and .git", () => {
    expect(safeRepoSubdir("")).toBeNull();
    expect(safeRepoSubdir("   ")).toBeNull();
    expect(safeRepoSubdir("/abs")).toBeNull();
    expect(safeRepoSubdir("C:\\win")).toBeNull();
    expect(safeRepoSubdir("..")).toBeNull();
    expect(safeRepoSubdir("../escape")).toBeNull();
    expect(safeRepoSubdir(".")).toBeNull();
    expect(safeRepoSubdir(".git")).toBeNull();
    expect(safeRepoSubdir(".GIT/hooks")).toBeNull();
  });

  test("sanitizeEvidenceSegment keeps safe chars, dashes the rest, collapses + trims", () => {
    expect(sanitizeEvidenceSegment("feat/x y")).toBe("feat-x-y");
    expect(sanitizeEvidenceSegment("--a__b.c--")).toBe("a__b.c");
    expect(sanitizeEvidenceSegment("  ok  ")).toBe("ok");
    expect(sanitizeEvidenceSegment("###")).toBe("");
  });

  test("evidenceBranchSlug splits + sanitizes + drops traversal", () => {
    expect(evidenceBranchSlug("feat/new-thing")).toEqual(["feat", "new-thing"]);
    expect(evidenceBranchSlug("a/../b")).toEqual(["a", "b"]);
    expect(evidenceBranchSlug("///")).toEqual([]);
  });
});

describe("repoPathHasSymlink (real fs)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ezcf-sym-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a plain non-existent path is safe", async () => {
    expect(await repoPathHasSymlink(productionHostRunner, dir, "a/b/c")).toBe(false);
  });

  test("an existing real dir chain is safe", async () => {
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    expect(await repoPathHasSymlink(productionHostRunner, dir, "a/b")).toBe(false);
  });

  test("a symlinked component is unsafe", async () => {
    mkdirSync(join(dir, "real"), { recursive: true });
    symlinkSync(join(dir, "real"), join(dir, "link"));
    expect(await repoPathHasSymlink(productionHostRunner, dir, "link/evidence")).toBe(true);
  });

  test("a traversal / absolute rel is unsafe", async () => {
    expect(await repoPathHasSymlink(productionHostRunner, dir, "../x")).toBe(true);
    expect(await repoPathHasSymlink(productionHostRunner, dir, "/abs")).toBe(true);
  });
});

describe("resolveTestEvidenceLocation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ezcf-ev-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const noopRunner: ShellRunner = async () => ({ exitCode: 1, stdout: "", stderr: "" });

  test("opt-out (default) → the temp dir", async () => {
    const ev: RepoEvidence = { storeInRepo: false, dir: ".ez-code-factory/evidence" };
    const loc = await resolveTestEvidenceLocation({
      runner: noopRunner,
      worktree: dir,
      branch: "feat/x",
      runId: "run_1",
      tmpBase: "/tmp/ext",
      evidence: ev,
    });
    expect(loc).toEqual({ dir: "/tmp/ext/ez-code-factory-evidence/run_1", storeInRepo: false, rel: "" });
  });

  test("opt-in with a safe subdir → an in-repo branch-named dir", async () => {
    const ev: RepoEvidence = { storeInRepo: true, dir: "evidence" };
    const loc = await resolveTestEvidenceLocation({
      runner: productionHostRunner,
      worktree: dir,
      branch: "feat/x",
      runId: "run_1",
      tmpBase: "/tmp/ext",
      evidence: ev,
    });
    expect(loc.storeInRepo).toBe(true);
    expect(loc.dir).toBe(join(dir, "evidence", "feat", "x"));
    expect(loc.rel).toBe("evidence/feat/x");
  });

  test("opt-in with an unsafe (absolute) subdir → falls back to temp", async () => {
    const ev: RepoEvidence = { storeInRepo: true, dir: "/etc" };
    const loc = await resolveTestEvidenceLocation({
      runner: productionHostRunner,
      worktree: dir,
      branch: "feat/x",
      runId: "run_1",
      tmpBase: "/tmp/ext",
      evidence: ev,
    });
    expect(loc.storeInRepo).toBe(false);
    expect(loc.dir).toBe("/tmp/ext/ez-code-factory-evidence/run_1");
  });

  test("opt-in with a branch that slugs to nothing → uses the run id segment", async () => {
    const ev: RepoEvidence = { storeInRepo: true, dir: "evidence" };
    const loc = await resolveTestEvidenceLocation({
      runner: productionHostRunner,
      worktree: dir,
      branch: "///",
      runId: "run_1",
      tmpBase: "/tmp/ext",
      evidence: ev,
    });
    expect(loc.dir).toBe(join(dir, "evidence", "run_1"));
  });

  test("opt-in through a symlinked evidence root → falls back to temp", async () => {
    mkdirSync(join(dir, "real"), { recursive: true });
    symlinkSync(join(dir, "real"), join(dir, "evidence"));
    const ev: RepoEvidence = { storeInRepo: true, dir: "evidence" };
    const loc = await resolveTestEvidenceLocation({
      runner: productionHostRunner,
      worktree: dir,
      branch: "feat/x",
      runId: "run_1",
      tmpBase: "/tmp/ext",
      evidence: ev,
    });
    expect(loc.storeInRepo).toBe(false);
  });
});
