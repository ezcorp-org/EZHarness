// ── Triggers — the unattended fire path's PURE half ──────────────────
//
// `permissions.triggers` has been declared since 8.1 and called from
// nowhere. This module is what binds it to the job lifecycle: which host
// row a saved job wants, which rows a save must retire, which job a fire
// belongs to, and how to describe a refusal to the person who has to fix
// it.
//
// Everything here is a pure function over data. The RPCs live in
// `index.ts`, where the channel is; the rules live here, where they are
// covered.
//
// ── THE ONE ORDERING RULE THIS WHOLE FEATURE HANGS ON ────────────────
//
// **`ctx.triggers.register` is OWNER-SCOPED and a fire is OWNERLESS.**
//
// `handlePiTriggers` (`src/extensions/tool-executor/rpc-handlers.ts`)
// resolves provenance through `resolveReverseRpcMeta`, which refuses any
// call whose per-call snapshot carries `ownerless: true` with `-32106`
// before the handler's ladder starts. `ScheduleDaemon.dispatchFire` stamps
// exactly that on every cron tick (`registerFireCallProvenance({...,
// ownerless: true})`), and the webhook daemon does the same. It is not an
// oversight: `sdk_capability_calls.on_behalf_of` is NOT NULL with an FK to
// `users`, so a registration the host cannot attribute to a human is a row
// it cannot write.
//
// So registration happens ON THE SAVE PATH — a Hub page action, which
// carries the clicking user — and NEVER from inside a fire. Getting that
// backwards produces a console that works once by hand and never again,
// with a `-32106` in a log nobody reads.
//
// The same rule kills a boot-time reconcile: a subprocess starting up has
// no call token at all, so even `ctx.triggers.list()` fails there
// (`-32602`, provenance unresolved). What boot CAN do is wire handlers,
// which is local — see {@link triggerKeyForJob} and `index.ts`'s
// `hydrateTriggerHandlers`.
//
// ── WHY A FIRE CANNOT USE `ctx.workflows.run()` ──────────────────────
//
// Same ownerlessness, one method over. `ezcorp/workflows` resolves through
// `resolveReverseRpcMeta` too, so an unattended `run()` dies at rung 0 —
// and rung 7 refuses it again with `WORKFLOWS_NO_OWNER` for the deeper
// reason that `WorkflowExecutor.runWorkflow` scopes `workflow:*` SSE on
// `userId`. Neither refusal is weakened here. The sanctioned path is
// `ctx.workflows.runFor(jobRef)` on the distinct
// `ezcorp/workflows-delegated` method, whose ownerless-TOLERANT resolver
// exists precisely so the ownerless decision can be re-taken at rung D7
// against a consent row a human wrote.

import type {
  BackgroundTriggerKind,
  FactoryJob,
  JobTrigger,
} from "./jobs";
import { BACKGROUND_TRIGGER_KINDS, isBackgroundTrigger, isValidJobId } from "./jobs";

// ── The key is the job ───────────────────────────────────────────────

/**
 * The host's `key` charset, MIRRORED.
 *
 * `TRIGGER_KEY_RE` in `src/extensions/triggers-store.ts` is
 * `/^[a-z0-9][a-z0-9:_-]{0,63}$/`. Mirrored rather than imported for the
 * same reason `TRIGGER_ENVELOPE` is: importing anything under
 * `src/extensions/**` would drag a host module into the sandboxed bundle.
 * `triggers.test.ts` pins the two source texts against each other, so
 * drift is a named failure rather than a `TRIGGER_KEY_INVALID` nobody can
 * explain.
 *
 * Note the case: the host's charset is **lowercase only**, while
 * {@link isValidJobId} accepts `[A-Za-z0-9]`. Every id this console mints
 * is a `crypto.randomUUID()` and therefore lowercase, but the two sets are
 * not the same set, and {@link triggerKeyForJob} is what refuses the
 * difference instead of discovering it as a host rejection.
 */
export const HOST_TRIGGER_KEY_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

/** Namespaces this console's keys inside its own extension's key space. */
export const TRIGGER_KEY_PREFIX = "job:";

