// ── Shared step machinery — ported from pipeline/steps/common*.go ────
//
// The StepContext each step receives, the StepOutcome each returns, and the
// shared commit/head-continuity/base-SHA helpers. Two of the six security
// invariants live here: assertPipelineHeadContinuity (invariant 4) and the
// deterministic fix-commit prefix (renamed `ez-code-factory(<step>)`).
//
// Ports: internal/pipeline/pipeline.go (StepContext/StepOutcome),
// internal/pipeline/steps/common_fix.go (assertPipelineHeadContinuity,
// commitAgentFixes, executeFixMode, extractCommitSummary),
// internal/pipeline/steps/common_git.go (resolveBranchBaseSHA & friends).

import type { AgentDispatcher, DispatchResult, SessionRole } from "../agent";
import type { PipelineConfig } from "../config";
import { EMPTY_TREE_SHA, isZeroSHA, makeGit, shortSHA, type Git } from "../git";
import type { PipelineStep } from "../config";
import type { ShellRunner } from "../shell";

/** A mutable view of the run the steps read + advance. `headSha` is the pipeline's
 *  recorded head — the un-clobberable head-continuity anchor. */
export interface RunView {
  id: string;
  /** Branch name (no refs/heads/ prefix) or a full ref. */
  branch: string;
  ref: string;
  headSha: string;
  /** The last-observed remote head (deliberately stale on force-push). */
  baseSha: string;
  intent: string | null;
  intentSource: string | null;
}

/** Repo facts a step needs. `workingPath` is the project root (for the bundled-
 *  local-default guard); "" when unavailable. */
export interface RepoView {
  defaultBranch: string;
  workingPath: string;
}

/** Everything a step reads/drives. Assembled by the executor per step. */
export interface StepContext {
  worktree: string;
  gateDir: string;
  run: RunView;
  repo: RepoView;
  config: PipelineConfig;
  fixing: boolean;
  previousFindings: string;
  /** Prior rounds of THIS step (drives the round-history prompt section). */
  rounds: import("../runs").StepRoundRecord[];
  dispatcher: AgentDispatcher;
  /** Read-only git on the host runner (rev-parse, diff, ls-remote, fetch). */
  hostGit: Git;
  /** Mutating git under the nested jail (rebase, add, commit, push). */
  jailedGit: Git;
  /** The raw host runner (for non-git checks like `test -d`, and gitAt). */
  hostRunner: ShellRunner;
  log: (message: string) => void;
  /** Persist an advanced head SHA (updates the run record). */
  updateHeadSha: (sha: string) => Promise<void>;
}

/** Bind read-only host git to an arbitrary dir (e.g. the working repo for the
 *  bundled-local-default guard). */
export function gitAt(sctx: StepContext, dir: string): Git {
  return makeGit(sctx.hostRunner, dir);
}

/** A step's result. Mirrors upstream StepOutcome (M1 subset). */
export interface StepOutcome {
  needsApproval?: boolean;
  autoFixable?: boolean;
  /** Findings JSON (canonical wire) for the gate, or "". */
  findings?: string;
  /** Skip all subsequent steps (empty diff after rebase). */
  skipRemaining?: boolean;
  /** Mark this step skipped (not failed). */
  skipped?: boolean;
  /** Agent's one-line fix summary from this round, or "". */
  fixSummary?: string;
}

/** Every step implements a name + an execute. */
export interface Step {
  name: PipelineStep;
  execute(sctx: StepContext): Promise<StepOutcome>;
}

/** True when the run's intent is authoritative acceptance criteria. */
export function intentIsAuthoritative(run: RunView): boolean {
  return run.intentSource === "agent";
}

/** `refs/heads/<branch>` unless already a full ref. Verbatim normalizedBranchRef. */
export function normalizedBranchRef(ref: string): string {
  return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
}

/** Deterministic fix-commit message — renamed prefix. Verbatim shape. */
export function deterministicFixCommitMessage(step: PipelineStep, summary: string): string {
  return `ez-code-factory(${step}): ${summary === "" ? "apply fixes" : summary}`;
}

// ── Base-SHA resolution (common_git.go) ─────────────────────────────

/** merge-base of HEAD against origin/<default> then <default>, or "" when none. */
export async function mergeBaseWithDefaultBranch(git: Git, defaultBranch: string): Promise<string> {
  if (defaultBranch.trim() === "") return "";
  for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
    const r = await git.try("merge-base", "HEAD", ref);
    if (r.exitCode === 0 && r.stdout.trim() !== "") return r.stdout.trim();
  }
  return "";
}

/** A usable base SHA for diff/log ops, falling back to the empty tree. Verbatim resolveBaseSHA. */
export async function resolveBaseSHA(git: Git, baseSha: string, defaultBranch: string): Promise<string> {
  if (!isZeroSHA(baseSha)) return baseSha;
  const mb = await mergeBaseWithDefaultBranch(git, defaultBranch);
  if (mb !== "") return mb;
  return EMPTY_TREE_SHA;
}

