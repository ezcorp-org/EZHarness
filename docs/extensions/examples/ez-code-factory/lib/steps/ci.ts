// ── CI step — port of internal/pipeline/steps/ci.go (+ ci_fix.go) ──
//
// After the PR opens, babysit CI until the PR merges/closes, CI passes, an idle
// timeout elapses, or auto-fix is exhausted. The poll loop is DETERMINISTIC
// (spec §11): its clock, poll wait, gh runner, and base-branch-tip resolver are
// all injected — no wall-clock sleeps in tests. On failure it fetches the failed
// logs, drives an agent fix (verbatim CI-fix prompt variants), guarded-force-
// pushes (reusing push.ts's patch-id safety + head-continuity assert), and
// resumes. The `reconcileApprovalGate` opt-in resolves a stale parked gate once
// the PR is merged/closed. GitHub-only; skip-not-fail when the host is absent /
// unauthenticated / not GitHub, or the PR URL is missing.

import {
  detectProvider,
  extractHost,
  extractPRNumber,
  makeGitHubHost,
  mergeableConflict,
  mergeableResolved,
  repoSlug,
  type Check,
  type GitHubHost,
  type PR,
} from "../github";
import {
  BASE_BRANCH_TIP_RESOLVE_MS,
  DEFAULT_CHECKS_GRACE_MS,
  ciFailureOutcome,
  ciMergeabilityOutcome,
  ciMonitoringTimeoutOutcome,
  encodeLastFixedChecks,
  failingCheckCompletedAfter,
  failingCheckCompletionTimes,
  failingCheckNames,
  hasPendingChecks,
  pendingCheckMatchesLastFixed,
  pollInterval,
} from "./ci-poll";
import { resolveForcePushDecision } from "./push";
import {
  assertPipelineHeadContinuity,
  intentIsAuthoritative,
  normalizedBranchRef,
  repoDispatchOptions,
  resolveBranchBaseSHA,
  shortSHA,
  type ReconcileResult,
  type Step,
  type StepContext,
  type StepOutcome,
} from "./common";
import { userIntentPromptSection } from "../prompts";

/** The base-branch tip resolution (drives idle-timeout re-arm). `resolved` is
 *  false for a fallback/unknown SHA that must NOT re-arm. */
export interface BaseBranchTip {
  sha: string;
  resolved: boolean;
}

/** Test-injectable knobs mirroring upstream's CIStep struct fields; production
 *  uses the defaults (clock/sleep/gh come from StepContext). */
export interface CiStepOptions {
  /** Resolve the upstream default-branch tip each poll. Default: fetch + rev-parse. */
  baseBranchTip?: (sctx: StepContext) => Promise<BaseBranchTip>;
  /** Grace period (ms) before trusting an empty check set. Default 60s. */
  gracePeriodMs?: number;
  /** Fixed poll interval (ms) overriding the computed schedule (tests only). */
  pollIntervalMs?: number;
}

/** The default base-branch-tip resolver: fetch origin/<default> and rev-parse. */
async function defaultBaseBranchTip(sctx: StepContext, defaultBranch: string): Promise<BaseBranchTip> {
  const fetched = await sctx.hostGit.fetchRemoteBranch("origin", defaultBranch);
  if (fetched.exitCode === 0) {
    const sha = await sctx.hostGit.revParseVerify(`refs/remotes/origin/${defaultBranch}^{commit}`);
    if (sha) return { sha, resolved: true };
  }
  return { sha: "", resolved: false };
}

