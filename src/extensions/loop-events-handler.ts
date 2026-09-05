/**
 * Admit loop notices, not human approval decisions or extension storage writes.
 * Scoped notices commit receipt, audit, and subscriber outbox in one transaction.
 * Global notices are explicitly ephemeral UI invalidations without dispatch.
 */
import type { JsonRpcRequest, JsonRpcResponse, ExtensionPermissions } from "./types";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import type { PermissionEngine } from "./permission-engine";
import { createRateLimiter } from "./rate-limit";
import { capabilityToolsDisabled } from "./capability-flags";
import { insertAuditEntry, insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import { rpcError, rpcResult } from "./json-rpc";
import { canonicalJson, sha256 } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { getDb } from "../db/connection";
import { admitEventInTransaction } from "../db/queries/extension-event-receipts";
import { releaseRows } from "../db/queries/extension-releases";
import { emitPersistedDomainEvent, publishDomainEvent, type DomainExtensionEvent } from "./domain-event-outbox";
import { resolveCallProvenance } from "./call-provenance";
import { LifecycleError } from "./v4/types";
import type { MigrationDb } from "../db/migrations/types";

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
async function auditEphemeralNotice(
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

async function acceptNotice(extensionId: string, req: JsonRpcRequest, ctx: LoopEventsContext, type: "approval_pending" | "approval_resolved" | "auto_disabled", payload: Record<string, unknown>, identity: string | undefined): Promise<JsonRpcResponse> {
  const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : undefined;
  const userId = ctx.userId && ctx.userId !== "unknown" ? ctx.userId : null;
  if (!conversationId) {
    await auditEphemeralNotice(extensionId, userId, type, String(payload.loopId), { ...payload, durable: false, approvalAuthority: false });
    ctx.bus?.emit(`loops:${type}`, payload as AgentEvents[`loops:${typeof type}`]);
    return rpcResult(req.id, { ok: true, durable: false });
  }
  if (!userId || !identity) return rpcError(req.id, -32602, "A host-bound principal and run identity are required for scoped loop notices");
  try {
    const key = await sha256(canonicalJson([extensionId, payload.loopId, identity, type]));
    let event: DomainExtensionEvent | undefined;
    const admitted = await getDb().transaction(async (transaction: MigrationDb) => {
      const owners = releaseRows<{ user_id: string }>(await transaction.execute(sql`SELECT c.user_id FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.id = ${conversationId} AND c.user_id = ${userId} AND u.status = 'active' FOR SHARE OF c, u`));
      if (owners.length !== 1) throw new LifecycleError("permission_denied", "The active principal must own the host-bound conversation");
      return admitEventInTransaction(transaction, { principalId: userId, namespace: "loop-notice", key, scope: conversationId, payload }, async eventId => {
        await insertTransactionalAuditEntry(transaction, eventId, userId, EXT_AUDIT_ACTIONS.LOOP_EVENT_EMITTED, extensionId, { permission: "loopEvents", newValue: type, actor: "extension", ...payload, durable: true, approvalAuthority: false });
        event = { id: eventId, type: `loops:${type}`, conversationId, payload };
        return publishDomainEvent(transaction, event);
      });
    });
    if (admitted.accepted && event) emitPersistedDomainEvent(ctx.bus, event);
    return rpcResult(req.id, { ok: true, durable: true, receiptId: admitted.receipt.id, duplicate: !admitted.accepted });
  } catch (error) {
    return rpcError(req.id, -32001, error instanceof LifecycleError ? error.message : "Loop notice admission failed; no notice was accepted");
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

  const type = isString(params.type) && params.type.length <= 32 ? params.type : undefined;
  const payload = params.payload;
  if (!isObj(payload)) {
    await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["payload: not an object"] });
    return rpcError(req.id, -32602, "Invalid payload: expected an object");
  }

  const { loopId, conversationId } = payload;
  // loopId + conversationId shape are common to every event type.
  if (!isString(loopId) || loopId.length === 0 || loopId.length > 128) {
    await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["payload.loopId is required"] });
    return rpcError(req.id, -32602, "payload.loopId is required");
  }
  if (conversationId !== undefined && !isString(conversationId)) {
    await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["payload.conversationId must be a string when present"] });
    return rpcError(req.id, -32602, "payload.conversationId must be a string when present");
  }
  const hostConversation = ctx.conversationId && ctx.conversationId !== "unknown" ? ctx.conversationId : undefined;
  if (conversationId && conversationId !== hostConversation) {
    await auditReject(extensionId, userIdForAudit, "scope-mismatch");
    return rpcError(req.id, -32602, "payload.conversationId does not match the host-bound conversation");
  }
  // Only forward a non-empty conversationId (empty → global broadcast).
  const conv =
    hostConversation
      ? { conversationId: hostConversation }
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
    if (!isString(runId) || runId.length === 0 || runId.length > 128) {
      await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["payload.runId is required"] });
      return rpcError(req.id, -32602, "payload.runId is required");
    }
    if (type === "approval_pending") {
      return acceptNotice(extensionId, req, ctx, type, { loopId: wireLoopId, runId, ...conv }, runId);
    }
    const decision = payload.decision;
    if (decision !== "approved" && decision !== "declined") {
      await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["payload.decision must be 'approved' | 'declined'"] });
      return rpcError(req.id, -32602, "payload.decision must be 'approved' | 'declined'");
    }
    return acceptNotice(extensionId, req, ctx, type, { loopId: wireLoopId, runId, decision, ...conv }, runId);
  }

  if (type === "auto_disabled") {
    const consecutiveErrors = payload.consecutiveErrors;
    if (typeof consecutiveErrors !== "number" || !Number.isSafeInteger(consecutiveErrors) || consecutiveErrors < 0) {
      await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: ["payload.consecutiveErrors must be a non-negative safe integer"] });
      return rpcError(req.id, -32602, "payload.consecutiveErrors must be a non-negative safe integer");
    }
    const meta = isObj(params._meta) ? params._meta : undefined;
    const provenance = typeof meta?.ezCallId === "string" ? resolveCallProvenance(meta.ezCallId) : undefined;
    const identity = provenance?.actorExtensionId === extensionId && !provenance.ownerless && provenance.onBehalfOf === ctx.userId && provenance.conversationId === hostConversation ? provenance.runId ?? undefined : undefined;
    return acceptNotice(extensionId, req, ctx, type, { loopId: wireLoopId, consecutiveErrors, ...conv }, identity);
  }

  await auditReject(extensionId, userIdForAudit, "schema-mismatch", { errors: [`type: unknown value ${String(type)}`] });
  return rpcError(req.id, -32602, `Unknown event type: ${String(type)}`);
}
