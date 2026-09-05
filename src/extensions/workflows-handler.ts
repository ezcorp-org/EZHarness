/**
 * `ezcorp/workflows` reverse-RPC handler (W2) — `ctx.workflows.run()`.
 *
 * Lets an extension trigger a run of a workflow IT SHIPS (a
 * `*.workflow.yaml` at the root of its install dir, loaded by
 * `src/runtime/workflow-extension-loader.ts`). The host resolves the
 * definition, starts the run against the LIVE `WorkflowExecutor`, and
 * returns `{workflowRunId}` **immediately** — non-blocking, mirroring
 * `ezcorp/spawn-assignment`. `runWorkflow` is fully awaited internally and
 * a graph with agent steps routinely outlives the 20s host reverse-RPC
 * timeout, so blocking here would guarantee a spurious `-32603` while the
 * run kept going invisibly. The extension follows progress by POLLING
 * `op: "runs"` — NOT by subscribing to the `workflow:*` bus events, which
 * cannot reach an extension at all: `EventSubscriptionDispatcher.dispatch`
 * drops any payload without a top-level string `conversationId`
 * (`event-subscription-dispatcher.ts`), and `WorkflowRun` has no such
 * field (`src/types.ts`). Because all four names ARE in
 * `DIRECT_CARRIER_EVENT_TYPES`, `registerExtension` ACCEPTS such a
 * subscription and it then never fires — registered, silent, forever. So
 * the read below is the only correlation path there is.
 *
 * ── Enforcement ladder (strict order) ──────────────────────────────────
 *   0. Provenance — resolved by the CALLER from the host-issued
 *      `_meta.ezCallId` the subprocess echoed back, NEVER the wire. Which
 *      resolver runs depends on the RPC method, and it is the ONLY thing
 *      that differs between the two entry points:
 *        - `ezcorp/workflows` → `handlePiWorkflows` →
 *          `resolveReverseRpcMeta`, which ALSO refuses an OWNERLESS
 *          background fire outright (`-32106`) before this ladder starts.
 *        - `ezcorp/workflows-delegated` → `handlePiWorkflowsDelegated` →
 *          `resolveDelegatedProvenance`, which passes an ownerless fire
 *          through with `userId: null` so it reaches rung 7 instead.
 *      Either way an ownerless fire is REFUSED — see the attribution note
 *      below. The delegated method only decides WHERE.
 *   1. Kill-switch (`EZCORP_DISABLE_CAPABILITY_TOOLS=1`)
 *   2. Grant check — a structurally valid `permissions.workflows` grant
 *   3. Payload: the workflow NAME. Read before the PDP call on purpose —
 *      the capability is PER-NAME (`{kind:"ezcorp:workflows:run",
 *      value:<name>}`), so the name is an input to the authorization
 *      question, not something checked after it.
 *   4. Manifest allowlist — the name must be in the on-disk manifest's
 *      declaration, not just the stored grant. Defense-in-depth, copied
 *      from `schedule-handler.ts`: a grant that went stale against a
 *      narrowed manifest must not stay exploitable.
 *   5. Grant allowlist — the name must be in the GRANTED list too.
 *   6. PDP authorize for the per-name capability.
 *   7. Scope bounds — a bound acting user (see attribution note).
 *   8. Wiring gate — when the call carries a conversation, the extension
 *      must actually be wired to it.
 *   9. Instantaneous rate limit (token bucket, 50 ops/sec).
 *  10. Payload: the rest (`v`, `input` shape + size).
 *  11. Hourly quota (`grant.workflows.maxRunsPerHour`).
 *  12. Resolve — `<extensionName>:<name>` against the LIVE merged cache.
 *  13. Dispatch.
 *
 * Every outcome — accept AND reject — writes a `sdk_capability_calls` row
 * via `recordCapabilityCall` with `capability: "workflows"`, a typed
 * `errorCode` on rejection.
 *
 * ── The attribution decision (deliberate) ──────────────────────────────
 *
 * Cron and webhook fires are OWNERLESS: the provenance snapshot carries no
 * `onBehalfOf`. `WorkflowExecutor.runWorkflow` scopes its `workflow:*` SSE
 * delivery on `userId` and is fail-closed on a missing one, so an ownerless
 * run would execute with no owner AND no observability — real LLM spend
 * with nobody watching and nobody accountable.
 *
 * We REFUSE ownerless triggers rather than inventing an owner. Attributing
 * a background fire to (say) the installing user would bill that user's
 * provider credits for work they did not initiate and would push the run's
 * event stream at them; both are worse than a clean, typed failure. On the
 * `ezcorp/workflows` path the refusal is inherited for free from
 * `resolveReverseRpcMeta` (`-32106`, "No owner scope for this background
 * fire"), and this handler re-asserts it at rung 7 so the bound is testable
 * in isolation and cannot be lost by a future caller that skips the shared
 * helper.
 *
 * `ezcorp/workflows-delegated` IS that future caller, and rung 7 is why it
 * is safe to add. It skips the rung-0 refusal deliberately — a delegated
 * fire is ownerless by definition, so refusing at rung 0 would make the
 * whole ladder unreachable for it — and rung 7 catches it instead, with the
 * same `-32106` plus the `audit_log` row rung 0 never wrote. Rung 7 is
 * therefore no longer a belt-and-braces re-assertion; it is the LOAD-BEARING
 * ownerless bound for that method. Do not weaken it, and do not "simplify"
 * it away on the grounds that the caller already checks — one caller does,
 * one deliberately does not.
 *
 * ── C3 · the FOURTH op, and the one rung 7 does not bound ──────────────
 *
 * `op: "runFor"` fires a workflow the extension does NOT ship, as a
 * principal a human already consented to. It is the one path where an
 * ownerless CALLER is legitimate — that is the entire feature — so it
 * does not reach rung 7 at all. What replaces rung 7 is not an absence:
 * the owner comes off a `workflow_delegations` row keyed on the
 * REGISTRY-resolved extension id, D4 proves that owner still resolves to
 * a live principal before anything is audited against it, and D7 re-asks
 * the read/run ladder as that principal on every single fire.
 *
 * It is admitted ONLY on `ezcorp/workflows-delegated`; on
 * `ezcorp/workflows` it is an unknown op. Full ladder, rung order and
 * audit-destination table: {@link runForDelegation}.
 */
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types";
import type { PermissionEngine } from "./permission-engine";
import { rpcError, rpcResult } from "./json-rpc";
import { capabilityToolsDisabled } from "./capability-flags";
import { createRateLimiter } from "./rate-limit";
import { recordCapabilityCall } from "./recordCapabilityCall";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import { getConversationExtensionIds } from "../db/queries/conversation-extensions";
import { getConversation } from "../db/queries/conversations";
import {
  getWorkflowRuntime,
  type WorkflowRuntime,
} from "../runtime/workflow/runtime-registry";
import type { WorkflowDefinition, WorkflowRunStatus } from "../types";
import { isValidWorkflowName, namespacedWorkflowName } from "../runtime/workflow-name";
import { canRunWorkflow, workflowExtensionLiveness } from "../runtime/workflow-authz";
import { workflowReleaseCanAccess } from "../runtime/workflow-release-assets";
import { listWorkflowRunsForCaller, RUN_STATUS_FILTERS } from "../runtime/workflow-run-trace";
import { listPendingWorkflowApprovalsForUser } from "../db/queries/workflow-approvals";
import { formatGateRelay } from "../runtime/workflow-approval-relay";
import { extensionLogger } from "../logger";
// ── C3 · delegated execution ──────────────────────────────────────────
import type { DelegationOwnerKind, WorkflowDelegationRow } from "../db/schema";
import {
  carryDelegationConsentForward,
  countDelegationRunsSince,
  delegationOwnerId,
  disableWorkflowDelegation,
  findLiveWorkflowDelegation,
  recordDelegationRunOutcome,
} from "../db/queries/workflow-delegations";
import { findLiveServiceAccount } from "../db/queries/service-accounts";
import { getUserById } from "../db/queries/users";
import {
  insertWorkflowRun,
  suspendWorkflowRun,
  sumServiceAccountTokensSince,
} from "../db/queries/workflow-runs";
import {
  authorizeDelegationConsent,
  delegationPrincipal,
  DELEGATION_CONSENT_DENIALS,
} from "../runtime/workflow-delegation-consent";
import { computeDelegationConsentRecord } from "../runtime/workflow-delegation-record";
import {
  reconcileDelegationConsent,
  CONSENT_CARRIED_FORWARD_REASON,
} from "../runtime/workflow-consent-reconcile";
import { workflowDefinitionHash } from "../runtime/workflow-definition-hash";
import { startOfUtcDay } from "./webhook-store";

const log = extensionLogger("workflows", "handler");

const MAX_OPS_PER_SECOND = 50;
const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

/** Serialized-size ceiling on the caller-supplied workflow `input`. Bounds
 *  what rides into the ref resolver, the persisted `workflow_runs.input`
 *  column, and every agent step's prompt. */
export const MAX_WORKFLOW_INPUT_BYTES = 16_384;

/** Sliding-window length for the per-hour trigger quota. */
const QUOTA_WINDOW_MS = 60 * 60 * 1000;

/**
 * Ceiling on a caller-supplied `jobRef` correlation handle.
 *
 * Sized to hold a UUID with room to spare and nothing like a document.
 * The value is stored verbatim in `workflow_runs.job_ref` and rendered
 * on the run trace, so it is bounded like every other rendered string
 * rather than trusted for being "just an id".
 */
export const MAX_JOB_REF_LEN = 128;

/**
 * The charset a `jobRef` may use.
 *
 * Deliberately narrow — id-shaped only. The host never resolves this
 * value (jobs live in an extension's `Storage`, not a table), so its ONLY
 * consumers are a text column and a UI cell; a handle that can carry
 * whitespace, control characters or markup buys nothing and costs a
 * rendering question on every surface it reaches. A strict subset of the
 * shapes real callers use — a UUID, a slug — so tightening it later
 * cannot orphan a legal id that already exists.
 *
 * REJECTED, never truncated or sanitized: a silently-rewritten
 * correlation handle correlates to the wrong thing, which is worse than
 * carrying none.
 */
export const JOB_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** True when `value` is a legal `jobRef`. */
export function isValidJobRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_JOB_REF_LEN &&
    JOB_REF_RE.test(value)
  );
}

/**
 * The reverse-RPC method the delegated ladder is reachable on, and ONLY
 * on. Must equal the key in `REVERSE_RPC_ROUTES`
 * (`tool-executor/rpc-handlers.ts`) — the router exact-matches it, so the
 * value this handler compares against is the one the host itself chose.
 */
export const DELEGATED_WORKFLOWS_METHOD = "ezcorp/workflows-delegated";

/** The `op` that fires a workflow the extension does NOT ship, on behalf
 *  of the human (or service account) who delegated it. */
export const DELEGATED_OP = "runFor";

/**
 * C3's own kill-switch (rung 1b).
 *
 * Separate from `EZCORP_DISABLE_CAPABILITY_TOOLS` on purpose: an operator
 * who needs delegated execution off in an incident should not have to
 * take down every extension's task events, spawns and first-party
 * workflow triggers to get it. Unset ⇒ no behaviour change, which is the
 * same contract `capabilityToolsDisabled` carries.
 */
export function delegatedWorkflowsDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env["EZCORP_DISABLE_DELEGATED_WORKFLOWS"] === "1";
}

/**
 * `owner_kind` → the `sdk_capability_calls.on_behalf_of` value an outcome
 * on that kind carries, or `null` when there is no user to carry.
 *
 * **This map IS the audit-destination decision**, and it is the reason
 * that decision is per rung AND per owner kind rather than per rung:
 * `null` routes the outcome to `audit_log` through {@link audit}'s
 * ownerless branch, exactly as rung 7 does, because
 * `sdk_capability_calls.on_behalf_of` is NOT NULL with an FK to `users`
 * and a `service` principal has no `users` row by construction. Get this
 * wrong in the permissive direction and a service-account denial does not
 * merely land in the wrong table — the insert is swallowed and the denial
 * VANISHES.
 *
 * A KEYED LOOKUP for the same reason `DELEGATION_OWNER_COLUMN` and
 * `DELEGATION_PRINCIPAL` are: a two-armed `switch` compiles today and
 * falls silently through the day a third principal kind exists, and the
 * fallthrough value here would be "attribute it to somebody".
 */
