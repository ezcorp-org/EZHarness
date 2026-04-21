import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { insertObservabilityEvent } from "../db/queries/observability";
import { logger } from "../logger";
const log = logger.child("observability");

export class ObservabilityCollector {
  private unsubscribers: (() => void)[] = [];

  constructor(private bus: EventBus<AgentEvents>) {}

  start(): void {
    this.unsubscribers.push(
      this.bus.on("tool:complete", (data) => {
        insertObservabilityEvent({
          conversationId: data.conversationId,
          eventType: "tool_call",
          data: {
            toolName: data.toolName,
            extensionId: data.extensionId,
            duration: data.duration,
            success: data.success,
          },
          durationMs: data.duration,
        }).catch((err) => log.error("Failed to persist tool:complete", { error: String(err) }));
      }),

      this.bus.on("tool:error", (data) => {
        insertObservabilityEvent({
          conversationId: data.conversationId,
          eventType: "tool_error",
          data: {
            toolName: data.toolName,
            extensionId: data.extensionId,
            error: data.error,
            duration: data.duration,
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
