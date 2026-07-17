/**
 * Handles the `ezcorp/emit-loop-event` reverse RPC (Loops EZ Mode Phase 2).
 *
 * Lets a loop primitive (running in an isolated extension subprocess) emit the
 * three CONTENT-FREE approval nudges onto the SAME host `AgentEvents` bus every
 * other platform event uses — the reverse RPC is only the transport, NOT a
 * parallel bus:
 *
 *   - `approval_pending`  → emits `loops:approval_pending`
 *   - `approval_resolved` → emits `loops:approval_resolved`
 *   - `auto_disabled`     → emits `loops:auto_disabled` (user-visible notice
 *                           when a loop auto-disables — never a silent stop)
 *
 * This is deliberately SEPARATE from `ezcorp/emit-task-event`: task events are
 * FORCED to the host's `currentConversationId` and rejected when the context is
 * unbound, but loops fire ownerless (cron) and may be global-scope, so their
 * nudge must be emittable WITHOUT a conversation. It brings the emit-task-event
 * SECURITY posture across, adapted for the ownerless / global-broadcast shape:
 *
 *   1. Kill-switch: the capability tier's `EZCORP_DISABLE_CAPABILITY_TOOLS`
 *      env flag disables loop-event emission along with the rest of the tier.
 *   2. Permission gate: `loopEvents` (PDP cap `ezcorp:loops:emit`), the
 *      least-privilege analog of emit-task-event's `taskEvents`. A larger
 *      blast radius (global broadcast) earns its OWN gate rather than riding
 *      the conversation-forced `taskEvents` grant.
 *   3. loopId PROVENANCE: the wire `loopId` is STAMPED host-side as
 *      `<extensionId>:<loopId>` from the handler's own `extensionId` (never
 *      caller-supplied identity), so an extension can only emit for its own
 *      loops — it structurally cannot forge or target another extension's
 *      loop id.
 *   4. Rate limit: the same 50 ops/sec limiter the other capability-RPC
 *      handlers use bounds a leaked/looping emitter.
 *
 * AUDIT — the tamper-evident mirror. Both a successful emission
 * (`LOOP_EVENT_EMITTED`) AND every rejection (`LOOP_EVENT_REJECTED`) write an
 * audit row via the established `insertAuditEntry` path. The `approval_resolved`
 * emission is the independent, append-only MIRROR of the LOCKED per-loop
 * approval-label store (`loop-types.ts`) — the label history can be
 * cross-checked against a stream the extension cannot rewrite.
 *
 * Trust model: the payload is content-free by construction (loopId + runId,
 * + `decision` on resolve) — never the proposal body. The optional
 * `conversationId` is passed through verbatim: it only scopes SSE delivery, and
 * the SSE filter authorizes conversation delivery to the OWNER only, so a
 * forged id can at worst hand a different user a spurious "some loop changed"
 * refresh nudge (they then GET the authorized dashboard — the source of truth).
 * No data crosses.
 */

import type { JsonRpcRequest, JsonRpcResponse, ExtensionPermissions } from "./types";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import type { PermissionEngine } from "./permission-engine";
import { createRateLimiter } from "./rate-limit";
import { capabilityToolsDisabled } from "./capability-flags";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import { rpcError, rpcResult } from "./json-rpc";

const MAX_OPS_PER_SECOND = 50;
const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

export interface LoopEventsContext {
  /** The host event bus. Undefined in contexts with no bus (a no-op emit). */
  bus: EventBus<AgentEvents> | undefined;
  /** Acting user for audit provenance; `"unknown"` / empty for an ownerless
   *  cron fire (loops may fire with no owning user). */
  userId: string;
  /** Install-time grant blob — the boolean-fallback permission source when
   *  no PDP engine is threaded (pre-PDP unit tests). */
  grantedPermissions: ExtensionPermissions;
  /** Phase 6 PDP. Optional for back-compat with pre-PDP unit tests. */
  engine?: PermissionEngine;
  /** Optional conversation scope for the PDP authorize call. */
  conversationId?: string;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Write a rejection audit row. Never throws — an audit failure must not
 *  break the response path. */
async function auditReject(
  extensionId: string,
  userId: string | null,
  reason: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await insertAuditEntry(userId, EXT_AUDIT_ACTIONS.LOOP_EVENT_REJECTED, extensionId, {
      permission: "loopEvents",
      oldValue: undefined,
      newValue: undefined,
      actor: "system",
      reason,
      ...(extra ?? {}),
    });
  } catch {
    // Audit failure must never break the response path.
  }
}

/** Write a successful-emission audit row (the tamper-evident mirror). Never
 *  throws. Carries the host-STAMPED loopId so the row is attributable to the
 *  emitting extension's own namespace. */
async function auditEmit(
  extensionId: string,
  userId: string | null,
  type: string,
  stampedLoopId: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await insertAuditEntry(userId, EXT_AUDIT_ACTIONS.LOOP_EVENT_EMITTED, extensionId, {
      permission: "loopEvents",
      oldValue: undefined,
      newValue: type,
      actor: "system",
      loopId: stampedLoopId,
      ...(extra ?? {}),
    });
  } catch {
    // The mirror is best-effort at the write; the emission already happened.
  }
}

