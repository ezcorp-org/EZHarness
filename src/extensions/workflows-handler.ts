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
 * run kept going invisibly. The extension follows progress via the
 * `workflow:*` bus events (all four are direct-carrier types) and the
 * `workflow_runs` history.
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
import type { WorkflowDefinition } from "../types";
import { isValidWorkflowName, namespacedWorkflowName } from "../runtime/workflow-name";
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
  | "WORKFLOWS_DISPATCH_FAILED";

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
    startWorkflowRun(runtime, definition, input, projectId, ownedCtx);
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
  // row — worse than returning none. Correlate on the `workflow:start` event
  // (it carries both `workflowRun.id` and `workflowName`) or on the run
  // history keyed by `workflow_name`.
  return rpcResult(req.id, { v: 1, workflow: fullName, started: true });
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
): Promise<void> {
  try {
    await insertAuditEntry(
      null,
      EXT_AUDIT_ACTIONS.WORKFLOW_TRIGGER_NO_OWNER,
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
  },
): Promise<void> {
  // An OWNERLESS call cannot be recorded in `sdk_capability_calls` at all
  // — see {@link auditOwnerless}. Only `ezcorp/workflows-delegated` can get
  // here with no owner (its rung 0 is tolerant); `ezcorp/workflows` is
  // refused before the ladder starts. Without this branch the insert would
  // be silently swallowed by the NOT NULL FK and the deny would vanish.
  if (!ctx.userId || ctx.userId === "unknown") {
    await auditOwnerless(
      ctx.extensionId,
      spec.after?.workflow ?? spec.resourceId,
      spec.errorCode ?? "ownerless",
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
