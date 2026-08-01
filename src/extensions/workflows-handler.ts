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
 *   0. Provenance — resolved by the CALLER (`handlePiWorkflows` →
 *      `resolveReverseRpcMeta`) from the host-issued `_meta.ezCallId` the
 *      subprocess echoed back, NEVER the wire. That helper also refuses an
 *      OWNERLESS background fire outright (`-32106`); see the attribution
 *      note below for why that refusal is the whole design here.
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
 * event stream at them; both are worse than a clean, typed failure. The
 * refusal is inherited for free from `resolveReverseRpcMeta` (`-32106`,
 * "No owner scope for this background fire"), and this handler re-asserts
 * it at rung 7 so the bound is testable in isolation and cannot be lost by
 * a future caller that skips the shared helper.
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
import { listWorkflowRunsForCaller, RUN_STATUS_FILTERS } from "../runtime/workflow-run-trace";
import { listPendingWorkflowApprovalsForUser } from "../db/queries/workflow-approvals";
import { formatGateRelay } from "../runtime/workflow-approval-relay";
import { extensionLogger } from "../logger";

const log = extensionLogger("workflows", "handler");

const MAX_OPS_PER_SECOND = 50;
const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

/** Serialized-size ceiling on the caller-supplied workflow `input`. Bounds
 *  what rides into the ref resolver, the persisted `workflow_runs.input`
 *  column, and every agent step's prompt. */
export const MAX_WORKFLOW_INPUT_BYTES = 16_384;

/** Sliding-window length for the per-hour trigger quota. */
const QUOTA_WINDOW_MS = 60 * 60 * 1000;


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
  | "WORKFLOWS_BAD_OP";

export interface WorkflowsHandlerContext {
  /** Manifest NAME of the calling extension, resolved host-side from the
   *  registry — never the wire. Doubles as the namespace prefix. */
  extensionName: string;
  /** Registry extension id (the audit/actor anchor). */
  extensionId: string;
  /** Acting user, from the host-issued provenance token. The caller
   *  guarantees this is non-empty; rung 7 re-asserts it. */
  userId: string;
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

  // 2. Grant check — structural. A grant with an empty name list or a
  //    non-positive rate ceiling authorizes nothing; the clamp never
  //    produces one, so reaching here means a hand-edited / legacy row.
  const granted = ctx.grantedPermissions.workflows;
  if (
    !granted ||
    !Array.isArray(granted.names) ||
    granted.names.length === 0 ||
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
  const op = params.op === undefined ? "run" : params.op;
  if (op !== "run" && op !== "approvals" && op !== "runs") {
    return deny("WORKFLOWS_BAD_OP", `Unknown 'op': ${String(op)}`, -32602);
  }
  if (op === "approvals") {
    return readApprovals(req, ctx, startedAt, deps, granted.names, deny);
  }
  if (op === "runs") {
    return readRuns(req, ctx, startedAt, deps, granted.names, deny);
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
    try {
      await insertAuditEntry(
        null,
        EXT_AUDIT_ACTIONS.WORKFLOW_TRIGGER_NO_OWNER,
        ctx.extensionId,
        {
          permission: "workflows",
          oldValue: undefined,
          newValue: name,
          actor: "system",
          reason: "no-owner",
        },
      );
    } catch {
      // Audit failure must never change the response.
    }
    return rpcError(req.id, -32106, message, { reason: "WORKFLOWS_NO_OWNER" });
  }

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
  let input: Record<string, unknown> = {};
  if (params.input !== undefined) {
    const raw = params.input;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return deny("WORKFLOWS_BAD_PAYLOAD", "'input' must be a JSON object", -32602);
    }
    const serialized = JSON.stringify(raw);
    if (serialized.length > MAX_WORKFLOW_INPUT_BYTES) {
      return deny(
        "WORKFLOWS_BAD_PAYLOAD",
        `'input' too large (${serialized.length} > ${MAX_WORKFLOW_INPUT_BYTES} bytes)`,
        -32602,
      );
    }
    input = raw as Record<string, unknown>;
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
  const definition = runtime.getWorkflows().find((w) => w.name === fullName);
  if (!definition) {
    return deny("WORKFLOW_NOT_FOUND", `Workflow not found: ${fullName}`, -32602);
  }

  // 13. Dispatch. Non-blocking: `runWorkflow` awaits the entire graph, which
  //     routinely outlives the host reverse-RPC timeout. The projectId is
  //     derived server-side from the calling conversation — never the wire.
  const projectId = ctx.conversationId
    ? ((await getConversation(ctx.conversationId))?.projectId ?? undefined)
    : undefined;

  try {
    startWorkflowRun(runtime, definition, input, projectId, ctx);
  } catch (err) {
    return deny(
      "WORKFLOWS_DISPATCH_FAILED",
      `Workflow dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      -32603,
    );
  }

  await audit(ctx, startedAt, deps, {
    success: true,
    after: { workflow: fullName },
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
  }));

  await audit(ctx, startedAt, deps, {
    success: true,
    after: { op: "runs", count: runs.length },
  });
  return rpcResult(req.id, { v: 1, runs });
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
  ctx: WorkflowsHandlerContext,
): void {
  const promise = runtime.workflowExecutor.runWorkflow(
    definition,
    input,
    projectId,
    ctx.userId,
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
  },
): Promise<void> {
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
      action: "run",
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
