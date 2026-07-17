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
  | { kind: "manual"; tool?: string; pageAction?: string }
  /**
   * Fire off an inbound HTTP webhook (Loops EZ Mode Phase 4). The `slug`
   * MUST be declared in the manifest's `permissions.webhooks[]` — the host
   * validates it at install and drops undeclared slugs (mirrors cron/event;
   * never widens the grant). A leaked-token attacker controls the payload,
   * so a loop with ANY webhook trigger is PERMANENTLY `untrusted-input`
   * (`hasUntrustedInputTrigger`): Phase 8 never offers autopilot for it, and
   * the fire `input` arrives as a delimited {@link WebhookInput} wrapper the
   * check/act must treat as untrusted (never interpolate raw). */
  | { kind: "webhook"; slug: string };

// ── Webhook fire input — the delimited UNTRUSTED wrapper ─────────────
//
// A webhook body is attacker-controllable by definition (a leaked token
// lets anyone POST arbitrary bytes). The host hands the loop's `check`/`act`
// the payload ONLY inside this clearly-delimited, self-describing wrapper —
// never the raw string as a bare `input`. `untrusted: true` is a structural
// marker (always present, always true) so downstream code + the Phase-8
// content-trust gate can recognize webhook-originated input at a glance;
// `parsed` is populated only when `contentType` was JSON and the body parsed,
// otherwise the caller works from the size-capped raw `body` text. Nothing
// here is ever interpolated into a prompt/command by the primitive — the loop
// author decides how to consume it (delimited data block + injection preamble
// is the documented posture; see docs/extensions/loops.md § Webhook triggers).

export interface WebhookInput {
  /** Discriminant so a multi-trigger loop can branch on the fire source. */
  kind: "webhook";
  /** The manifest-declared slug this delivery targeted. */
  slug: string;
  /** Structural untrusted marker — ALWAYS `true`. Present so check/act (and
   *  Phase 8's gate) can recognize attacker-controllable input structurally,
   *  not by convention. */
  untrusted: true;
  /** The inbound `Content-Type` header (lowercased), or `null` when absent. */
  contentType: string | null;
  /** The size-capped raw request body as UTF-8 text (never re-serialized —
   *  the exact bytes the sender posted, so an HMAC over it stays valid). */
  body: string;
  /** The parsed JSON body, present ONLY when `contentType` was JSON-ish AND
   *  `body` parsed cleanly. Untrusted data — treat as hostile. `undefined`
   *  for non-JSON or unparseable bodies (work from `body`). */
  parsed?: unknown;
  /** Host-issued delivery id (the `webhook_deliveries` row) — a stable
   *  idempotency handle for the fire. */
  deliveryId: string;
  /** ISO timestamp the host accepted the delivery. */
  receivedAt: string;
}

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
  /** The proposal snapshot, set when the run parks in `awaiting_approval`.
   *  Plain data (the `finalize`/`discard` closures live in an in-memory
   *  registry, never here). Doubles as the label's `proposalSnapshot`. */
  proposal?: LoopProposal;
  /** Set when a run in `finalizing` can no longer be resolved automatically
   *  (crash re-entry or a lost closure after a restart) — the human must
   *  verify the side effect manually. Never re-invokes `finalize`. */
  verifyManually?: boolean;
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

// ── Approval (Phase 2 — proactive only) ──────────────────────────────
//
// Loop-level governance of what a run may DO with its output. When
// `contract.approval` is present, an `act` (or deferred completion) that
// returns a `proposal` ActResult parks the run in the primitive-owned,
// non-terminal `awaiting_approval` state instead of finalizing; a human
// approve/decline resolves it. The primitive OWNS the approve/decline
// transitions AND the `awaiting_approval`/`finalizing`/`approved`/`declined`
// states (see loop-core `APPROVAL_STATES`) — extensions only supply the
// `finalize`/`discard` closures, so governance can't be forgotten or faked
// per-loop.
//
// Phase 2 ships ONLY `mode: "proactive"`. `"plan"` (Phase 7) and
// `"autopilot"` (Phase 8) are deliberately NOT part of this union yet.