export function makeCiStep(opts: CiStepOptions = {}): Step {
  const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_CHECKS_GRACE_MS;

  const resolveHost = async (sctx: StepContext): Promise<{ host: GitHubHost } | { skip: string }> => {
    const upstreamUrl = await resolveUpstreamUrl(sctx);
    let provider = detectProvider(upstreamUrl);
    if (provider !== "github" && sctx.run.prUrl) provider = detectProvider(sctx.run.prUrl);
    if (provider !== "github") return { skip: "not a GitHub upstream" };
    const source = upstreamUrl !== "" ? upstreamUrl : (sctx.run.prUrl ?? "");
    const host = makeGitHubHost(sctx.gh, { host: extractHost(source), repo: repoSlug(source) });
    const unavailable = await host.available();
    if (unavailable !== null) return { skip: unavailable };
    return { host };
  };

  const baseBranchTip = opts.baseBranchTip;

  return {
    name: "ci",
    async execute(sctx) {
      const resolved = await resolveHost(sctx);
      if ("skip" in resolved) {
        sctx.log(`skipping CI: ${resolved.skip}`);
        return { skipped: true };
      }
      const prURL = (sctx.run.prUrl ?? "").trim();
      if (prURL === "") {
        sctx.log("no PR URL found, skipping CI");
        return { skipped: true };
      }
      const prNumber = extractPRNumber(prURL);
      if (prNumber === null) throw new Error(`extract PR number from ${prURL}`);
      const pr: PR = { number: prNumber, url: prURL };
      const defaultBranch = sctx.repo.defaultBranch.trim() || "main";
      const tipResolver = baseBranchTip ?? ((s: StepContext) => defaultBaseBranchTip(s, defaultBranch));
      return pollLoop(sctx, resolved.host, pr, { gracePeriodMs, pollIntervalMs: opts.pollIntervalMs, tipResolver });
    },

    async reconcileApprovalGate(sctx): Promise<ReconcileResult> {
      const resolved = await resolveHost(sctx);
      if ("skip" in resolved) throw new Error(`cannot check PR state: ${resolved.skip}`);
      const prURL = (sctx.run.prUrl ?? "").trim();
      if (prURL === "") throw new Error("run has no PR URL");
      const prNumber = extractPRNumber(prURL);
      if (prNumber === null) throw new Error(`extract PR number from ${prURL}`);
      const state = await resolved.host.getPRState({ number: prNumber, url: prURL });
      if (state === "MERGED") {
        sctx.log("PR has been merged; clearing stale CI approval gate");
        return { resolved: true };
      }
      if (state === "CLOSED") {
        sctx.log("PR has been closed; clearing stale CI approval gate");
        return { resolved: true };
      }
      if (state === "OPEN") return { resolved: false };
      throw new Error(`PR state is unresolved: ${state}`);
    },
  };
}

/** The default CI step (production wiring). */
export const ciStep: Step = makeCiStep();

// ── Poll loop (ci.go Execute) ───────────────────────────────────────

interface PollDeps {
  gracePeriodMs: number;
  pollIntervalMs: number | undefined;
  tipResolver: (sctx: StepContext) => Promise<BaseBranchTip>;
}

/** Mutable poll-loop state (upstream's CIStep struct fields). */
interface PollState {
  lastFixedChecks: string;
  lastFixedCompletedAt: Record<string, number>;
  ciFixAttempts: number;
  timeoutAnchor: number;
  lastBaseTip: string;
  manualFixAttempted: boolean;
  mergeabilityBlockedReason: string;
  timeoutFailingChecks: string[];
  timeoutMergeConflict: boolean;
}