/**
 * The host trigger key for a job, or `null` when the id cannot make one.
 *
 * `job:<uuid>` is 40 characters, comfortably inside the host's 64. The
 * `null` arm is reachable only by a job id written by something other than
 * this console's `crypto.randomUUID()` — refused rather than truncated,
 * because a truncated key would register a row that dispatches to a job id
 * that does not exist.
 */
export function triggerKeyForJob(jobId: string): string | null {
  if (!isValidJobId(jobId)) return null;
  const key = `${TRIGGER_KEY_PREFIX}${jobId}`;
  return HOST_TRIGGER_KEY_RE.test(key) ? key : null;
}

/**
 * The job a fired key belongs to, or `null`.
 *
 * The inverse of {@link triggerKeyForJob} and the ONLY reader of a fire's
 * `key`. A fire arrives on the wire from the host, so the id is validated
 * with the store's own {@link isValidJobId} before it can be spliced into
 * a storage key — the same rule `jobIdFromActionPayload` follows for the
 * other untrusted entry point.
 */
export function jobIdFromTriggerKey(key: unknown): string | null {
  if (typeof key !== "string" || !key.startsWith(TRIGGER_KEY_PREFIX)) return null;
  const jobId = key.slice(TRIGGER_KEY_PREFIX.length);
  return isValidJobId(jobId) ? jobId : null;
}

// ── What a saved job wants the host to hold ──────────────────────────

/** The `ctx.triggers.register` payload for a job, minus nothing. The host
 *  mints a webhook's slug and secret itself, which is why that arm carries
 *  no field an operator could steer. */
export type TriggerRegistration =
  | { kind: "cron"; key: string; cron: string; timezone: string }
  | { kind: "webhook"; key: string };

/**
 * The host row a job should have, or `null` for a job that should have
 * none.
 *
 * Three ways to want none, and they are deliberately one function rather
 * than three checks at the call site:
 *
 *   - the trigger is `manual` (or a kind this build does not dispatch);
 *   - the job is DISABLED — `enabled: false` is this console's retire, and
 *     a retired job that still wakes the subprocess every night is the
 *     orphan `triggers-sweep.ts` exists to complain about;
 *   - the id cannot make a legal key.
 */
export function desiredRegistration(job: FactoryJob): TriggerRegistration | null {
  if (!job.enabled || !isBackgroundTrigger(job.trigger)) return null;
  const key = triggerKeyForJob(job.id);
  if (key === null) return null;
  return job.trigger.kind === "cron"
    ? { kind: "cron", key, cron: job.trigger.cron, timezone: job.trigger.timezone }
    : { kind: "webhook", key };
}

/** What a save must do to the host's rows for one job. */
export interface TriggerPlan {
  /** The row to create or update in place. `register` is idempotent on the
   *  key host-side — same row, same slug, same secret — so a job editor
   *  saving twice is the normal case rather than an error. */
  register: TriggerRegistration | null;
  /** Kinds whose row must go. At most one entry today: a job holds one
   *  trigger, so the only removable row is the kind it USED to be. */
  unregister: BackgroundTriggerKind[];
}

/**
 * The plan for a save: what the job wants now, minus what it had.
 *
 * ## Why `before` and not a `list()` reconcile
 *
 * A per-save `ctx.triggers.list()` would be self-healing and would also be
 * two extra owner-scoped RPCs and an `sdk_capability_calls` row per save.
 * The save path already reads the stored job for `candidateDraft` and the
 * audit diff, so `before` is free and exact for every transition a human
 * can drive.
 *
 * ## The unregister arm tolerates a miss BY DESIGN
 *
 * `handleUnregister` answers `TRIGGER_NOT_FOUND` (`-32602`) for a key it
 * does not hold, and the caller in `index.ts` records that as a no-op
 * rather than as a failed save. Without that, a job whose registration
 * failed once could never be edited again: every subsequent save would try
 * to retire a row that was never written and refuse itself over it.
 *
 * Pure: no storage, no clock, no channel.
 */
