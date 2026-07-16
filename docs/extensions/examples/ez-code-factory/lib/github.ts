// ── GitHub host over the gh CLI — port of scm/github/github.go (+ scm/host.go) ──
//
// The PR + CI steps talk to GitHub through the `gh` CLI, wrapped behind an
// injectable `GhRunner` seam (mirrors lib/shell.ts's ShellRunner) so tests
// drive every branch with a fake instead of a live host. GitHub-only (decision
// #3 / spec §11): provider detection is a github.com check, and the fork /
// GitLab / Bitbucket / Azure / GHE-host-config paths upstream carries are out of
// scope. Every method builds `gh` argv, runs it, and parses the JSON; the pure
// helpers (slug/host/PR-number extraction, state/bucket normalization) are
// exercised directly.

import type { ShellResult } from "./shell";

/** Run `gh <args>` (optionally feeding stdin), resolving the raw result. The
 *  production runner (index.ts) binds the worktree cwd + GH_TOKEN from the
 *  secret setting; tests inject a fake. Mirrors github.go's CmdFactory. */
export type GhRunner = (args: string[], opts?: { stdin?: string }) => Promise<ShellResult>;

// ── Provider detection (scm/scm.go DetectProvider, GitHub-only) ─────

export type Provider = "github" | "unknown";

/** GitHub when the URL names github.com, else unknown. GitHub-only v1 scope —
 *  the GHE-host-config / GitLab / Bitbucket / Azure fallbacks are out of scope. */
export function detectProvider(url: string): Provider {
  return url.toLowerCase().includes("github.com") ? "github" : "unknown";
}

// ── URL parsing (scm/host.go + github.go) ───────────────────────────

/** Lowercased host (no port) from a git remote or PR URL; "" when none.
 *  Handles scp-like `git@host:path` and `scheme://[user@]host[:port]/path`.
 *  Verbatim intent of ExtractHost. */
export function extractHost(remote: string): string {
  let s = remote.trim();
  if (s === "") return "";
  const scheme = s.indexOf("://");
  if (scheme >= 0) {
    s = s.slice(scheme + 3);
    const slash = s.indexOf("/");
    if (slash >= 0) s = s.slice(0, slash);
    const at = s.lastIndexOf("@");
    if (at >= 0) s = s.slice(at + 1);
    return stripPort(s).toLowerCase();
  }
  const colon = s.indexOf(":");
  if (colon >= 0) {
    s = s.slice(0, colon);
  } else {
    const slash = s.indexOf("/");
    if (slash >= 0) s = s.slice(0, slash);
  }
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  return s.toLowerCase();
}

/** Strip a trailing `:port` from a host, leaving bare hosts intact. */
function stripPort(host: string): string {
  const c = host.lastIndexOf(":");
  if (c < 0) return host;
  const port = host.slice(c + 1);
  if (port !== "" && /^[0-9]+$/.test(port)) return host.slice(0, c);
  return host;
}

/**
 * Extract the `owner/name` slug from a GitHub remote or PR URL. Supports
 * https, scp-like ssh (`git@github.com:owner/name.git`), ssh://, and longer
 * paths (PR links — the leading two path segments). "" when there is no
 * owner/name pair. Verbatim RepoSlug.
 */
export function repoSlug(remoteURL: string): string {
  let raw = remoteURL.trim();
  if (raw === "") return "";
  if (raw.endsWith(".git")) raw = raw.slice(0, -".git".length);
  if (raw.includes("://")) {
    const rest = raw.slice(raw.indexOf("://") + 3);
    const slash = rest.indexOf("/");
    if (slash < 0) return "";
    raw = rest.slice(slash + 1);
  } else if (raw.includes(":")) {
    raw = raw.slice(raw.indexOf(":") + 1);
  }
  const parts = raw.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) return "";
  const owner = parts[0]!.trim();
  const name = parts[1]!.trim();
  if (owner === "" || name === "") return "";
  return `${owner}/${name}`;
}

/**
 * The trailing numeric segment of a PR URL (GitHub `/pull/N`), or null when the
 * URL has no numeric tail. Verbatim ExtractPRNumber (returns null instead of an
 * error — callers treat null as "no PR").
 */
export function extractPRNumber(prURL: string): string | null {
  const trimmed = prURL.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  const num = parts[parts.length - 1] ?? "";
  if (num === "" || !/^[0-9]+$/.test(num)) return null;
  return num;
}

// ── PR / check value types (scm/host.go) ────────────────────────────

export interface PR {
  number: string;
  url: string;
}

