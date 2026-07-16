// ── Pipeline executor — resumable state machine ─────────────────────
//
// Port of internal/pipeline/executor.go's executeStep loop + step sequencing,
// adapted from upstream's in-process goroutine-blocking approach to a DURABLE,
// resumable model: instead of blocking on a Go channel at an approval gate, the
// executor persists the parked state (step_results + step_rounds + run status)
// and RETURNS. A later `respondToGate` call reloads that state and continues.
//
// Fixed step order (config.PIPELINE_STEPS); M1 implements intent/rebase/review/
// push, and registers test/document/lint/pr/ci as auto-skipped ("lands in
// M3/M4"). The auto-fix loop honors per-step caps (review=0 → always parks);
// respond actions approve/fix/skip/abort carry upstream's merge semantics;
// rebase's empty-diff SkipRemaining short-circuits the rest.

import {
  autoFixLimit,
  IMPLEMENTED_STEPS,
  PIPELINE_STEPS,
  type PipelineConfig,
  type PipelineStep,
} from "./config";
import type { AgentDispatcher } from "./agent";
import { makeGit } from "./git";
import { emptyRepoConfig, type RepoConfig } from "./repo-config";
import type { ShellRunner } from "./shell";
import {
  deserializeFindings,
  emptyFindings,
  serializeFindings,
  type RunRecord,
  type RunStore,
  type StepResultRecord,
  type StepRoundRecord,
  type StepStatus,
} from "./runs";
import {
  autoFixableFindingsJSON,
  combineSelectedFindingIDs,
  filterFindingsJSON,
  findingIDsJSON,
  hasAskUserFindingsJSON,
  marshalFindingIDs,
  mergeUserOverridesJSON,
  normalizeFindingsJSON,
} from "./findings";
import { makeRunShared, type RunShared, type RunView, type Step, type StepContext, type StepOutcome } from "./steps/common";
import { intentStep } from "./steps/intent";
import { rebaseStep } from "./steps/rebase";
import { reviewStep } from "./steps/review";
import { testStep } from "./steps/test";
import { documentStep } from "./steps/document";
import { lintStep } from "./steps/lint";
import { pushStep } from "./steps/push";

/** Registry of the pipeline steps. `null` = registered but not implemented yet
 *  (auto-skipped until its milestone). Order is enforced by PIPELINE_STEPS. */
export const STEP_REGISTRY: Record<PipelineStep, Step | null> = {
  intent: intentStep,
  rebase: rebaseStep,
  review: reviewStep,
  test: testStep,
  document: documentStep,
  lint: lintStep,
  push: pushStep,
  pr: null,
  ci: null,
};

/** Everything the executor needs. hostRunner drives read-only git; jailedRunner
 *  drives mutating commit/push (the nested jail in production). */
export interface ExecutorDeps {
  store: RunStore;
  worktree: string;
  gateDir: string;
  /** Project root (the user's working repo) — the bundled-local-default guard
   *  reads it and the jail uses it as the forbidden-data anchor. */
  workingPath: string;
  config: PipelineConfig;
  dispatcher: AgentDispatcher;
  hostRunner: ShellRunner;
  jailedRunner: ShellRunner;
  /** Base dir for per-run test-evidence artifacts (the per-extension TMPDIR).
   *  Threaded to every StepContext; defaults to "/tmp" when omitted. */
  tmpBase?: string;
  /**
   * SECURITY (spec §1 invariant 1): resolve the TRUSTED-branch-gated per-repo
   * config BEFORE any agent dispatches. When set, startPipeline calls it once,
   * PERSISTS the result on the run, and threads it to every step; a throw aborts
   * the run fail-closed BEFORE `advance` (so no step — and thus no agent — runs).
   * respondToGate never re-calls it: it reuses the persisted config, so a
   * transient fetch failure can never kill a parked run mid-review. When omitted,
   * the executor falls back to the run's persisted `repoConfig` (or an empty
   * config) with no fetch — the shape M1 executor tests rely on.
   */
  resolveRepoConfig?: () => Promise<RepoConfig>;
  /** Injected clock (ms) so parked-time + round durations are deterministic. */
  now: () => number;
  /** Called after each persisted change (dashboard refresh). Optional. */
  onChange?: () => Promise<void> | void;
  /** Per-step log sink. Optional. */
  log?: (runId: string, step: PipelineStep, message: string) => void;
  /** Step registry override (tests inject scripted steps). Defaults to
   *  STEP_REGISTRY — the real intent/rebase/review/push wiring. */
  steps?: Record<PipelineStep, Step | null>;
}