export function triggerPlan(job: FactoryJob, before: JobTrigger | null): TriggerPlan {
  const register = desiredRegistration(job);
  const had: BackgroundTriggerKind | null =
    before !== null && isBackgroundTrigger(before) ? before.kind : null;
  const unregister =
    had !== null && had !== register?.kind ? [had] : ([] as BackgroundTriggerKind[]);
  return { register, unregister };
}

/** Every background kind, for a caller that must retire a job's rows
 *  wholesale without knowing which one it held. */
export const ALL_BACKGROUND_KINDS: readonly BackgroundTriggerKind[] =
  BACKGROUND_TRIGGER_KINDS;

// ── Describing a refusal to the person who has to fix it ─────────────

/**
 * What KIND of thing went wrong, which is the question an operator staring
 * at a stopped job is actually asking.
 *
 *   - `consent`  — a human has to look at a diff and say yes again. The
 *                  job is fine; the authority behind it went stale.
 *   - `quota`    — a bound did its job. Nothing is broken and nothing needs
 *                  a human; the next window works.
 *   - `platform` — an operator-controlled switch or a transient host
 *                  condition. Not about this job at all.
 *   - `install`  — the extension's grant or the delegation row is wrong.
 *                  Permanent until somebody changes an install.
 *   - `job`      — this console refused its own job before spending
 *                  anything.
 *   - `unknown`  — a reason this build has never heard of. Reported
 *                  VERBATIM rather than guessed at.
 */
export type FireRefusalKind =
  | "consent"
  | "quota"
  | "platform"
  | "install"
  | "job"
  | "unknown";

/** One classified refusal, ready for the audit trail and the console. */
export interface FireRefusal {
  /** The host's typed `data.reason`, or `LOCAL_<x>` for a refusal this
   *  console made itself. Never a message — messages move between builds
   *  and a trail keyed on prose cannot be aggregated. */
  reason: string;
  kind: FireRefusalKind;
  /** One sentence an operator can act on. Authored, closed-set copy —
   *  never host prose and never job content, so it is safe in a rendered
   *  cell (invariant J) and in a 30-day audit bucket (invariant I). */
  remedy: string;
}

/** This console's own refusals, before any RPC is spent. Prefixed so a
 *  reader can tell "we refused" from "the host refused" at a glance. */
export const LOCAL_REFUSAL = {
  unknownKey: "LOCAL_UNKNOWN_TRIGGER_KEY",
  jobMissing: "LOCAL_JOB_NOT_FOUND",
  jobDisabled: "LOCAL_JOB_DISABLED",
  notBackground: "LOCAL_NOT_A_BACKGROUND_JOB",
  kindMismatch: "LOCAL_TRIGGER_KIND_MISMATCH",
  invalidJob: "LOCAL_JOB_NO_LONGER_VALID",
} as const;

/**
 * The reason→remedy table, keyed on the host's typed `data.reason`.
 *
 * **This is the legibility control.** Without it every unattended failure
 * reads the same — "the job stopped" — and the one failure that has a
 * one-click fix (`DELEGATION_CONSENT_STALE`) is indistinguishable from the
 * ones that do not. The codes come from `WorkflowTriggerDenyReason`
 * (`src/extensions/workflows-handler.ts`) and from the SDK's own
 * `runFor()` docblock, which is the contract this table implements.
 *
 * A code missing from this table is NOT a bug to hide: `describeFireRefusal`
 * falls through to `unknown` and carries the raw reason, so a host that
 * grows a code says so instead of being silently re-labelled.
 */
export const FIRE_REFUSAL_TABLE: Readonly<
  Record<string, { kind: FireRefusalKind; remedy: string }>
