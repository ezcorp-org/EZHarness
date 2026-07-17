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
  ApprovalMode,
  CheckResult,
  FailureClass,
  LoopAutoDisableContext,
  LoopContract,
  LoopProposal,
  LoopRunEvent,
  LoopRunState,
  ResolvedContract,
} from "./loop-types";

// ── Defaults ─────────────────────────────────────────────────────────

/** Default run-status vocabulary for terminal (capture) loops. */
export const DEFAULT_STATES = ["done"] as const;
export const DEFAULT_MAX_RUNS = 100;
export const DEFAULT_MAX_EVENTS_PER_RUN = 50;

// ── Approval states (primitive-owned) ────────────────────────────────
//
// When `contract.approval` is present the primitive owns these states —
// they are auto-injected into the resolved contract so an extension never
// declares (or can forget) them. `awaiting_approval` + `finalizing` are
// NON-terminal (parked, never retention-evicted); `approved` + `declined`
// are terminal.

/** A parked run awaiting a human approve/decline. Non-terminal. */
export const AWAITING_APPROVAL = "awaiting_approval";
/** Finalize-intent recorded; `finalize` is (or was) running. Non-terminal.
 *  A re-entry that finds this state must NOT re-invoke finalize. */
export const FINALIZING = "finalizing";
/** Approve resolved + finalize completed. Terminal. */
export const APPROVED = "approved";
/** Decline (human or staleness) resolved. Terminal. */
export const DECLINED = "declined";

/** The four primitive-owned approval states + their terminal subset.
 *  Kept on one line each: a multi-line array literal makes Bun emit a
 *  phantom uncovered DA record per element line in every shard that
 *  loads (but doesn't exercise) this module, and merge-lcov doesn't union
 *  those away — so the merged coverage gate flagged 53-56 as missed. */
export const APPROVAL_STATES = [AWAITING_APPROVAL, FINALIZING, APPROVED, DECLINED] as const;
export const APPROVAL_TERMINAL_STATES = [APPROVED, DECLINED] as const;

/** Default staleness horizon: a parked proposal older than this many days
 *  auto-declines. 0 disables the sweep. */
export const DEFAULT_STALE_AFTER_DAYS = 7;

/** Fill every contract gap so downstream branches are total. Pure. */
export function resolveContract<Input>(
  contract: LoopContract<Input> = {},
): ResolvedContract<Input> {
  const declaredStates =
    contract.states && contract.states.length > 0
      ? contract.states
      : DEFAULT_STATES;
  // Default: every declared state is terminal (capture loops resolve in
  // one transition). Deferred loops declare a narrower `terminal` subset.
  const declaredTerminal =
    contract.terminal && contract.terminal.length > 0
      ? contract.terminal
      : declaredStates;

  // Approval: inject the primitive-owned states so `transition` accepts
  // them without the extension re-declaring the governance vocabulary.
  const hasApproval = contract.approval !== undefined;
  // Reject an unknown approval mode LOUDLY at construction. Phase 2 ships ONLY
  // `"proactive"`; `"plan"` (Phase 7) and `"autopilot"` (Phase 8) are not in
  // the union yet. A loop that declares an unsupported mode is a
  // misconfiguration that MUST fail install rather than silently degrade to
  // proactive — this guards the Phase 7/8 graduation surface.
  if (hasApproval) {
    const mode = contract.approval!.mode ?? "proactive";
    if (mode !== "proactive") {
      throw new Error(
        `[@ezcorp/sdk] defineLoop: contract.approval.mode "${mode}" is not supported — only "proactive" is available in this phase`,
      );
    }
  }
  const states = hasApproval
    ? dedupe([...declaredStates, ...APPROVAL_STATES])
    : declaredStates;
  const terminal = hasApproval
    ? dedupe([...declaredTerminal, ...APPROVAL_TERMINAL_STATES])
    : declaredTerminal;

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
    ...(hasApproval
      ? {
          approval: {
            mode: (contract.approval!.mode ?? "proactive") as ApprovalMode,
            staleAfterDays:
              contract.approval!.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS,
          },
        }
      : {}),
    configVersion: contract.configVersion ?? "0",
  };
}

