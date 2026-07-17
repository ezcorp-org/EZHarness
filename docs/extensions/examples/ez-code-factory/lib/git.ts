// ── Git helpers over the injectable ShellRunner ─────────────────────
//
// DRY wrappers so the pipeline steps never hand-build `["git","-C",dir,…]`
// arrays. `makeGit(runner, dir)` binds a runner (host for read-only ops, the
// nested jail for mutating commit/push) to a working dir. The primitives mirror
// internal/git/git.go; the ancestry tri-state preserves git's exit-1-vs-error
// distinction the force-push detection relies on.
//
// Pure over the runner — every method routes through the injected ShellRunner,
// so tests drive real git against a throwaway repo AND stub specific exit codes.

import type { ShellResult, ShellRunner } from "./shell";

/** Git's empty-tree object id — the base for a brand-new branch's diff. */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** True for an empty string or an all-zero SHA (a branch create/delete ref). */
export function isZeroSHA(sha: string): boolean {
  const s = sha.trim();
  return s === "" || /^0+$/.test(s);
}

/** First 12 chars of a SHA for human-readable step logs. Verbatim shortSHA. */
export function shortSHA(sha: string): string {
  return sha.length <= 12 ? sha : sha.slice(0, 12);
}

/** A non-zero git exit, carrying the code + stderr so callers can branch (e.g.
 *  force-push detection distinguishing exit 1 from a real error). */
export class GitError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** merge-base --is-ancestor outcome: exit 0 = yes, exit 1 = no, else error. */
export type Ancestry = "yes" | "no" | "error";

export interface Git {
  /** Run a git subcommand; reject with GitError on non-zero exit, else resolve
   *  trimmed stdout. Use for ops where any failure must abort the step. */
  run(...args: string[]): Promise<string>;
  /** Run a git subcommand; never throw — resolve the raw ShellResult. */
  try(...args: string[]): Promise<ShellResult>;
  /** True when the subcommand exits 0. */
  ok(...args: string[]): Promise<boolean>;
  /** Current worktree HEAD SHA. */
  headSha(): Promise<string>;
  /** `git status --porcelain` output (error tolerated → ""). */
  statusPorcelain(): Promise<string>;
  /** SHA a ref resolves to, or null when it does not exist. */
  revParseVerify(ref: string): Promise<string | null>;
  /** Ancestry tri-state for `merge-base --is-ancestor ancestor descendant`. */
  ancestry(ancestor: string, descendant: string): Promise<Ancestry>;
  /** `git diff <base> <head>` (throws on git error). */
  diff(base: string, head: string): Promise<string>;
  /** `git diff --name-only <base>..<head>` split into non-empty paths. */
  diffNameOnly(base: string, head: string): Promise<string[]>;
  /** SHA of `ref` on `remote` via ls-remote, "" when absent (throws on git error). */
  lsRemoteSHA(remote: string, ref: string): Promise<string>;
  /** Force-update fetch of a branch into its remote-tracking ref. Returns the
   *  ShellResult so best-effort callers can log-and-continue on failure. */
  fetchRemoteBranch(remote: string, branch: string): Promise<ShellResult>;
  /** Force-update fetch of a branch into an explicit local ref. */
  fetchRemoteBranchToRef(remote: string, branch: string, localRef: string): Promise<ShellResult>;
  /** Push HEAD to `remote` `ref`. With `forceWithLease`, anchors the lease to
   *  `expectedSHA` (`--force-with-lease=ref:sha`) when provided, else a bare
   *  lease. Throws GitError on rejection. Verbatim PushWithOptions. */
  push(remote: string, ref: string, expectedSHA: string, forceWithLease: boolean): Promise<void>;
}

/** Bind a runner + working dir into a Git helper. */
export function makeGit(runner: ShellRunner, dir: string): Git {
  const argv = (args: string[]): string[] => ["git", "-C", dir, ...args];

  const tryRun = (...args: string[]): Promise<ShellResult> => runner(argv(args), dir);

  const run = async (...args: string[]): Promise<string> => {
    const r = await tryRun(...args);
    if (r.exitCode !== 0) {
      throw new GitError(
        r.exitCode,
        r.stderr,
        `git ${args.join(" ")} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
      );
    }
    return r.stdout.trim();
  };

  const ok = async (...args: string[]): Promise<boolean> => (await tryRun(...args)).exitCode === 0;

  return {
    run,
    try: tryRun,
    ok,
    headSha: () => run("rev-parse", "HEAD"),
    async statusPorcelain() {
      return (await tryRun("status", "--porcelain")).stdout;
    },
    async revParseVerify(ref) {
      const r = await tryRun("rev-parse", "--verify", ref);
      return r.exitCode === 0 ? r.stdout.trim() : null;
    },
    async ancestry(ancestor, descendant) {
      const r = await tryRun("merge-base", "--is-ancestor", ancestor, descendant);
      if (r.exitCode === 0) return "yes";
      if (r.exitCode === 1) return "no";
      return "error";
    },
    diff: (base, head) => run("diff", base, head),
    async diffNameOnly(base, head) {
      const out = await run("diff", "--name-only", `${base}..${head}`);
      return out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
    },
    async lsRemoteSHA(remote, ref) {
      const out = await run("ls-remote", remote, ref);
      const fields = out.trim().split(/\s+/).filter(Boolean);
      return fields.length === 0 ? "" : fields[0]!;
    },
    fetchRemoteBranch: (remote, branch) =>
      tryRun("fetch", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`),
    fetchRemoteBranchToRef: (remote, branch, localRef) =>
      tryRun("fetch", "--no-tags", remote, `+refs/heads/${branch}:${localRef}`),
    async push(remote, ref, expectedSHA, forceWithLease) {
      const args = ["push", remote];
      if (forceWithLease) {
        args.push(expectedSHA !== "" ? `--force-with-lease=${ref}:${expectedSHA}` : "--force-with-lease");
      }
      args.push(`HEAD:${ref}`);
      await run(...args);
    },
  };
}