> = {
  // ── The one this feature exists to make legible ──
  DELEGATION_CONSENT_STALE: {
    kind: "consent",
    remedy:
      "The run was PARKED, not executed — what you authorized has changed (a template edit, a permissions change, or a new release). Open the delegation, review the diff, and consent again; the parked run resumes from the start.",
  },
  DELEGATION_OWNER_LOST_WORKFLOW_ACCESS: {
    kind: "consent",
    remedy:
      "The principal this job runs as can no longer reach the workflow, so the platform switched the delegation off. Consent again to restart it.",
  },
  DELEGATION_NOT_FOUND: {
    kind: "consent",
    remedy:
      "No live authorization for this job — never granted, or revoked. Authorize it in the workflow UI; saving a schedule never arms one.",
  },
  DELEGATION_DISABLED_ROW: {
    kind: "consent",
    remedy: "The authorization was switched off. Consent again to restart it.",
  },

  // ── Bounds working as designed ──
  DELEGATION_QUOTA_EXCEEDED: {
    kind: "quota",
    remedy:
      "This job hit the runs-per-day limit you chose. Nothing is broken; it fires again tomorrow, or raise the limit and consent again.",
  },
  WORKFLOWS_QUOTA_EXCEEDED: {
    kind: "quota",
    remedy:
      "The extension hit its hourly run ceiling across every job. It clears within the hour.",
  },
  DELEGATION_SPEND_EXCEEDED: {
    kind: "quota",
    remedy:
      "The token budget on this job admits no work. Raise it on the delegation and consent again.",
  },
  DELEGATION_DAILY_TOKENS_EXCEEDED: {
    kind: "quota",
    remedy:
      "The service account this job runs as has spent its daily token budget. An admin can raise the account's limit.",
  },
  WORKFLOWS_RATE_LIMITED: {
    kind: "quota",
    remedy: "Too many calls at once. The next fire goes through.",
  },

  // ── Not about this job ──
  DELEGATION_DISABLED: {
    kind: "platform",
    remedy:
      "An operator has turned delegated runs off instance-wide (EZCORP_DISABLE_DELEGATED_WORKFLOWS). Nothing about this job changed; the next fire works once it is turned back on.",
  },
  WORKFLOWS_DISABLED: {
    kind: "platform",
    remedy:
      "An operator has turned the capability tier off instance-wide. Nothing about this job changed.",
  },
  DELEGATION_RUNTIME_UNAVAILABLE: {
    kind: "platform",
    remedy: "The workflow runtime was not ready. The next fire retries.",
  },
  WORKFLOWS_DISPATCH_FAILED: {
    kind: "platform",
    remedy: "The run could not be started. The next fire retries.",
  },

  // ── Install-shaped: permanent until somebody edits an install ──
  DELEGATION_NOT_GRANTED: {
    kind: "install",
    remedy:
      "This extension does not hold the delegated-run permission. That is an install-level grant, not something a job can fix.",
  },
  WORKFLOWS_NOT_GRANTED: {
    kind: "install",
    remedy:
      "This extension's workflow grant is not usable for delegated runs. That is an install-level grant, not something a job can fix.",
  },
  DELEGATION_BAD_REF: {
    kind: "install",
    remedy: "The job handle is malformed — a bug in this console, not a setting.",
  },
  DELEGATION_WORKFLOW_NOT_FOUND: {
    kind: "install",
    remedy:
      "The workflow the authorization names no longer resolves. Consent again against a workflow that exists.",
  },
  DELEGATION_OWNER_UNRESOLVED: {
    kind: "install",
    remedy:
      "The principal this job runs as no longer exists or is disabled. Consent again as a live principal.",
  },

  // ── This console's own refusals ──
  [LOCAL_REFUSAL.unknownKey]: {
    kind: "job",
    remedy: "A trigger fired for a key this console does not recognise. Nothing ran.",
  },
  [LOCAL_REFUSAL.jobMissing]: {
    kind: "job",
    remedy: "The job behind this trigger is gone. Nothing ran.",
  },
  [LOCAL_REFUSAL.jobDisabled]: {
    kind: "job",
    remedy: "The job is disabled. Re-enable it and save to arm its schedule again.",
  },
  [LOCAL_REFUSAL.notBackground]: {
    kind: "job",
    remedy:
      "The job no longer has a background trigger. Nothing ran; save it again to retire the leftover schedule.",
  },
  [LOCAL_REFUSAL.kindMismatch]: {
    kind: "job",
    remedy:
      "A leftover schedule of the wrong kind fired. Nothing ran; save the job again to retire it.",
  },
  [LOCAL_REFUSAL.invalidJob]: {
    kind: "job",
    remedy:
      "The stored job no longer passes this console's own rules, so it was refused before anything was spent. Open it and fix the field named in the trail.",
  },
};