export type ApprovalMode = "proactive";

export interface LoopApproval {
  /** Only `"proactive"` in Phase 2. Defaults to `"proactive"` when the
   *  `approval` block is present (see `resolveContract`). */
  mode?: ApprovalMode;
  /** Auto-decline a parked proposal older than this many days (the parked
   *  proposals "rot" mitigation). The staleness sweep runs `discard` and
   *  writes a `declined` label with `decidedBy: "system"`. Defaults to
   *  `DEFAULT_STALE_AFTER_DAYS` (7) when UNDEFINED — the sweep is ON by
   *  default; set `0` to DISABLE the sweep (never auto-decline). */
  staleAfterDays?: number;
}

export interface LoopContract<Input = unknown> {
  /** The run status vocabulary. Default `["done"]` (terminal loops).
   *  When `approval` is present the primitive auto-injects its owned
   *  states (`awaiting_approval`, `finalizing`, `approved`, `declined`). */
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
  /** Proactive-approval governance (Phase 2). Presence gates the
   *  `proposal` ActResult + the primitive's owned approval states. */
  approval?: LoopApproval;
  /** Opaque config version stamped onto every approval label so the
   *  Phase-9 evolve loop can attribute a decision to the config that
   *  produced it. Defaults to `"0"`. Bump when the loop's prompt/config
   *  changes so the held-out eval signal stays attributable. */
  configVersion?: string;
}

// ── check ──────────────────────────────────────────────────────────
//
// The deterministic pre-act gate: "does the AI process even need to run?"
// A `check` runs AFTER the idempotency/dup gate and BEFORE `act`, deciding
// `proceed` (optionally enriching the input `act` sees) or `skip` (a
// first-class decline with a reason, logged, never an error). Omitting
// `check` is `proceed: true` — zero migration for existing loops.
//
// DETERMINISM BY CONSTRUCTION: `LoopCheckContext` deliberately has NO
// `llm`, NO `spawn`, NO `recentMessages`. The check stage *cannot* invoke a
// model or dispatch an agent — the type system is the firewall, not a
// convention. Structured endpoints (JSON APIs, git) are parseable here;
// messy-HTML sources are NOT (that parsing belongs in `act`, and such loops
// are `untrusted-input`). Document the limit; never soften the firewall.

export type CheckResult<Input = unknown> =
  /** Run `act`. `input`, when present, REPLACES what `act` sees (the
   *  deterministic enrichment — e.g. the git head a git-cursor check
   *  resolved). Omit it to pass the trigger input through unchanged. */
  | { proceed: true; input?: Input }
  /** Decline this fire. Logged as a `skip` with `reason` in the fire
   *  audit log — NOT an error, NOT counted toward auto-disable. */
  | { proceed: false; reason: string };

export interface LoopCheckContext<Input = unknown> {
  /** The triggering input (event payload | tool args | cron tick). */
  input: Input;
  /** Resolved user settings, with a `{}` fallback already applied. */
  settings: LoopSettings;
  /** Per-fire metadata (same shape as `LoopActContext.fire`). */
  fire: {
    id: string;
    firedAt: string;
    trigger: LoopTrigger;
    catchUp: boolean;
  };
  /** Durable per-loop cursor, persisted at `loop:<id>:cursor` (Storage,
   *  same scope as the contract, writes under `withLock`). The
   *  deterministic "how far have I processed?" marker a git-cursor /
   *  threshold check reads + advances. `get` resolves `undefined` when
   *  unset. */
  cursor: {
    get<T = unknown>(): Promise<T | undefined>;
    set<T = unknown>(value: T): Promise<void>;
  };
  /** Host-mediated `fetch` — the sandbox-preload gates it against the
   *  loop's network grant. The ONLY external-data surface the check has;
   *  there is deliberately no `llm` to parse the response. */
  fetch: typeof fetch;
  /** Append a free-form note to the fire's audit log. */
  log: (msg: string, level?: "info" | "warn" | "error") => void;
}