const DELEGATION_AUDIT_ON_BEHALF_OF = {
  user: (ownerId: string): string | null => ownerId,
  service: (): string | null => null,
} as const satisfies Record<DelegationOwnerKind, (ownerId: string) => string | null>;

/**
 * `owner_kind` → the `audit_log` action an outcome on that kind uses IF
 * it routes there. Paired with {@link DELEGATION_AUDIT_ON_BEHALF_OF} so
 * the destination and the action cannot disagree.
 *
 * The `user` arm is unreachable in practice — a `user`-kind outcome past
 * rung D4 has a proven `users` row and therefore lands in
 * `sdk_capability_calls` — and it is present anyway, keyed, so that the
 * map stays total and a third kind is one entry rather than a search for
 * every place a kind is assumed.
 */
const DELEGATION_AUDIT_LOG_ACTION = {
  user: EXT_AUDIT_ACTIONS.WORKFLOW_DELEGATION_NO_OWNER,
  service: EXT_AUDIT_ACTIONS.WORKFLOW_DELEGATION_SERVICE,
} as const satisfies Record<DelegationOwnerKind, string>;


/** Typed rejection reasons — the `errorCode` on the audit row, so analytics
 *  can tell "not granted" from "quota exhausted" from "no such workflow". */
export type WorkflowTriggerDenyReason =
  | "WORKFLOWS_DISABLED"
  | "WORKFLOWS_NOT_GRANTED"
  | "WORKFLOW_NAME_INVALID"
  | "WORKFLOW_NOT_DECLARED"
  | "WORKFLOW_NOT_GRANTED"
  | "WORKFLOWS_PERM_DENIED"
  | "WORKFLOWS_NO_OWNER"
  | "WORKFLOWS_NOT_WIRED"
  | "WORKFLOWS_RATE_LIMITED"
  | "WORKFLOWS_BAD_PAYLOAD"
  | "WORKFLOWS_QUOTA_EXCEEDED"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOWS_RUNTIME_UNAVAILABLE"
  | "WORKFLOWS_DISPATCH_FAILED"
  | "WORKFLOWS_BAD_OP"
  // ── C3 · the delegated (`op: "runFor"`) rungs ──────────────────────
  //
  // Every one of these is its OWN code, and none collapses into a shared
  // `DELEGATION_DENIED`. Two of them drive completely different human
  // remedies from the same-looking symptom ("my cron job stopped"), and
  // one — `DELEGATION_OWNER_LOST_WORKFLOW_ACCESS` — survives into
  // `workflow_delegations.disabled_reason`, where it is the only thing a
  // user will ever read about why it stopped.
  /** 1b — `EZCORP_DISABLE_DELEGATED_WORKFLOWS=1`. C3's own kill switch. */
  | "DELEGATION_DISABLED"
  /** 2b — the install grant does not carry `allowDelegated`. */
  | "DELEGATION_NOT_GRANTED"
  /** D1 — the `jobRef` is not id-shaped. */
  | "DELEGATION_BAD_REF"
  /** D2 — no LIVE delegation for this (extension, job). This is the code
   *  a FORGED ref produces, and it is the whole of §4: the wire has no
   *  field that names a principal, so "invent an owner" matches zero rows
   *  rather than being denied. */
  | "DELEGATION_NOT_FOUND"
  /** D3 — the row exists and is switched off. Carries `disabled_reason`. */
  | "DELEGATION_DISABLED_ROW"
  /** D4 — the owner the row names does not resolve to a live principal. */
  | "DELEGATION_OWNER_UNRESOLVED"
  /** D7 — the owner could run this workflow at consent time and cannot
   *  now. Distinct from the consent-time
   *  `DELEGATION_OWNER_CANNOT_RUN_WORKFLOW` because nothing the human did
   *  was wrong: the world moved. */
  | "DELEGATION_OWNER_LOST_WORKFLOW_ACCESS"
  /** D7 — the delegation's `workflow_name` resolves to nothing the
   *  principal can even see. */
  | "DELEGATION_WORKFLOW_NOT_FOUND"
  /** D6 — the recomputed consent hash differs from the stored one. The
   *  run is PARKED, not refused: see {@link parkConsentStaleRun}. */
  | "DELEGATION_CONSENT_STALE"
  /** D8 — `max_runs_per_day`, counted over the UTC calendar day. */
  | "DELEGATION_QUOTA_EXCEEDED"
  /** D9 — the delegation's `max_tokens_per_run` cannot admit any work. */
  | "DELEGATION_SPEND_EXCEEDED"
  /**
   * D10 — the OWNING SERVICE ACCOUNT has spent its
   * `max_tokens_per_day` across all of its delegations.
   *
   * Its own code, not a reuse of `DELEGATION_SPEND_EXCEEDED` (per-RUN
   * tokens) or `DELEGATION_QUOTA_EXCEEDED` (per-delegation daily RUNS).
   * Three bounds, three remedies: wait for tomorrow, raise this
   * delegation's cap (`PATCH /api/workflows/delegations/:id`), or raise
   * the ACCOUNT's cap — which is an admin action on a different object
   * entirely. Collapsing any two would make the audit row unable to say
   * which.
   *
   * Reachable only on the `service` arm, so every one of these lands in
   * `audit_log` with a NULL user.
   */
  | "DELEGATION_DAILY_TOKENS_EXCEEDED"
  /** D6/D7 — the runtime is registered but WITHOUT the readers this
   *  ladder authorizes and hashes against. Fail CLOSED: a registration
   *  that cannot answer "who owns this?" or "which agents exist?" has not
   *  earned a permissive default (`workflow/runtime-registry.ts`). */
  | "DELEGATION_RUNTIME_UNAVAILABLE";

export interface WorkflowsHandlerContext {
  /** Manifest NAME of the calling extension, resolved host-side from the
   *  registry — never the wire. Doubles as the namespace prefix. */
  extensionName: string;
  /** Registry extension id (the audit/actor anchor). */
  extensionId: string;
  /** Acting user, from the host-issued provenance token.
   *
   *  NULLABLE on purpose. The `ezcorp/workflows` caller
   *  (`handlePiWorkflows` → `resolveReverseRpcMeta`) still guarantees a
   *  non-empty value — it refuses ownerless at rung 0. The
   *  `ezcorp/workflows-delegated` caller (`handlePiWorkflowsDelegated` →
   *  `resolveDelegatedProvenance`) deliberately does NOT, so that an
   *  ownerless fire reaches rung 7 and is refused THERE — audited, typed,
   *  and in one place — instead of dying before the ladder starts.
   *  Rung 7 has always coded for the falsy case; this type now says so. */
  userId: string | null;
  /** Calling conversation, or null for a non-chat (but still owned) call. */
  conversationId: string | null;
  /** The INSTALLED grant. */
  grantedPermissions: ExtensionPermissions;
  /** The registry manifest — source of the defense-in-depth allowlist. */
  manifest: ExtensionManifestV2;
  /** PDP. Optional only for pre-PDP unit contexts, matching every sibling
   *  handler; production always threads it. */
  engine?: PermissionEngine;
}

/**
 * The handler context AFTER rung 7 — the ownerless bound has been applied,
 * so the acting user is known.
 *
 * Exists so the compiler, not a comment, enforces that the RUN DISPATCH
 * sits below the ownerless bound. `runWorkflow` scopes its `workflow:*` SSE
 * delivery on this id and is fail-closed on a missing one, so a null here
 * would execute real LLM spend that nobody can see. If a future edit moves
 * `startWorkflowRun` above rung 7, this type fails the build instead of
 * shipping an invisible run.
 */
type OwnedWorkflowsHandlerContext = WorkflowsHandlerContext & { userId: string };

// ── Per-hour trigger quota ─────────────────────────────────────────────
//
// A plain sliding window keyed by extension id. Deliberately in-memory and
// process-local: it is a spend guardrail on a live executor, not a durable
// accounting ledger (`workflow_runs` is that). A restart resetting the
// window is acceptable; a DB round-trip on the hot path is not.
const triggerTimes = new Map<string, number[]>();

function checkHourlyQuota(
  extensionId: string,
  maxRunsPerHour: number,
): { ok: boolean; used: number } {
  const now = Date.now();
  const cutoff = now - QUOTA_WINDOW_MS;
  const kept = (triggerTimes.get(extensionId) ?? []).filter((t) => t > cutoff);
  if (kept.length >= maxRunsPerHour) {
    triggerTimes.set(extensionId, kept);
    return { ok: false, used: kept.length };
  }
  kept.push(now);
  triggerTimes.set(extensionId, kept);
  return { ok: true, used: kept.length };
}

/**
 * Rung 10's `input` validation, shared verbatim by `op: "run"` and
 * `op: "runFor"`.
 *
 * One function because the two ops must bound the SAME payload surface:
 * `input` rides into the ref resolver, the persisted `workflow_runs.input`
 * column and every agent step's prompt on both paths, and a delegated
 * fire is the one with an unattended principal behind it. A second copy
 * of the ceiling would eventually be the larger one.
 */
function readWorkflowInput(
  raw: unknown,
): { ok: true; input: Record<string, unknown> } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, input: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "'input' must be a JSON object" };
  }
  const serialized = JSON.stringify(raw);
  if (serialized.length > MAX_WORKFLOW_INPUT_BYTES) {
    return {
      ok: false,
      message: `'input' too large (${serialized.length} > ${MAX_WORKFLOW_INPUT_BYTES} bytes)`,
    };
  }
  return { ok: true, input: raw as Record<string, unknown> };
}

/** Test-only: clear the in-memory hourly-quota window. */
export function _resetWorkflowTriggerQuotaForTests(): void {
  triggerTimes.clear();
}

/** Test-only: refill one extension's instantaneous token bucket. The bucket
 *  is module-level and shared across every call in a process, so without
 *  this a test that deliberately exhausts it would leak the empty bucket
 *  into whatever runs next. */
export function _resetWorkflowRateLimitForTests(extensionId: string): void {
  consumeTokens.forget(extensionId);
}

// ── Handler ────────────────────────────────────────────────────────────

/** Injectable seam so a unit test can exercise the audit-failure branch.
 *  `recordCapabilityCall` never throws by contract, so the handler's
 *  defensive `catch` is otherwise unreachable — and that catch is what
 *  guarantees an audit hiccup can never turn a successful trigger into an
 *  RPC error. Production callers pass no `deps`. */
export interface WorkflowsHandlerDeps {
  recordCapabilityCall: typeof recordCapabilityCall;
}