/** The effective step registry for a run (injected override or the default). */
function registry(deps: ExecutorDeps): Record<PipelineStep, Step | null> {
  return deps.steps ?? STEP_REGISTRY;
}

/** The set of steps to execute for real (registered + non-null impl). Injected
 *  steps are all "implemented"; the default registry uses IMPLEMENTED_STEPS. */
function isImplemented(deps: ExecutorDeps, step: PipelineStep): boolean {
  if (deps.steps) return deps.steps[step] !== null;
  return IMPLEMENTED_STEPS.has(step) && STEP_REGISTRY[step] !== null;
}

/** Terminal or paused result of a pipeline invocation. */
export interface PipelineOutcome {
  status: "completed" | "failed" | "aborted" | "parked";
  /** The step the run parked at (when status === "parked"). */
  parkedStep?: PipelineStep;
  /** The failure/abort reason (when failed/aborted). */
  error?: string;
}

export type RespondAction = "approve" | "fix" | "skip" | "abort";

export interface RespondInput {
  step: PipelineStep;
  action: RespondAction;
  /** Agent-produced finding ids the user selected for a fix. */
  findingIds?: string[];
  /** Per-finding user instructions, keyed by finding id. */
  instructions?: Record<string, string>;
  /** User-authored findings to merge in for the fix. */
  addedFindings?: unknown[];
}

const ZERO_SHA = "0".repeat(40);

// ── record helpers ──────────────────────────────────────────────────

function newStepResult(runId: string, step: PipelineStep, cap: number): StepResultRecord {
  return {
    runId,
    step,
    status: "pending",
    findings: emptyFindings(),
    agentPid: null,
    autoFixLimit: cap,
    round: 0,
    autoFixAttempts: 0,
    executionMs: 0,
    fixSummary: null,
  };
}

/** Load a step's result row, creating a pending one on first sight. */
async function ensureStepResult(
  deps: ExecutorDeps,
  runId: string,
  step: PipelineStep,
): Promise<StepResultRecord> {
  const existing = await deps.store.getStepResult(runId, step);
  if (existing) return existing;
  const sr = newStepResult(runId, step, autoFixLimit(deps.config, step));
  await deps.store.putStepResult(sr);
  return sr;
}

function buildRunView(rec: RunRecord): RunView {
  return {
    id: rec.id,
    branch: rec.branch,
    ref: rec.ref,
    headSha: rec.headSha,
    baseSha: rec.baseSha,
    intent: rec.intent,
    intentSource: rec.intentSource,
  };
}

function buildStepContext(
  deps: ExecutorDeps,
  run: RunView,
  step: PipelineStep,
  rounds: StepRoundRecord[],
  fixing: boolean,
  previousFindings: string,
  repoConfig: RepoConfig,
  shared: RunShared,
): StepContext {
  return {
    worktree: deps.worktree,
    gateDir: deps.gateDir,
    tmpBase: deps.tmpBase ?? "/tmp",
    run,
    repo: { defaultBranch: deps.config.defaultBranch, workingPath: deps.workingPath },
    config: deps.config,
    repoConfig,
    shared,
    fixing,
    previousFindings,
    rounds,
    dispatcher: deps.dispatcher,
    hostGit: makeGit(deps.hostRunner, deps.worktree),
    jailedGit: makeGit(deps.jailedRunner, deps.worktree),
    hostRunner: deps.hostRunner,
    log: (m) => deps.log?.(run.id, step, m),
    updateHeadSha: async (sha) => {
      await deps.store.updateRun(run.id, { headSha: sha });
    },
  };
}

async function notify(deps: ExecutorDeps): Promise<void> {
  if (deps.onChange) await deps.onChange();
}

async function setRunStatus(
  deps: ExecutorDeps,
  runId: string,
  patch: Partial<RunRecord>,
): Promise<void> {
  await deps.store.updateRun(runId, patch);
  await notify(deps);
}

// ── fix loop (executeStep, executor.go) ─────────────────────────────

type StepLoopKind = "completed" | "skipped" | "skipRemaining" | "parked";

/**
 * Execute one step with the auto-fix loop. Persists a round per execution and
 * the (possibly parked) step result. Returns the loop kind; on "parked" the
 * step result carries awaiting_approval/fix_review. Mutates `sr` in place.
 */
