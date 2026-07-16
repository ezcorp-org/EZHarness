// ── Loop primitive — pure state machine ─────────────────────────────
//
// Zero I/O. Every function here is a pure transform on plain data, so the
// whole run lifecycle is 100%-unit-testable without a channel, DB, or
// clock dependency (time is always injected). The I/O-bearing facade
// (`loop.ts`) composes these with `Storage` + `withLock` + the triggers.
//
// Generalized from ez-code's exported pure helpers (`appendRun`,
// `applyAssignmentUpdate`, `recordRunEvent`, `isLive`, `mapStatus`) so the
// dispatch loop maps 1:1 and the capture loops collapse onto the same
// transitions.

import type {
  ActResult,
  CheckResult,
  FailureClass,
  LoopAutoDisableContext,
  LoopContract,
  LoopRunEvent,
  LoopRunState,
  ResolvedContract,
} from "./loop-types";

// ── Defaults ─────────────────────────────────────────────────────────

/** Default run-status vocabulary for terminal (capture) loops. */
export const DEFAULT_STATES = ["done"] as const;
export const DEFAULT_MAX_RUNS = 100;
export const DEFAULT_MAX_EVENTS_PER_RUN = 50;

/** Fill every contract gap so downstream branches are total. Pure. */
export function resolveContract<Input>(
  contract: LoopContract<Input> = {},
): ResolvedContract<Input> {
  const states =
    contract.states && contract.states.length > 0
      ? contract.states
      : DEFAULT_STATES;
  // Default: every declared state is terminal (capture loops resolve in
  // one transition). Deferred loops declare a narrower `terminal` subset.
  const terminal =
    contract.terminal && contract.terminal.length > 0
      ? contract.terminal
      : states;
  return {
    states,
    terminal,
    scope: contract.scope ?? "global",
    ...(contract.idempotencyKey
      ? { idempotencyKey: contract.idempotencyKey }
      : {}),
    maxRuns: contract.retention?.maxRuns ?? DEFAULT_MAX_RUNS,
    maxEventsPerRun:
      contract.retention?.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN,
    classify: contract.failure?.classify ?? (() => "transient"),
    autoDisableAfter: contract.failure?.autoDisableAfter ?? 0,
    ...(contract.failure?.onAutoDisable
      ? { onAutoDisable: contract.failure.onAutoDisable }
      : {}),
  };
}

// ── Status predicates ────────────────────────────────────────────────

/** Whether `status` is a terminal state under the resolved contract. Pure. */
export function isTerminal(
  status: string,
  contract: ResolvedContract,
): boolean {
  return contract.terminal.includes(status);
}

/** A run is live (steerable/cancellable, open for deferred re-entry) iff
 *  its status is NOT terminal. Pure. */
export function isLive(
  run: Pick<LoopRunState, "status">,
  contract: ResolvedContract,
): boolean {
  return !isTerminal(run.status, contract);
}

// ── Event-log capping ────────────────────────────────────────────────

/** Prepend the newest event and cap to `maxEventsPerRun`. Pure — returns
 *  a NEW array (newest first). */
export function appendEvent(
  events: LoopRunEvent[],
  evt: LoopRunEvent,
  maxEventsPerRun: number,
): LoopRunEvent[] {
  return [evt, ...events].slice(0, Math.max(0, maxEventsPerRun));
}

// ── Run creation ─────────────────────────────────────────────────────

export interface NewRunInput<Outcome = unknown> {
  id: string;
  loopId: string;
  status: string;
  input?: unknown;
  /** Terminal outcome set atomically when a capture loop resolves in one
   *  fire (avoids a redundant claim→transition double-write). */
  outcome?: Outcome;
  idempotencyKey?: string;
  externalRunId?: string;
  externalAssignmentId?: string;
  externalTaskId?: string;
  subConversationId?: string;
  /** Initial note for the first event-log entry. */
  note?: string;
}

