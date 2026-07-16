#!/usr/bin/env bun
// docs-updater — the flagship proactive PR-drafter loop.
//
// The user's exact example, honestly scoped (council decision #8): it
// DRAFTS a docs PR, a human APPROVES, and on the `/repo` self-dev mount the
// merge stays MANUAL on GitHub (auto-merge is deliberately disabled there —
// respected, never worked around).
//
//   trigger (cron daily | manual tool)
//     → check    : git HEAD vs the durable cursor (sandboxed `git`, NO LLM)
//         · unchanged → { proceed: false }  (a logged skip, not an error)
//         · new commits → advance cursor, enrich with the commit subjects
//     → act      : ctx.spawn a coding agent to update README / docs
//                  (DEFERRED — the run stays open until the agent completes)
//     → onComplete: the agent's completion → a `proposal` (kind `pr`) that
//                  PARKS the run in `awaiting_approval`
//     → approve  : finalize — re-validate write-scope + mergeability, then
//                  mark the PR approved via the sandboxed `gh` pipeline
//                  (merge stays MANUAL on `/repo`; permitted elsewhere)
//     → decline  : discard — close the PR
//
// WRITE-SCOPE JAIL — grants, not prompt hope: the drafted PR is validated to
// touch ONLY the configured `write_paths` (README.md, docs/…). A PR that
// changes anything outside them is REFUSED at approval time (structural,
// fail-safe) — the human approver never even sees an out-of-scope draft as
// approvable. The preset prompt also asks the agent for docs-only edits, but
// the structural gate is the enforcement, not the prompt.
//
// AT-MOST-ONCE cursor: the cursor advances in `check` (the moment new commits
// are seen). If the later draft/approval never lands, that window's commits
// are NOT re-drafted on the next fire — at-most-once beats re-drafting the
// same span on every sweep. See README + docs/extensions/loops.md.
//
// The `check` runs deterministic `git` via a hermetic `Bun.spawn` (shell
// grant); the `gh` pipeline runs through the ez-code sandbox seam
// (`buildSandboxArgv`). The check context structurally CANNOT reach an LLM
// (see LoopCheckContext). The finalize/discard `gh` steps are skip-not-fail
// on `gh` absence (exit 127), mirroring ez-code.

import {
  approveRun,
  createToolDispatcher,
  declineRun,
  defineLoop,
  getChannel,
  getLoopTools,
  PageBuilder,
  type ActResult,
  type CheckResult,
  type LoopActContext,
  type LoopCheckContext,
  type LoopCompleteContext,
  type LoopRunState,
  type PageActionEvent,
} from "@ezcorp/sdk/runtime";

/** The loop id — namespaces the run store + the approval labels. */
export const LOOP_ID = "docs-updater";
/** The Hub page id (must match `manifest.pages[].id`). */
export const PAGE_ID = "dashboard";
/** Row-action event names (must be in `permissions.eventSubscriptions`). */
export const APPROVE_EVENT = "docs-updater:approve";
export const DECLINE_EVENT = "docs-updater:decline";

// ── Public shapes (exported for tests + artifact assertions) ────────

/** The deterministic enrichment a proceeding `check` hands to `act`. */
export interface DocsInput {
  /** HEAD commit hash the check advanced the cursor to. */
  headHash: string;
  /** The prior cursor value, when the loop had already reviewed a commit. */
  sinceHash?: string;
  /** Commit subjects in `sinceHash..HEAD` (newest first) — the review span. */
  subjects: string[];
}

/** A recorded docs-updater outcome (terminal run / approved / declined). */
export interface DocsOutcome {
  /** The HEAD the drafting reviewed up to. */
  headHash: string;
  /** The drafted PR url / branch, when one was opened. */
  prRef?: string;
  /** finalize marker (`ready` | `merged` | `not_mergeable` | … ). */
  marked?: string;
  /** discard result. */
  closed?: boolean;
  /** Free-text note (skip reason, gh-unavailable, out-of-scope, …). */
  note?: string;
}