export async function handleWorkflowsRpc(
  req: JsonRpcRequest,
  ctx: WorkflowsHandlerContext,
  // Built at call time — NOT hoisted to a module-scope const — so merely
  // importing this module never eagerly reads the `recordCapabilityCall`
  // binding, which would trip any test that mocks that module. Same
  // rationale as `QueueAgentMessageDeps` in spawn-assignment-handler.ts.
  deps: WorkflowsHandlerDeps = { recordCapabilityCall },
): Promise<JsonRpcResponse> {
  const startedAt = Date.now();
  const params = (req.params ?? {}) as Record<string, unknown>;

  const deny = async (
    reason: WorkflowTriggerDenyReason,
    message: string,
    code = -32001,
    after?: Record<string, unknown>,
  ): Promise<JsonRpcResponse> => {
    await audit(ctx, startedAt, deps, {
      success: false,
      errorCode: reason,
      errorMessage: message,
      ...(after ? { after } : {}),
    });
    return rpcError(req.id, code, message, { reason });
  };

  // 1. Kill-switch — the whole capability tier off, no further work.
  if (capabilityToolsDisabled()) {
    return deny("WORKFLOWS_DISABLED", "workflows permission not granted");
  }

  // 1b. C3's OWN kill-switch, scoped to the delegated verb and nothing
  //     else. Read off the raw `op` — before validation, before the grant
  //     check — so that turning C3 off in an incident is one env var and
  //     costs no reasoning about which rung the switch sits above.
  //
  //     Deliberately NOT keyed on the METHOD: `ezcorp/workflows-delegated`
  //     also serves the ordinary `run` / `runs` / `approvals` ops (it is
  //     the same ladder with a tolerant rung 0), and an operator disabling
  //     delegated FIRES has not asked to break an extension's status
  //     polling.
  if (params.op === DELEGATED_OP && delegatedWorkflowsDisabled()) {
    return deny("DELEGATION_DISABLED", "delegated workflow runs are disabled");
  }

  // 2. Grant check — structural. A grant with an empty name list or a
  //    non-positive rate ceiling authorizes nothing; the clamp never
  //    produces one, so reaching here means a hand-edited / legacy row.
  //
  //    ONE exception, and only one (C3 / D-3): a DELEGATED-ONLY grant.
  //    `allowDelegated` opts the extension into firing workflows it does
  //    not ship, so it has no names to list — and dropping it here would
  //    make the whole delegated feature unreachable, which is the defect
  //    this branch exists to fix. The bit is not a bypass: it lets the
  //    grant clear this STRUCTURAL rung and nothing else. Every rung
  //    below is unchanged and still per-name, so an `op: "run"` on such a
  //    grant is refused at rung 4 (nothing declared) and the two READ ops
  //    fail closed on the empty list — `readApprovals` filters against an
  //    empty `mine` set (nothing matches) and `readRuns` passes an empty
  //    array to `listWorkflowRunsPage`, whose documented contract is that
  //    an empty array matches nothing rather than widening to unscoped
  //    (`src/db/queries/workflow-runs.ts` — `workflowNames`).
  //
  //    For any grant written before C3, `allowDelegated` is absent, so
  //    `!allowDelegated` is true and the predicate below is the original
  //    expression, character for character.
  const granted = ctx.grantedPermissions.workflows;
  const allowDelegated = granted?.allowDelegated === true;
  if (
    !granted ||
    !Array.isArray(granted.names) ||
    (granted.names.length === 0 && !allowDelegated) ||
    typeof granted.maxRunsPerHour !== "number" ||
    !Number.isFinite(granted.maxRunsPerHour) ||
    granted.maxRunsPerHour <= 0
  ) {
    return deny("WORKFLOWS_NOT_GRANTED", "workflows permission not granted");
  }

  // 2b. Which OPERATION. Absent ⇒ `run`, so every existing caller — the
  //     SDK's `ctx.workflows.run()`, every shipped extension — takes the
  //     identical path it always did, ladder rungs and all.
  //
  //     `approvals` and `runs` are READS, and they branch out here rather
  //     than threading a flag through the rungs below: rungs 3-6 are
  //     per-NAME authorization for a trigger, and rung 11 is the hourly
  //     RUN quota. A status read starts nothing, so making it clear those
  //     would either be meaningless (rung 3 demands a name a whole-set
  //     read does not have) or actively wrong (a poll burning the run
  //     budget until the extension can no longer do the thing it was
  //     granted).
  //
  //     `runFor` (C3) is the fourth op and the ONLY one that is not
  //     reachable on both methods. It is admitted solely on
  //     `ezcorp/workflows-delegated`, and on `ezcorp/workflows` it is an
  //     unknown op like any other. That is not belt-and-braces: §4's
  //     argument is "different method, different resolver, different
  //     ladder", and a verb that skipped rung 7's ownerless bound would be
  //     reachable from the resolver that exists to enforce it. The check
  //     reads `req.method`, which is the string the reverse-RPC ROUTER
  //     exact-matched to get here (`tool-executor/rpc-handlers.ts` —
  //     `REVERSE_RPC_ROUTES`), so it is host-verified by construction
  //     rather than a wire claim.
  const op = params.op === undefined ? "run" : params.op;
  const delegatedMethod = req.method === DELEGATED_WORKFLOWS_METHOD;
  if (op !== "run" && op !== "approvals" && op !== "runs" && !(op === DELEGATED_OP && delegatedMethod)) {
    return deny("WORKFLOWS_BAD_OP", `Unknown 'op': ${String(op)}`, -32602);
  }
  if (op === "approvals") {
    return readApprovals(req, ctx, startedAt, deps, granted.names, deny);
  }
  if (op === "runs") {
    return readRuns(req, ctx, startedAt, deps, granted.names, deny);
  }
  if (op === DELEGATED_OP) {
    return runForDelegation(req, ctx, startedAt, deps, granted, deny);
  }

  // 3. The workflow NAME. Read before the PDP call because the capability
  //    is per-name. A name carrying the `:` namespace separator is rejected
  //    outright — the host applies the prefix itself (rung 12), so the wire
  //    can never express a host or foreign-extension workflow name.
  const name = params.workflow;
  if (!isValidWorkflowName(name)) {
    return deny(
      "WORKFLOW_NAME_INVALID",
      "'workflow' must be a bare workflow name declared by this extension",
      -32602,
    );
  }

  // 4. Manifest allowlist (defense-in-depth — mirrors schedule-handler's
  //    cron check). The stored grant is the primary gate, but a manifest
  //    that has since NARROWED its declaration must win: a stale grant
  //    naming a workflow the author removed is not exploitable.
  const declared = ctx.manifest.permissions?.workflows?.names ?? [];
  if (!declared.includes(name)) {
    return deny("WORKFLOW_NOT_DECLARED", "workflow-not-declared");
  }

  // 5. Grant allowlist.
  if (!granted.names.includes(name)) {
    return deny("WORKFLOW_NOT_GRANTED", "workflow-not-granted");
  }

  // 6. PDP — the canonical decision, per-name. `prompt` is treated as a
  //    non-deny here: `ezcorp:workflows:run` is deliberately NOT in
  //    SENSITIVE_KINDS (see the rationale block in capability-types.ts), so
  //    the engine never returns `prompt` for it; branching on `deny` alone
  //    keeps this handler correct if a future always-allow row changes the
  //    shape of an allow.
  if (ctx.engine) {
    const decision = await ctx.engine.authorize(
      {
        extensionId: ctx.extensionId,
        userId: ctx.userId || null,
        conversationId: ctx.conversationId,
        toolName: "ezcorp/workflows",
      },
      [{ kind: "ezcorp:workflows:run", value: name }],
    );
    if (decision.decision === "deny") {
      return deny("WORKFLOWS_PERM_DENIED", "workflows permission not granted");
    }
  }

  // 7. Scope bounds — a bound acting user. See the attribution note in the
  //    module doc: an ownerless run is invisible (fail-closed SSE scoping)
  //    and unaccountable, so it is refused rather than attributed to
  //    somebody who did not ask for it.
  //
  //    This rung audits to `audit_log` instead of `sdk_capability_calls`,
  //    because the latter's `on_behalf_of` is NOT NULL with an FK to
  //    `users` — an ownerless row cannot exist there, so routing it through
  //    `deny()` would produce a swallowed insert and no trail at all for
  //    precisely the rejection class that most needs one.
  if (!ctx.userId || ctx.userId === "unknown") {
    const message =
      "Workflow triggers require an acting user — a background (cron/webhook) fire has no owner to attribute the run to";
    await auditOwnerless(ctx.extensionId, name, "no-owner");
    return rpcError(req.id, -32106, message, { reason: "WORKFLOWS_NO_OWNER" });
  }
  // Past the bound: the acting user is known. Everything below that can
  // start a run takes THIS context, so the ownerless check above cannot be
  // bypassed by a future reordering without a compile error.
  const ownedCtx: OwnedWorkflowsHandlerContext = { ...ctx, userId: ctx.userId };

  // 8. Wiring gate. Only meaningful when the call carries a conversation;
  //    an owned but conversation-less call (a lifecycle/event dispatch)
  //    has no wiring to check and is bounded by rungs 4-6 instead.
  if (ctx.conversationId) {
    const wired = await getConversationExtensionIds(ctx.conversationId);
    if (!wired.includes(ctx.extensionId)) {
      return deny("WORKFLOWS_NOT_WIRED", "Extension not wired to this conversation");
    }
  }

  // 9. Instantaneous rate limit.
  if (!consumeTokens(ctx.extensionId, 1)) {
    return deny("WORKFLOWS_RATE_LIMITED", "Rate limited", -32029);
  }

  // 10. Remaining payload validation.
  if (params.v !== 1) {
    return deny("WORKFLOWS_BAD_PAYLOAD", "Missing or invalid 'v' (expected 1)", -32602);
  }
  const inputCheck = readWorkflowInput(params.input);
  if (!inputCheck.ok) {
    return deny("WORKFLOWS_BAD_PAYLOAD", inputCheck.message, -32602);
  }
  const input = inputCheck.input;
  //     `jobRef` — the caller's OWN correlation handle, persisted verbatim
  //     to `workflow_runs.job_ref`. It is the durable half of "which saved
  //     job fired this run?": without it a console can only guess by
  //     matching timestamps, which is wrong the first time two jobs fire
  //     together.
  //
  //     **ON THIS OP THE HANDLE GRANTS NOTHING**, and is checked for SHAPE
  //     only. Every rung above has already decided whether this caller may
  //     start this workflow; a handle supplied by the same caller cannot
  //     be allowed to reopen that question, so nothing below branches on
  //     it. Rejected rather than sanitized: a silently-rewritten handle
  //     correlates to the wrong job, which is worse than carrying none.
  //
  //     **THE SAME-NAMED FIELD ON `op: "runFor"` IS DIFFERENT, AND IT IS
  //     THE OTHER SITE A FUTURE READER MUST NOT CONFUSE WITH THIS ONE.**
  //     There it is the LOOKUP KEY for the `workflow_delegations` row, so
  //     it selects which authority is exercised — see
  //     {@link runForDelegation}. That is defensible only because it is a
  //     different op on a different METHOD with a different resolver and a
  //     different ladder, and because the row it selects was written by a
  //     human. A refactor that "unified the two handlers" on the strength
  //     of the paragraph above, without reading this one, would make a
  //     correlation handle authority-bearing on the trigger path — the
  //     confused deputy in its textbook form.
  let jobRef: string | undefined;
  if (params.jobRef !== undefined) {
    if (!isValidJobRef(params.jobRef)) {
      return deny(
        "WORKFLOWS_BAD_PAYLOAD",
        `'jobRef' must be an id-shaped string of at most ${MAX_JOB_REF_LEN} characters`,
        -32602,
      );
    }
    jobRef = params.jobRef;
  }

  // 11. Hourly quota — the real spend bound on this capability.
  const quota = checkHourlyQuota(ctx.extensionId, granted.maxRunsPerHour);
  if (!quota.ok) {
    return deny(
      "WORKFLOWS_QUOTA_EXCEEDED",
      "workflow trigger quota exceeded",
      -32103,
      { used: quota.used, maxRunsPerHour: granted.maxRunsPerHour },
    );
  }

  // 12. Resolve against the LIVE merged cache. The namespace prefix is
  //     applied HERE, host-side, from the registry-resolved extension name
  //     — so `find(w => w.name === …)` can only ever land on this
  //     extension's own asset.
  const runtime = getWorkflowRuntime();
  if (!runtime) {
    return deny(
      "WORKFLOWS_RUNTIME_UNAVAILABLE",
      "Workflow runtime unavailable in this context",
      -32603,
    );
  }
  const fullName = namespacedWorkflowName(ctx.extensionName, name);
  const decisionEntry = runtime.getCachedWorkflows?.().find(entry => entry.definition.name === fullName);
  if (decisionEntry?.source !== "extension") {
    return deny("WORKFLOW_NOT_FOUND", `Workflow not found: ${fullName}`, -32602);
  }

  // 13. Dispatch. Non-blocking: `runWorkflow` awaits the entire graph, which
  //     routinely outlives the host reverse-RPC timeout. The projectId is
  //     derived server-side from the calling conversation — never the wire.
  const projectId = ctx.conversationId
    ? ((await getConversation(ctx.conversationId))?.projectId ?? undefined)
    : undefined;

  // 12b. The SHARED run ladder — the same `canRunWorkflow` the REST route
  //      and the `run_workflow` built-in ask, so this path cannot become
  //      the one way to start a workflow the caller could not otherwise
  //      start. Every rung above bounds the EXTENSION (its grant, its
  //      manifest, its quota); this one bounds the WORKFLOW, and its live
  //      extension-liveness re-check is the rule the rungs above do not
  //      express: `reloadWorkflows()` fires only on workflow CRUD, so a
  //      DISABLED extension's workflows stay runnable off the stale merged
  //      cache until something writes a workflow or the process restarts.
  //
  //      Ordered here, after rung 12, because it must authorize the entry
  //      the executor will ACTUALLY run rather than a re-lookup by name —
  //      the same requirement `canRunWorkflow`'s own doc states.
  //
  //      A STRICT TIGHTENING, never a widening: an extension-shipped
  //      workflow is a `system` cache entry, whose run audience is
  //      "anyone", so the ladder rung itself refuses nobody this handler
  //      already admitted. What it adds is the liveness check.
  const runnable = await canRunWorkflow(
    decisionEntry,
    // `role: "member"` — the LOWER privilege, deliberately. A reverse-RPC
    // provenance token carries a user id, not a role, and `context.ts`
    // takes exactly this reading for nested runs: "the safe reading of
    // 'we do not know' is the lower privilege". It costs nothing on the
    // entries this handler can address (all `system`), and it means a
    // future `private` row squatting an extension-namespaced name is
    // refused here rather than waved through on an assumed role.
    { id: ownedCtx.userId, role: "member" },
    projectId ?? null,
  );
  if (!runnable.allowed) {
    return deny("WORKFLOWS_PERM_DENIED", runnable.reason);
  }

  try {
    startWorkflowRun(runtime, decisionEntry.definition, input, projectId, ownedCtx, jobRef);
  } catch (err) {
    return deny(
      "WORKFLOWS_DISPATCH_FAILED",
      `Workflow dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      -32603,
    );
  }

  await audit(ctx, startedAt, deps, {
    success: true,
    // The handle is on the audit row too, so the capability trail and the
    // `workflow_runs` row name the same job without a join through the
    // extension's private storage.
    after: { workflow: fullName, ...(jobRef !== undefined ? { jobRef } : {}) },
    resourceId: fullName,
  });

  // NO run id in the response — deliberately. `runWorkflow` mints its id
  // internally and only surfaces it on the returned `WorkflowRun` and the
  // `workflow:start` event, neither of which this non-blocking path can read
  // without awaiting the whole graph. Returning a host-minted correlation id
  // instead would hand the extension a value that matches no `workflow_runs`
  // row — worse than returning none. Correlate with `op: "runs"`, which
  // lists this extension's runs newest-first for the acting user; the
  // `workflow:start` event is NOT an option (see the module doc).
  return rpcResult(req.id, { v: 1, workflow: fullName, started: true });
}

/** The caller's own `deny` closure — it owns the audit row, so the read
 *  path borrows it rather than writing a second one that could drift. */
type DenyFn = (
  reason: WorkflowTriggerDenyReason,
  message: string,
  code?: number,
) => Promise<JsonRpcResponse>;

/**
 * `op: "approvals"` — the parked decisions this extension's workflows are
 * waiting on, for the ACTING USER, each carrying its verbatim relay.
 *
 * ## Why this exists at all
 *
 * A trigger is fire-and-forget: `runWorkflow` is not awaited and the
 * response deliberately carries no run id, because a graph with agent
 * steps outlives the reverse-RPC budget. So by the time a run parks on an
 * approval — routinely minutes later, after the agent steps that decide
 * what the human is even being asked about — the tool result that started
 * it is long gone. Without a read, an extension driving a workflow from a
 * chat has NO way to learn its run is waiting on the user, and the LLM
 * simply goes quiet on a question it should be relaying.
 *
 * ## The relay is the point
 *
 * Every entry carries `formatGateRelay(...)`, which is the only thing that
 * renders a parked approval for an LLM and always leads with the
 * "relay verbatim, do not pre-judge, STOP" directive (ported invariant 2).
 * The caller cannot get the items without it — there is no other exported
 * shape to reach for.
 *
 * ## Scoping
 *
 * Two filters, both structural:
 *
 *   - **The user.** `listPendingWorkflowApprovalsForUser` joins on the
 *     RUN's owner, and an unowned run is admin-only. The extension never
 *     passes an admin flag, so it sees the acting user's runs and no one
 *     else's — the prompt text names what is about to be done and to what.
 *   - **The extension's own workflows.** Restricted to the GRANTED names,
 *     namespaced host-side exactly as rung 12 does it, so the wire can
 *     never express another extension's asset.
 *
 * It reuses the `workflows` grant rather than introducing a second one: a
 * read of parked approvals for workflows you are already permitted to RUN
 * is strictly narrower than the trigger you hold. It does NOT consume the
 * hourly run quota — see the branch that routes here.
 */
async function readApprovals(
  req: JsonRpcRequest,
  ctx: WorkflowsHandlerContext,
  startedAt: number,
  deps: WorkflowsHandlerDeps,
  grantedNames: string[],
  deny: DenyFn,
): Promise<JsonRpcResponse> {
  // Rung 7 — a bound acting user. The whole result set is defined by who
  // is asking, so an ownerless read is not a narrower read, it is a
  // different question with no answer.
  if (!ctx.userId || ctx.userId === "unknown") {
    return rpcError(
      req.id,
      -32106,
      "Reading parked approvals requires an acting user — there is no owner whose decisions to list",
      { reason: "WORKFLOWS_NO_OWNER" },
    );
  }
  // Rung 8 — the same wiring gate the trigger clears.
  if (ctx.conversationId) {
    const wired = await getConversationExtensionIds(ctx.conversationId);
    if (!wired.includes(ctx.extensionId)) {
      return deny("WORKFLOWS_NOT_WIRED", "Extension not wired to this conversation");
    }
  }
  // Rung 9 — the instantaneous bucket still applies. A read is cheap, not
  // free, and this one runs a join.
  if (!consumeTokens(ctx.extensionId, 1)) {
    return deny("WORKFLOWS_RATE_LIMITED", "Rate limited", -32029);
  }

  const mine = new Set(
    grantedNames.map((n) => namespacedWorkflowName(ctx.extensionName, n)),
  );
  const pending = await listPendingWorkflowApprovalsForUser(ctx.userId);
  const approvals = pending
    .filter((p) => mine.has(p.workflowName))
    .map((p) => ({
      approvalId: p.approval.id,
      workflowRunId: p.workflowRunId,
      workflowName: p.workflowName,
      stepName: p.approval.stepName,
      choices: p.approval.choices ?? [],
      requireItemConsent: p.approval.requireItemConsent,
      itemIds: p.approval.itemIds ?? [],
      expiresAt: p.approval.expiresAt ? p.approval.expiresAt.toISOString() : null,
      relay: formatGateRelay({
        workflowName: p.workflowName,
        stepName: p.approval.stepName,
        prompt: p.approval.prompt,
        choices: p.approval.choices ?? [],
        requireItemConsent: p.approval.requireItemConsent,
        itemIds: p.approval.itemIds ?? [],
      }),
    }));

  await audit(ctx, startedAt, deps, {
    success: true,
    after: { op: "approvals", count: approvals.length },
  });
  return rpcResult(req.id, { v: 1, approvals });
}

/** Default / ceiling page size for `op: "runs"`. Deliberately far below
 *  the route's `RUN_PAGE_MAX` (200): this is a correlation poll on a
 *  reverse-RPC channel, not a history browser. */
export const RUNS_PAGE_DEFAULT = 20;
export const RUNS_PAGE_MAX = 50;

/**
 * `op: "runs"` — the run history of THIS extension's workflows, for the
 * ACTING USER, newest first.
 *
 * ## Why this exists at all
 *
 * `run()` is fire-and-forget and returns no run id (see rung 13), and the
 * `workflow:*` bus events are structurally undeliverable to an extension
 * (see the module doc). Without this read there is NO path from a fired
 * trigger to a `workflow_runs` row — an extension could start work and
 * then never learn whether it succeeded, failed, or parked. That is the
 * gap this closes, and it is the whole reason `run()` returning no id is
 * tolerable.
 *
 * ## Scoping — the same two structural filters `readApprovals` uses
 *
 *   - **The user.** `listWorkflowRunsForCaller` pushes `user_id` into the
 *     WHERE and is called with `isAdmin: false` UNCONDITIONALLY — an
 *     extension is never an admin, so a run it did not initiate on this
 *     user's behalf is not its business. An unowned run (CLI / scheduled
 *     fire) matches no user filter and is therefore admin-only, the same
 *     fail-closed reading `mayControlRun` takes.
 *   - **The extension's own workflows.** Restricted to the GRANTED names,
 *     namespaced host-side exactly as rung 12 does it, so the wire can
 *     never express another extension's asset — nor the host's
 *     identically-named one.
 *
 * Both filters are in the QUERY, not applied to the result: post-filtering
 * a keyset page returns short pages that read as "no more runs".
 *
 * The rows carry no `input` and no `result` — `WorkflowRunSummary` is
 * already the shape that omits `input` for being the untrusted payload
 * surface, and `result` is unbounded agent output that would blow the
 * reverse-RPC frame. A caller who needs either opens the run in the trace
 * UI, where the redaction and the per-run authorization both apply.
 *
 * Like `approvals`, it reuses the `workflows` grant (reading the history
 * of runs you are permitted to START is strictly narrower than starting
 * them) and does NOT consume the hourly run quota.
 */
async function readRuns(
  req: JsonRpcRequest,
  ctx: WorkflowsHandlerContext,
  startedAt: number,
  deps: WorkflowsHandlerDeps,
  grantedNames: string[],
  deny: DenyFn,
): Promise<JsonRpcResponse> {
  // Rung 7 — a bound acting user. The result set is defined by who is
  // asking, so an ownerless read is not a narrower read; it is a different
  // question with no answer.
  if (!ctx.userId || ctx.userId === "unknown") {
    return rpcError(
      req.id,
      -32106,
      "Reading workflow runs requires an acting user — there is no owner whose runs to list",
      { reason: "WORKFLOWS_NO_OWNER" },
    );
  }
  // Rung 8 — the same wiring gate the trigger clears.
  if (ctx.conversationId) {
    const wired = await getConversationExtensionIds(ctx.conversationId);
    if (!wired.includes(ctx.extensionId)) {
      return deny("WORKFLOWS_NOT_WIRED", "Extension not wired to this conversation");
    }
  }
  // Rung 9 — the instantaneous bucket still applies. A read is cheap, not
  // free, and this one is a keyset scan.
  if (!consumeTokens(ctx.extensionId, 1)) {
    return deny("WORKFLOWS_RATE_LIMITED", "Rate limited", -32029);
  }

  // Rung 10 — payload. `workflow` is OPTIONAL here (unlike a trigger,
  // which is meaningless without a name): absent means "every workflow I
  // am granted". When present it is authorized exactly as rung 5 does it,
  // against the GRANT, so narrowing can never widen.
  const params = (req.params ?? {}) as Record<string, unknown>;
  let names = grantedNames;
  if (params.workflow !== undefined) {
    const one = params.workflow;
    if (!isValidWorkflowName(one) || !grantedNames.includes(one)) {
      return deny(
        "WORKFLOW_NOT_GRANTED",
        "'workflow' must be a bare workflow name this extension is granted",
        -32602,
      );
    }
    names = [one];
  }
  let limit = RUNS_PAGE_DEFAULT;
  if (params.limit !== undefined) {
    const raw = params.limit;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > RUNS_PAGE_MAX) {
      return deny(
        "WORKFLOWS_BAD_PAYLOAD",
        `'limit' must be an integer 1..${RUNS_PAGE_MAX}`,
        -32602,
      );
    }
    limit = raw;
  }
  let status: WorkflowRunStatus | undefined;
  if (params.status !== undefined) {
    const raw = params.status;
    if (typeof raw !== "string" || !RUN_STATUS_FILTERS.has(raw)) {
      return deny(
        "WORKFLOWS_BAD_PAYLOAD",
        `'status' must be one of: ${[...RUN_STATUS_FILTERS].join(", ")}`,
        -32602,
      );
    }
    status = raw as WorkflowRunStatus;
  }

  const page = await listWorkflowRunsForCaller(
    {
      workflowNames: names.map((n) => namespacedWorkflowName(ctx.extensionName, n)),
      limit,
      ...(status !== undefined ? { status } : {}),
    },
    // NEVER `isAdmin: true` — an extension holds no role, and admin here
    // would drop the ownership filter entirely.
    { userId: ctx.userId, isAdmin: false },
  );
  const runs = page.runs.map((r) => ({
    workflowRunId: r.id,
    workflowName: r.workflowName,
    status: r.status,
    projectId: r.projectId,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    suspendedReason: r.suspendedReason,
    resumable: r.resumable,
    // THE CORRELATION. `run()` returns no run id (rung 13), so this is
    // how a caller learns which of its own runs came from which of its
    // own jobs. It is the caller's own handle coming back — the host
    // stored it verbatim and resolves nothing — so returning it leaks
    // nothing the caller did not already know, and the read is already
    // scoped to this extension's workflows and this user's runs.
    jobRef: r.jobRef,
  }));

  await audit(ctx, startedAt, deps, {
    success: true,
    after: { op: "runs", count: runs.length },
  });
  return rpcResult(req.id, { v: 1, runs });
}

// ── C3 · `op: "runFor"` — the delegated ladder (D1–D10) ────────────────

/**
 * Deny a delegated rung: the typed code, the message, an optional JSON-RPC
 * code and an optional audit `after` blob.
 *
 * Named rather than written inline at each of its four sites so that the
 * rungs, {@link lostAccess} and {@link parkConsentStaleRun} provably take
 * the SAME closure — the one that already knows the proven attribution
 * and therefore the audit destination. A helper that accepted a
 * structurally-similar function would let a future rung pass one that
 * audits somewhere else.
 */
type DelegatedDenyFn = (
  reason: WorkflowTriggerDenyReason,
  message: string,
  code?: number,
  after?: Record<string, unknown>,
) => Promise<JsonRpcResponse>;

/**
 * A live delegation plus the principal it was PROVED to carry.
 *
 * "Proved" is the load-bearing word and it is the same principle PR #58's
 * `holdsClaim` applies to a lease: naming an owner the platform cannot
 * resolve proves nothing, so rung D4 re-reads the `users` /
 * `service_accounts` row and this struct only exists downstream of it.
 * Everything below D4 audits against `onBehalfOf`, and an unproven owner
 * id there is an FK violation, a swallowed insert, and a denial with no
 * trail.
 */
interface ProvenDelegation {
  row: WorkflowDelegationRow;
  ownerKind: DelegationOwnerKind;
  ownerId: string;
  /** `sdk_capability_calls.on_behalf_of`, or null ⇒ route to `audit_log`. */
  onBehalfOf: string | null;
  /** The `audit_log` action used when `onBehalfOf` is null. */
  ownerlessAction: string;
}

/**
 * D4's outcome. The message names the REMEDY, because the two arms have
 * completely different ones (re-invite the user vs re-enable the
 * account).
 *
 * The success arm carries `dailyTokenCap` so that rung D10 reads the
 * account's `max_tokens_per_day` off the SAME row that just proved the
 * account is live, rather than issuing a second `service_accounts` read
 * that could see a different row. `null` means "this principal kind has
 * no daily token bound" and is the honest answer for `user`: there is no
 * such column on `users`, and inventing a default here would be a number
 * nobody chose.
 */
type OwnerResolution =
  | { ok: true; dailyTokenCap: number | null }
  | { ok: false; message: string };

/**
 * Rung D4, per owner kind — is the principal this row names still live?
 *
 * A KEYED LOOKUP, third and last of the trio (`DELEGATION_OWNER_COLUMN`,
 * `DELEGATION_PRINCIPAL`, this): a third principal kind is one entry here
 * and a compile error until it is written.
 *
 * `user` asks ONE question — `status === "active"` — rather than
 * separating "gone" from "deactivated", and the reason is that only one
 * of those can arrive here. `owner_user_id` is `ON DELETE CASCADE`
 * (`db/schema.ts:615`), so a DELETED user takes the delegation with them
 * and the fire dies at D2 with `DELEGATION_NOT_FOUND`. What survives a
 * user going away is a DEACTIVATED row, which is live, FK-valid, and
 * belongs to somebody who may no longer act — precisely this rung. A
 * second branch for the deleted case would be a message no user can ever
 * read, and an untestable line pretending otherwise.
 *
 * `service` demands `enabled`, which is what {@link findLiveServiceAccount}
 * already filters on for the consent route, so the two agree by sharing
 * the reader rather than by luck.
 *
 * Each arm also states its own DAILY TOKEN BOUND, and stating it here is
 * what makes rung D10 total: a third principal kind is a compile error
 * until somebody decides whether it has one, instead of silently
 * inheriting "unbounded" from a `switch` that fell through.
 */
const RESOLVE_DELEGATION_OWNER = {
  user: async (ownerId: string): Promise<OwnerResolution> => {
    const user = await getUserById(ownerId);
    // `users` carries no per-day token column and deliberately gets no
    // invented default. A `user` delegation is bounded by its own
    // `max_tokens_per_run` and `max_runs_per_day`, which is the product
    // the human agreed to at consent time.
    if (user?.status === "active") return { ok: true, dailyTokenCap: null };
    return { ok: false, message: "the user who delegated this job can no longer act" };
  },
  service: async (ownerId: string): Promise<OwnerResolution> => {
    const account = await findLiveServiceAccount(ownerId);
    if (account === undefined) {
      return {
        ok: false,
        message: "the service account this job runs as is disabled or no longer exists",
      };
    }
    // `NOT NULL` in the schema with no "unlimited" value
    // (`db/schema.ts` — `max_tokens_per_day`), so this is always a real
    // number and D10 always has something to compare against.
    return { ok: true, dailyTokenCap: account.maxTokensPerDay };
  },
} as const satisfies Record<DelegationOwnerKind, (ownerId: string) => Promise<OwnerResolution>>;

/**
 * `op: "runFor"` — fire a workflow this extension does NOT ship, as the
 * principal a human already consented to.
 *
 * ## The wire carries a job ref and NEVER a principal
 *
 * This is the strongest property in the feature and the reason D5 does
 * not exist. `jobRef` is the ONLY caller-supplied value with any
 * authority-adjacent role, and even that one is a lookup KEY rather than
 * a claim: the owner, the workflow name and the project all come off the
 * `workflow_delegations` row, keyed on the REGISTRY-resolved extension id.
 * So "invent an owner" is not denied, it is INEXPRESSIBLE — there is no
 * field for it, and a forged ref matches zero rows at D2.
 *
 * That also settles what {@link isValidJobRef} means on this op, and it
 * is the opposite of what it means on the `run` op (see the comment at
 * that site): **here the `jobRef` selects the authority.** It still
 * grants nothing by itself — it names a row that a human wrote, and every
 * rung below re-asks that row's questions against live state.
 *
 * ## The ladder, in order, with its audit destination
 *
 * | rung | check | deny code | audits to |
 * |---|---|---|---|
 * | 1   | capability tier off | `WORKFLOWS_DISABLED` | per caller |
 * | 1b  | `EZCORP_DISABLE_DELEGATED_WORKFLOWS` | `DELEGATION_DISABLED` | per caller |
 * | 2   | structural grant | `WORKFLOWS_NOT_GRANTED` | per caller |
 * | 2b  | `allowDelegated` on the grant | `DELEGATION_NOT_GRANTED` | per caller |
 * | 6   | PDP `ezcorp:workflows:run-delegated` | `WORKFLOWS_PERM_DENIED` | per caller |
 * | D1  | `jobRef` shape | `DELEGATION_BAD_REF` | per caller |
 * | 8   | wiring, when a conversation is present | `WORKFLOWS_NOT_WIRED` | per caller |
 * | 9   | instantaneous rate limit | `WORKFLOWS_RATE_LIMITED` | per caller |
 * | 10  | payload (`v`, `input`) | `WORKFLOWS_BAD_PAYLOAD` | per caller |
 * | 11  | extension hourly quota | `WORKFLOWS_QUOTA_EXCEEDED` | per caller |
 * | D2  | live delegation for (extension, job) | `DELEGATION_NOT_FOUND` | per caller |
 * | D4  | owner resolves to a live principal | `DELEGATION_OWNER_UNRESOLVED` | **`audit_log`, both kinds** |
 * | D3  | `enabled` | `DELEGATION_DISABLED_ROW` | per owner kind |
 * | D7  | owner may still RUN it + extension live | `DELEGATION_OWNER_LOST_WORKFLOW_ACCESS` / `DELEGATION_WORKFLOW_NOT_FOUND` | per owner kind |
 * | D6  | consent hash | `DELEGATION_CONSENT_STALE` (**parks the run**) | per owner kind |
 * | D8  | `max_runs_per_day`, UTC calendar day | `DELEGATION_QUOTA_EXCEEDED` | per owner kind |
 * | D9  | `max_tokens_per_run` admits work | `DELEGATION_SPEND_EXCEEDED` | per owner kind |
 * | D10 | owner's `max_tokens_per_day` (**`service` only**) | `DELEGATION_DAILY_TOKENS_EXCEEDED` | **`audit_log`** |
 * | 13  | dispatch | `WORKFLOWS_DISPATCH_FAILED` | per owner kind |
 *
 * "per caller" is `ctx.userId`: `sdk_capability_calls` for an in-chat
 * call, `audit_log` for the background fire this op almost always is.
 * "per owner kind" is {@link DELEGATION_AUDIT_ON_BEHALF_OF}.
 *
 * ## Three deliberate deviations from the plan's rung order
 *
 *  1. **D4 runs before D3.** The plan orders them lookup → enabled →
 *     owner. Attribution has to be PROVED before any outcome is audited
 *     against it, because `sdk_capability_calls.on_behalf_of` is NOT NULL
 *     with an FK to `users`; auditing a D3 denial against an owner id
 *     nobody checked is a swallowed insert. The reorder costs one query
 *     on a disabled row and buys a correct trail for every rung below it.
 *  2. **D7 runs before D6.** D6 needs the ROOT DEFINITION to hash, and
 *     the only ownership-aware way to get it is the resolution D7 already
 *     performs. Hashing first would also mean computing a fingerprint of
 *     a graph the owner is not allowed to run.
 *  3. **8/9/10/11 run before D2.** They are the caller's own payload and
 *     the extension's own budgets, and the `run` op asks them before its
 *     own expensive resolution rung too. Ordering them after four
 *     database round trips would make a malformed frame cost more than a
 *     valid one.
 *
 * Rungs 3, 4, 5 and 12 have no delegated counterpart: 3/4/5 are per-NAME
 * checks against a name the wire cannot express, and 12's resolution IS
 * D7 (§1.3 — D7 is the replacement bound for 4–5, and its strength is
 * exactly the strength of the read/run ladder).
 */
async function runForDelegation(
  req: JsonRpcRequest,
  ctx: WorkflowsHandlerContext,
  startedAt: number,
  deps: WorkflowsHandlerDeps,
  granted: NonNullable<ExtensionPermissions["workflows"]>,
  deny: DelegatedDenyFn,
): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as Record<string, unknown>;

  // 2b. The delegated opt-in. Deliberately its own rung rather than a
  //     widening of rung 2: rung 2 asks whether the grant is structurally
  //     usable at all (and, since C3, tolerates an empty `names` list for
  //     exactly this case), while this asks whether the extension was
  //     admitted to the delegated tier. A grant that clears rung 2 on the
  //     `allowDelegated` exception and does NOT hold the bit is a
  //     hand-edited row, and it must not fire anything.
  if (granted.allowDelegated !== true) {
    return deny("DELEGATION_NOT_GRANTED", "delegated workflow runs not granted");
  }

  // 6. PDP — the canonical decision. KIND-ONLY, with no value: the cap
  //    cannot be per-job because job refs are minted AFTER install by a
  //    human consent action, so an install-time grant cannot enumerate
  //    them (`capability-types.ts`). The per-job bound is the delegation
  //    row, which every rung below re-reads. A SEPARATE kind from
  //    `ezcorp:workflows:run`, because that one is clamped to the
  //    extension's own assets and reusing it would relax exactly the
  //    per-name clamp it exists to enforce.
  if (ctx.engine) {
    const decision = await ctx.engine.authorize(
      {
        extensionId: ctx.extensionId,
        userId: ctx.userId || null,
        conversationId: ctx.conversationId,
        toolName: DELEGATED_WORKFLOWS_METHOD,
      },
      [{ kind: "ezcorp:workflows:run-delegated" }],
    );
    if (decision.decision === "deny") {
      return deny("WORKFLOWS_PERM_DENIED", "delegated workflow runs not granted");
    }
  }

  // D1. The job ref — SHAPE only, and the shape is the same one the `run`
  //     op checks, from the same predicate. What differs is what a valid
  //     one MEANS; see the header.
  if (!isValidJobRef(params.jobRef)) {
    return deny(
      "DELEGATION_BAD_REF",
      `'jobRef' must be an id-shaped string of at most ${MAX_JOB_REF_LEN} characters`,
      -32602,
    );
  }
  const jobRef = params.jobRef;

  // 8. Wiring gate — shared verbatim with the `run` op. A delegated fire
  //    normally carries no conversation at all (it is a cron/webhook
  //    tick), so this is usually a no-op; it is asked anyway so that the
  //    in-chat case cannot reach a conversation the extension is not
  //    wired to.
  if (ctx.conversationId) {
    const wired = await getConversationExtensionIds(ctx.conversationId);
    if (!wired.includes(ctx.extensionId)) {
      return deny("WORKFLOWS_NOT_WIRED", "Extension not wired to this conversation");
    }
  }

  // 9. Instantaneous rate limit — the same bucket, keyed on the same
  //    extension id, so a delegated fire cannot be used to double an
  //    extension's burst budget.
  if (!consumeTokens(ctx.extensionId, 1)) {
    return deny("WORKFLOWS_RATE_LIMITED", "Rate limited", -32029);
  }

  // 10. Payload. `workflow` is NOT read here and there is nothing to
  //     read: R-5 removed the name from the wire, which is what makes a
  //     "delegation for A presented to run B" denial unnecessary — the
  //     value has no representation to disagree with.
  if (params.v !== 1) {
    return deny("WORKFLOWS_BAD_PAYLOAD", "Missing or invalid 'v' (expected 1)", -32602);
  }
  const inputCheck = readWorkflowInput(params.input);
  if (!inputCheck.ok) {
    return deny("WORKFLOWS_BAD_PAYLOAD", inputCheck.message, -32602);
  }
  const input = inputCheck.input;

  // 11. The extension's hourly run quota — the same window the `run` op
  //     consumes, deliberately shared: an extension holding both verbs
  //     must not get two budgets.
  const quota = checkHourlyQuota(ctx.extensionId, granted.maxRunsPerHour);
  if (!quota.ok) {
    return deny("WORKFLOWS_QUOTA_EXCEEDED", "workflow trigger quota exceeded", -32103, {
      used: quota.used,
      maxRunsPerHour: granted.maxRunsPerHour,
    });
  }

  // D2. THE lookup. Keyed on the registry-resolved extension id and the
  //     caller's ref, filtered to live (un-revoked) rows. A forged or
  //     stale ref lands here with nothing to show for it.
  //
  //     `enabled` is deliberately NOT in this predicate
  //     (`db/queries/workflow-delegations.ts` — the fire-path reader):
  //     a disabled row must come back so D3 can refuse with its
  //     `disabled_reason` instead of an indistinguishable "no such
  //     delegation", which is the whole remedy path for a job the
  //     platform switched off.
  const row = await findLiveWorkflowDelegation(ctx.extensionId, jobRef);
  if (row === undefined) {
    return deny("DELEGATION_NOT_FOUND", "no live delegation for this job");
  }

  // D4. Owner resolution — BEFORE D3, see deviation 1 in the header.
  const ownerKind = row.ownerKind;
  const ownerId = delegationOwnerId(row);
  const ownerlessAction = DELEGATION_AUDIT_LOG_ACTION[ownerKind];
  if (ownerId === null) {
    // A row on the mapped arm with a NULL id: the exact "enabled, valid
    // consent hash, names NOBODY" state the CASCADE FKs and the query
    // layer's `ownerColumnValues` exist to make unreachable. Refused
    // rather than trusted, because a latent ownerless grant is what
    // `-32106` exists to prevent.
    return denyDelegated(req, ctx, startedAt, deps, null, ownerlessAction, row, {
      reason: "DELEGATION_OWNER_UNRESOLVED",
      message: "this delegation names no owner",
    });
  }
  const owner = await RESOLVE_DELEGATION_OWNER[ownerKind](ownerId);
  if (!owner.ok) {
    // `audit_log` for BOTH kinds — an owner that does not resolve is
    // exactly the value the `on_behalf_of` FK would reject.
    return denyDelegated(
      req,
      ctx,
      startedAt,
      deps,
      null,
      EXT_AUDIT_ACTIONS.WORKFLOW_DELEGATION_NO_OWNER,
      row,
      {
        reason: "DELEGATION_OWNER_UNRESOLVED",
        message: `This job cannot run: ${owner.message}.`,
        code: -32106,
      },
    );
  }
  const proven: ProvenDelegation = {
    row,
    ownerKind,
    ownerId,
    onBehalfOf: DELEGATION_AUDIT_ON_BEHALF_OF[ownerKind](ownerId),
    ownerlessAction,
  };
  /** Every rung from here down audits against the PROVEN attribution. */
  const denyAs: DelegatedDenyFn = (reason, message, code, after) =>
    denyDelegated(req, ctx, startedAt, deps, proven.onBehalfOf, proven.ownerlessAction, row, {
      reason,
      message,
      ...(code !== undefined ? { code } : {}),
      ...(after !== undefined ? { after } : {}),
    });

  // D3. The row is switched off. The reason is the payload: it is the
  //     only thing a user ever reads about why their job stopped, and
  //     phase 4 reserved a distinct code for the re-tiering case
  //     precisely so this message is not generic.
  if (!row.enabled) {
    return denyAs(
      "DELEGATION_DISABLED_ROW",
      row.disabledReason ?? "this delegation is disabled",
    );
  }

  // D7. THE replacement bound for rungs 4–5. Asked as the principal the
  //     delegation CARRIES, which is a different principal from the human
  //     who consented whenever `owner_kind = 'service'`.
  const runtime = getWorkflowRuntime();
  if (!runtime) {
    return denyAs(
      "WORKFLOWS_RUNTIME_UNAVAILABLE",
      "Workflow runtime unavailable in this context",
      -32603,
    );
  }
  //     FAIL CLOSED on either reader being absent. `getCachedWorkflows`
  //     is what carries the provenance D7 authorizes against, and
  //     `listAgents` is what lets D6 hash an `agent` step as REACHABLE.
  //     A registration that cannot answer either has not earned a
  //     permissive default (`workflow/runtime-registry.ts`), and this
  //     path must NOT fall back to `cachedEntryFor`'s
  //     `systemCachedWorkflow` reconstruction the way rung 12b may: that
  //     fallback is a `system` entry, whose run audience is "anyone", so
  //     inheriting it here would turn "we cannot tell who owns this" into
  //     "everyone may run it" for a principal that is not even in the
  //     room.
  const entries = runtime.getCachedWorkflows?.();
  const agents = runtime.listAgents?.();
  if (entries === undefined || agents === undefined) {
    return denyAs(
      "DELEGATION_RUNTIME_UNAVAILABLE",
      "Workflow ownership is unreadable in this context, so a delegated run cannot be authorized",
      -32603,
    );
  }
  //     The SHARED consent policy, not a second copy of it. The consent
  //     route asks `authorizeDelegationConsent` before writing the row;
  //     this asks the identical function at every fire, because a
  //     fire-time answer that disagreed with the consent-time one either
  //     grants authority the human never saw or stales every fire of a
  //     delegation nobody can fix.
  const authz = authorizeDelegationConsent(entries, row.workflowName, ownerKind, ownerId);
  if (!authz.ok) {
    if (authz.code === DELEGATION_CONSENT_DENIALS.NOT_FOUND) {
      return denyAs("DELEGATION_WORKFLOW_NOT_FOUND", authz.message, -32602);
    }
    return lostAccess(denyAs, row, authz.message);
  }
  //     Rule 1 of `canRunWorkflow`, which the ladder itself does not
  //     express: is the extension that owns this name still installed and
  //     enabled? `reloadWorkflows()` fires only on workflow CRUD, so a
  //     disabled extension's workflows stay runnable off the stale merged
  //     cache until something writes a workflow or the process restarts.
  //     The whole of `canRunWorkflow` is unusable here — its
  //     `WorkflowPrincipal.id` is a non-null `string`, which a `service`
  //     delegation cannot satisfy — so the shared half is imported and
  //     the ladder half comes from the consent policy above.
  const live = await workflowExtensionLiveness(authz.entry.definition.name, authz.entry);
  if (!live.allowed) {
    return lostAccess(denyAs, row, live.reason);
  }
  if (authz.entry.extensionRelease && !await workflowReleaseCanAccess(authz.entry, ownerId, row.projectId)) return lostAccess(denyAs, row, "Workflow release is not available to this principal.");
  const definition = authz.entry.definition;

  // D6. The consent record, recomputed from LIVE state and reconciled.
  //     The stored value is never compared against itself.
  //
  //     Same assembly as the consent route, imported rather than
  //     reimplemented, and handed the OWNER'S-AND-KIND'S resolver: a
  //     `service` delegation walks a strictly smaller graph than a `user`
  //     one and must hash to a different value.
  //
  //     ## Reconciled, not compared — and that is the whole rung now
  //
  //     This used to be `record.consentHash !== row.consentHash` over ONE
  //     digest that folded the workflow definition in with the semantic
  //     surface. A BUNDLED extension ships its workflows inside the app
  //     image, so any release that edited an `ez-factory`
  //     `*.workflow.yaml`, its permissions block, or a referenced agent's
  //     capabilities moved that digest and parked EVERY delegation. The
  //     job stopped after every deploy and the only remedy was a human
  //     re-approving a capability set that had not changed — which is how
  //     a consent dialog stops being read.
  //
  //     `workflow-consent-reconcile.ts` owns the verdict, and the gate it
  //     applies is WIDENING: a recomputed capability closure that adds a
  //     key nobody approved parks exactly as before, while one that is
  //     unchanged or NARROWER carries consent forward. Nothing that adds
  //     reach is admitted without a human, which is the property the
  //     combined digest was bought for.
  const record = await computeDelegationConsentRecord({
    entry: authz.entry,
    extensionName: ctx.extensionName,
    workflowName: row.workflowName,
    projectId: row.projectId,
    runAs: { kind: ownerKind, id: ownerId },
    trigger: { kind: row.triggerKind, spec: row.triggerSpec },
    principal: delegationPrincipal(ownerKind, ownerId),
    entries,
    agents,
  });
  const verdict = reconcileDelegationConsent(
    {
      consentHash: row.consentHash,
      definitionHash: row.definitionHash,
      capabilitySet: row.capabilitySet,
    },
    record,
  );
  if (verdict.kind === "park") {
    return parkConsentStaleRun(
      req, ctx, startedAt, deps, proven, definition, input, denyAs, verdict.added,
    );
  }
  if (verdict.kind === "carry") {
    await carryConsentForward(ctx, proven, record, verdict);
  }

  // D8. The per-job daily quota. DURABLE and a CALENDAR day, unlike the
  //     extension-wide hourly window at rung 11 which is in-memory: a
  //     restart must not refund the spend bound on an unattended job, and
  //     `startOfUtcDay` is the same helper the webhook daemon's own daily
  //     quota uses so two subsystems cannot mean two things by "per day".
  const usedToday = await countDelegationRunsSince(row.id, startOfUtcDay(new Date()));
  if (usedToday >= row.maxRunsPerDay) {
    return denyAs("DELEGATION_QUOTA_EXCEEDED", "delegation daily run quota exceeded", -32103, {
      used: usedToday,
      maxRunsPerDay: row.maxRunsPerDay,
    });
  }

  // D9. The token ceiling, at DISPATCH.
  //
  //     Be precise about what this rung can and cannot be. A run that has
  //     not started has spent nothing, so there is exactly one
  //     dispatch-time question `max_tokens_per_run` can answer: does the
  //     cap admit ANY work at all? A non-positive cap would start a run
  //     that parks at its very first boundary having produced nothing,
  //     and the `budget-exceeded` resume rule would then refuse to
  //     continue it — a run created solely to be permanently stuck. The
  //     enforcement that has teeth is the STEP-BOUNDARY check
  //     (`workflow-executor.ts` — `enforceDelegatedTokenBudget`), which
  //     `delegationId` below is the one and only gate on.
  if (row.maxTokensPerRun <= 0) {
    return denyAs(
      "DELEGATION_SPEND_EXCEEDED",
      `this delegation's token budget (${row.maxTokensPerRun}) admits no work`,
      -32103,
    );
  }

  // D10. `service_accounts.max_tokens_per_day` — the OWNER's daily token
  //      budget, across every delegation it owns.
  //
  //      ## Which of the two kinds of bound this is, said out loud
  //
  //      D9 above is explicit that a PER-RUN token bound asked at
  //      dispatch is structurally vacuous: the run has not started, so it
  //      has spent nothing, and the only question left is whether the cap
  //      admits any work at all. **This rung is not that.** Its numerator
  //      is every token this account's EARLIER runs reported today, which
  //      is a real, already-settled number that a fire arriving now can
  //      genuinely be over. The vacuity in D9 came from the run being
  //      empty; there is no such emptiness in a day.
  //
  //      What it does NOT do, and this is the same honest scope
  //      `enforceDelegatedTokenBudget` states for itself: it does not
  //      bound the run it admits. Nothing re-checks the daily total
  //      mid-run, so a single admitted run can carry the account past its
  //      day. That overshoot is visible in the step rows and the trace,
  //      and what it bounds is the NEXT fire — which is exactly the
  //      division of labour the executor's docblock names ("what bounds
  //      the next fire is the delegation's own daily limits, which are the
  //      handler's business rather than the executor's").
  //
  //      ## Three separate bounds, and this is the third
  //
  //      D8 counts RUNS for ONE delegation. The step-boundary ceiling
  //      counts TOKENS for ONE run. This counts TOKENS for ONE ACCOUNT
  //      across ALL of its delegations — the only one that can see an
  //      account whose ten jobs are each individually well-behaved. Its
  //      own deny code for the same reason every other rung has one: the
  //      three have three different remedies (wait for tomorrow / raise
  //      the delegation's cap / raise the ACCOUNT's cap, which is an
  //      admin action on a different object).
  //
  //      ## Last, and after D9
  //
  //      It is the broadest and the most expensive rung — an aggregate
  //      over a day of `workflow_step_runs` — so it runs only once every
  //      narrower question has passed. A job over its own per-run cap
  //      should hear about its own cap, not about the account's day.
  //
  //      `user` delegations skip it entirely: `dailyTokenCap` is null,
  //      because `users` has no such column and D4 says so rather than
  //      guessing.
  //
  //      ## The audit destination follows, it is not re-decided
  //
  //      `denyAs` closes over the PROVEN attribution, and a `service`
  //      outcome carries `onBehalfOf: null`
  //      (`DELEGATION_AUDIT_ON_BEHALF_OF`), which routes to `audit_log`
  //      with `ext:workflow-delegation-service` exactly as rung 7's
  //      ownerless path does. That is not a nicety:
  //      `sdk_capability_calls.on_behalf_of` is NOT NULL with an FK to
  //      `users`, so an attempt to file this denial there would be a
  //      swallowed insert and the refusal would VANISH. Since this rung is
  //      reachable ONLY on the `service` arm, `audit_log` is its only
  //      destination.
  if (owner.dailyTokenCap !== null) {
    const spentToday = await sumServiceAccountTokensSince(ownerId, startOfUtcDay(new Date()));
    if (spentToday >= owner.dailyTokenCap) {
      return denyAs(
        "DELEGATION_DAILY_TOKENS_EXCEEDED",
        `the service account this job runs as has spent its daily token budget ` +
          `(${spentToday}/${owner.dailyTokenCap})`,
        -32103,
        { spentToday, maxTokensPerDay: owner.dailyTokenCap },
      );
    }
  }

  // 13. Dispatch AS THE OWNER, writing the three C3 columns.
  //
  //     `projectId` comes from the delegation row and never from params —
  //     the same confused-deputy bound the github-projects handler
  //     documents.
  //
  //     `userId` is the OWNER for a `user` delegation, which is what
  //     scopes the `workflow:*` SSE stream to the person accountable for
  //     the run, and `undefined` for a `service` one, which has no
  //     session to stream to. That asymmetry is the documented trade in
  //     the owner-kind table: a service account buys durability by giving
  //     up live visibility, and the trace plus the audit row are how it
  //     is observed instead.
  try {
    startDelegatedRun(runtime, definition, input, proven, jobRef, ctx);
  } catch (err) {
    await recordDelegationRunOutcome(row.id, false);
    return denyAs(
      "WORKFLOWS_DISPATCH_FAILED",
      `Workflow dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      -32603,
    );
  }

  await auditDelegated(ctx, startedAt, deps, proven, {
    success: true,
    after: { workflow: row.workflowName, jobRef, runAs: ownerKind, delegationId: row.id },
    resourceId: row.workflowName,
  });
  return rpcResult(req.id, {
    v: 1,
    workflow: row.workflowName,
    runAs: ownerKind,
    started: true,
  });
}

/**
 * D7's refusal: the owner could run this workflow when the human
 * consented, and cannot now.
 *
 * **It DISABLES the delegation, and that is the point of the rung.**
 * Phase 4 reserved `DELEGATION_OWNER_LOST_WORKFLOW_ACCESS` and
 * deliberately left it unemitted precisely so that this behaviour would
 * arrive with its emitter: a workflow re-tiered out of the principal's
 * reach makes every subsequent fire fail, and without a stated
 * `disabled_reason` the job would accrue `consecutive_failures` silently
 * until the auto-disable threshold of 5 told the user only that it had
 * failed too often. The remedy needs the reason, and the reason exists
 * only here.
 *
 * Disabling is not destroying: `revoked_at` stays NULL, so the row is
 * still the human's consent record, and re-consenting supersedes it with
 * a fresh, enabled row (`createWorkflowDelegation`). The refusal is
 * therefore recoverable by exactly the person who granted the authority.
 */
async function lostAccess(
  denyAs: DelegatedDenyFn,
  row: WorkflowDelegationRow,
  reason: string,
): Promise<JsonRpcResponse> {
  const message =
    `This job stopped: ${reason} ` +
    `It ran before, so nothing you did is wrong — the workflow's access changed. ` +
    `Consent again to restart it.`;
  await disableWorkflowDelegation(row.id, message);
  return denyAs("DELEGATION_OWNER_LOST_WORKFLOW_ACCESS", message, -32001, {
    disabled: true,
  });
}

/**
 * D6's OTHER outcome: re-stamp the delegation and keep going.
 *
 * Reached when a release changed the job without widening what it may
 * reach — the case that used to park every delegation on a bundled
 * extension after every deploy. Two writes, in this order and for
 * different reasons:
 *
 *  1. **The row.** `carryDelegationConsentForward` re-stamps both digests
 *     AND the capability set. The set is the load-bearing one: leaving a
 *     narrowed set stale would let the release that puts the capability
 *     back re-grant it against a wider comparison with no human in the
 *     loop. It CASes on the old hash, so a re-consent that lands in the
 *     gap is never clobbered.
 *  2. **The audit row.** Without it, "the platform re-authorized this
 *     delegation for you" would be an event with no trace, which is the
 *     one shape a consent control must never have. `audit_log` for BOTH
 *     owner kinds, attributed to `consented_by_user_id` — the human
 *     answerable for the consent (`db/schema.ts`), and a NOT NULL column
 *     with an FK to `users`, so unlike `sdk_capability_calls.on_behalf_of`
 *     it can hold a `service` delegation's row rather than swallowing it.
 *
 * Neither failure stops the fire. The verdict was "nothing widened", so
 * the run is authorized whether or not the bookkeeping landed; refusing
 * here would turn a write hiccup into the same deploy-time outage this
 * change exists to remove. A failed re-stamp costs one more reconcile on
 * the next fire, and `insertAuditEntry` never throws by contract.
 */
async function carryConsentForward(
  ctx: WorkflowsHandlerContext,
  proven: ProvenDelegation,
  record: {
    consentHash: string;
    definitionHash: string;
    capabilitySet: Array<{ kind: string; value: string | null }>;
  },
  verdict: { removed: string[]; semanticChanged: boolean; definitionChanged: boolean },
): Promise<void> {
  const stamped = await carryDelegationConsentForward(proven.row.id, proven.row.consentHash, {
    consentHash: record.consentHash,
    definitionHash: record.definitionHash,
    capabilitySet: record.capabilitySet,
  });
  log.info("delegated consent carried forward — nothing widened", {
    extension: ctx.extensionName,
    delegationId: proven.row.id,
    workflow: proven.row.workflowName,
    stamped,
    removed: verdict.removed,
    definitionChanged: verdict.definitionChanged,
    semanticChanged: verdict.semanticChanged,
  });
  await insertAuditEntry(
    proven.row.consentedByUserId,
    EXT_AUDIT_ACTIONS.WORKFLOW_DELEGATION_REAUTHORIZED,
    ctx.extensionId,
    {
      permission: "workflows",
      newValue: proven.row.workflowName,
      actor: "system",
      reason: CONSENT_CARRIED_FORWARD_REASON,
      delegationId: proven.row.id,
      jobRef: proven.row.jobRef,
      removed: verdict.removed,
      definitionChanged: verdict.definitionChanged,
      semanticChanged: verdict.semanticChanged,
      stamped,
    },
  );
}

/**
 * D6's refusal: PARK the run, do not fail it.
 *
 * A hard failure trains authors to disable the check; a suspension with a
 * legible reason makes the security control the fastest path back to a
 * working job. So the run row is written and immediately moved to
 * `suspended` with `suspended_reason='consent-stale'`, at
 * `cursor.batchIndex = 0` with nothing completed — **before the first
 * step dispatches**, so nothing executes in the interim.
 *
 * ## Why a run row exists at all for a refusal
 *
 * Because it is the only thing a re-consent can resume. The row carries
 * `delegation_id`, and `RESUME_RULES["consent-stale"]` allows a resume
 * only once the delegation's `consented_at` is strictly after this run's
 * `started_at` — i.e. only after a human has looked at the diff and said
 * yes again. Refusing without a row would leave the human nothing to
 * restart and the work would have to be re-triggered by the extension,
 * which for a cron job means waiting for the next tick.
 *
 * ## No `workflow_approvals` row
 *
 * Deliberately, and it is not an omission for a later phase to fill.
 * `consent-stale` is NOT resumable by answering an approval — the resume
 * rule never reads `workflow_approvals` — so an approval row would be a
 * decision the platform would then refuse to honour, which is the
 * "looks fixed" failure mode in its purest form. The capability-set diff
 * belongs on the consent dialog, where re-consent actually happens.
 *
 * A park that loses the race (someone cancelled the run between the two
 * writes) leaves the run wherever the winner put it and still refuses the
 * fire: `suspendWorkflowRun` CASes on `status='running'` and returns 0,
 * and there is nothing this path could do with that which would not be
 * dragging a run back from a fate another writer already decided.
 */
async function parkConsentStaleRun(
  req: JsonRpcRequest,
  ctx: WorkflowsHandlerContext,
  startedAt: number,
  deps: WorkflowsHandlerDeps,
  proven: ProvenDelegation,
  definition: WorkflowDefinition,
  input: Record<string, unknown>,
  denyAs: DelegatedDenyFn,
  added: string[],
): Promise<JsonRpcResponse> {
  const workflowRunId = crypto.randomUUID();
  // The message names the COUNT, never the keys. A capability key can
  // carry a path, a host or a tool name, and this string lands in an RPC
  // error the calling extension reads — an extension that may not itself
  // hold any of those grants. The keys go to `audit_log` and the process
  // log, where the reader is the platform rather than the caller.
  const message =
    `What you consented to for "${proven.row.workflowName}" has changed: it now reaches ` +
    `${added.length} capability(s) you did not approve, so this run is parked instead of ` +
    `executing. Review the changes and consent again.`;
  try {
    await insertWorkflowRun({
      id: workflowRunId,
      workflowName: proven.row.workflowName,
      projectId: proven.row.projectId,
      // The OWNER, not the caller — a parked run belongs to the principal
      // it would have executed as, so it appears where that principal's
      // runs appear. NULL for a service account, as every service-owned
      // run is.
      userId: proven.ownerKind === "user" ? proven.ownerId : null,
      input,
      startedAt: new Date(startedAt),
      // The graph this run was authorized against. Written even though
      // nothing executes: the resume path compares it unconditionally, so
      // a run parked against one definition cannot silently resume into
      // another.
      definitionHash: workflowDefinitionHash(definition),
      jobRef: proven.row.jobRef,
      delegationId: proven.row.id,
      runAsKind: proven.ownerKind,
      runAs: proven.ownerId,
    });
    await suspendWorkflowRun(workflowRunId, {
      reason: "consent-stale",
      // Batch 0, nothing completed, no `$prev` — the same shape a fresh
      // run starts from, because that is exactly where this one will
      // resume from once consent is refreshed.
      cursor: { batchIndex: 0, completedSteps: [], prevStepName: null },
    });
  } catch (err) {
    // The park could not be written. Refuse the fire anyway and say so —
    // the alternative is executing under a consent the human has not
    // given, which is the one outcome this rung exists to prevent.
    log.error("consent-stale park failed; refusing the fire regardless", {
      extension: ctx.extensionName,
      delegationId: proven.row.id,
      added,
      error: String(err),
    });
    return denyAs("DELEGATION_CONSENT_STALE", message, -32001, { parked: false });
  }
  await auditDelegated(ctx, startedAt, deps, proven, {
    success: false,
    errorCode: "DELEGATION_CONSENT_STALE",
    errorMessage: message,
    after: {
      workflow: proven.row.workflowName,
      jobRef: proven.row.jobRef,
      delegationId: proven.row.id,
      workflowRunId,
      parked: true,
      // WHICH keys widened. The one place a reviewer can answer "what did
      // the release add" without re-deriving the closure by hand.
      added,
    },
  });
  return rpcError(req.id, -32001, message, {
    reason: "DELEGATION_CONSENT_STALE",
    workflowRunId,
  });
}

/** Audit one delegated outcome against the PROVEN attribution, then
 *  return the RPC error. One function so a rung cannot pick a deny code
 *  and an audit destination independently. */
async function denyDelegated(
  req: JsonRpcRequest,
  ctx: WorkflowsHandlerContext,
  startedAt: number,
  deps: WorkflowsHandlerDeps,
  onBehalfOf: string | null,
  ownerlessAction: string,
  row: WorkflowDelegationRow,
  spec: {
    reason: WorkflowTriggerDenyReason;
    message: string;
    code?: number;
    after?: Record<string, unknown>;
  },
): Promise<JsonRpcResponse> {
  await audit({ ...ctx, userId: onBehalfOf }, startedAt, deps, {
    success: false,
    errorCode: spec.reason,
    errorMessage: spec.message,
    action: DELEGATED_OP,
    ownerlessAction,
    resourceId: row.workflowName,
    after: {
      workflow: row.workflowName,
      jobRef: row.jobRef,
      delegationId: row.id,
      runAs: row.ownerKind,
      ...(spec.after ?? {}),
    },
  });
  return rpcError(req.id, spec.code ?? -32001, spec.message, { reason: spec.reason });
}

/** The accept / park half of {@link denyDelegated} — same attribution
 *  rule, same single writer. */
async function auditDelegated(
  ctx: WorkflowsHandlerContext,
  startedAt: number,
  deps: WorkflowsHandlerDeps,
  proven: ProvenDelegation,
  spec: {
    success: boolean;
    errorCode?: string;
    errorMessage?: string;
    after?: Record<string, unknown>;
    resourceId?: string;
  },
): Promise<void> {
  await audit({ ...ctx, userId: proven.onBehalfOf }, startedAt, deps, {
    ...spec,
    action: DELEGATED_OP,
    ownerlessAction: proven.ownerlessAction,
  });
}

/**
 * The most recent delegated dispatch's settled handle.
 *
 * The dispatch is deliberately UN-awaited (rung 13 — `runWorkflow` awaits
 * the whole graph and would blow the reverse-RPC budget), but its
 * `.then()` is where the failure counter is folded in, and that write is
 * the only durable evidence a delegated run's outcome was ever recorded.
 * A test that slept a few macrotasks and hoped would be exactly the kind
 * of timing-dependent assertion that passes on a fast machine and hides a
 * dropped write on a slow one.
 *
 * Never awaited by production code, and never read by it either.
 */
let lastDelegatedDispatch: Promise<void> = Promise.resolve();

/** Test-only: settle the last delegated dispatch's outcome fold. */
export function _awaitDelegatedDispatchForTests(): Promise<void> {
  return lastDelegatedDispatch;
}

/**
 * Start a delegated run WITHOUT awaiting it, and fold its outcome back
 * into the delegation's failure counter.
 *
 * The counter is the reason this is not `startWorkflowRun`: a delegated
 * job is unattended, so "it has failed five times in a row" is the only
 * signal anybody gets, and it must come from the run's real terminal
 * status rather than from the dispatch returning. Success RESETS it, so a
 * job that recovers is not one failure away from being switched off.
 */
function startDelegatedRun(
  runtime: WorkflowRuntime,
  definition: WorkflowDefinition,
  input: Record<string, unknown>,
  proven: ProvenDelegation,
  jobRef: string,
  ctx: WorkflowsHandlerContext,
): void {
  const promise = runtime.workflowExecutor.runWorkflow(
    definition,
    input,
    proven.row.projectId ?? undefined,
    // The OWNER scopes SSE delivery. A service account has none.
    proven.ownerKind === "user" ? proven.ownerId : undefined,
    undefined,
    {
      jobRef,
      // THE gate on the step-boundary token ceiling. Without this key the
      // ceiling never fires, which is why it is not merely bookkeeping.
      delegationId: proven.row.id,
      runAsKind: proven.ownerKind,
      runAs: proven.ownerId,
    },
  );
  lastDelegatedDispatch = promise
    .then(async (run) => {
      log.info("delegated workflow finished", {
        extension: ctx.extensionName,
        workflow: definition.name,
        workflowRunId: run.id,
        status: run.status,
        delegationId: proven.row.id,
      });
      // `suspended` is NOT a failure: a run parked on an approval or on
      // its token ceiling is waiting, not broken, and counting it would
      // auto-disable exactly the jobs that use approvals.
      if (run.status === "error") await recordDelegationRunOutcome(proven.row.id, false);
      else if (run.status === "success") await recordDelegationRunOutcome(proven.row.id, true);
    })
    .catch((err) => {
      log.error("delegated workflow rejected (executor bug)", {
        extension: ctx.extensionName,
        workflow: definition.name,
        error: String(err),
      });
    });
}

/**
 * Start the run WITHOUT awaiting it (see rung 13 — `runWorkflow` awaits the
 * entire graph and would blow the 20s host reverse-RPC timeout).
 *
 * The synchronous part of `runWorkflow` can still throw (an unwired
 * executor, a definition the topo-sorter rejects outright), which is why
 * the call itself sits inside the caller's try/catch.
 */
function startWorkflowRun(
  runtime: WorkflowRuntime,
  definition: WorkflowDefinition,
  input: Record<string, unknown>,
  projectId: string | undefined,
  ctx: OwnedWorkflowsHandlerContext,
  jobRef: string | undefined,
): void {
  const promise = runtime.workflowExecutor.runWorkflow(
    definition,
    input,
    projectId,
    ctx.userId,
    // No signal — this dispatch is deliberately un-awaited (see rung 13),
    // so there is nothing here to abort it with.
    undefined,
    // The key is OMITTED, not set to `undefined`, when the caller supplied
    // no handle: the executor's `?? null` then writes SQL NULL rather than
    // letting a stray `undefined` reach the column.
    jobRef !== undefined ? { jobRef } : undefined,
  );
  // A rejection here would be an executor bug (`runWorkflow` terminalizes
  // internally and resolves), but an unhandled rejection can take the
  // process down — absorb and log under the extension's own subsystem
  // namespace so `EZCORP_DEBUG=ext.workflows` surfaces it.
  void promise
    .then((run) => {
      log.info("extension-triggered workflow finished", {
        extension: ctx.extensionName,
        workflow: definition.name,
        workflowRunId: run.id,
        status: run.status,
      });
    })
    .catch((err) => {
      log.error("extension-triggered workflow rejected (executor bug)", {
        extension: ctx.extensionName,
        workflow: definition.name,
        error: String(err),
      });
    });
}

/**
 * The ONE way an OWNERLESS trigger is audited: an `audit_log` row with a
 * NULL user, never `sdk_capability_calls`.
 *
 * `sdk_capability_calls.on_behalf_of` is NOT NULL with an FK to `users`
 * (`schema.ts`), so an ownerless row cannot exist there — the insert is
 * swallowed and the rejection class that most needs a trail gets none.
 * `audit_log.user_id` is nullable, so it can hold one.
 *
 * Shared by rung 7 (`reason: "no-owner"` — the ownerless bound itself) and
 * by {@link audit}'s ownerless fallback (`reason: <deny code>` — an
 * ownerless call refused by an EARLIER rung, reachable only via
 * `ezcorp/workflows-delegated`, whose rung 0 lets ownerless through). One
 * writer so the two can never disagree about destination or shape.
 *
 * Never throws: an audit failure must not change the RPC response.
 */
async function auditOwnerless(
  extensionId: string,
  workflowName: unknown,
  reason: string,
  /**
   * Which `audit_log` action names this outcome. Defaults to the ownerless
   * TRIGGER action, which is what rung 7 and the pre-delegation rungs are.
   *
   * C3's delegated ladder passes its own two: a `service`-kind outcome is
   * not "no owner" (it has one — it just is not a user), and a D4 failure
   * is not a trigger refusal. Reusing one action for all three would make
   * the audit table unable to answer the only question anyone asks of it,
   * which is which of those three happened.
   */
  action: string = EXT_AUDIT_ACTIONS.WORKFLOW_TRIGGER_NO_OWNER,
): Promise<void> {
  try {
    await insertAuditEntry(
      null,
      action,
      extensionId,
      {
        permission: "workflows",
        oldValue: undefined,
        newValue: typeof workflowName === "string" ? workflowName : undefined,
        actor: "system",
        reason,
      },
    );
  } catch {
    // Audit failure must never change the response.
  }
}

/** Single audit site for both outcomes — `recordCapabilityCall` never
 *  throws by contract, but wrap anyway so an audit hiccup can never turn a
 *  successful trigger into an RPC error. */
async function audit(
  ctx: WorkflowsHandlerContext,
  startedAt: number,
  deps: WorkflowsHandlerDeps,
  spec: {
    success: boolean;
    errorCode?: string;
    errorMessage?: string;
    after?: Record<string, unknown>;
    resourceId?: string;
    /** The `audit_log` action to use IF this outcome routes there. Ignored
     *  when the call is attributable to a user. See {@link auditOwnerless}. */
    ownerlessAction?: string;
    /** The verb on the `sdk_capability_calls` row. `"run"` for the trigger
     *  path; C3's delegated fire passes `"runFor"` so analytics can tell a
     *  delegated outcome from a first-party one without joining anything. */
    action?: string;
  },
): Promise<void> {
  // An OWNERLESS call cannot be recorded in `sdk_capability_calls` at all
  // — see {@link auditOwnerless}. Only `ezcorp/workflows-delegated` can get
  // here with no owner (its rung 0 is tolerant); `ezcorp/workflows` is
  // refused before the ladder starts. Without this branch the insert would
  // be silently swallowed by the NOT NULL FK and the deny would vanish.
  //
  // C3 reaches this branch on PURPOSE and by construction rather than by
  // accident: a `owner_kind='service'` delegation has no `users` row, so
  // the delegated ladder substitutes a null `userId` into the context it
  // audits with, and every one of its outcomes lands here.
  if (!ctx.userId || ctx.userId === "unknown") {
    await auditOwnerless(
      ctx.extensionId,
      spec.after?.workflow ?? spec.resourceId,
      spec.errorCode ?? "ownerless",
      spec.ownerlessAction,
    );
    return;
  }
  try {
    await deps.recordCapabilityCall({
      ctx: {
        actorExtensionId: ctx.extensionId,
        onBehalfOf: ctx.userId,
        conversationId: ctx.conversationId,
        runId: null,
        parentCallId: null,
      },
      capability: "workflows",
      action: spec.action ?? "run",
      resourceType: "workflow",
      ...(spec.resourceId ? { resourceId: spec.resourceId } : {}),
      ...(spec.after ? { after: spec.after } : {}),
      durationMs: Date.now() - startedAt,
      success: spec.success,
      ...(spec.errorCode ? { errorCode: spec.errorCode } : {}),
      ...(spec.errorMessage ? { errorMessage: spec.errorMessage } : {}),
      // Mirrors schedule-handler: a pill only for a successful, in-chat
      // trigger. A rejection is audit-only — a denied capability should not
      // spam the conversation.
      insertChatPill: spec.success && ctx.conversationId !== null,
    });
  } catch (err) {
    log.warn("workflow trigger audit failed (non-fatal)", { error: String(err) });
  }
}
