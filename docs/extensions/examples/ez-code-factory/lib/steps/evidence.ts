// ── Test-evidence location — port of pipeline/steps/evidence.go ─────
//
// Picks where the test step writes evidence artifacts (screenshots / GIFs /
// logs / CLI transcripts proving the intent works end-to-end).
//
// By default (opt-out) evidence lives in a temporary directory keyed by run id
// and is referenced only by local path. When the user opts in
// (`test.evidence.store_in_repo`) it lands under a readable, branch-named
// directory INSIDE the worktree so it is committed, pushed, and rendered
// directly on the PR. An absolute / escaping / symlink-traversing configured
// directory is REJECTED and falls back to the temporary location so evidence
// can never be written outside the worktree (renamed root:
// `ez-code-factory-evidence`).

import { posix } from "node:path";
import type { RepoEvidence } from "../repo-config";
import type { ShellRunner } from "../shell";

/** Where evidence is written for a run, and whether it lives in the repo tree. */
export interface EvidenceLocation {
  /** Absolute directory the agent writes artifacts into. */
  dir: string;
  /** True when the dir is inside the worktree (committed + pushed). */
  storeInRepo: boolean;
  /** Repo-relative path (only meaningful when storeInRepo) — the test step
   *  passes it to `git check-ignore`. "" for the temp location. */
  rel: string;
}

/** The temp evidence root (renamed from upstream `no-mistakes-evidence`). */
export function testEvidenceDir(tmpBase: string, runId: string): string {
  return posix.join(tmpBase, "ez-code-factory-evidence", runId);
}

/** True when `path` begins with a POSIX or Windows path root. Verbatim hasPathRootPrefix. */
export function hasPathRootPrefix(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\");
}

/** True when `path` begins with a `X:` Windows drive prefix. Verbatim hasWindowsDrivePrefix. */
export function hasWindowsDrivePrefix(path: string): boolean {
  if (path.length < 2 || path[1] !== ":") return false;
  const c = path.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/**
 * Validate a configured evidence directory as a relative path that stays inside
 * the repo worktree. Returns the cleaned path, or null when the directory is
 * empty, absolute, drive-prefixed, escapes the worktree, or targets `.git`.
 * Verbatim safeRepoSubdir.
 */
export function safeRepoSubdir(dir: string): string | null {
  const d = dir.trim();
  if (d === "" || hasPathRootPrefix(d) || hasWindowsDrivePrefix(d)) return null;
  const clean = posix.normalize(d.replace(/\\/g, "/")).replace(/\/+$/, "");
  if (clean === "." || clean === ".." || clean.startsWith("../")) return null;
  const first = clean.split("/")[0] ?? "";
  if (first.toLowerCase() === ".git") return null;
  return clean;
}

/**
 * Keep alphanumerics, dash, underscore, dot; replace every other char with a
 * dash, collapse dash runs, trim leading/trailing dashes. Verbatim
 * sanitizeEvidenceSegment.
 */
export function sanitizeEvidenceSegment(s: string): string {
  let out = "";
  for (const ch of s.trim()) {
    out += /[a-zA-Z0-9\-_.]/.test(ch) ? ch : "-";
  }
  while (out.includes("--")) out = out.replaceAll("--", "-");
  return out.replace(/^-+|-+$/g, "");
}

/**
 * Turn a branch name into readable, filesystem-safe path segments (separators
 * preserved as nested dirs; unsafe chars dashed; traversal segments dropped).
 * Verbatim evidenceBranchSlug.
 */
export function evidenceBranchSlug(branch: string): string[] {
  const segments: string[] = [];
  for (const raw of branch.split("/")) {
    const seg = sanitizeEvidenceSegment(raw);
    if (seg === "" || seg === "." || seg === "..") continue;
    segments.push(seg);
  }
  return segments;
}

/**
 * Walk the cumulative repo-relative path segment by segment and report whether
 * any component is (or traverses) a symlink — the escape a configured in-repo
 * evidence dir must not use. A non-existent tail is fine (nothing to traverse);
 * an unreadable component is treated as unsafe. Verbatim repoPathHasSymlink
 * (lstat walk → shell `test -L` / `test -e` on the host runner).
 */
export async function repoPathHasSymlink(
  runner: ShellRunner,
  worktree: string,
  rel: string,
): Promise<boolean> {
  const clean = posix.normalize(rel).replace(/\/+$/, "");
  if (clean === "." || clean === ".." || clean.startsWith("../") || clean.startsWith("/")) {
    return true;
  }
  let current = worktree;
  for (const part of clean.split("/")) {
    current = posix.join(current, part);
    // `test -L` exits 0 for a symlink (including a broken one).
    const isLink = await runner(["sh", "-c", 'test -L "$1"', "ez", current], worktree);
    if (isLink.exitCode === 0) return true;
    // Not a symlink and `test -e` non-zero → the component does not exist yet;
    // nothing further to traverse, so the path is safe.
    const exists = await runner(["sh", "-c", 'test -e "$1"', "ez", current], worktree);
    if (exists.exitCode !== 0) return false;
  }
  return false;
}

/** Inputs the test step supplies to resolve where evidence is written. */
export interface EvidenceResolveInput {
  runner: ShellRunner;
  worktree: string;
  branch: string;
  runId: string;
  tmpBase: string;
  evidence: RepoEvidence;
}

/**
 * Resolve the evidence location for a run. Opt-out → the temp dir. Opt-in with a
 * safe, non-symlink-traversing subdir → an in-repo, branch-named dir; any
 * unsafe configuration falls back to the temp dir. Verbatim
 * resolveTestEvidenceLocation.
 */
export async function resolveTestEvidenceLocation(input: EvidenceResolveInput): Promise<EvidenceLocation> {
  const temp: EvidenceLocation = {
    dir: testEvidenceDir(input.tmpBase, input.runId),
    storeInRepo: false,
    rel: "",
  };
  if (!input.evidence.storeInRepo) return temp;
  const sub = safeRepoSubdir(input.evidence.dir);
  if (sub === null) return temp;
  let segments = evidenceBranchSlug(input.branch);
  if (segments.length === 0) segments = [input.runId];
  const relParts = [sub, ...segments];
  const rel = relParts.join("/");
  if (await repoPathHasSymlink(input.runner, input.worktree, rel)) return temp;
  return { dir: [input.worktree, ...relParts].join("/"), storeInRepo: true, rel };
}