export type LoopCheck<Input = unknown> = (
  ctx: LoopCheckContext<Input>,
) => Promise<CheckResult<Input>>;

// ── Compile-time firewall (CI-enforced) ─────────────────────────────
//
// Determinism-by-construction is only a firewall if something FAILS THE
// BUILD when it's breached. `LoopCheckContext` must NEVER expose `llm`,
// `spawn`, or `recentMessages` — the check stage structurally cannot invoke
// a model or dispatch an agent. The runtime FIREWALL test asserts the shape,
// and a type-level `Absent<…>` assertion lived in loop.test.ts — but
// `tsconfig.typecheck.json` excludes `**/*.test.ts`, so CI `tsc` never
// compiled it (the guard was inert on the merge path).
//
// This assertion lives in `src/**`, which `tsconfig.typecheck.json` DOES
// compile, so CI `tsc` is the enforcement point: if any forbidden key leaks
// into `LoopCheckContext`, `_Absent<K>` resolves to `false`, the
// `_ExpectTrue<…>` constraint is violated, and the build fails with TS2344.
// Pure types — zero runtime cost, and exported so no lint/dead-code pass can
// elide it. (Not re-exported from the runtime barrel; internal to the SDK.)
type _ExpectTrue<T extends true> = T;
type _Absent<K extends string> = K extends keyof LoopCheckContext ? false : true;
export type _LoopCheckFirewall = [
  _ExpectTrue<_Absent<"llm">>,
  _ExpectTrue<_Absent<"spawn">>,
  _ExpectTrue<_Absent<"recentMessages">>,
];

// ── act ──────────────────────────────────────────────────────────────

/** The gated-output descriptor a `proposal` ActResult carries. Persisted
 *  verbatim onto the parked run (`LoopRunState.proposal`) as the
 *  `proposalSnapshot` an approval label captures — so it must be plain,
 *  JSON-serializable data (NO closures). */
export interface LoopProposal {
  title: string;
  summary: string;
  /** What the finalize consequence is: open/mark a PR, write an artifact,
   *  or take a one-shot action. Drives Phase-3 finalize semantics (a `pr`
   *  finalize MUST re-validate mergeability against current base). */
  kind: "pr" | "artifact" | "action";
  /** PR url, file path, action id, … — the thing `finalize` acts on. */
  ref?: string;
}

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
  /**
   * Gated output (Phase 2). Parks the run in the primitive-owned
   * `awaiting_approval` state; a human approve invokes `finalize`
   * (exactly once), decline invokes `discard`. Requires
   * `contract.approval` — a proposal without it is a misconfiguration
   * (classified like a thrown act). `finalize`/`discard` are held in an
   * in-memory registry keyed by run id — they do NOT survive a process
   * restart (a restart strands the run for the staleness sweep / a
   * "verify manually" surface, never a silent double-act).
   */
  | {
      kind: "proposal";
      /** Free-form label recorded on the parked run's event log (e.g.
       *  `"pr_drafted"`). The RUN's top-level status is forced to the
       *  primitive's `awaiting_approval` regardless. */
      status: string;
      proposal: LoopProposal;
      /** Approve → run this ONCE. Its resolved value becomes the run's
       *  terminal outcome. */
      finalize: () => Promise<Outcome>;
      /** Decline (or staleness auto-decline) → best-effort cleanup. */
      discard?: () => Promise<void>;
    }
  | { kind: "skip"; reason: string };

// ── Approval labels — the LOCKED eval signal ─────────────────────────
//
// Every approve/decline resolution appends one immutable label to the
// per-loop, append-only label store (`loop:<id>:labels`). This history IS
// the held-out signal Phase 9's evolve loop optimizes against and Phase
// 8's trust graduation reads — so it is written ONLY by the primitive's
// approval-resolution path, NEVER exposed through any tool granted to a
// spawned agent, and never retention-evicted. The `loops:approval_resolved`
// host event + audit stream is its tamper-evident mirror.