// ── git HEAD + range readers (sandboxed, hermetic exec) ─────────────

/** The current HEAD commit of a repo: its full hash + subject line. */
export interface GitHead {
  hash: string;
  subject: string;
}
export type GitHeadReader = (repoPath: string) => Promise<GitHead | null>;
export type CommitSubjectsReader = (
  repoPath: string,
  sinceHash: string | undefined,
) => Promise<string[]>;

/**
 * Parse `git log -1 --format=%H%x00%s` output into a HEAD. Pure — every
 * branch (git failure, empty output, missing subject, empty hash) is
 * unit-testable without spawning git. `%x00` (NUL) separates hash from
 * subject so a subject line can never be confused with the delimiter.
 */
export function parseGitHead(stdout: string, exitCode: number): GitHead | null {
  if (exitCode !== 0) return null;
  const line = stdout.trim();
  if (!line) return null;
  const nul = line.indexOf("\0");
  const hash = nul === -1 ? line : line.slice(0, nul);
  const subject = nul === -1 ? "" : line.slice(nul + 1);
  return hash ? { hash, subject } : null;
}

/**
 * Parse newline-separated commit subjects (`git log --format=%s`) into a
 * trimmed, non-empty list. Pure. A non-zero exit yields `[]` (degrade to a
 * clean, subject-less review span rather than failing the fire).
 */
export function parseCommitSubjects(stdout: string, exitCode: number): string[] {
  if (exitCode !== 0) return [];
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Hermetic git env — never read the host user's global/system config. */
const HERMETIC_GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
} as const;

/**
 * Read `<repo>`'s HEAD commit via `git log -1`. Deterministic + read-only —
 * the "structured endpoint" the check firewall is honest about. Returns
 * `null` when the repo has no commits or `git` fails so the check degrades to
 * a clean skip.
 */
export async function readGitHead(repoPath: string): Promise<GitHead | null> {
  const proc = Bun.spawn(
    ["git", "-C", repoPath, "log", "-1", "--format=%H%x00%s"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...HERMETIC_GIT_ENV } },
  );
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return parseGitHead(out, code);
}

/**
 * Read the commit subjects in `sinceHash..HEAD` (newest first) via
 * `git log`. When `sinceHash` is undefined (first-ever review) it returns
 * just the HEAD subject. Deterministic + read-only; degrades to `[]` on any
 * git failure.
 */
export async function readCommitSubjects(
  repoPath: string,
  sinceHash: string | undefined,
): Promise<string[]> {
  const range = sinceHash ? [`${sinceHash}..HEAD`] : ["-1"];
  const proc = Bun.spawn(
    ["git", "-C", repoPath, "log", ...range, "--format=%s"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...HERMETIC_GIT_ENV } },
  );
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return parseCommitSubjects(out, code);
}

// ── Module-level seams (test injection) ─────────────────────────────

let gitHeadImpl: GitHeadReader = readGitHead;
/** @internal test-only — substitute the git HEAD reader. */
export function _setGitHeadForTests(fn: GitHeadReader | null): void {
  gitHeadImpl = fn ?? readGitHead;
}

let commitSubjectsImpl: CommitSubjectsReader = readCommitSubjects;
/** @internal test-only — substitute the commit-subjects reader. */
export function _setCommitSubjectsForTests(fn: CommitSubjectsReader | null): void {
  commitSubjectsImpl = fn ?? readCommitSubjects;
}

// The active project's git repo root (host-injected at spawn). Named once
// (not an inline lambda) so the single default body is covered on both the
// initial binding and the test-reset path.
const defaultProjectRoot: () => string | undefined = () =>
  process.env.EZCORP_PROJECT_ROOT;
let projectRootImpl: () => string | undefined = defaultProjectRoot;
/** @internal test-only — substitute the project-root resolver. */
export function _setProjectRootForTests(
  fn: (() => string | undefined) | null,
): void {
  projectRootImpl = fn ?? defaultProjectRoot;
}

