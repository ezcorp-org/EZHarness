// ── LoopEvents — typed client for the ezcorp/emit-loop-event reverse RPC ─
//
// Emits the two loop-approval bus events (`loops:approval_pending`,
// `loops:approval_resolved`) from an extension subprocess. Reuses the SAME
// host EventBus as every other platform event — the reverse RPC is only the
// transport; `handleEmitLoopEventRpc` on the host emits onto the bus. This
// is deliberately NOT the `ezcorp/emit-task-event` path: task events are
// FORCED to the host's `currentConversationId` and rejected when the context
// is unbound, but loops fire ownerless (cron) and may be global-scope, so
// their nudge must be emittable without a conversation.
//
// The payloads are CONTENT-FREE by design — `loopId` + `runId` (+ an
// optional `decision`) only, NEVER the proposal body. The web badge/inbox
// treats them as invalidation signals; the authorized dashboard/GET is the
// source of truth. That keeps them safe to broadcast to every authenticated
// subscriber when the loop has no owning conversation (see the host filter).

import { getChannel } from "./channel";
import type { ApprovalDecision } from "./loop-types";

/** The wire shape the host `handleEmitLoopEventRpc` validates. */
export interface EmitLoopEventParams {
  v: 1;
  type: "approval_pending" | "approval_resolved";
  payload: {
    loopId: string;
    runId: string;
    /** Present only on `approval_resolved`. */
    decision?: ApprovalDecision;
    /** Optional owning conversation — when set the host scopes SSE delivery
     *  to that conversation's owner; when absent the content-free nudge
     *  broadcasts to every authenticated subscriber. */
    conversationId?: string;
  };
}

export class LoopEvents {
  async emitApprovalPending(payload: {
    loopId: string;
    runId: string;
    conversationId?: string;
  }): Promise<void> {
    await getChannel().request<{ ok: true }>("ezcorp/emit-loop-event", {
      v: 1,
      type: "approval_pending",
      payload: {
        loopId: payload.loopId,
        runId: payload.runId,
        ...(payload.conversationId !== undefined
          ? { conversationId: payload.conversationId }
          : {}),
      },
    } satisfies EmitLoopEventParams);
  }

  async emitApprovalResolved(payload: {
    loopId: string;
    runId: string;
    decision: ApprovalDecision;
    conversationId?: string;
  }): Promise<void> {
    await getChannel().request<{ ok: true }>("ezcorp/emit-loop-event", {
      v: 1,
      type: "approval_resolved",
      payload: {
        loopId: payload.loopId,
        runId: payload.runId,
        decision: payload.decision,
        ...(payload.conversationId !== undefined
          ? { conversationId: payload.conversationId }
          : {}),
      },
    } satisfies EmitLoopEventParams);
  }
}
