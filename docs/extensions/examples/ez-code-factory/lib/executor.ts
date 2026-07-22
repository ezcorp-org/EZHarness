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
import type { AgentDispatcher, DispatchOptions, DispatchResult } from "./agent";
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
import type { GhRunner } from "./github";
import type { StepWithRounds } from "./runs";
import {
  buildStepIORecord,
  emptyOutcomeFlags,
  makeStepIOSink,
  snapshotRepoConfig,
  type RawStepIORecord,
  type StepIODispatch,
  type StepIOSink,
} from "./step-io";
import { withRunHeartbeat, type HeartbeatSchedule } from "./heartbeat";
import { intentStep } from "./steps/intent";
import { rebaseStep } from "./steps/rebase";
import { reviewStep } from "./steps/review";
import { testStep } from "./steps/test";
import { documentStep } from "./steps/document";
import { lintStep } from "./steps/lint";
import { pushStep } from "./steps/push";
import { prStep } from "./steps/pr";
import { ciStep } from "./steps/ci";

/** Registry of the pipeline steps — every step is implemented as of M4 (the CI
 *  step also opts into ReconcileApprovalGate). `null` remains a valid registry
 *  entry so tests can inject a step-less slot (auto-skipped). Order is enforced
 *  by PIPELINE_STEPS. */