// ── Settings resolution (pure) ──────────────────────────────────────

/** Resolve the repo path from settings → project root → `/repo` → cwd. */
export function resolveRepoPath(
  settings: Record<string, unknown>,
  projectRoot: string | undefined,
): string {
  const configured =
    typeof settings.repo_path === "string" && settings.repo_path.length > 0
      ? settings.repo_path
      : "";
  return configured || projectRoot || "/repo";
}

/** Parse the comma-separated `write_paths` setting into a trimmed, non-empty
 *  prefix list. Blank/undefined → the safe default. Pure. */
export function resolveWritePaths(settings: Record<string, unknown>): string[] {
  const raw =
    typeof settings.write_paths === "string" && settings.write_paths.length > 0
      ? settings.write_paths
      : "README.md,docs/";
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : ["README.md", "docs/"];
}

/** Whether the repo is the `/repo` self-dev mount, where merge is ALWAYS
 *  manual on GitHub (auto-merge deliberately disabled — respected). Pure. */
export function isSelfRepo(repoPath: string): boolean {
  return repoPath === "/repo" || repoPath.endsWith("/repo");
}

/**
 * Return the changed paths that fall OUTSIDE the write-scope allowlist. A
 * changed file matches a write path when it equals it or lives under it
 * (prefix + `/`). Pure — the structural write-scope jail. An empty result
 * means the PR is within scope.
 */
export function filterOutsideWritePaths(
  changed: string[],
  writePaths: string[],
): string[] {
  return changed.filter((file) => {
    return !writePaths.some(
      (wp) =>
        file === wp ||
        file === wp.replace(/\/$/, "") ||
        file.startsWith(wp.endsWith("/") ? wp : `${wp}/`),
    );
  });
}

/**
 * Extract a GitHub PR reference from an agent's completion text. Prefers a
 * full PR url (`https://github.com/o/r/pull/123`); falls back to a bare
 * `#123`. Returns null when the completion mentions no PR. Pure.
 */