async function runStepFixLoop(
  deps: ExecutorDeps,
  impl: Step,
  sr: StepResultRecord,
  run: RunView,
  initFixing: boolean,
  initPreviousFindings: string,
  repoConfig: RepoConfig,
  shared: RunShared,
): Promise<{ kind: StepLoopKind; findings: string }> {
  const cap = autoFixLimit(deps.config, impl.name);
  let fixing = initFixing;
  let previousFindings = initPreviousFindings;
  let terminal: { kind: StepLoopKind; findings: string } | null = null;

  // Loops while auto-fixing; the terminal branch sets `terminal`, so the loop
  // exits naturally (no unreachable infinite-loop tail).
  while (terminal === null) {
    const rounds = await deps.store.getStepRounds(run.id, impl.name);
    const sctx = buildStepContext(deps, run, impl.name, rounds, fixing, previousFindings, repoConfig, shared);
    const roundStart = deps.now();
    const outcome: StepOutcome = await impl.execute(sctx);
    sr.round += 1;
    const durationMs = deps.now() - roundStart;
    // Accumulate execution-only elapsed ms across every round (initial + fixes),
    // excluding parked wait time — upstream tracks this on the step result. The
    // per-round wall-clock lives on StepRoundRecord.durationMs.
    sr.executionMs += durationMs;
    const findings = normalizeFindingsJSON(outcome.findings ?? "", impl.name);
    sr.findings = findings === "" ? emptyFindings() : deserializeFindings(JSON.parse(findings));
    sr.fixSummary = outcome.fixSummary && outcome.fixSummary !== "" ? outcome.fixSummary : null;

    const willAutoFix =
      outcome.autoFixable === true &&
      cap > 0 &&
      sr.autoFixAttempts < cap &&
      autoFixableFindingsJSON(findings) !== "";

    const round: StepRoundRecord = {
      runId: run.id,
      step: impl.name,
      round: sr.round,
      trigger: fixing ? "auto_fix" : "initial",
      findingsJson: findings === "" ? null : findings,
      userFindingsJson: null,
      selectedFindingIds: willAutoFix ? emptyToNull(findingIDsJSON(autoFixableFindingsJSON(findings))) : null,
      selectionSource: willAutoFix ? "auto_fix" : null,
      fixSummary: sr.fixSummary,
      durationMs,
    };
    await deps.store.appendStepRound(round);
    await deps.store.putStepResult(sr);

    if (willAutoFix) {
      sr.autoFixAttempts += 1;
      sr.status = "fixing";
      await deps.store.putStepResult(sr);
      await notify(deps);
      fixing = true;
      previousFindings = autoFixableFindingsJSON(findings);
      continue;
    }

    if (outcome.needsApproval !== true && !hasAskUserFindingsJSON(findings)) {
      terminal = {
        kind: outcome.skipRemaining ? "skipRemaining" : outcome.skipped ? "skipped" : "completed",
        findings,
      };
    } else {
      // Park: persist the gate status so a respond can resume.
      sr.status = fixing ? "fix_review" : "awaiting_approval";
      await deps.store.putStepResult(sr);
      terminal = { kind: "parked", findings };
    }
  }
  return terminal;
}

function emptyToNull(s: string): string | null {
  return s === "" ? null : s;
}

// ── advance / terminal transitions ──────────────────────────────────

async function skipStep(deps: ExecutorDeps, sr: StepResultRecord, note?: string): Promise<void> {
  sr.status = "skipped";
  await deps.store.putStepResult(sr);
  if (note) deps.log?.(sr.runId, sr.step as PipelineStep, note);
  await notify(deps);
}

async function completeStepStatus(
  deps: ExecutorDeps,
  sr: StepResultRecord,
  status: StepStatus,
): Promise<void> {
  sr.status = status;
  await deps.store.putStepResult(sr);
  await notify(deps);
}

async function completeRun(deps: ExecutorDeps, runId: string): Promise<PipelineOutcome> {
  await setRunStatus(deps, runId, { status: "completed", awaitingAgentSince: null });
  return { status: "completed" };
}

async function failRun(
  deps: ExecutorDeps,
  runId: string,
  reason: string,
  status: "failed" | "aborted",
): Promise<PipelineOutcome> {
  await setRunStatus(deps, runId, { status, awaitingAgentSince: null, error: reason });
  return { status, error: reason };
}

