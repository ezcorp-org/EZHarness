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

import type { AgentDispatcher, DispatchOptions, DispatchResult, SessionRole } from "../agent";
import type { PipelineConfig } from "../config";
import { EMPTY_TREE_SHA, isZeroSHA, makeGit, shortSHA, type Git } from "../git";
import type { PipelineStep } from "../config";
import type { RepoConfig } from "../repo-config";
import type { ShellRunner } from "../shell";

// ── Run-scoped in-memory hand-off (pipeline/shared.go) ──────────────

/** The lint assessment the combined document+lint housekeeping pass produces
 *  and hands to the lint step, so lint does not pay a second cold agent pass.
 *  Verbatim HousekeepingLintResult. */
export interface HousekeepingLintResult {
  /** Lint-category findings (possibly empty) in the lint step's own JSON shape. */
  findingsJson: string;
  /** The housekeeping pass's one-line lint summary. */
  summary: string;
}

/**
 * Carries in-memory run-scoped results one step hands to a later step in the
 * SAME executor invocation. Verbatim RunShared, adapted to the resumable
 * executor: upstream keeps one RunShared for the whole run's in-memory lifetime;
 * here it is INVOCATION-scoped (one per startPipeline / respondToGate call). The
 * common no-park document→lint sequence shares it (stash consumed); a park (or
 * any respond boundary) between document and lint is a process boundary that
 * invalidates the stash, so lint falls back to its own cold pass — matching the
 * spec's "fix round / process restart invalidates → cold-pass fallback". Never
 * persisted: on any boundary the consuming step simply does its own work.
 */
export interface RunShared {
  /** Record the combined pass's lint assessment (replaces any previous). */
  setHousekeepingLint(result: HousekeepingLintResult): void;
  /** Discard a previous assessment before a document pass starts, so a later
   *  lint step never consumes stale findings. */
  clearHousekeepingLint(): void;
  /** Return AND consume the stash; the second call returns null so a lint fix
   *  round re-assesses with its own pass instead of trusting a stale result. */
  takeHousekeepingLint(): HousekeepingLintResult | null;
}

/** A fresh, empty RunShared (factory — matches the makeGit/createRunStore idiom;
 *  a closure over the single stash slot, so there is no class-declaration line to
 *  leave dangling in coverage). */
export function makeRunShared(): RunShared {
  let housekeepingLint: HousekeepingLintResult | null = null;
  return {
    setHousekeepingLint(result) {
      housekeepingLint = result;
    },
    clearHousekeepingLint() {
      housekeepingLint = null;
    },
    takeHousekeepingLint() {
      const result = housekeepingLint;
      housekeepingLint = null;
      return result;
    },
  };
}

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
  /** Base dir for per-run test-evidence artifacts (the per-extension TMPDIR).
   *  The evidence temp dir is `<tmpBase>/ez-code-factory-evidence/<runId>`. */
  tmpBase: string;
  run: RunView;
  repo: RepoView;
  config: PipelineConfig;
  /** The resolved, trusted-branch-gated per-repo config (executing commands +
   *  agent + document policy come trusted-only; see lib/repo-config.ts). Every
   *  step receives it; test/document/lint consume its executing fields. */
  repoConfig: RepoConfig;
  /** Run-scoped in-memory hand-off (the document→lint housekeeping stash). */
  shared: RunShared;
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

/**
 * The per-repo agent selection + project-instruction boundary a step's agent
 * dispatch must carry, sourced from the TRUSTED repo config (both are
 * trusted-branch-gated fields — a pushed branch cannot pick the agent or flip
 * the boundary). Spread into every DispatchOptions so the executing
 * selection always follows the security boundary. Empty/false fields are
 * omitted so the deployment default applies. Verbatim intent of upstream's
 * config.Agent / DisableProjectSettings threading into the agent layer.
 */
export function repoDispatchOptions(
  sctx: StepContext,
): Pick<DispatchOptions, "agentName" | "disableProjectSettings"> {
  return {
    ...(sctx.repoConfig.agent ? { agentName: sctx.repoConfig.agent } : {}),
    ...(sctx.repoConfig.disableProjectSettings ? { disableProjectSettings: true } : {}),
  };
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
  /** Ran after the agent turn but BEFORE the fix commit — the test step uses it
   *  to snapshot new (still-untracked) test files the agent wrote, which the
   *  commit would otherwise sweep out of `git status --porcelain`. Verbatim
   *  AfterAgentRun. */
  afterAgentRun?: (result: DispatchResult) => Promise<void> | void;
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
      ...repoDispatchOptions(sctx),
    });
  } catch (err) {
    throw new Error(`${opts.errorPrefix}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (opts.afterAgentRun) await opts.afterAgentRun(result);
  const summary = extractCommitSummary(result);
  await commitAgentFixes(sctx, step, summary, opts.fallbackSummary);
  return summary;
}

// ── Configured-command execution (common_exec.go) ──────────────────

/** Result of running a configured `commands.*` shell command. */
export interface StepShellResult {
  /** Combined stdout + stderr (the CombinedOutput upstream reports). */
  output: string;
  /** Process exit code (a non-zero exit is NOT an error — it is a finding). */
  exitCode: number;
}

/**
 * Run a TRUSTED configured command (`commands.test` / `commands.lint`) via
 * `sh -c` in the worktree, returning its combined output + exit code. The
 * command comes from the trusted default branch only (repo-config.ts), never a
 * pushed SHA — this is where the supply-chain boundary earns its keep, so the
 * caller must pass a trusted-sourced command. Verbatim runShellCommandWithEnv.
 */
export async function runStepShellCommand(
  runner: ShellRunner,
  cwd: string,
  cmd: string,
): Promise<StepShellResult> {
  const r = await runner(["sh", "-c", cmd], cwd);
  return { output: `${r.stdout}${r.stderr}`, exitCode: r.exitCode };
}

// ── New-test-file detection (common_diff.go) ────────────────────────

/** True when a path matches a common test-file naming pattern. Verbatim isTestFile. */
export function isTestFile(path: string): boolean {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  if (base === "") return false;
  if (base.endsWith("_test.go")) return true;
  if (base.endsWith("_test.rs")) return true;
  if (base.endsWith(".py")) {
    const name = base.slice(0, -".py".length);
    if (name.startsWith("test_") || name.endsWith("_test")) return true;
  }
  if (base.endsWith(".rb") && base.startsWith("test_")) return true;
  if (base.endsWith("Test.java") || base.endsWith("Tests.java")) return true;
  for (const ext of [".js", ".ts", ".jsx", ".tsx"]) {
    if (base.endsWith(`.test${ext}`) || base.endsWith(`.spec${ext}`)) return true;
  }
  return false;
}

/**
 * Paths of new (untracked `??` or staged-add `A`) files matching a test-file
 * naming pattern, read from `git status --porcelain`. Used so the test step can
 * ALWAYS require approval when the agent wrote a new test file. Verbatim
 * detectNewTestFiles.
 */
export async function detectNewTestFiles(git: Git): Promise<string[]> {
  const out = await git.statusPorcelain();
  if (out.trim() === "") return [];
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (status === "??" || status[0] === "A") {
      if (isTestFile(path)) files.push(path);
    }
  }
  return files;
}

export { shortSHA };