export function parsePrRef(resultPreview: string | undefined): string | null {
  if (!resultPreview) return null;
  const url = resultPreview.match(
    /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/,
  );
  if (url) return url[0];
  const num = resultPreview.match(/(?:^|\s)#(\d+)\b/);
  if (num) return `#${num[1]}`;
  return null;
}

// ── check ───────────────────────────────────────────────────────────

/**
 * The deterministic gate. Resolves the repo's HEAD and compares it to the
 * durable cursor. No change → `{ proceed: false }` (logged skip). New commits
 * → advance the cursor (AT-MOST-ONCE) and enrich the input with the review
 * span so `act` never re-derives it. Exported so a unit test can drive it
 * with an injected git reader + an in-memory cursor.
 */
export async function checkDocsActivity(
  ctx: LoopCheckContext<DocsInput>,
): Promise<CheckResult<DocsInput>> {
  if (ctx.settings.enabled === false) {
    return { proceed: false, reason: "settings_disabled" };
  }
  const repoPath = resolveRepoPath(ctx.settings, projectRootImpl());

  const head = await gitHeadImpl(repoPath);
  if (!head) return { proceed: false, reason: "no_git_head" };

  const sinceHash = await ctx.cursor.get<string>();
  if (sinceHash === head.hash) {
    return { proceed: false, reason: "no_new_commits" };
  }

  // AT-MOST-ONCE: advance the cursor the moment new commits are seen.
  await ctx.cursor.set(head.hash);
  const subjects = await commitSubjectsImpl(repoPath, sinceHash);
  ctx.log(
    `new work ${head.hash.slice(0, 8)} (${subjects.length} commit${subjects.length === 1 ? "" : "s"}) — drafting docs update`,
  );
  return {
    proceed: true,
    input: {
      headHash: head.hash,
      ...(sinceHash ? { sinceHash } : {}),
      subjects,
    },
  };
}

// ── act (deferred) ──────────────────────────────────────────────────

/**
 * Build the preset coding-agent prompt. Pure. Names the review span + the
 * write-scope explicitly (defense in depth alongside the structural jail).
 */
export function buildAgentPrompt(input: DocsInput, writePaths: string[]): string {
  const span = input.sinceHash
    ? `merged since ${input.sinceHash.slice(0, 8)} (through ${input.headHash.slice(0, 8)})`
    : `up to ${input.headHash.slice(0, 8)}`;
  const subjectList =
    input.subjects.length > 0
      ? input.subjects.map((s) => `  - ${s}`).join("\n")
      : "  (no commit subjects available)";
  return [
    `Review the work ${span} and update the project documentation to match.`,
    "",
    "Commits in scope:",
    subjectList,
    "",
    `Only edit files under: ${writePaths.join(", ")} (README, feature list, docs/).`,
    "Do NOT touch source code, tests, or config. When done, open a draft pull",
    "request with your documentation changes and report its URL.",
  ].join("\n");
}

/**
 * Deferred `act`: dispatch a coding agent to update the docs, then leave the
 * run OPEN until the agent completes (`onComplete` turns that completion into
 * a proposal). Exported for unit tests.
 */
export async function docsUpdaterAct(
  ctx: LoopActContext<DocsInput>,
): Promise<ActResult<DocsOutcome>> {
  const writePaths = resolveWritePaths(ctx.settings);
  const agentName =
    typeof ctx.settings.agent_name === "string" && ctx.settings.agent_name.length > 0
      ? ctx.settings.agent_name
      : "coder";
  const prompt = buildAgentPrompt(ctx.input, writePaths);
  const handle = await ctx.spawn({
    agentName,
    task: prompt,
    title: `docs-updater: ${ctx.input.headHash.slice(0, 8)}`,
  });
  ctx.log(`dispatched ${agentName} (run ${handle.agentRunId})`);
  return {
    kind: "deferred",
    runId: handle.agentRunId,
    status: "drafting",
    awaitEvent: "task:assignment_update",
    assignmentId: handle.assignmentId,
    taskId: handle.taskId,
    subConversationId: handle.subConversationId,
  };
}

// ── Sandboxed shell (ez-code Seam B pattern) ────────────────────────

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
/** Runs a command in a cwd. Injectable so tests drive git/gh deterministically. */
export type ShellRunner = (cmd: string[], cwd: string) => Promise<ShellResult>;

/**
 * Production runner — runs `cmd` in `cwd` as an injection-safe `Bun.spawn`:
 * an ARGV ARRAY (never a `sh -c` string, so a PR ref / path can carry no
 * shell metacharacter), with the hermetic git env, inside the extension's own
 * host-imposed Landlock jail (the real containment boundary). Mirrors
 * repo-activity-notify's `readGitHead` pattern — "sandboxed" here means
 * argv-array + hermetic env + the subprocess jail, NOT a second inner jail
 * (ez-code's Seam-B worktree wrap defends against UNTRUSTED agent diffs; the
 * `gh` steps here are fixed argv over a validated PR ref, so that inner jail
 * is not needed). `repo` is retained for signature symmetry with the injected
 * test seam.
 */
export function makeProductionShell(_repo: string): ShellRunner {
  return async (cmd, cwd) => {
    const proc = Bun.spawn(cmd, {
      cwd,
      env: { ...process.env, ...HERMETIC_GIT_ENV },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  };
}

let shellImpl: ShellRunner | null = null;
/** Resolve the active shell — the injected test seam, else a repo-scoped
 *  production runner. Exported for direct branch coverage. */
export function getShell(repo: string): ShellRunner {
  return shellImpl ?? makeProductionShell(repo);
}
/** @internal test-only — substitute the sandboxed shell runner. */
export function _setShellForTests(fn: ShellRunner | null): void {
  shellImpl = fn;
}

/** A `gh` invocation's exit code 127 means the binary is absent — a
 *  skip-not-fail, never a hard error (ez-code precedent). Pure. */
export function isGhUnavailable(result: ShellResult): boolean {
  return result.exitCode === 127;
}

// ── gh pipeline (finalize / discard) ────────────────────────────────

/** Read a PR's changed file paths via `gh pr diff --name-only`. Returns the
 *  list, or `{ unavailable: true }` when `gh` is absent (127). */
export async function readPrChangedFiles(
  shell: ShellRunner,
  repo: string,
  prRef: string,
): Promise<{ files: string[]; unavailable: boolean }> {
  const res = await shell(["gh", "pr", "diff", prRef, "--name-only"], repo);
  if (isGhUnavailable(res)) return { files: [], unavailable: true };
  const files =
    res.exitCode === 0
      ? res.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0)
      : [];
  return { files, unavailable: false };
}

/** Read a PR's `state` + `mergeable` via `gh pr view --json`. Returns the
 *  parsed fields, or `{ unavailable: true }` when `gh` is absent (127), or
 *  `{ error }` on a non-JSON / failed read. */
export async function readPrStatus(
  shell: ShellRunner,
  repo: string,
  prRef: string,
): Promise<{
  state?: string;
  mergeable?: string;
  unavailable: boolean;
  error?: string;
}> {
  const res = await shell(
    ["gh", "pr", "view", prRef, "--json", "state,mergeable"],
    repo,
  );
  if (isGhUnavailable(res)) return { unavailable: true };
  if (res.exitCode !== 0) {
    return { unavailable: false, error: res.stderr.trim() || `exit ${res.exitCode}` };
  }
  try {
    const parsed = JSON.parse(res.stdout) as { state?: string; mergeable?: string };
    return {
      unavailable: false,
      ...(parsed.state ? { state: parsed.state } : {}),
      ...(parsed.mergeable ? { mergeable: parsed.mergeable } : {}),
    };
  } catch {
    return { unavailable: false, error: "gh pr view returned non-JSON" };
  }
}

export interface FinalizeInput {
  repo: string;
  prRef: string;
  writePaths: string[];
  /** `/repo` → merge stays manual on GitHub (never merge). */
  selfRepo: boolean;
  /** On a NON-/repo target only: also merge on approve. */
  autoMerge: boolean;
}

/**
 * Finalize an approved docs PR: re-validate the write-scope jail + PR
 * mergeability against the CURRENT base, then mark the PR approved (comment +
 * un-draft) — and, on a non-`/repo` target with auto-merge on, merge it.
 * Merge NEVER happens on `/repo`. `gh` absence (127) is skip-not-fail. Pure
 * over an injected shell, so every branch is unit-testable.
 */
export async function finalizeDocsPr(
  shell: ShellRunner,
  input: FinalizeInput,
): Promise<DocsOutcome & { marked: string }> {
  const { repo, prRef, writePaths, selfRepo, autoMerge } = input;

  // 1. Re-validate the write-scope jail (structural — grants not prompt hope).
  const changed = await readPrChangedFiles(shell, repo, prRef);
  if (changed.unavailable) {
    return { headHash: "", prRef, marked: "skipped_gh_unavailable", note: "gh not installed" };
  }
  const outside = filterOutsideWritePaths(changed.files, writePaths);
  if (outside.length > 0) {
    return {
      headHash: "",
      prRef,
      marked: "rejected_out_of_scope",
      note: `PR touches paths outside the write scope: ${outside.join(", ")}`,
    };
  }

  // 2. Re-validate mergeability against the current base (never merge blind).
  const status = await readPrStatus(shell, repo, prRef);
  if (status.unavailable) {
    return { headHash: "", prRef, marked: "skipped_gh_unavailable", note: "gh not installed" };
  }
  if (status.error) {
    return { headHash: "", prRef, marked: "pr_read_failed", note: status.error };
  }
  if (status.state && status.state !== "OPEN") {
    return { headHash: "", prRef, marked: `already_${status.state.toLowerCase()}` };
  }
  if (status.mergeable === "CONFLICTING") {
    return { headHash: "", prRef, marked: "not_mergeable", note: "conflicts with base" };
  }

  // 3. Mark approved — a comment + un-draft (ready for review). Best-effort:
  //    a failed comment must not block the un-draft.
  const comment = await shell(
    ["gh", "pr", "comment", prRef, "--body", "Approved via docs-updater."],
    repo,
  );
  if (isGhUnavailable(comment)) {
    return { headHash: "", prRef, marked: "skipped_gh_unavailable", note: "gh not installed" };
  }
  const ready = await shell(["gh", "pr", "ready", prRef], repo);
  if (isGhUnavailable(ready)) {
    return { headHash: "", prRef, marked: "skipped_gh_unavailable", note: "gh not installed" };
  }

  // 4. Merge — ONLY on a non-/repo target with auto-merge on. `/repo` NEVER
  //    merges (auto-merge deliberately disabled there — respected).
  if (autoMerge && !selfRepo) {
    const merge = await shell(["gh", "pr", "merge", prRef, "--squash"], repo);
    if (isGhUnavailable(merge)) {
      return { headHash: "", prRef, marked: "skipped_gh_unavailable", note: "gh not installed" };
    }
    if (merge.exitCode !== 0) {
      return { headHash: "", prRef, marked: "merge_failed", note: merge.stderr.trim() || `exit ${merge.exitCode}` };
    }
    return { headHash: "", prRef, marked: "merged" };
  }

  return {
    headHash: "",
    prRef,
    marked: "ready",
    ...(selfRepo ? { note: "merge stays manual on GitHub for /repo" } : {}),
  };
}

/**
 * Discard a declined docs PR: close it. `gh` absence (127) is skip-not-fail.
 * Best-effort — a close failure never un-declines the run (the primitive
 * treats discard as fire-and-forget cleanup).
 */
export async function discardDocsPr(
  shell: ShellRunner,
  repo: string,
  prRef: string,
): Promise<void> {
  const res = await shell(["gh", "pr", "close", prRef], repo);
  if (isGhUnavailable(res)) return; // skip-not-fail
  // A non-zero close is logged by the caller's best-effort wrapper; nothing
  // to surface here (declineRun already resolved the run).
}

// ── onComplete (deferred → proposal composition) ────────────────────

/**
 * The agent finished. Turn its completion into a `proposal` (kind `pr`) that
 * parks the run for approval. When the completion names no PR, terminalize as
 * `no_pr` (the agent found nothing to draft, or failed to open a PR). Exported
 * for unit tests.
 */
export async function docsUpdaterOnComplete(
  ctx: LoopCompleteContext<DocsOutcome>,
): Promise<ActResult<DocsOutcome>> {
  const input = ctx.run.input as DocsInput | undefined;
  const headHash = input?.headHash ?? "";
  const prRef = parsePrRef(ctx.resultPreview);
  if (!prRef) {
    ctx.log("agent completed without opening a PR — nothing to approve");
    return { kind: "terminal", status: "no_pr", outcome: { headHash, note: "no PR drafted" } };
  }

  const repo = resolveRepoPath(ctx.settings, projectRootImpl());
  const writePaths = resolveWritePaths(ctx.settings);
  const selfRepo = isSelfRepo(repo);
  const autoMerge = ctx.settings.auto_merge === true;
  const shell = getShell(repo);

  // Pre-park write-scope validation: refuse an out-of-scope draft BEFORE it
  // ever reaches a human approver (grants, not prompt hope). `gh` absent →
  // can't validate now; park anyway (the finalize re-check is the backstop).
  const changed = await readPrChangedFiles(shell, repo, prRef);
  if (!changed.unavailable) {
    const outside = filterOutsideWritePaths(changed.files, writePaths);
    if (outside.length > 0) {
      ctx.log(`draft ${prRef} touches out-of-scope paths — closing, not parking`);
      try {
        await discardDocsPr(shell, repo, prRef);
      } catch {
        // Best-effort cleanup; the terminal status is the durable signal.
      }
      return {
        kind: "terminal",
        status: "rejected_out_of_scope",
        outcome: {
          headHash,
          prRef,
          note: `out-of-scope paths: ${outside.join(", ")}`,
        },
      };
    }
  }

  const scopeNote = changed.unavailable
    ? " (write-scope re-checked at approval)"
    : "";
  return {
    kind: "proposal",
    status: "pr_drafted",
    proposal: {
      title: `Docs update for ${headHash.slice(0, 8)}`,
      summary: `Drafted PR ${prRef} updating docs for ${input?.subjects.length ?? 0} commit(s).${scopeNote}`,
      kind: "pr",
      ref: prRef,
    },
    // Approve → finalize (re-validate + mark approved). The head hash is
    // threaded onto the outcome for the artifact mirror.
    finalize: async () => {
      const outcome = await finalizeDocsPr(shell, {
        repo,
        prRef,
        writePaths,
        selfRepo,
        autoMerge,
      });
      return { ...outcome, headHash };
    },
    // Decline → discard (close the PR). Best-effort.
    discard: async () => {
      await discardDocsPr(shell, repo, prRef);
    },
  };
}

// ── Dashboard (Hub page + approve/decline row actions) ──────────────

/** Short status label for a run's proposal state. Pure. */
export function statusLabel(run: LoopRunState<DocsOutcome>): string {
  switch (run.status) {
    case "awaiting_approval":
      return "Awaiting approval";
    case "finalizing":
      return run.verifyManually ? "Verify manually" : "Finalizing";
    case "approved":
      return "Approved";
    case "declined":
      return "Declined";
    case "drafting":
      return "Drafting";
    default:
      return run.status;
  }
}

/** Build the Hub dashboard tree from the current run list. Parked runs get
 *  per-run Approve / Decline buttons (the proposal `ref` in the payload). */
export function buildDashboard(runs: LoopRunState<DocsOutcome>[]): PageBuilder {
  const page = new PageBuilder("docs-updater");
  page.heading(1, "docs-updater");
  if (runs.length === 0) {
    page.emptyState("No runs yet", "Draft a docs PR with the run_docs_update tool or wait for the daily sweep.");
    return page;
  }
  page.section("Runs", (s) => {
    for (const run of runs) {
      const title = run.proposal?.title ?? `Run ${run.id.slice(0, 8)}`;
      s.section(`${title} — ${statusLabel(run)}`, (row) => {
        if (run.proposal?.ref) row.markdownBlock(`PR: \`${run.proposal.ref}\``);
        if (run.status === "awaiting_approval") {
          row.button(
            "Approve",
            { event: APPROVE_EVENT, payload: { runId: run.id } },
            "primary",
          );
          row.button(
            "Decline",
            { event: DECLINE_EVENT, payload: { runId: run.id } },
            "danger",
          );
        }
      });
    }
  });
  return page;
}

// The dashboard-render seam is the primitive's `log.dashboard.render`; the
// row actions below are the primitive-owned approve/decline resolution. Kept
// as a thin injectable seam so the row-action tests observe the resolution
// without a live channel.
let approveImpl: typeof approveRun = approveRun;
let declineImpl: typeof declineRun = declineRun;
/** @internal test-only — substitute the primitive approve/decline resolvers. */
export function _setResolversForTests(
  approve: typeof approveRun | null,
  decline: typeof declineRun | null,
): void {
  approveImpl = approve ?? approveRun;
  declineImpl = decline ?? declineRun;
}

/**
 * Dashboard "Approve" row action → resolve the parked run through the
 * primitive-owned `approveRun`. `decidedBy` is `event.userId`, which the host
 * events route STAMPS from the authenticated session (see the decidedBy note
 * in docs/extensions/loops.md) — never trusted from the client body / payload.
 */
export async function handleApproveAction(event: PageActionEvent): Promise<void> {
  const runId = event.payload?.runId;
  if (typeof runId !== "string" || runId.length === 0) return;
  // Guard: without a host-stamped identity we cannot attribute the decision —
  // refuse rather than write an empty `decidedBy` onto the LOCKED eval label.
  if (typeof event.userId !== "string" || event.userId.length === 0) return;
  await approveImpl(LOOP_ID, runId, event.userId);
}

/** Dashboard "Decline" row action → `declineRun`. Same host-stamped
 *  `decidedBy` provenance as approve. */
export async function handleDeclineAction(event: PageActionEvent): Promise<void> {
  const runId = event.payload?.runId;
  if (typeof runId !== "string" || runId.length === 0) return;
  if (typeof event.userId !== "string" || event.userId.length === 0) return;
  const note =
    typeof event.payload?.note === "string" ? (event.payload.note as string) : undefined;
  await declineImpl(LOOP_ID, runId, event.userId, note);
}

// ── registration ────────────────────────────────────────────────────

/**
 * Register the loop. Exported (not auto-run) so unit tests can register it
 * against a stubbed channel without `import.meta.main`.
 */
export function defineDocsUpdaterLoop(): void {
  defineLoop<DocsInput, DocsOutcome>({
    id: LOOP_ID,
    trigger: [
      { kind: "cron", cron: "0 6 * * *" },
      { kind: "manual", tool: "run_docs_update" },
    ],
    contract: {
      states: ["drafting", "no_pr", "rejected_out_of_scope"],
      terminal: ["no_pr", "rejected_out_of_scope"],
      scope: "global",
      retention: { maxRuns: 50 },
      // Proactive approval: a drafted PR parks for a human decision. The
      // primitive injects awaiting_approval/finalizing/approved/declined.
      approval: { mode: "proactive", staleAfterDays: 7 },
      // maxConcurrent 1 keeps a slow daily sweep from overlapping a manual run
      // and double-advancing the cursor (parked runs are excluded from the cap).
      concurrency: { maxConcurrent: 1 },
      // Bump when the prompt/config changes so the eval signal stays attributable.
      configVersion: "1",
    },
    check: checkDocsActivity,
    act: docsUpdaterAct,
    onComplete: docsUpdaterOnComplete,
    log: {
      artifact: (run, outcome) => ({
        path: `prs/${run.id}.md`,
        body: [
          `# docs-updater run ${run.id}`,
          "",
          `- status: ${run.status}`,
          `- head: ${outcome.headHash || "?"}`,
          ...(outcome.prRef ? [`- pr: ${outcome.prRef}`] : []),
          ...(outcome.marked ? [`- marked: ${outcome.marked}`] : []),
          ...(outcome.note ? [`- note: ${outcome.note}`] : []),
          "",
        ].join("\n"),
      }),
      dashboard: {
        pageId: PAGE_ID,
        render: (runs) => buildDashboard(runs),
        rowActions: {
          [APPROVE_EVENT]: handleApproveAction,
          [DECLINE_EVENT]: handleDeclineAction,
        },
      },
    },
  });
}

/**
 * Production boot: register the loop, mount the manual-trigger tool, and start
 * the channel read loop. Exported (not inlined under `import.meta.main`) so a
 * unit test can drive the boot path against the SDK test channel (the read
 * loop is fire-and-forget). Mirrors sample-loop / repo-activity-notify.
 */
export function start(): void {
  defineDocsUpdaterLoop();
  createToolDispatcher({ ...getLoopTools() });
  getChannel().start();
}

// Gated on `import.meta.main` so test imports don't open stdin.
if (import.meta.main) start();