/** Build a fresh run record with one initial event. Pure (clock injected). */
export function createRun<Outcome = unknown>(
  input: NewRunInput<Outcome>,
  contract: ResolvedContract,
  now: string,
): LoopRunState<Outcome> {
  const firstEvent: LoopRunEvent = {
    at: now,
    status: input.status,
    ...(input.note ? { note: input.note } : {}),
  };
  return {
    id: input.id,
    loopId: input.loopId,
    scope: contract.scope,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    status: input.status,
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    ...(input.externalRunId ? { externalRunId: input.externalRunId } : {}),
    ...(input.externalAssignmentId
      ? { externalAssignmentId: input.externalAssignmentId }
      : {}),
    ...(input.externalTaskId ? { externalTaskId: input.externalTaskId } : {}),
    ...(input.subConversationId
      ? { subConversationId: input.subConversationId }
      : {}),
    events: appendEvent([], firstEvent, contract.maxEventsPerRun),
    createdAt: now,
    updatedAt: now,
  };
}

// ── Transition ───────────────────────────────────────────────────────

/** Apply a status transition + capped event-log entry to a run. Pure —
 *  returns a NEW run. An unknown `status` (not in `contract.states`) is
 *  rejected by `transition`'s caller; this low-level helper trusts it. */
export function transition<Outcome = unknown>(
  run: LoopRunState<Outcome>,
  next: {
    status: string;
    /** Status recorded on the appended EVENT-LOG entry. Defaults to
     *  `status`. Lets a caller record a raw host event (e.g. "steered")
     *  while the run's top-level status stays unchanged or maps to a
     *  different contract state. */
    eventStatus?: string;
    note?: string;
    outcome?: Outcome;
    externalRunId?: string;
    externalAssignmentId?: string;
    externalTaskId?: string;
    subConversationId?: string;
  },
  contract: ResolvedContract,
  now: string,
): LoopRunState<Outcome> {
  const evt: LoopRunEvent = {
    at: now,
    status: next.eventStatus ?? next.status,
    ...(next.note ? { note: next.note } : {}),
  };
  return {
    ...run,
    status: next.status,
    ...(next.outcome !== undefined ? { outcome: next.outcome } : {}),
    ...(next.externalRunId ? { externalRunId: next.externalRunId } : {}),
    ...(next.externalAssignmentId
      ? { externalAssignmentId: next.externalAssignmentId }
      : {}),
    ...(next.externalTaskId ? { externalTaskId: next.externalTaskId } : {}),
    ...(next.subConversationId
      ? { subConversationId: next.subConversationId }
      : {}),
    updatedAt: now,
    events: appendEvent(run.events, evt, contract.maxEventsPerRun),
  };
}

/** Whether a status is a member of the contract's declared vocabulary.
 *  Pure. */
export function isKnownState(
  status: string,
  contract: ResolvedContract,
): boolean {
  return contract.states.includes(status);
}

// ── Idempotency ──────────────────────────────────────────────────────

/**
 * Decide whether a new fire keyed `idempotencyKey` is a duplicate of an
 * already-OPEN (non-terminal) run. A duplicate on a still-open run is a
 * no-op (safe under cron catch-up + double-delivered events). A key that
 * only matches TERMINAL runs is NOT a dupe — the work finished and may run
 * again (e.g. a fresh slug after the old one was deleted). Pure.
 */
export function findOpenDuplicate<Outcome = unknown>(
  runs: LoopRunState<Outcome>[],
  idempotencyKey: string | undefined,
  contract: ResolvedContract,
): LoopRunState<Outcome> | undefined {
  if (!idempotencyKey) return undefined;
  return runs.find(
    (r) =>
      r.idempotencyKey === idempotencyKey && isLive(r, contract),
  );
}

// ── Retention ────────────────────────────────────────────────────────

/**
 * Trim the run list to `maxRuns`, evicting OLDEST TERMINAL runs first so
 * an open (in-flight) run is never dropped out from under the loop. Pure —
 * returns a NEW array preserving the input order of survivors.
 *
 * Strategy: if over budget, drop the oldest terminal runs (by `createdAt`)
 * until within budget. If still over budget after evicting every terminal
 * run (i.e. more open runs than `maxRuns`), keep all open runs — never
 * discard live state. Order of survivors matches the input.
 */