/** Mark every remaining pipeline step (from `start`) skipped. */
async function skipRemainingSteps(deps: ExecutorDeps, runId: string, start: number): Promise<void> {
  for (let i = start; i < PIPELINE_STEPS.length; i++) {
    const step = PIPELINE_STEPS[i]!;
    const sr = await ensureStepResult(deps, runId, step);
    if (sr.status === "completed" || sr.status === "skipped") continue;
    await skipStep(deps, sr);
  }
}

/**
 * Run steps from `startIndex` until the pipeline parks, completes, or fails.
 * The single engine both startPipeline and respondToGate feed into.
 */
async function advance(
  deps: ExecutorDeps,
  run: RunView,
  startIndex: number,
  repoConfig: RepoConfig,
  shared: RunShared,
): Promise<PipelineOutcome> {
  for (let i = startIndex; i < PIPELINE_STEPS.length; i++) {
    const step = PIPELINE_STEPS[i]!;
    const sr = await ensureStepResult(deps, run.id, step);
    if (sr.status === "completed" || sr.status === "skipped") continue;

    const impl = registry(deps)[step];
    if (impl === null || !isImplemented(deps, step)) {
      await skipStep(deps, sr, `${step} not implemented until M4 — auto-skipped`);
      continue;
    }

    await completeStepStatus(deps, sr, "running");
    let result: { kind: StepLoopKind; findings: string };
    try {
      result = await runStepFixLoop(deps, impl, sr, run, false, "", repoConfig, shared);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sr.status = "failed";
      await deps.store.putStepResult(sr);
      return failRun(deps, run.id, `step ${step} failed: ${message}`, "failed");
    }

    if (result.kind === "parked") {
      return park(deps, run.id, step);
    }
    if (result.kind === "skipRemaining") {
      await completeStepStatus(deps, sr, "completed");
      await skipRemainingSteps(deps, run.id, i + 1);
      return completeRun(deps, run.id);
    }
    await completeStepStatus(deps, sr, result.kind === "skipped" ? "skipped" : "completed");
  }
  return completeRun(deps, run.id);
}

/** Persist the parked run state (awaiting the human) and return. */
async function park(deps: ExecutorDeps, runId: string, step: PipelineStep): Promise<PipelineOutcome> {
  const nowIso = new Date(deps.now()).toISOString();
  await setRunStatus(deps, runId, { status: "awaiting_approval", awaitingAgentSince: nowIso });
  return { status: "parked", parkedStep: step };
}

// ── public entry points ─────────────────────────────────────────────

/**
 * Resolve the run's TRUSTED-branch-gated repo config. When the `resolveRepoConfig`
 * seam is wired, run it (fetch → resolve → assert → merge) — a throw means the
 * trusted config was unreadable, which the caller turns into a fail-closed run
 * failure BEFORE any step executes. When the seam is absent, reuse the run's
 * persisted config (or an empty one) with no fetch. */
async function resolveRunRepoConfig(deps: ExecutorDeps, rec: RunRecord): Promise<RepoConfig> {
  if (deps.resolveRepoConfig) {
    const resolved = await deps.resolveRepoConfig();
    await deps.store.updateRun(rec.id, { repoConfig: resolved });
    return resolved;
  }
  return rec.repoConfig ?? emptyRepoConfig();
}

/** Start (or restart from the top) a run's pipeline. */
export async function startPipeline(runId: string, deps: ExecutorDeps): Promise<PipelineOutcome> {
  const rec = await deps.store.getRun(runId);
  if (!rec) return { status: "failed", error: `run ${runId} not found` };
  await setRunStatus(deps, runId, { status: "running" });
  // SECURITY: resolve the trusted-branch config BEFORE any step — a fetch/resolve/
  // parse failure aborts the run fail-closed, so no agent is ever dispatched
  // against an unreadable trusted config (spec §1 invariant 1).
  let repoConfig: RepoConfig;
  try {
    repoConfig = await resolveRunRepoConfig(deps, rec);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failRun(deps, runId, `trusted config unreadable: ${message}`, "failed");
  }
  const run = buildRunView({ ...rec, status: "running" });
  return advance(deps, run, 0, repoConfig, makeRunShared());
}

/**
 * Apply a user's approval action to the currently-parked gate and resume.
 * Semantics (spec §1): approve → complete the step + continue; skip → mark the
 * STEP skipped + continue; abort → fail the run as cancelled; fix → merge the
 * user's selected findings + instructions + added findings and re-execute the
 * step (Fixing=true), which may park again or complete.
 */