export interface PRContent {
  title: string;
  body: string;
}

export type PRState = "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";
export type MergeableState = "MERGEABLE" | "CONFLICTING" | "PENDING";
export type CheckBucket = "pass" | "fail" | "pending" | "cancel" | "skipping" | "";

export interface Check {
  name: string;
  bucket: CheckBucket;
  /** RFC3339 completion time, or "" when unknown (drives CI re-run detection). */
  completedAt: string;
}

/** A check is failing when its bucket is `fail`. */
export function checkFailing(c: Check): boolean {
  return c.bucket === "fail";
}
/** A check is pending when still running/queued. */
export function checkPending(c: Check): boolean {
  return c.bucket === "pending";
}

/** Normalize a gh `state`/`.state` string to a PRState. Verbatim normalizePRState. */
export function normalizePRState(raw: string): PRState {
  switch (raw.trim().toUpperCase()) {
    case "OPEN":
      return "OPEN";
    case "MERGED":
      return "MERGED";
    case "CLOSED":
      return "CLOSED";
    default:
      return "UNKNOWN";
  }
}

/** Normalize a gh `.mergeable` string. Verbatim normalizeMergeableState. */
export function normalizeMergeableState(raw: string): MergeableState {
  switch (raw.trim().toUpperCase()) {
    case "MERGEABLE":
      return "MERGEABLE";
    case "CONFLICTING":
      return "CONFLICTING";
    default:
      return "PENDING";
  }
}

/** A resolved (final) mergeable state — MERGEABLE or CONFLICTING. */
export function mergeableResolved(s: MergeableState): boolean {
  return s === "MERGEABLE" || s === "CONFLICTING";
}
/** A known merge conflict. */
export function mergeableConflict(s: MergeableState): boolean {
  return s === "CONFLICTING";
}

/** Normalize a gh check `bucket` (preferred) or `state` to a CheckBucket.
 *  Verbatim normalizeCheckBucket. */
export function normalizeCheckBucket(bucket: string, state: string): CheckBucket {
  const b = bucket.trim();
  if (b !== "") return b as CheckBucket;
  switch (state.trim().toUpperCase()) {
    case "SUCCESS":
      return "pass";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "fail";
    case "PENDING":
    case "QUEUED":
    case "IN_PROGRESS":
    case "WAITING":
    case "REQUESTED":
    case "EXPECTED":
      return "pending";
    case "CANCELLED":
      return "cancel";
    case "SKIPPED":
    case "NEUTRAL":
    case "STALE":
      return "skipping";
    default:
      return "";
  }
}

// ── gh-CLI host ─────────────────────────────────────────────────────

/** The provider-agnostic PR-host surface the pr/ci steps consume. */
export interface GitHubHost {
  available(): Promise<string | null>;
  findPR(branch: string, base: string): Promise<PR | null>;
  createPR(branch: string, base: string, content: PRContent): Promise<PR | null>;
  updatePR(pr: PR, content: PRContent): Promise<PR>;
  getPRState(pr: PR): Promise<PRState>;
  getChecks(pr: PR): Promise<Check[]>;
  getMergeableState(pr: PR): Promise<MergeableState>;
  fetchFailedCheckLogs(branch: string, headSHA: string, failingNames: string[]): Promise<string>;
}

/** JSON.parse that never throws — malformed gh output yields null. */
function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Build a GitHubHost bound to a GhRunner + repo slug/host. `repo` (owner/name)
 * is passed via `--repo` so gh resolves the right repository regardless of the
 * process cwd (the daemon runs from a fixed dir); `host` scopes the auth check
 * (`--hostname`) so a stale credential for an unrelated gh host cannot make this
 * repo look unauthenticated. Verbatim New/NewWithFork intent, fork path omitted.
 */