export const STEP_REGISTRY: Record<PipelineStep, Step | null> = {
  intent: intentStep,
  rebase: rebaseStep,
  review: reviewStep,
  test: testStep,
  document: documentStep,
  lint: lintStep,
  push: pushStep,
  pr: prStep,
  ci: ciStep,
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
  /** GitHub CLI runner (pr/ci). Defaults to a stub that reports gh unavailable,
   *  so a run whose deployment never wired gh SKIPS pr/ci (skip-not-fail). */
  gh?: GhRunner;
  /** CI poll-loop sleep seam (deterministic in tests). Defaults to a real
   *  setTimeout in production. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after each persisted change (dashboard refresh). Optional. */
  onChange?: () => Promise<void> | void;
  /** Per-step log sink. Optional. */
  log?: (runId: string, step: PipelineStep, message: string) => void;
  /** Step registry override (tests inject scripted steps). Defaults to
   *  STEP_REGISTRY — the real intent/rebase/review/push wiring. */
  steps?: Record<PipelineStep, Step | null>;
  /**
   * Control plane (L4): steps this run's JOB opted to skip. Threaded from the
   * matched job; the sequencer marks each `skipped` (reason `skipped by job
   * <name>`) BEFORE dispatching, so no agent runs for a skipped step. PROTECTED
   * steps (intent/rebase/review/push) are rejected at save time and never
   * appear here. Absent → nothing job-skipped (default behavior).
   */
  skipSteps?: PipelineStep[];
  /** The matched job's name, for the `skipped by job <name>` skip reason. */
  jobName?: string;
  /**
   * Per-run liveness heartbeat (L3). When present, the executor wraps each
   * `impl.execute` in a heartbeat interval (writes immediately + every
   * intervalMs) so a live run keeps beating and a dead one goes silent — the
   * sweep then marks the silent run `stalled`. Writes a SEPARATE
   * `heartbeats/<runId>` key (never a read-modify-write on the run record).
   * Optional — omitted by executor tests that don't assert liveness; a
   * heartbeat write failure never fails the run.
   */
  heartbeat?: {
    write: (runId: string, at: string) => Promise<void>;
    schedule?: HeartbeatSchedule;
    intervalMs?: number;
  };
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

/** Terminal or paused result of a pipeline invocation. `checks_passed` is a
 *  RESTING (not terminal) outcome the CI step produces when checks go green (spec
 *  §1 step 9): the run released its worktree + lock but the PR is still open, so a
 *  later `reconcile` advances it to `completed`. */
export interface PipelineOutcome {
  status: "completed" | "failed" | "aborted" | "parked" | "checks_passed";
  /** The step the run parked/rested at (when status === "parked" | "checks_passed"). */
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

/**
 * Wrap a dispatcher so every SETTLED dispatch is reported to `onSettled`: with
 * its result on success (`error === null`), or with an error message on throw
 * (`result === null`), then the throw propagates. Transparent to the step
 * (returns/throws the inner value unchanged). Keeps the capture concern out of
 * every step: steps keep calling `sctx.dispatcher.dispatch(...)` unaware they
 * are recorded. The caller records step-result LINKAGE on success only (a
 * failed dispatch has no durable conversation to link) and the full dispatch IO
 * — prompt / bounded preview / error — on both paths.
 */
function recordingDispatcher(
  inner: AgentDispatcher,
  onSettled: (
    opts: DispatchOptions,
    result: DispatchResult | null,
    error: string | null,
    at: string,
  ) => void,
  now: () => number,
): AgentDispatcher {
  return {
    async dispatch(opts) {
      try {
        const result = await inner.dispatch(opts);
        onSettled(opts, result, null, new Date(now()).toISOString());
        return result;
      } catch (err) {
        onSettled(opts, null, err instanceof Error ? err.message : String(err), new Date(now()).toISOString());
        throw err;
      }
    },
  };
}

/** The bounded agent RESULT PREVIEW (work product — the final answer, NOT the
 *  turn-by-turn transcript, which L6 forbids in the record): the structured
 *  output when present, else the final text. Field-level caps applied later by
 *  `buildStepIORecord`. */
function resultPreviewText(result: DispatchResult): string {
  if (result.output !== null && result.output !== undefined) {
    try {
      return JSON.stringify(result.output);
    } catch {
      return result.text;
    }
  }
  return result.text;
}

/** Build one dispatch's IO entry from the settled dispatch (result on success,
 *  error string on throw). Handle ids are lifted from the result when present. */
function buildDispatchIO(
  opts: DispatchOptions,
  result: DispatchResult | null,
  error: string | null,
  at: string,
): StepIODispatch {
  return {
    role: opts.role,
    promptText: opts.prompt,
    resultPreview: result ? resultPreviewText(result) : "",
    assignmentId: result?.assignmentId ?? "",
    subConversationId: result?.subConversationId ?? "",
    agentRunId: result?.agentRunId ?? "",
    at,
    ...(error !== null ? { error } : {}),
  };
}

/** Write one round's step_io record — record-and-continue: a bounding/storage
 *  failure must NEVER fail the run (log via the injected sink, proceed). */
async function writeStepIO(deps: ExecutorDeps, raw: RawStepIORecord): Promise<void> {
  try {
    await deps.store.putStepIO(buildStepIORecord(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log?.(raw.runId, raw.step as PipelineStep, `step_io write failed (continuing): ${message}`);
  }
}

/** Append one dispatch's linkage to a step result (in place). No-op when the
 *  result lacks handle ids (a hand-built DispatchResult, or a step fake in
 *  tests) so recording is a pure enrichment that never fabricates a ref. */
function appendDispatchRef(
  sr: StepResultRecord,
  opts: DispatchOptions,
  result: DispatchResult,
  at: string,
): void {
  if (!result.assignmentId || !result.subConversationId) return;
  (sr.agentDispatches ??= []).push({
    role: opts.role,
    assignmentId: result.assignmentId,
    subConversationId: result.subConversationId,
    agentRunId: result.agentRunId ?? "",
    at,
  });
}

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
    prUrl: rec.prUrl ?? null,
  };
}

/** A gh runner used when the deployment never wired one: every call reports a
 *  non-zero exit, so `host.available()` fails and pr/ci SKIP (skip-not-fail). */
const unavailableGh: GhRunner = async () => ({ exitCode: 127, stdout: "", stderr: "gh not wired" });

/** Real poll wait (production default) — the only wall-clock sleep. */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Load every pipeline step's persisted result + rounds (PR-body assembly). */
async function loadStepHistory(deps: ExecutorDeps, runId: string): Promise<StepWithRounds[]> {
  const out: StepWithRounds[] = [];
  for (const step of PIPELINE_STEPS) {
    const result = await deps.store.getStepResult(runId, step);
    if (!result) continue;
    const rounds = await deps.store.getStepRounds(runId, step);
    out.push({ result, rounds });
  }
  return out;
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
  ioSink?: StepIOSink,
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
    gh: deps.gh ?? unavailableGh,
    now: deps.now,
    sleep: deps.sleep ?? realSleep,
    log: (m) => deps.log?.(run.id, step, m),
    updateHeadSha: async (sha) => {
      await deps.store.updateRun(run.id, { headSha: sha });
    },
    updatePrUrl: async (url) => {
      await deps.store.updateRun(run.id, { prUrl: url });
      run.prUrl = url;
    },
    loadStepHistory: () => loadStepHistory(deps, run.id),
    ...(ioSink ? { ioSink } : {}),
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

type StepLoopKind = "completed" | "skipped" | "skipRemaining" | "parked" | "checksPassed";

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
    // One IO sink per round, drained into the step_io record at round end.
    const sink = makeStepIOSink();
    const sctx = buildStepContext(deps, run, impl.name, rounds, fixing, previousFindings, repoConfig, shared, sink);
    // Record each agent dispatch this round makes: its LINKAGE onto the step
    // result (success only — a failed dispatch has no durable conversation to
    // link), and its full IO (prompt / bounded preview / error) into the round
    // sink on BOTH the success and throw paths. The wrapper is transparent to
    // the step; the appended refs persist with the step result below.
    sctx.dispatcher = recordingDispatcher(
      sctx.dispatcher,
      (opts, result, error, at) => {
        if (result) appendDispatchRef(sr, opts, result, at);
        sink.recordDispatch(buildDispatchIO(opts, result, error, at));
      },
      deps.now,
    );

    // The attempt's 1-based round number, computed BEFORE execute. The success
    // path post-increments sr.round to this same value below (:353 pre-edit), so
    // the IO record and the round record share one number; an errored attempt
    // records its IO here WITHOUT touching sr.round (L2 — so an initial-pass
    // throw lands at round 1, and a fix-round throw at prior+1, never
    // overwriting the completed round's record).
    const attemptRound = sr.round + 1;
    const ioInputs = {
      runId: run.id,
      step: impl.name,
      round: attemptRound,
      trigger: (fixing ? "auto_fix" : "initial") as "initial" | "auto_fix",
      branch: run.branch,
      headSha: run.headSha,
      worktreePath: deps.worktree,
      repoConfig: snapshotRepoConfig(repoConfig),
      startedAt: new Date(deps.now()).toISOString(),
    };

    const roundStart = deps.now();
    let outcome: StepOutcome;
    try {
      // Wrap execute in the per-run heartbeat interval (when wired) so a live
      // run keeps beating through dispatch awaits / long trusted shell commands
      // / the CI poll loop, and a dead process goes silent for the sweep to
      // mark stalled. When no heartbeat is wired, execute directly.
      outcome = deps.heartbeat
        ? await withRunHeartbeat(
            {
              write: deps.heartbeat.write,
              now: deps.now,
              schedule: deps.heartbeat.schedule,
              intervalMs: deps.heartbeat.intervalMs,
            },
            run.id,
            () => impl.execute(sctx),
          )
        : await impl.execute(sctx);
    } catch (err) {
      // Record the failed attempt's IO under attemptRound (leaving sr.round
      // untouched — the caller marks the step failed), then rethrow.
      const endedMs = deps.now();
      await writeStepIO(deps, {
        ...ioInputs,
        dispatches: sink.dispatches(),
        shellCommands: sink.shellCommands(),
        endedAt: new Date(endedMs).toISOString(),
        durationMs: endedMs - roundStart,
        error: err instanceof Error ? err.message : String(err),
        outcome: emptyOutcomeFlags(),
      });
      throw err;
    }
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
    // Beside the round + result: the round's step_io observability record under
    // attemptRound (=== sr.round now). Record-and-continue — never fails the run.
    await writeStepIO(deps, {
      ...ioInputs,
      dispatches: sink.dispatches(),
      shellCommands: sink.shellCommands(),
      endedAt: new Date(deps.now()).toISOString(),
      durationMs,
      error: null,
      outcome: {
        needsApproval: outcome.needsApproval === true,
        autoFixable: outcome.autoFixable === true,
        skipped: outcome.skipped === true,
        skipRemaining: outcome.skipRemaining === true,
        checksPassed: outcome.checksPassed === true,
      },
    });

    if (willAutoFix) {
      sr.autoFixAttempts += 1;
      sr.status = "fixing";
      await deps.store.putStepResult(sr);
      await notify(deps);
      fixing = true;
      previousFindings = autoFixableFindingsJSON(findings);
      continue;
    }

    if (outcome.checksPassed === true) {
      // CI checks went green (spec §1 step 9): rest the run at checks_passed. The
      // STEP is left parked at its gate (awaiting_approval) so a later reconcile
      // finds it and completes it on merge/close; the RUN status transition (to
      // the resting checks_passed) is applied by advance().
      sr.status = "awaiting_approval";
      await deps.store.putStepResult(sr);
      terminal = { kind: "checksPassed", findings };
    } else if (outcome.needsApproval !== true && !hasAskUserFindingsJSON(findings)) {
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

    // Control plane (L4): the run's job opted to skip this step. Mark it
    // `skipped` BEFORE any dispatch so no agent runs. Protected steps
    // (intent/rebase/review/push) are rejected on save, so they never reach
    // here — a skip can never bypass the review gate.
    if (deps.skipSteps?.includes(step)) {
      await skipStep(deps, sr, `skipped by job ${deps.jobName ?? "?"}`);
      continue;
    }

    const impl = registry(deps)[step];
    if (impl === null || !isImplemented(deps, step)) {
      await skipStep(deps, sr, `${step} not implemented — auto-skipped`);
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
    if (result.kind === "checksPassed") {
      // The CI step already left its own gate parked (awaiting_approval); rest the
      // RUN at checks_passed and return. The worktree + lock release because the
      // index maps a non-"parked" outcome to teardown.
      return checksPassedRest(deps, run.id, step);
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

/**
 * Rest the run at `checks_passed` (spec §1 step 9): the CI step saw green checks
 * and exited instead of babysitting the open PR. Records `awaitingAgentSince` so
 * a later reconcile accounts the parked time exactly as an approve/reconcile
 * would. The run is NOT terminal and NOT `parked` — the index maps this to a
 * worktree teardown + lock release (the resource win over the old multi-day
 * poll), while the CI step stays parked so `reconcileGate` completes the run on
 * merge/close.
 */
async function checksPassedRest(deps: ExecutorDeps, runId: string, step: PipelineStep): Promise<PipelineOutcome> {
  const nowIso = new Date(deps.now()).toISOString();
  await setRunStatus(deps, runId, { status: "checks_passed", awaitingAgentSince: nowIso });
  return { status: "checks_passed", parkedStep: step };
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

/**
 * Drive a parked step's opt-in ReconcileApprovalGate (spec §1): a read-only,
 * bounded poll of external truth (the CI step checks whether its PR has been
 * merged/closed). When the gate RESOLVES, the parked step is completed and the
 * pipeline advances exactly as an `approve` respond would — so a run parked at
 * CI auto-clears once its PR merges without a human. When the step is not
 * parked, has no reconcile hook, or reconcile does not resolve (still open /
 * host error), the run stays parked (fail-safe: reconcile never guesses).
 * Reconcile errors are swallowed to a "parked" result — an unreachable host must
 * not fail a run that a human can still act on.
 */
export async function reconcileGate(runId: string, deps: ExecutorDeps): Promise<PipelineOutcome> {
  const rec = await deps.store.getRun(runId);
  if (!rec) return { status: "failed", error: `run ${runId} not found` };

  for (let i = 0; i < PIPELINE_STEPS.length; i++) {
    const step = PIPELINE_STEPS[i]!;
    const sr = await deps.store.getStepResult(runId, step);
    if (!sr || (sr.status !== "awaiting_approval" && sr.status !== "fix_review")) continue;

    const impl = registry(deps)[step];
    if (!impl || !impl.reconcileApprovalGate) return { status: "parked", parkedStep: step };

    const repoConfig = rec.repoConfig ?? emptyRepoConfig();
    const run = buildRunView(rec);
    const rounds = await deps.store.getStepRounds(runId, step);
    const shared = makeRunShared();
    // No IO sink here (L2, deliberately OUT of scope v1): the reconcile path is a
    // read-only bounded PR-state poll — it dispatches nothing and runs no trusted
    // shell command, so there is no per-round IO to capture. Omitting the sink
    // leaves `sctx.ioSink` undefined, so any incidental recorder call no-ops.
    const sctx = buildStepContext(deps, run, step, rounds, false, "", repoConfig, shared);
    let resolvedGate = false;
    try {
      resolvedGate = (await impl.reconcileApprovalGate(sctx)).resolved;
    } catch (err) {
      deps.log?.(runId, step, `reconcile check failed, leaving gate parked: ${err instanceof Error ? err.message : String(err)}`);
      return { status: "parked", parkedStep: step };
    }
    if (!resolvedGate) return { status: "parked", parkedStep: step };

    // External truth superseded the gate — account the parked time, complete the
    // step, and advance exactly as an approve would.
    if (rec.awaitingAgentSince) {
      const parked = Math.max(0, deps.now() - Date.parse(rec.awaitingAgentSince));
      await setRunStatus(deps, runId, { parkedMs: rec.parkedMs + parked, awaitingAgentSince: null });
    }
    await setRunStatus(deps, runId, { status: "running" });
    deps.log?.(runId, step, "reconcile resolved the gate (PR merged/closed); completing step");
    await completeStepStatus(deps, sr, "completed");
    return advance(deps, run, i + 1, repoConfig, shared);
  }
  return { status: "parked" };
}

export { ZERO_SHA };