async function pollLoop(sctx: StepContext, host: GitHubHost, pr: PR, deps: PollDeps): Promise<StepOutcome> {
  const timeout = sctx.config.ciTimeoutMs;
  const unlimited = timeout < 0;
  const started = sctx.now();
  const st: PollState = {
    lastFixedChecks: "",
    lastFixedCompletedAt: {},
    ciFixAttempts: 0,
    timeoutAnchor: started,
    lastBaseTip: "",
    manualFixAttempted: false,
    mergeabilityBlockedReason: "",
    timeoutFailingChecks: [],
    timeoutMergeConflict: false,
  };
  sctx.log(
    unlimited
      ? `monitoring CI for PR #${pr.number} (no timeout, until merged or closed)...`
      : `monitoring CI for PR #${pr.number} (timeout: ${timeout}ms)...`,
  );

  const timeoutOutcome = (): StepOutcome => {
    sctx.log("CI timeout reached");
    if (st.timeoutFailingChecks.length > 0 || st.timeoutMergeConflict) {
      return ciFailureOutcome(st.timeoutFailingChecks, st.timeoutMergeConflict, "CI timed out with known failures still present");
    }
    if (st.mergeabilityBlockedReason !== "") {
      return ciMergeabilityOutcome("mergeability check timed out", st.mergeabilityBlockedReason);
    }
    return ciMonitoringTimeoutOutcome();
  };

  for (;;) {
    if (!unlimited && sctx.now() - st.timeoutAnchor >= timeout) return timeoutOutcome();

    // Re-arm the idle timeout whenever the base branch advances.
    if (!unlimited) {
      const tip = await deps.tipResolver(sctx);
      if (tip.resolved && tip.sha !== "") {
        if (st.lastBaseTip === "") {
          st.lastBaseTip = tip.sha;
        } else if (tip.sha !== st.lastBaseTip) {
          sctx.log(`base branch advanced (${shortSHA(st.lastBaseTip)}..${shortSHA(tip.sha)}), re-arming CI monitor timeout`);
          st.timeoutAnchor = sctx.now();
          st.lastBaseTip = tip.sha;
        }
      }
    }

    const elapsed = sctx.now() - started;
    const terminal = await pollOnce(sctx, host, pr, deps, st, elapsed);
    if (terminal !== null) return terminal;

    const interval = deps.pollIntervalMs ?? pollInterval(sctx.now() - started);
    await sctx.sleep(interval);
  }
}

/**
 * One poll iteration: check PR state / mergeability / CI checks and either drive
 * a fix, park (return an outcome), complete (return {}), or return null to keep
 * polling. Mutates `st`.
 */
async function pollOnce(
  sctx: StepContext,
  host: GitHubHost,
  pr: PR,
  deps: PollDeps,
  st: PollState,
  elapsed: number,
): Promise<StepOutcome | null> {
  let prStateKnown = true;
  try {
    const state = await host.getPRState(pr);
    if (state === "MERGED") {
      sctx.log("PR has been merged!");
      return {};
    }
    if (state === "CLOSED") {
      sctx.log("PR has been closed");
      return {};
    }
  } catch (err) {
    sctx.log(`warning: could not check PR state: ${msg(err)}`);
    prStateKnown = false;
  }

  let mergeConflict = false;
  let mergeabilityKnown = true;
  try {
    const mergeState = await host.getMergeableState(pr);
    mergeConflict = mergeableConflict(mergeState);
    mergeabilityKnown = mergeableResolved(mergeState);
    if (!mergeabilityKnown) {
      sctx.log(`mergeable state still pending: ${mergeState}`);
      st.mergeabilityBlockedReason = `PR mergeability remained unresolved before timeout: ${mergeState}`;
    } else {
      st.mergeabilityBlockedReason = "";
      st.timeoutMergeConflict = mergeConflict;
    }
  } catch (err) {
    sctx.log(`warning: could not check mergeable state: ${msg(err)}`);
    st.mergeabilityBlockedReason = "";
    mergeabilityKnown = false;
  }

  let checks: Check[];
  try {
    checks = await host.getChecks(pr);
  } catch (err) {
    sctx.log(`warning: could not check CI: ${msg(err)}`);
    return null;
  }
  return handleChecks(sctx, host, pr, deps, st, { checks, mergeConflict, prStateKnown, mergeabilityKnown, elapsed });
}

interface CheckContext {
  checks: Check[];
  mergeConflict: boolean;
  prStateKnown: boolean;
  mergeabilityKnown: boolean;
  elapsed: number;
}

/** The check-handling branch (ci.go's GetChecks block). Returns a terminal
 *  outcome, or null to keep polling. Mutates `st`. */
