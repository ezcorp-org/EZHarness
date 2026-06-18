// ── Loop primitive — public type contract ───────────────────────────
//
// The `defineLoop({ trigger, contract, act, log })` primitive collapses
// the boilerplate every autonomous SDK loop hand-rolls (settings
// resolution, run-record + status state machine, idempotency, retention,
// failure policy, dashboard) onto ONE declarative call. These types are
// the DX contract; the pure state machine lives in `loop-core.ts` and the
// I/O-bearing facade in `loop.ts`.
//
// Design references:
//   - tasks/loop-sdk-primitive.md (canonical build spec)
//   - docs/plans/2026-06-18-loop-sdk-primitive-design.md
//
// LOCKED: run-state is SDK `Storage` (per-run keys + `withLock`), NOT a
// host table. The filesystem (`.ezcorp/extension-data/<loop>/`) is
// artifacts + config ONLY — never the source of truth.

import type { StorageScope } from "./storage";
import type { HubPageTree, PageActionEvent, PageBuilder } from "./page";
import type { Llm } from "./llm";
import type { SubscribableEvent } from "./host-event-types";
import type { spawnAssignment } from "./spawn";

// ── Trigger ──────────────────────────────────────────────────────────
//
// How a fire is induced. A loop may declare ONE trigger or an array; all
// are validated against the manifest at install time (crons must be in
// `permissions.schedule.crons`; events in `permissions.eventSubscriptions`).
// The primitive never widens the permission surface — undeclared
// crons/events are dropped by the host (existing Schedule/event behavior).

export type LoopTrigger =
  | { kind: "cron"; cron: string; timezone?: string }
  | {
      kind: "event";
      event: SubscribableEvent;
      /** Pre-gate replacing each loop's hand-rolled "is this the right
       *  agent/status?" check. A falsey return short-circuits to a `skip`
       *  outcome (logged, not an error). */
      filter?: (payload: unknown) => boolean;
    }
  | { kind: "manual"; tool?: string; pageAction?: string };

// ── Run state ────────────────────────────────────────────────────────
//
// The unit the dashboard shows + the substrate the deferred path drives.
// Stored one-per-key under `loop:<loopId>:run:<runId>` (see loop-store).

/** A single capped event-log entry on a run. */
export interface LoopRunEvent {
  /** ISO timestamp. */
  at: string;
  /** Raw status string from the inbound event / act result. */
  status: string;
  /** Optional human note (result preview, steer message, etc.). */
  note?: string;
}

export interface LoopRunState<Outcome = unknown> {
  /** Stable run id. For deferred loops this is the host `agentRunId`. */
  id: string;
  /** Owning loop id (namespaces the store keys). */
  loopId: string;
  /** Storage scope the run was claimed under. */
  scope: StorageScope;
  /** Idempotency key, when the contract supplies one. Duplicate keys on
   *  a still-open run are no-ops. */
  idempotencyKey?: string;
  /** Current status — one of `contract.states`. */
  status: string;
  /** The triggering input snapshot (event payload / tool args / cron tick). */
  input?: unknown;
  /** Terminal outcome, set once the run reaches a `contract.terminal` state. */
  outcome?: Outcome;
  /** Deferred-handoff correlation ids (set by deferred `act`). */
  externalRunId?: string;
  externalAssignmentId?: string;
  externalTaskId?: string;
  subConversationId?: string;
  /** Capped append-log (newest first), bounded by `retention.maxEventsPerRun`. */
  events: LoopRunEvent[];
  createdAt: string;
  updatedAt: string;
}

// ── Contract ─────────────────────────────────────────────────────────
//
// Declares the shape + rules of a run so the primitive owns the state
// machine the four loops each hand-roll. Configurable (not opinionated)
// about idempotency, retention, and error policy — supplies defaults +
// hooks, never a hard-coded strategy.

export type FailureClass = "transient" | "permanent";

export interface LoopFailurePolicy {
  /** Soft-classify a thrown error. `permanent` failures count toward
   *  auto-disable; `transient` ones are retried next fire. Default: all
   *  errors are `transient`. */
  classify?: (err: unknown) => FailureClass;
  /** Disable the loop after this many CONSECUTIVE permanent errors.
   *  Mirrors briefing's "disable @5". 0 / undefined = never auto-disable. */
  autoDisableAfter?: number;
  /** Called once when auto-disable trips (e.g. notify the operator). */
  onAutoDisable?: (ctx: LoopAutoDisableContext) => Promise<void> | void;
}

export interface LoopAutoDisableContext {
  loopId: string;
  /** Consecutive permanent-error count that crossed the threshold. */
  consecutiveErrors: number;
  /** The most recent error that tripped the threshold. */
  lastError: unknown;
}

export interface LoopRetention {
  /** Max run records kept; oldest TERMINAL runs trimmed beyond this.
   *  Default 100 (ez-code parity). */
  maxRuns?: number;
  /** Max event-log entries per run; oldest trimmed beyond this.
   *  Default 50 (ez-code parity). */
  maxEventsPerRun?: number;
}

