/**
 * Handles the `ezcorp/emit-loop-event` reverse RPC (Loops EZ Mode Phase 2).
 *
 * Lets a loop primitive (running in an isolated extension subprocess) emit the
 * two CONTENT-FREE approval nudges onto the SAME host `AgentEvents` bus every
 * other platform event uses — the reverse RPC is only the transport, NOT a
 * parallel bus:
 *
 *   - `approval_pending`  → emits `loops:approval_pending`
 *   - `approval_resolved` → emits `loops:approval_resolved`
 *
 * This is deliberately SEPARATE from `ezcorp/emit-task-event`: task events are
 * FORCED to the host's `currentConversationId` and rejected when the context is
 * unbound, but loops fire ownerless (cron) and may be global-scope, so their
 * nudge must be emittable WITHOUT a conversation.
 *
 * Trust model: the payload is content-free by construction (loopId + runId,
 * + `decision` on resolve) — never the proposal body. The optional
 * `conversationId` is passed through verbatim: it only scopes SSE delivery, and
 * the SSE filter authorizes conversation delivery to the OWNER only, so a
 * forged id can at worst hand a different user a spurious "some loop changed"
 * refresh nudge (they then GET the authorized dashboard — the source of truth).
 * No data crosses. Abuse is bounded by the same 50 ops/sec limiter the other
 * capability-RPC handlers use.
 */

import type { JsonRpcRequest, JsonRpcResponse } from "./types";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { createRateLimiter } from "./rate-limit";
import { rpcError, rpcResult } from "./json-rpc";

const MAX_OPS_PER_SECOND = 50;
const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

export interface LoopEventsContext {
  /** The host event bus. Undefined in contexts with no bus (a no-op emit). */
  bus: EventBus<AgentEvents> | undefined;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function handleEmitLoopEventRpc(
  extensionId: string,
  req: JsonRpcRequest,
  ctx: LoopEventsContext,
): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Rate limit — a leaked/looping emitter must not flood the bus.
  if (!consumeTokens(extensionId, 1)) {
    return rpcError(req.id, -32029, "Rate limited");
  }

  if (params.v !== 1) {
    return rpcError(req.id, -32602, "Missing or invalid 'v' (expected 1)");
  }

  const type = isString(params.type) ? params.type : undefined;
  const payload = params.payload;
  if (!isObj(payload)) {
    return rpcError(req.id, -32602, "Invalid payload: expected an object");
  }

  const { loopId, runId, conversationId } = payload;
  if (!isString(loopId) || loopId.length === 0) {
    return rpcError(req.id, -32602, "payload.loopId is required");
  }
  if (!isString(runId) || runId.length === 0) {
    return rpcError(req.id, -32602, "payload.runId is required");
  }
  if (conversationId !== undefined && !isString(conversationId)) {
    return rpcError(req.id, -32602, "payload.conversationId must be a string when present");
  }
  // Only forward a non-empty conversationId (empty → global broadcast).
  const conv =
    isString(conversationId) && conversationId.length > 0
      ? { conversationId }
      : {};

  if (type === "approval_pending") {
    ctx.bus?.emit("loops:approval_pending", { loopId, runId, ...conv });
    return rpcResult(req.id, { ok: true });
  }

  if (type === "approval_resolved") {
    const decision = payload.decision;
    if (decision !== "approved" && decision !== "declined") {
      return rpcError(req.id, -32602, "payload.decision must be 'approved' | 'declined'");
    }
    ctx.bus?.emit("loops:approval_resolved", { loopId, runId, decision, ...conv });
    return rpcResult(req.id, { ok: true });
  }

  return rpcError(req.id, -32602, `Unknown event type: ${String(type)}`);
}
