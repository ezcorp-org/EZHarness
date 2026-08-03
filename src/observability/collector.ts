import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { insertObservabilityEvent } from "../db/queries/observability";
import {
  persistableConversationId,
  workflowRunIdFromScopeKey,
} from "../runtime/workflow-scope-key";
import { logger } from "../logger";
const log = logger.child("observability");

/**
 * Split a tool event's `conversationId` into the pair the row can
 * actually hold.
 *
 * A tool call made from inside a WORKFLOW carries the synthetic
 * `workflow-run:<id>` scope key, not a conversation id. That key matches
 * no `conversations` row, so while `observability_events.conversation_id`
 * was NOT NULL the insert failed the FK on EVERY workflow tool call and
 * the only trace was `Failed to persist tool:complete` in the log — the
 * call itself was recorded nowhere.
 *
 * Dropping the row would have "fixed" the noise by deleting the signal.
 * Instead the coordinate is translated: no conversation (`null`, now a
 * legal value) plus the run id in the event payload, where the global
 * dashboard's `data->>'extensionId'` grouping already looks. A chat tool
 * call is untouched — `workflowRunId` is simply absent.
 */
export function toolEventScope(conversationId: string): {
  conversationId: string | null;
  workflowRunId: string | null;
} {
  return {
    conversationId: persistableConversationId(conversationId),
    workflowRunId: workflowRunIdFromScopeKey(conversationId),
  };
}

export class ObservabilityCollector {
  private unsubscribers: (() => void)[] = [];

  constructor(private bus: EventBus<AgentEvents>) {}

  start(): void {
    this.unsubscribers.push(
      this.bus.on("tool:complete", (data) => {
        const scope = toolEventScope(data.conversationId);
        insertObservabilityEvent({
          conversationId: scope.conversationId,
          eventType: "tool_call",
          data: {
            toolName: data.toolName,
            extensionId: data.extensionId,
            duration: data.duration,
            success: data.success,
            // Present only for a workflow tool step — this is the run the
            // call belongs to, and the reason the row no longer has to
            // lie about having a conversation.
            ...(scope.workflowRunId !== null
              ? { workflowRunId: scope.workflowRunId }
              : {}),
          },
          durationMs: data.duration,
        }).catch((err) => log.error("Failed to persist tool:complete", { error: String(err) }));
      }),

      this.bus.on("tool:error", (data) => {
        const scope = toolEventScope(data.conversationId);
        insertObservabilityEvent({
          conversationId: scope.conversationId,
          eventType: "tool_error",
          data: {
            toolName: data.toolName,
            extensionId: data.extensionId,
            error: data.error,
            duration: data.duration,
            ...(scope.workflowRunId !== null
              ? { workflowRunId: scope.workflowRunId }
              : {}),
          },
          durationMs: data.duration,
        }).catch((err) => log.error("Failed to persist tool:error", { error: String(err) }));
      }),

      this.bus.on("obs:turn", (data) => {
        insertObservabilityEvent({
          conversationId: data.conversationId,
          messageId: data.messageId,
          eventType: "turn_summary",
          data: {
            llmDurationMs: data.llmDurationMs,
            toolDurationMs: data.toolDurationMs,
            totalDurationMs: data.totalDurationMs,
            tokenUsage: data.tokenUsage,
          },
          durationMs: data.totalDurationMs,
        }).catch((err) => log.error("Failed to persist obs:turn", { error: String(err) }));
      }),

      // Persist every sub-agent invocation (success or failure) anchored to the PARENT
      // conversation so it shows up in the parent's observability panel. Previously agent
      // failures only surfaced as a small red chip — this is the missing trail that lets
      // users see exactly which sub-agent failed and why.
      this.bus.on("agent:complete", (data) => {
        if (!data.parentConversationId) return;
        insertObservabilityEvent({
          conversationId: data.parentConversationId,
          eventType: data.success ? "agent_call" : "agent_error",
          data: {
            agentName: data.agentName,
            agentConfigId: data.agentConfigId,
            subConversationId: data.subConversationId,
            agentRunId: data.agentRunId,
            resultPreview: data.resultPreview,
            success: data.success,
          },
        }).catch((err) => log.error("Failed to persist agent:complete", { error: String(err) }));
      }),

      // Persist top-level run errors (including watchdog timeouts and force-cancels).
      // Requires conversationId on the event payload — legacy code paths that don't carry
      // it are simply skipped since there's no valid observability_events row to write.
      this.bus.on("run:error", (data) => {
        const convId = data.conversationId;
        if (!convId) return;
        insertObservabilityEvent({
          conversationId: convId,
          eventType: "run_error",
          data: {
            runId: data.run.id,
            error: data.error,
            agentName: data.run.agentName,
          },
        }).catch((err) => log.error("Failed to persist run:error", { error: String(err) }));
      }),
    );
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }
}

export function startCollector(bus: EventBus<AgentEvents>): () => void {
  const collector = new ObservabilityCollector(bus);
  collector.start();
  return () => collector.stop();
}