export type ApprovalDecision = "approved" | "declined";

export interface LoopApprovalLabel {
  loopId: string;
  runId: string;
  /** The parked proposal, snapshotted at decision time. */
  proposalSnapshot: LoopProposal;
  decision: ApprovalDecision;
  /** Resolver identity: a user id for a human decision, or `"system"` for
   *  a staleness auto-decline. */
  decidedBy: string;
  /** ISO timestamp of the decision. */
  decidedAt: string;
  /** Optional free-text note (decline reason, staleness marker, …). */
  note?: string;
  /** `contract.configVersion` at decision time — attributes the decision
   *  to the config that produced the proposal. */
  loopConfigVersion: string;
}

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

// ── onComplete (deferred → proposal composition) ─────────────────────
//
// A deferred loop's `act` returns `{ kind: "deferred" }` and the run stays
// open until an inbound `task:assignment_update` reaches a terminal host
// status. When that happens, the primitive normally terminalizes the run.
// A loop that wants the spawned agent's completion to become a *proposal*
// (park for approval, e.g. docs-updater's drafted PR) supplies `onComplete`:
// it runs at the deferred-completion boundary and may return a `proposal`
// (park) or a `terminal` result. Omitted = the run terminalizes as before
// (zero migration for existing deferred loops).

export interface LoopCompleteContext<Outcome = unknown> {
  /** The completed run record (its `outcome` is not yet set; the original
   *  trigger input is on `run.input`). */
  run: LoopRunState<Outcome>;
  /** The mapped terminal status the assignment resolved to. */
  status: string;
  /** The inbound assignment payload's result preview, when present. */
  resultPreview?: string;
  /** Resolved user settings, `{}` fallback applied. */
  settings: LoopSettings;
  /** Append a note to the run's audit log. */
  log: (msg: string, level?: "info" | "warn" | "error") => void;
}

export type LoopOnComplete<Outcome = unknown> = (
  ctx: LoopCompleteContext<Outcome>,
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
  /**
   * Explicitly classify this loop `untrusted-input` because its `check`/`act`
   * ingests attacker-controllable EXTERNAL content that NO trigger-level rule
   * catches — a settings-configured `ctx.fetch` in `check`, or an LLM parse of
   * fetched text in `act` (seo-watcher's shape). A webhook trigger already
   * makes a loop untrusted-input via {@link LoopTrigger}; this covers the
   * fetch-based loops that have no such trigger. It is ORed with the
   * trigger-derived classification (`hasUntrustedInputTrigger`) — it can only
   * ADD the marker, never clear a webhook trigger's — so Phase 8's content-trust
   * gate (autopilot NEVER offerable on an untrusted-input loop) reads the
   * combined result. Omitted = trigger-derived classification only. */
  contentTrust?: "untrusted-input";
  contract?: LoopContract<Input>;
  /** Optional deterministic pre-act gate (trigger → dup gate → `check` →
   *  `act`). Omitted = `proceed: true` (zero migration). See
   *  `LoopCheckContext` — it structurally cannot invoke a model. */
  check?: LoopCheck<Input>;
  act: LoopAct<Input, Outcome>;
  /** Optional deferred-completion hook (Phase 2). Turns a spawned agent's
   *  completion into a `proposal` (park for approval) or a `terminal`
   *  result. Omitted = terminalize as before. */
  onComplete?: LoopOnComplete<Outcome>;
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
  /** Resolved proactive-approval governance, present iff the loop declared
   *  `contract.approval`. When set, the primitive's owned approval states
   *  are guaranteed present in `states`/`terminal`. */
  approval?: { mode: ApprovalMode; staleAfterDays: number };
  /** Config version stamped on every approval label. Default `"0"`. */
  configVersion: string;
}