/** The fallback remedy for a reason this build has never heard of. */
export const UNKNOWN_REFUSAL_REMEDY =
  "The host refused this fire with a reason this console does not recognise. The trail carries it verbatim; open the run trace or the audit log.";

/**
 * Classify a refusal.
 *
 * Reads the typed `data.reason` off the host's `JsonRpcError`, NEVER the
 * message: `runFor()`'s own docblock says to branch on `err.data.reason`,
 * and a message is prose that moves between builds. A thrown value that is
 * not a JSON-RPC error at all (a transport failure, a bug in this file)
 * lands on `unknown` with a stable synthetic reason rather than throwing
 * out of a fire handler and taking the subprocess's dispatch with it.
 */
export function describeFireRefusal(reason: string): FireRefusal {
  const entry = FIRE_REFUSAL_TABLE[reason];
  return entry === undefined
    ? { reason, kind: "unknown", remedy: UNKNOWN_REFUSAL_REMEDY }
    : { reason, kind: entry.kind, remedy: entry.remedy };
}

/** The synthetic reason for a throw that carried no typed `data.reason`. */
export const UNTYPED_REFUSAL_REASON = "HOST_REFUSED_UNTYPED";

/**
 * The typed reason on a thrown host error, or {@link UNTYPED_REFUSAL_REASON}.
 *
 * Structural rather than `instanceof JsonRpcError`: the SDK class is a
 * value import, and a reverse-RPC rejection that crossed a module boundary
 * (or a test double) can carry the same shape without the same identity.
 * The field is read defensively because it comes off the wire.
 */
export function fireRefusalReason(err: unknown): string {
  const data = (err as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null) {
    const reason = (data as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return UNTYPED_REFUSAL_REASON;
}

// ── The job's own record of its last unattended fire ─────────────────

/**
 * What the console remembers about a job's last UNATTENDED fire.
 *
 * ## Why the job carries this and the run index does not
 *
 * A refused fire produces no run to reconcile — except for
 * `DELEGATION_CONSENT_STALE`, which parks a `workflow_runs` row the
 * console can only see if `ctx.workflows.runs()` is asked by a user the
 * run is scoped to. Every OTHER refusal produces nothing at all: no run
 * row, no `lastRunAt`, no line in Recent runs. So a job whose schedule
 * silently stopped looks exactly like a job that has not come round yet.
 *
 * That is the "shipped green, proved nothing" failure in operational form,
 * and this field is what closes it. The extension learns the refusal
 * DIRECTLY, as the rejection of its own `runFor` call, so this record does
 * not depend on any scoping question being answered a particular way.
 *
 * ## Content-free (invariant I)
 *
 * A typed reason code, an authored remedy from a closed table, and an
 * instant. Never the host's message, never a job input, never anything a
 * run produced.
 */
export interface JobFireOutcome {
  /** ISO instant of the fire attempt. */
  at: string;
  ok: boolean;
  /** Present only when `ok` is false. */
  reason?: string;
  kind?: FireRefusalKind;
  remedy?: string;
}

/** The console's one-line State for a job, given its last fire. Pure, and
 *  the strings are authored constants — nothing operator-derived reaches
 *  a rendered cell through here (invariant J). */
export function fireStateLabel(outcome: JobFireOutcome | undefined): string | null {
  if (outcome === undefined || outcome.ok) return null;
  switch (outcome.kind) {
    case "consent":
      return "consent stale — re-authorize";
    case "quota":
      return "paused by a limit";
    case "platform":
      return "platform paused";
    case "install":
      return "needs an install fix";
    case "job":
      return "refused by this console";
    default:
      return "last fire refused";
  }
}