/** Branch base relative to the default branch (merge-base preferred). Verbatim resolveBranchBaseSHA. */
export async function resolveBranchBaseSHA(git: Git, baseSha: string, defaultBranch: string): Promise<string> {
  const mb = await mergeBaseWithDefaultBranch(git, defaultBranch);
  if (mb !== "") return mb;
  return resolveBaseSHA(git, baseSha, defaultBranch);
}

// ── Head-continuity guard (common_fix.go, invariant 4) ──────────────

/** Raised when the worktree HEAD diverged from the pipeline's recorded head. */
export class HeadContinuityError extends Error {}

/**
 * Fail closed when the worktree HEAD is no longer a descendant of the head the
 * pipeline itself last recorded (run.headSha). A concurrent process that reset
 * the shared worktree to a divergent commit would otherwise let a later step
 * commit on an unreviewed tree. A forward-only move (recorded head is an
 * ancestor of live HEAD) is allowed; a divergent or backward reset aborts.
 * Verbatim assertPipelineHeadContinuity.
 */
export async function assertPipelineHeadContinuity(sctx: StepContext, step: PipelineStep): Promise<void> {
  const recorded = sctx.run.headSha.trim();
  if (recorded === "") return;
  const currentHead = await sctx.hostGit.headSha();
  if (currentHead === recorded) return;
  const rel = await sctx.hostGit.ancestry(recorded, currentHead);
  if (rel !== "yes") {
    throw new HeadContinuityError(
      `refusing to commit ${step} changes: worktree HEAD ${currentHead} is not a descendant of the ` +
        `pipeline's recorded head ${recorded}; the reviewed change was rewritten out-of-band and would ` +
        `be lost - aborting to protect it`,
    );
  }
}

/**
 * Commit whatever the agent changed, guarded by head-continuity BEFORE and AFTER
 * the commit, then advance the branch ref + recorded head. No-op (logs) when the
 * worktree is clean. Verbatim commitAgentFixes.
 */
export async function commitAgentFixes(
  sctx: StepContext,
  step: PipelineStep,
  summary: string,
  fallbackSummary: string,
): Promise<void> {
  await assertPipelineHeadContinuity(sctx, step);
  const status = await sctx.hostGit.statusPorcelain();
  if (status.trim() === "") {
    sctx.log("no agent changes to commit");
    return;
  }
  await sctx.jailedGit.run("add", "-A");
  const commitMessage = deterministicFixCommitMessage(step, summary === "" ? fallbackSummary : summary);
  await sctx.jailedGit.run("commit", "-m", commitMessage);
  const headSha = await sctx.hostGit.headSha();
  await assertPipelineHeadContinuity(sctx, step);
  const ref = normalizedBranchRef(sctx.run.branch);
  await sctx.jailedGit.run("update-ref", ref, headSha);
  sctx.run.headSha = headSha;
  await sctx.updateHeadSha(headSha);
  sctx.log(`committed agent fixes: ${commitMessage}`);
}

/** Parse the agent's `{summary}` structured output, cleaned. Verbatim extractCommitSummary. */
export function extractCommitSummary(result: DispatchResult): string {
  const o = (result.output && typeof result.output === "object" ? result.output : null) as
    | { summary?: unknown }
    | null;
  const raw = o && typeof o.summary === "string" ? o.summary : "";
  const cleaned = raw.split(/\s+/).filter(Boolean).join(" ");
  return cleaned.replace(/^[ \t\r\n"'.;:,-]+|[ \t\r\n"'.;:,-]+$/g, "");
}

/** Options controlling one fix-mode agent turn. Verbatim fixExecutionOptions (M1 subset). */
export interface FixExecutionOptions {
  requirePreviousFindings?: boolean;
  missingFindingsError?: string;
  logMessage?: string;
  prompt: string;
  errorPrefix: string;
  fallbackSummary: string;
  role: SessionRole;
  jsonSchema: Record<string, unknown>;
}

/**
 * Run the fix agent and commit its changes; return its one-line fix summary
 * (""when unparseable). No-op when not fixing. Verbatim executeFixMode.
 */
export async function executeFixMode(
  sctx: StepContext,
  step: PipelineStep,
  opts: FixExecutionOptions,
): Promise<string> {
  if (!sctx.fixing) return "";
  if (opts.requirePreviousFindings && sctx.previousFindings === "") {
    throw new Error(opts.missingFindingsError ?? "fix requires previous findings");
  }
  if (opts.logMessage) sctx.log(opts.logMessage);
  let result: DispatchResult;
  try {
    result = await sctx.dispatcher.dispatch({
      role: opts.role,
      prompt: opts.prompt,
      cwd: sctx.worktree,
      jsonSchema: opts.jsonSchema,
    });
  } catch (err) {
    throw new Error(`${opts.errorPrefix}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const summary = extractCommitSummary(result);
  await commitAgentFixes(sctx, step, summary, opts.fallbackSummary);
  return summary;
}

export { shortSHA };