async function handleChecks(
  sctx: StepContext,
  host: GitHubHost,
  pr: PR,
  deps: PollDeps,
  st: PollState,
  ctx: CheckContext,
): Promise<StepOutcome | null> {
  const { checks, mergeConflict } = ctx;
  const ciFixLimit = sctx.config.autoFixLimits.ci;
  const pending = hasPendingChecks(checks);
  const failing = failingCheckNames(checks);
  const hasIssues = failing.length > 0 || mergeConflict;
  st.timeoutFailingChecks = [...failing];

  // A failing check that completed after our last fix push means CI already
  // re-ran — treat as a new iteration so the retry path can fire.
  if (failingCheckCompletedAfter(checks, st.lastFixedCompletedAt)) {
    st.lastFixedChecks = "";
    st.lastFixedCompletedAt = {};
  }

  if (hasIssues && pending) {
    if (pendingCheckMatchesLastFixed(checks, st.lastFixedChecks)) {
      st.lastFixedChecks = "";
      st.lastFixedCompletedAt = {};
    }
    sctx.log("issues detected but checks still pending, waiting for all checks to complete...");
    return null;
  }

  if (hasIssues) {
    return handleIssues(sctx, host, pr, st, { failing, mergeConflict, ciFixLimit, checks });
  }

  // No issues: clear the attempt marker and log the monitoring status.
  st.lastFixedChecks = "";
  st.lastFixedCompletedAt = {};
  if (!ctx.prStateKnown || !ctx.mergeabilityKnown) {
    // Transient unknown — keep polling without a status claim.
  } else if (pending) {
    sctx.log("checks running");
  } else if (checks.length === 0 && ctx.elapsed < deps.gracePeriodMs) {
    sctx.log("no CI checks reported yet, waiting for checks to register...");
  } else if (checks.length === 0) {
    sctx.log("no CI checks reported");
  } else {
    sctx.log("checks passed");
  }
  return null;
}

interface IssueContext {
  failing: string[];
  mergeConflict: boolean;
  ciFixLimit: number;
  checks: Check[];
}

/** All checks done + issues present: fix or report. Verbatim ci.go's hasIssues
 *  branch. Returns a park outcome, or null to keep polling. Mutates `st`. */
async function handleIssues(
  sctx: StepContext,
  host: GitHubHost,
  pr: PR,
  st: PollState,
  ctx: IssueContext,
): Promise<StepOutcome | null> {
  const { failing, mergeConflict, ciFixLimit } = ctx;
  const fixKey = encodeLastFixedChecks(failing, mergeConflict);
  const fixCompletedAt = failingCheckCompletionTimes(ctx.checks);
  const issueDesc = describeIssues(failing, mergeConflict);

  if (sctx.fixing && !st.manualFixAttempted) {
    st.manualFixAttempted = true;
    sctx.log(`issues detected: ${issueDesc} - manual fix requested...`);
    const before = sctx.run.headSha;
    const { pushed } = await tryFix(sctx, host, pr, failing, mergeConflict);
    if (pushed || sctx.run.headSha !== before) {
      st.lastFixedChecks = fixKey;
      st.lastFixedCompletedAt = fixCompletedAt;
    } else {
      sctx.log("CI fix produced no changes, returning for manual intervention...");
      return ciFailureOutcome(failing, mergeConflict, "CI fix produced no changes - failures require manual intervention");
    }
    return null;
  }
  if (sctx.fixing && fixKey === st.lastFixedChecks) {
    sctx.log("fix already attempted for these issues, waiting for CI re-run...");
    return null;
  }
  if (ciFixLimit <= 0) {
    sctx.log(`issues detected: ${issueDesc} - auto-fix disabled, waiting for manual intervention...`);
    return ciFailureOutcome(failing, mergeConflict, "CI failures require manual intervention");
  }
  if (st.ciFixAttempts >= ciFixLimit) {
    sctx.log(`issues detected: ${issueDesc} - max auto-fix attempts (${ciFixLimit}) reached, waiting for manual intervention...`);
    return ciFailureOutcome(failing, mergeConflict, "CI failures still present after auto-fix attempts");
  }
  if (fixKey === st.lastFixedChecks) {
    sctx.log("fix already attempted for these issues, waiting for CI re-run...");
    return null;
  }
  st.ciFixAttempts += 1;
  sctx.log(`issues detected: ${issueDesc} - auto-fixing (attempt ${st.ciFixAttempts}/${ciFixLimit})...`);
  const before = sctx.run.headSha;
  const { pushed } = await tryFix(sctx, host, pr, failing, mergeConflict);
  if (pushed || sctx.run.headSha !== before) {
    st.lastFixedChecks = fixKey;
    st.lastFixedCompletedAt = fixCompletedAt;
  } else {
    sctx.log("CI fix produced no changes, will retry if attempts remain...");
  }
  return null;
}