export interface LoopConcurrency {
  maxConcurrent?: number;
  maxPerDay?: number;
}

export interface LoopContract<Input = unknown> {
  /** The run status vocabulary. Default `["done"]` (terminal loops). */
  states?: readonly string[];
  /** Subset of `states` considered "done". Default = all of `states`. */
  terminal?: readonly string[];
  /** Storage scope for run records. Default `"global"`. */
  scope?: StorageScope;
  /** Stable key for a unit of work; a duplicate on a still-open run is a
   *  no-op (replaces ez-code dedup, distiller slug-collision intent). */
  idempotencyKey?: (input: Input) => string | undefined;
  retention?: LoopRetention;
  failure?: LoopFailurePolicy;
  concurrency?: LoopConcurrency;
}

// ── act ──────────────────────────────────────────────────────────────

export type ActResult<Outcome = unknown> =
  | { kind: "terminal"; status: string; outcome: Outcome }
  | {
      kind: "deferred";
      runId: string;
      status: string;
      awaitEvent: "task:assignment_update";
      /** Handoff correlation ids persisted onto the open run so the
       *  inbound event can match it. */
      assignmentId?: string;
      taskId?: string;
      subConversationId?: string;
    }
  | { kind: "skip"; reason: string };

/** Resolved settings reader (replaces each loop's hand-rolled
 *  try/catch-to-`{}` fallback). */
export type LoopSettings = Record<string, unknown>;

/** A formatted, recent-message slice (replaces the verbatim-duplicated
 *  last-20 code). */
export interface LoopMessage {
  id: string;
  role: string;
  content: string;
}

export interface LoopActContext<Input = unknown> {
  /** Per-fire metadata. */
  fire: {
    id: string;
    firedAt: string;
    trigger: LoopTrigger;
    catchUp: boolean;
  };
  /** The triggering input (event payload | tool args | cron tick). */
  input: Input;
  /** Current open run record, when one exists (deferred re-entry). */
  state?: LoopRunState;
  /** Resolved user settings, with `{}` fallback already applied. */
  settings: LoopSettings;
  /** Shared `Llm` with centralized provider→default-model resolution. */
  llm: Llm;
  /** Fetch + slice + format recent messages (default last 20). */
  recentMessages: (
    conversationId: string,
    n?: number,
  ) => Promise<LoopMessage[]>;
  /** Format a message slice into the canonical `[id] role: content` text. */
  formatMessages: (messages: LoopMessage[]) => string;
  /** Deferred dispatch. */
  spawn: typeof spawnAssignment;
  /** Append a free-form note to the fire's audit log. */
  log: (msg: string, level?: "info" | "warn" | "error") => void;
}

export type LoopAct<Input = unknown, Outcome = unknown> = (
  ctx: LoopActContext<Input>,
) => Promise<ActResult<Outcome>>;

// ── log ──────────────────────────────────────────────────────────────

export interface LoopArtifact {
  /** Path RELATIVE to `.ezcorp/extension-data/<loop>/`. */
  path: string;
  body: string;
}

export interface LoopDashboard<Outcome = unknown> {
  /** Must match a `manifest.pages[].id`. */
  pageId: string;
  /** Build the page tree from the current run list. Generalizes
   *  ez-code's `buildDashboard`. */
  render: (runs: LoopRunState<Outcome>[]) => HubPageTree | PageBuilder;
  /** Row/button action handlers keyed by full namespaced event name. */
  rowActions?: Record<
    string,
    (event: PageActionEvent) => Promise<void> | void
  >;
}

export interface LoopLog<Outcome = unknown> {
  /** Map a terminal outcome to a human-readable artifact mirrored under
   *  `.ezcorp/extension-data/<loop>/` (NEVER the source of truth). Return
   *  `null` to write nothing. Fail-soft — a write error never fails the run. */
  artifact?: (
    run: LoopRunState<Outcome>,
    outcome: Outcome,
  ) => LoopArtifact | null;
  /** Optional Hub dashboard — opt-in, declarative. */
  dashboard?: LoopDashboard<Outcome>;
}

// ── defineLoop input ─────────────────────────────────────────────────

export interface LoopDefinition<Input = unknown, Outcome = unknown> {
  /** Unique per extension; namespaces the run store. */
  id: string;
  /** One trigger or many. */
  trigger: LoopTrigger | LoopTrigger[];
  contract?: LoopContract<Input>;
  act: LoopAct<Input, Outcome>;
  log?: LoopLog<Outcome>;
}

// ── Resolved contract (internal) ─────────────────────────────────────
//
// `loop-core` operates on a fully-defaulted contract so every branch is
// total. `resolveContract` (loop-core) fills the gaps once.

export interface ResolvedContract<Input = unknown> {
  states: readonly string[];
  terminal: readonly string[];
  scope: StorageScope;
  idempotencyKey?: (input: Input) => string | undefined;
  maxRuns: number;
  maxEventsPerRun: number;
  classify: (err: unknown) => FailureClass;
  autoDisableAfter: number;
  onAutoDisable?: (ctx: LoopAutoDisableContext) => Promise<void> | void;
}