export async function respondToGate(
  runId: string,
  input: RespondInput,
  deps: ExecutorDeps,
): Promise<PipelineOutcome> {
  const rec = await deps.store.getRun(runId);
  if (!rec) return { status: "failed", error: `run ${runId} not found` };

  const stepIndex = PIPELINE_STEPS.indexOf(input.step);
  if (stepIndex < 0) return { status: "failed", error: `unknown step ${input.step}` };
  const sr = await deps.store.getStepResult(runId, input.step);
  if (!sr || (sr.status !== "awaiting_approval" && sr.status !== "fix_review")) {
    return { status: "failed", error: `step ${input.step} is not awaiting approval` };
  }

  // Account the parked time before resuming.
  if (rec.awaitingAgentSince) {
    const parked = Math.max(0, deps.now() - Date.parse(rec.awaitingAgentSince));
    await setRunStatus(deps, runId, { parkedMs: rec.parkedMs + parked, awaitingAgentSince: null });
  }
  await setRunStatus(deps, runId, { status: "running" });
  const refreshed = (await deps.store.getRun(runId)) ?? rec;
  const run = buildRunView(refreshed);
  // Reuse the config resolved (and persisted) at startPipeline — a respond never
  // re-fetches, so a transient default-branch fetch failure can never kill a
  // parked run mid-review. A fresh RunShared per respond gives the document→lint
  // stash the correct invocation-scoped lifetime.
  const repoConfig = refreshed.repoConfig ?? emptyRepoConfig();
  const shared = makeRunShared();

  switch (input.action) {
    case "approve":
      await completeStepStatus(deps, sr, "completed");
      return advance(deps, run, stepIndex + 1, repoConfig, shared);
    case "skip":
      await completeStepStatus(deps, sr, "skipped");
      return advance(deps, run, stepIndex + 1, repoConfig, shared);
    case "abort":
      sr.status = "failed";
      await deps.store.putStepResult(sr);
      return failRun(deps, runId, `step ${input.step}: aborted by user`, "aborted");
    case "fix":
      return applyFix(deps, run, sr, stepIndex, input, repoConfig, shared);
  }
}

/** The `fix` action: merge user selections + re-execute the step. */
async function applyFix(
  deps: ExecutorDeps,
  run: RunView,
  sr: StepResultRecord,
  stepIndex: number,
  input: RespondInput,
  repoConfig: RepoConfig,
  shared: RunShared,
): Promise<PipelineOutcome> {
  const impl = registry(deps)[input.step];
  if (impl === null) return { status: "failed", error: `step ${input.step} is not fixable` };

  const findingIds = input.findingIds ?? [];
  // Serialize via the canonical serializeFindings so the parked findings carry
  // every field (tested / testing_summary / artifacts / user_instructions), not
  // just the hand-rolled summary + risk pair — the fix agent sees the full set.
  const parkedFindings = serializeFindings(sr.findings);
  const selected = filterFindingsJSON(parkedFindings, findingIds);
  const merged = mergeUserOverridesJSON(selected, input.instructions ?? {}, input.addedFindings ?? []);

  // Record the user's selection on the parked round for round history.
  const allSelectedIds = combineSelectedFindingIDs(findingIds, merged);
  await deps.store.patchLastStepRound(run.id, input.step, {
    selectedFindingIds: emptyToNull(marshalFindingIDs(allSelectedIds)),
    selectionSource: "user",
    userFindingsJson: merged !== "" && merged !== selected ? merged : null,
  });

  sr.status = "fixing";
  await deps.store.putStepResult(sr);
  await notify(deps);

  let result: { kind: StepLoopKind; findings: string };
  try {
    result = await runStepFixLoop(deps, impl, sr, run, true, merged, repoConfig, shared);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sr.status = "failed";
    await deps.store.putStepResult(sr);
    return failRun(deps, run.id, `step ${input.step} failed: ${message}`, "failed");
  }

  if (result.kind === "parked") return park(deps, run.id, input.step);
  if (result.kind === "skipRemaining") {
    await completeStepStatus(deps, sr, "completed");
    await skipRemainingSteps(deps, run.id, stepIndex + 1);
    return completeRun(deps, run.id);
  }
  await completeStepStatus(deps, sr, result.kind === "skipped" ? "skipped" : "completed");
  return advance(deps, run, stepIndex + 1, repoConfig, shared);
}

export { ZERO_SHA };