export function trimRetention<Outcome = unknown>(
  runs: LoopRunState<Outcome>[],
  contract: ResolvedContract,
): LoopRunState<Outcome>[] {
  const maxRuns = contract.maxRuns;
  if (runs.length <= maxRuns) return runs.slice();

  const overBy = runs.length - maxRuns;
  // Oldest terminal runs are the eviction candidates. Order by `createdAt`
  // ascending, breaking ties by ORIGINAL array position: callers pass runs
  // newest-first, so a LATER index means an OLDER run when timestamps tie
  // (claims in the same millisecond). Without the positional tiebreaker the
  // sort is unstable and could evict the newest run under tied timestamps.
  const terminalIdsOldestFirst = runs
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => isTerminal(r.status, contract))
    .slice()
    .sort((a, b) => {
      const byTime = a.r.createdAt.localeCompare(b.r.createdAt);
      return byTime !== 0 ? byTime : b.i - a.i;
    })
    .slice(0, overBy)
    .map(({ r }) => r.id);

  const evict = new Set(terminalIdsOldestFirst);
  return runs.filter((r) => !evict.has(r.id));
}

// ── Failure / auto-disable ───────────────────────────────────────────

export interface FailureDecision {
  class: FailureClass;
  /** Running count of consecutive PERMANENT errors AFTER this failure. */
  consecutiveErrors: number;
  /** True iff this failure crossed the `autoDisableAfter` threshold. */
  shouldDisable: boolean;
}

/**
 * Classify a thrown error and decide whether it crosses the auto-disable
 * threshold. `priorConsecutive` is the consecutive-permanent-error count
 * BEFORE this failure (0 after any success / transient error). Pure.
 *
 * - A `transient` failure resets the consecutive count to 0 and never
 *   disables (worth a retry next fire).
 * - A `permanent` failure increments the count; it disables exactly when
 *   the new count reaches `autoDisableAfter` (and the threshold is > 0).
 */
export function classifyFailure(
  err: unknown,
  priorConsecutive: number,
  contract: ResolvedContract,
): FailureDecision {
  const cls = contract.classify(err);
  if (cls === "transient") {
    return { class: "transient", consecutiveErrors: 0, shouldDisable: false };
  }
  const consecutiveErrors = priorConsecutive + 1;
  const shouldDisable =
    contract.autoDisableAfter > 0 &&
    consecutiveErrors >= contract.autoDisableAfter;
  return { class: "permanent", consecutiveErrors, shouldDisable };
}

/** Build the context handed to `onAutoDisable`. Pure. */
export function autoDisableContext(
  loopId: string,
  decision: FailureDecision,
  lastError: unknown,
): LoopAutoDisableContext {
  return {
    loopId,
    consecutiveErrors: decision.consecutiveErrors,
    lastError,
  };
}

// ── act-result validation ────────────────────────────────────────────

/**
 * Validate an `act` result's status against the contract vocabulary.
 * Returns an error string when a terminal/deferred result names an
 * unknown state, else null. `skip` carries no status, so it always passes.
 * Pure.
 */
export function validateActResult(
  result: ActResult,
  contract: ResolvedContract,
): string | null {
  if (result.kind === "skip") return null;
  if (!isKnownState(result.status, contract)) {
    return `loop act returned unknown status "${result.status}" — declare it in contract.states (${contract.states.join(", ")})`;
  }
  return null;
}

// ── check-result validation ──────────────────────────────────────────

/**
 * Validate a `check` result before the fire pipeline acts on it. A
 * `proceed: false` MUST carry a non-empty `reason` string (it becomes the
 * `skip`'s audit reason); a malformed decline is treated as a check error
 * (classified by `contract.failure`, like a thrown check) rather than a
 * silent no-reason skip. `proceed: true` always passes. Returns an error
 * string or null. Pure.
 */
export function validateCheckResult(result: CheckResult): string | null {
  if (result.proceed === false) {
    if (typeof result.reason !== "string" || result.reason.length === 0) {
      return "loop check returned proceed:false without a non-empty reason string";
    }
  }
  return null;
}