export function makeGitHubHost(gh: GhRunner, opts: { host: string; repo: string }): GitHubHost {
  const repo = opts.repo.trim();
  const host = opts.host.trim();
  const repoArgs = (): string[] => (repo === "" ? [] : ["--repo", repo]);

  return {
    async available() {
      const authArgs = ["auth", "status"];
      if (host !== "") authArgs.push("--hostname", host);
      const r = await gh(authArgs);
      return r.exitCode === 0 ? null : "gh CLI is not authenticated";
    },

    async findPR(branch, base) {
      const args = ["pr", "list", "--head", branch];
      if (base.trim() !== "") args.push("--base", base);
      args.push(...repoArgs(), "--state", "open", "--json", "number,url");
      const r = await gh(args);
      if (r.exitCode !== 0) {
        throw new Error(`gh pr list: ${(r.stderr || r.stdout).trim()}`);
      }
      const prs = safeJson<Array<{ number?: number; url?: string }>>(r.stdout);
      if (!Array.isArray(prs) || prs.length === 0) return null;
      const candidate = prs[0]!;
      const url = (candidate.url ?? "").trim();
      if (url === "") return null;
      const number =
        typeof candidate.number === "number" && candidate.number > 0
          ? String(candidate.number)
          : (extractPRNumber(url) ?? "");
      return { url, number };
    },

    async createPR(branch, base, content) {
      const args = [
        "pr", "create", "--head", branch, "--base", base,
        ...repoArgs(), "--title", content.title, "--body-file", "-",
      ];
      const r = await gh(args, { stdin: content.body });
      if (r.exitCode !== 0) {
        throw new Error(`gh pr create: ${(r.stderr || r.stdout).trim()}`);
      }
      const url = r.stdout.trim();
      if (url === "") return null;
      return { url, number: extractPRNumber(url) ?? "" };
    },

    async updatePR(pr, content) {
      const id = pr.number !== "" ? pr.number : pr.url;
      const args = ["pr", "edit", id, ...repoArgs(), "--title", content.title, "--body-file", "-"];
      const r = await gh(args, { stdin: content.body });
      if (r.exitCode !== 0) {
        throw new Error(`gh pr edit: ${(r.stderr || r.stdout).trim()}`);
      }
      return pr;
    },

    async getPRState(pr) {
      const r = await gh(["pr", "view", pr.number, ...repoArgs(), "--json", "state", "--jq", ".state"]);
      if (r.exitCode !== 0) {
        throw new Error(`gh pr view: ${(r.stderr || r.stdout).trim()}`);
      }
      return normalizePRState(r.stdout.trim());
    },

    async getChecks(pr) {
      const r = await gh(["pr", "checks", pr.number, ...repoArgs(), "--json", "name,state,bucket,completedAt"]);
      if (r.exitCode !== 0) {
        if ((r.stdout + r.stderr).includes("no checks reported")) return [];
        throw new Error(`gh pr checks: ${(r.stderr || r.stdout).trim()}`);
      }
      const raw = safeJson<Array<{ name?: string; state?: string; bucket?: string; completedAt?: string }>>(r.stdout);
      if (!Array.isArray(raw)) throw new Error("parse CI checks: malformed gh output");
      return raw.map((c) => ({
        name: c.name ?? "",
        bucket: normalizeCheckBucket(c.bucket ?? "", c.state ?? ""),
        completedAt: (c.completedAt ?? "").trim(),
      }));
    },

    async getMergeableState(pr) {
      const r = await gh(["pr", "view", pr.number, ...repoArgs(), "--json", "mergeable", "--jq", ".mergeable"]);
      if (r.exitCode !== 0) {
        throw new Error(`gh pr view mergeable: ${(r.stderr || r.stdout).trim()}`);
      }
      return normalizeMergeableState(r.stdout.trim());
    },

    async fetchFailedCheckLogs(branch, headSHA, failingNames) {
      const targets = new Set(failingNames.map(normalizeRunName).filter((n) => n !== ""));
      if (targets.size === 0) return "";
      const args = ["run", "list", "--branch", branch];
      if (headSHA.trim() !== "") args.push("--commit", headSHA.trim());
      args.push(...repoArgs(), "--status", "failure", "--limit", "20", "--json", "databaseId,name,displayTitle,workflowName");
      const list = await gh(args);
      if (list.exitCode !== 0) return "";
      const runs = safeJson<Array<{ databaseId?: number; name?: string; displayTitle?: string; workflowName?: string }>>(list.stdout);
      if (!Array.isArray(runs)) return "";
      for (const run of runs) {
        const names = [run.name, run.displayTitle, run.workflowName];
        if (!names.some((n) => targets.has(normalizeRunName(n ?? "")))) continue;
        const id = run.databaseId;
        if (typeof id !== "number" || id === 0) continue;
        const view = await gh(["run", "view", String(id), ...repoArgs(), "--log-failed"]);
        if (view.exitCode !== 0) continue;
        const logs = view.stdout.trim();
        if (logs !== "") return logs;
      }
      return "";
    },
  };
}

/** Lowercased, trimmed run/check name for target matching. Verbatim normalizeRunName. */
function normalizeRunName(name: string): string {
  return name.trim().toLowerCase();
}