export async function handleEmitLoopEventRpc(
  extensionId: string,
  req: JsonRpcRequest,
  ctx: LoopEventsContext,
): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const userIdForAudit = ctx.userId && ctx.userId !== "unknown" ? ctx.userId : null;

  // 1. Kill-switch: the capability tier is disabled globally via env.
  if (capabilityToolsDisabled()) {
    await auditReject(extensionId, userIdForAudit, "permission-missing");
    return rpcError(req.id, -32001, "loopEvents permission not granted");
  }

  // 2. Permission gate — Phase 6 PDP is the sole gate; the legacy boolean
  //    fallback is retained for context that pre-dates PDP wiring. Unlike
  //    emit-task-event, loops need NO conversation scope + NO conversation
  //    wiring (they fire ownerless / global), so those two rungs are
  //    deliberately absent.
  if (ctx.engine) {
    const decision = await ctx.engine.authorize(
      {
        extensionId,
        userId: userIdForAudit,
        conversationId:
          ctx.conversationId && ctx.conversationId !== "unknown"
            ? ctx.conversationId
            : null,
        toolName: "ezcorp/emit-loop-event",
      },
      [{ kind: "ezcorp:loops:emit" }],
    );
    if (decision.decision === "deny") {
      await auditReject(extensionId, userIdForAudit, "permission-missing");
      return rpcError(req.id, -32001, "loopEvents permission not granted");
    }
  } else if (ctx.grantedPermissions.loopEvents !== true) {
    await auditReject(extensionId, userIdForAudit, "permission-missing");
    return rpcError(req.id, -32001, "loopEvents permission not granted");
  }

  // 3. Rate limit — a leaked/looping emitter must not flood the bus.
  if (!consumeTokens(extensionId, 1)) {
    await auditReject(extensionId, userIdForAudit, "rate-limited");
    return rpcError(req.id, -32029, "Rate limited");
  }

  // 4. Payload validation.
  if (params.v !== 1) {
    await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["v: expected 1"] });
    return rpcError(req.id, -32602, "Missing or invalid 'v' (expected 1)");
  }

  const type = isString(params.type) ? params.type : undefined;
  const payload = params.payload;
  if (!isObj(payload)) {
    await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["payload: not an object"] });
    return rpcError(req.id, -32602, "Invalid payload: expected an object");
  }

  const { loopId, conversationId } = payload;
  // loopId + conversationId shape are common to every event type.
  if (!isString(loopId) || loopId.length === 0) {
    await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["payload.loopId is required"] });
    return rpcError(req.id, -32602, "payload.loopId is required");
  }
  if (conversationId !== undefined && !isString(conversationId)) {
    await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["payload.conversationId must be a string when present"] });
    return rpcError(req.id, -32602, "payload.conversationId must be a string when present");
  }
  // Only forward a non-empty conversationId (empty → global broadcast).
  const conv =
    isString(conversationId) && conversationId.length > 0
      ? { conversationId }
      : {};

  // loopId PROVENANCE — stamp the wire id with THIS extension's id, taken
  // from the handler's `extensionId` (host-known provenance, never the
  // payload). An extension can therefore only emit for its own loops; a
  // caller that passes a colon-bearing or foreign-looking loopId is still
  // re-namespaced under its own id (`<extensionId>:<foreign>`), so it can
  // never target another extension's loop.
  const wireLoopId = `${extensionId}:${loopId}`;

  // The approval events carry a runId; the auto-disable notice does not.
  if (type === "approval_pending" || type === "approval_resolved") {
    const runId = payload.runId;
    if (!isString(runId) || runId.length === 0) {
      await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["payload.runId is required"] });
      return rpcError(req.id, -32602, "payload.runId is required");
    }
    if (type === "approval_pending") {
      ctx.bus?.emit("loops:approval_pending", { loopId: wireLoopId, runId, ...conv });
      await auditEmit(extensionId, userIdForAudit, type, wireLoopId, { runId });
      return rpcResult(req.id, { ok: true });
    }
    const decision = payload.decision;
    if (decision !== "approved" && decision !== "declined") {
      await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["payload.decision must be 'approved' | 'declined'"] });
      return rpcError(req.id, -32602, "payload.decision must be 'approved' | 'declined'");
    }
    ctx.bus?.emit("loops:approval_resolved", { loopId: wireLoopId, runId, decision, ...conv });
    await auditEmit(extensionId, userIdForAudit, type, wireLoopId, { runId, decision });
    return rpcResult(req.id, { ok: true });
  }

  if (type === "auto_disabled") {
    const consecutiveErrors = payload.consecutiveErrors;
    if (typeof consecutiveErrors !== "number" || !Number.isFinite(consecutiveErrors)) {
      await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["payload.consecutiveErrors must be a finite number"] });
      return rpcError(req.id, -32602, "payload.consecutiveErrors must be a finite number");
    }
    ctx.bus?.emit("loops:auto_disabled", { loopId: wireLoopId, consecutiveErrors, ...conv });
    await auditEmit(extensionId, userIdForAudit, type, wireLoopId, { consecutiveErrors });
    return rpcResult(req.id, { ok: true });
  }

  await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: [`type: unknown value ${String(type)}`] });
  return rpcError(req.id, -32602, `Unknown event type: ${String(type)}`);
}