function describeIssues(failing: string[], mergeConflict: boolean): string {
  let desc = failing.join(", ");
  if (mergeConflict) desc = desc !== "" ? `${desc} + merge conflict` : "merge conflict";
  return desc;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Auto-fix (ci_fix.go autoFixCI + commitAndPush) ──────────────────

/** Max CI-fix log bytes fed to the agent prompt. Verbatim maxLogBytes. */
const MAX_LOG_BYTES = 32 * 1024;

async function tryFix(
  sctx: StepContext,
  host: GitHubHost,
  pr: PR,
  failing: string[],
  mergeConflict: boolean,
): Promise<{ pushed: boolean }> {
  const defaultBranch = sctx.repo.defaultBranch.trim() || "main";
  const baseSHA = await resolveBranchBaseSHA(sctx.hostGit, sctx.run.baseSha, defaultBranch);
  const promptBaseSHA = mergeConflict ? await resolveDefaultTipSHA(sctx, defaultBranch, baseSHA) : baseSHA;

  let logOutput = "";
  try {
    const raw = await host.fetchFailedCheckLogs(sctx.run.branch, sctx.run.headSha, failing);
    if (raw !== "") logOutput = trimLog(raw.trim(), MAX_LOG_BYTES);
  } catch (err) {
    sctx.log(`warning: failed to fetch CI logs: ${msg(err)}`);
  }

  const prompt = buildCiFixPrompt({
    branch: sctx.run.branch,
    baseSHA: promptBaseSHA,
    targetSHA: sctx.run.headSha,
    prNumber: pr.number,
    failing,
    mergeConflict,
    rebaseTargetSHA: mergeConflict ? promptBaseSHA : "",
    logOutput,
    intentCtx: { intent: sctx.run.intent, authoritative: intentIsAuthoritative(sctx.run) },
  });

  sctx.log("running agent to fix CI issues...");
  try {
    await sctx.dispatcher.dispatch({
      role: "fixer",
      prompt,
      cwd: sctx.worktree,
      ...repoDispatchOptions(sctx),
    });
  } catch (err) {
    throw new Error(`agent CI fix: ${msg(err)}`);
  }

  return commitAndPush(sctx);
}

/** Resolve the upstream default-branch TIP sha for a merge-conflict rebase.
 *  Best-effort → falls back to baseSHA. */
async function resolveDefaultTipSHA(sctx: StepContext, defaultBranch: string, fallback: string): Promise<string> {
  const fetched = await sctx.hostGit.fetchRemoteBranch("origin", defaultBranch);
  if (fetched.exitCode === 0) {
    const sha = await sctx.hostGit.revParseVerify(`refs/remotes/origin/${defaultBranch}^{commit}`);
    if (sha) return sha;
  }
  return fallback;
}

/** Commit any agent changes and guarded-force-push. Returns whether anything was
 *  pushed. Verbatim commitAndPush, with the head-continuity assert (invariant 4). */
async function commitAndPush(sctx: StepContext): Promise<{ pushed: boolean }> {
  const status = await sctx.hostGit.statusPorcelain();
  if (status.trim() === "") {
    sctx.log("no changes to commit");
    const headSha = await sctx.hostGit.headSha();
    if (headSha !== sctx.run.headSha) return pushUpdatedHead(sctx, headSha);
    return { pushed: false };
  }
  await assertPipelineHeadContinuity(sctx, "ci");
  await sctx.jailedGit.run("add", "-A");
  await sctx.jailedGit.run("commit", "-m", "ez-code-factory: apply CI fixes");
  const headSha = await sctx.hostGit.headSha();
  await assertPipelineHeadContinuity(sctx, "ci");
  return pushUpdatedHead(sctx, headSha);
}

/** Guarded force-push of `newHeadSHA` (reuses push.ts patch-id safety). Verbatim
 *  pushUpdatedHeadSHA. */
async function pushUpdatedHead(sctx: StepContext, newHeadSHA: string): Promise<{ pushed: boolean }> {
  const ref = normalizedBranchRef(sctx.run.branch);
  const decision = await resolveForcePushDecision(
    sctx.hostGit,
    "origin",
    ref,
    newHeadSHA,
    sctx.run.headSha,
    sctx.run.baseSha,
  );
  if (decision.upToDate) {
    await sctx.jailedGit.run("update-ref", ref, newHeadSHA);
    sctx.run.headSha = newHeadSHA;
    await sctx.updateHeadSha(newHeadSHA);
    return { pushed: false };
  }
  await sctx.jailedGit.push("origin", ref, decision.remoteSHA, !decision.newBranch);
  await sctx.jailedGit.run("update-ref", ref, newHeadSHA);
  sctx.run.headSha = newHeadSHA;
  await sctx.updateHeadSha(newHeadSHA);
  sctx.log("committed and pushed fixes");
  return { pushed: true };
}

/** Middle-truncate a log to at most `maxBytes` bytes with a marker. */
function trimLog(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  const head = Math.floor(maxBytes / 2);
  const tail = maxBytes - head;
  const buf = Buffer.from(text, "utf-8");
  return `${buf.subarray(0, head).toString("utf-8")}\n... [truncated] ...\n${buf.subarray(buf.length - tail).toString("utf-8")}`;
}

// ── CI-fix prompt (ci_fix.go — verbatim variants) ───────────────────

interface CiFixPromptInput {
  branch: string;
  baseSHA: string;
  targetSHA: string;
  prNumber: string;
  failing: string[];
  mergeConflict: boolean;
  rebaseTargetSHA: string;
  logOutput: string;
  intentCtx: { intent: string | null; authoritative: boolean };
}

/** Build the CI-fix prompt (failures-only / merge-conflict / both variants),
 *  as a single template so prose lines never split into phantom coverage rows. */
function buildCiFixPrompt(input: CiFixPromptInput): string {
  const { branch, baseSHA, targetSHA, prNumber, failing, mergeConflict } = input;
  const bothVariant = failing.length > 0 && mergeConflict;
  let intro: string;
  let rules: string;
  if (bothVariant) {
    intro =
      "The following CI checks have failed and the PR has merge conflicts with the base branch. Diagnose and fix the CI issues, then rebase onto the base branch and resolve the merge conflicts.";
    rules = FIX_RULES;
  } else if (mergeConflict) {
    intro = "The PR has merge conflicts with the base branch. Rebase onto the base branch and resolve the merge conflicts.";
    rules = MERGE_RULES;
  } else {
    intro = "The following CI checks have failed on this PR. Diagnose and fix the issues.";
    rules = FIX_RULES;
  }
  let prompt = `${intro}

Context:
- branch: ${branch}
- base commit: ${baseSHA}
- target commit: ${targetSHA}
- PR number: ${prNumber}
- failing checks: ${failing.join(", ")}
- merge conflict: ${mergeConflict}

Rules:
${rules}`;
  if (mergeConflict) prompt += `\n- rebase target commit: ${input.rebaseTargetSHA}`;
  if (input.logOutput !== "") prompt += `\n\nCI logs:\n${input.logOutput}`;
  prompt += userIntentPromptSection(input.intentCtx);
  return prompt;
}

const FIX_RULES = `- You MUST produce file changes that fix the failing checks. Do not conclude that nothing needs to change.
- If a test fails only on a specific OS (e.g. Windows CRLF, path separators), fix the test to be cross-platform.
- If a test is flaky, make it deterministic.
- Make the smallest correct root-cause fix.
- Do not refactor beyond what is needed for that root-cause fix.
- Verify the fix by running the most relevant commands locally before finishing.`;

const MERGE_RULES = `- Resolve the merge conflicts by applying the minimal necessary changes.
- Do not make unrelated file edits.
- Verify the rebase completes cleanly before finishing.`;

// ── Shared ──────────────────────────────────────────────────────────

/** The gate repo's upstream URL from the worktree (linked worktrees share the
 *  repo remote config). "" when unreadable → provider unknown → skip. */
async function resolveUpstreamUrl(sctx: StepContext): Promise<string> {
  const r = await sctx.hostGit.try("remote", "get-url", "origin");
  return r.exitCode === 0 ? r.stdout.trim() : "";
}