/** De-dupe a string list preserving first-seen order. Pure. */
function dedupe(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
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

// ── Parked-run predicates (approval) ─────────────────────────────────

/** A run is PARKED iff it awaits a human approve/decline (`awaiting_approval`)
 *  or is mid-finalize (`finalizing`). Parked runs are non-terminal, so they
 *  are never retention-evicted (trimRetention evicts only terminal runs) and
 *  — per the spec — are EXCLUDED from the active-run count that a
 *  `maxConcurrent` cap would gate. Pure. */
export function isParked(run: Pick<LoopRunState, "status">): boolean {
  return run.status === AWAITING_APPROVAL || run.status === FINALIZING;
}

/**
 * Count runs that are ACTIVE for concurrency purposes: live (non-terminal)
 * AND not parked. A parked run holds no compute — it is waiting on a human —
 * so it must not count against `maxConcurrent`. Pure. (The maxConcurrent
 * *enforcement* lands with the trigger that needs it; this is the invariant
 * it must honor, kept testable from day one.)
 */
export function countActiveRuns<Outcome = unknown>(
  runs: LoopRunState<Outcome>[],
  contract: ResolvedContract,
): number {
  return runs.filter((r) => isLive(r, contract) && !isParked(r)).length;
}

// ── Staleness ────────────────────────────────────────────────────────

/**
 * Whether a parked proposal has rotted past the staleness horizon. Only
 * `awaiting_approval` runs are candidates (a `finalizing` run already has a
 * human decision behind it). `staleAfterDays <= 0` disables the sweep. The
 * clock is injected (`nowMs`) so this is pure + deterministic.
 */
export function isProposalStale(
  run: Pick<LoopRunState, "status" | "createdAt">,
  staleAfterDays: number,
  nowMs: number,
): boolean {
  if (staleAfterDays <= 0) return false;
  if (run.status !== AWAITING_APPROVAL) return false;
  const created = Date.parse(run.createdAt);
  if (Number.isNaN(created)) return false;
  const ageMs = nowMs - created;
  return ageMs >= staleAfterDays * 24 * 60 * 60 * 1000;
}

// ── Proposal validation ──────────────────────────────────────────────

/**
 * Validate a `proposal` ActResult's descriptor at runtime (the type is
 * advisory — `act` is JS). Returns an error string or null. Pure.
 */
export function validateProposal(proposal: unknown): string | null {
  if (typeof proposal !== "object" || proposal === null) {
    return "loop proposal must be an object ({ title, summary, kind })";
  }
  const p = proposal as Partial<LoopProposal>;
  if (typeof p.title !== "string" || p.title.length === 0) {
    return "loop proposal.title must be a non-empty string";
  }
  if (typeof p.summary !== "string") {
    return "loop proposal.summary must be a string";
  }
  if (p.kind !== "pr" && p.kind !== "artifact" && p.kind !== "action") {
    return 'loop proposal.kind must be one of "pr" | "artifact" | "action"';
  }
  if (p.ref !== undefined && typeof p.ref !== "string") {
    return "loop proposal.ref must be a string when present";
  }
  return null;
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
  /** Proposal snapshot set when a run is claimed already parked in
   *  `awaiting_approval`. */
  proposal?: LoopProposal;
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
    ...(input.proposal !== undefined ? { proposal: input.proposal } : {}),
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
    /** Set/replace the proposal snapshot (deferred completion → park). */
    proposal?: LoopProposal;
    /** Flag the run for manual verification (crash/restart re-entry on a
     *  `finalizing` run — never re-invoke finalize). */
    verifyManually?: boolean;
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
    ...(next.proposal !== undefined ? { proposal: next.proposal } : {}),
    ...(next.verifyManually !== undefined
      ? { verifyManually: next.verifyManually }
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
 *
 * `proposal` is governed by the primitive, not the contract vocabulary:
 * its `status` is a free-form event label (the run parks at the
 * primitive-owned `awaiting_approval`), so it is NOT checked against
 * `contract.states`. It IS rejected when the loop never declared
 * `contract.approval` (a proposal with no governance is a misconfiguration)
 * or when the proposal descriptor is malformed. Pure.
 */
export function validateActResult(
  result: ActResult,
  contract: ResolvedContract,
): string | null {
  if (result.kind === "skip") return null;
  if (result.kind === "proposal") {
    if (!contract.approval) {
      return "loop act returned a proposal but contract.approval is not declared — add `approval: { mode: \"proactive\" }`";
    }
    if (typeof result.finalize !== "function") {
      return "loop proposal must supply a finalize() function";
    }
    return validateProposal(result.proposal);
  }
  if (!isKnownState(result.status, contract)) {
    return `loop act returned unknown status "${result.status}" — declare it in contract.states (${contract.states.join(", ")})`;
  }
  return null;
}

// ── check-result validation ──────────────────────────────────────────

/**
 * Validate a `check` result before the fire pipeline acts on it. A misbehaving
 * check (this is JS at runtime — the `CheckResult` type is advisory) may hand
 * back anything, so guard the whole shape, not just the reason:
 *   - the result must be a non-null object,
 *   - `proceed` must be a boolean (a truthy non-boolean must NOT silently act),
 *   - a `proceed: false` MUST carry a non-empty `reason` string (it becomes the
 *     `skip`'s audit reason).
 * Any violation is treated as a check error (classified by `contract.failure`,
 * like a thrown check) rather than a silent, mis-branched fire. `proceed: true`
 * otherwise passes. Returns an error string or null. Pure.
 */
export function validateCheckResult(result: CheckResult): string | null {
  // `result` is typed `CheckResult`, but a runtime check can return junk;
  // widen to `unknown` so the guards below aren't narrowed away as dead.
  const r = result as unknown;
  if (typeof r !== "object" || r === null) {
    return "loop check must return an object ({ proceed: boolean, … })";
  }
  const proceed = (r as { proceed?: unknown }).proceed;
  if (typeof proceed !== "boolean") {
    return "loop check result.proceed must be a boolean (true | false)";
  }
  if (proceed === false) {
    const reason = (r as { reason?: unknown }).reason;
    if (typeof reason !== "string" || reason.length === 0) {
      return "loop check returned proceed:false without a non-empty reason string";
    }
  }
  return null;
}
