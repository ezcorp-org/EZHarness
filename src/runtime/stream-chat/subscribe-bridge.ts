import { and, eq, isNull } from "drizzle-orm";
import type { Agent, AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "../../types";
import { logger } from "../../logger";
import { getDb } from "../../db/connection";
import { toolCalls, conversations } from "../../db/schema";
import { persistToolCall } from "../../db/queries/tool-calls";
import { ExtensionRegistry } from "../../extensions/registry";
import type { StreamChatContext } from "./context";
import type { StreamChatHost } from "./host";

const log = logger.child("executor.streamChat.subscribe");

/** Subset of streamChat's options the subscribe handler reads. */
export interface SubscribeBridgeOptions {
  agentConfigId?: string;
  model?: string;
  provider?: string;
}

/** Subset of the conversation row the subscribe handler reads
 *  (analytics fallbacks for tool-call rows + assistant-message
 *  parent linkage). */
export interface SubscribeBridgeConvRecord {
  userId?: string | null;
  agentConfigId?: string | null;
  model?: string | null;
  provider?: string | null;
}

/**
 * Wire the pi-agent-core event stream into the executor's local
 * EventBus, persist tool calls + per-turn assistant messages, and
 * forward sub-agent activity into the watchdog so multi-minute
 * auto-spin-up turns aren't killed by the idle detector.
 *
 * Mutates `ctx.unsub` (the pi-agent subscription) and
 * `ctx.unsubAgentActivity` (the bus listeners) so the finalize phase
 * can detach them in the finally block.
 *
 * Pure function — does not depend on the executor class shape, only
 * on the StreamChatHost view.
 */
export function subscribeBridge(
  ctx: StreamChatContext,
  host: StreamChatHost,
  piAgent: Agent,
  conversationId: string,
  options: SubscribeBridgeOptions,
  convRecord: SubscribeBridgeConvRecord | null,
): void {
  const { run } = ctx;

  // Serialize async DB operations from the sync subscribe callback.
  // Closure over `ctx.dbQueue` so the success/cancel paths can `await ctx.dbQueue`.
  const queueDb = (fn: () => Promise<void>) => {
    ctx.dbQueue = ctx.dbQueue.then(fn).catch((err) => log.error("DB error", { error: String(err) }));
  };

  // Subscribe to AgentEvents and bridge to local EventBus
  ctx.unsub = piAgent.subscribe((event: AgentEvent) => {
    // Any pi-agent-core event counts as progress for the watchdog — LLM is actively producing output.
    host.watchdog.bumpActivity(run.id);
    switch (event.type) {
      case "turn_start":
        ctx.turnText = "";
        ctx.turnThinking = "";
        ctx.turnHasToolCalls = false;
        host.bus.emit("run:status", { runId: run.id, status: "Thinking..." });
        break;
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          ctx.turnText += ame.delta;
          ctx.allTurnsText += ame.delta;
          host.bus.emit("run:token", { runId: run.id, token: ame.delta, kind: "text" });
        } else if (ame.type === "thinking_delta") {
          ctx.turnThinking += ame.delta;
          host.bus.emit("run:token", { runId: run.id, token: ame.delta, kind: "thinking" });
        }
        break;
      }
      case "tool_execution_start": {
        ctx.turnHasToolCalls = true;
        const args = (event.args ?? {}) as Record<string, unknown>;
        ctx.pendingToolArgs.set(event.toolCallId, args);
        // invoke_agent has its own agent:spawn/agent:complete events — skip tool:start
        if (event.toolName === "invoke_agent") break;
        // Build descriptive status from tool name + primary arg
        const primaryArg = args.file_path ?? args.path ?? args.pattern ?? args.command ?? args.query ?? args.url;
        const statusDetail = primaryArg ? `: ${String(primaryArg).slice(0, 60)}` : '';
        host.bus.emit("run:status", { runId: run.id, status: `Running ${event.toolName}${statusDetail}...` });
        const toolDef = ctx.builtinToolDefsMap.get(event.toolName);
        // Extension tools live in the registry under `<ext>__<tool>`;
        // built-ins are bare names. Same lookup logic as tool_execution_end.
        const startRegistered = !toolDef && event.toolName.includes("__")
          ? ExtensionRegistry.getInstance().getRegisteredTool(event.toolName)
          : undefined;
        host.bus.emit("tool:start", {
          conversationId, extensionId: "", toolName: event.toolName,
          input: event.args, timestamp: Date.now(),
          cardType: toolDef?.cardType ?? startRegistered?.cardType,
          category: toolDef?.category,
          // Propagate the pi-agent tool call id so the client can correlate
          // this start with the later complete/error event (and with the
          // persisted DB row — see the DB insert in tool_execution_end).
          invocationId: event.toolCallId,
        });
        break;
      }
      case "tool_execution_end": {
        // invoke_agent uses agent:spawn/agent:complete — skip tool:complete/error WS events
        // but still persist to DB below
        // cardType lookup: built-ins are in builtinToolDefsMap; extension
        // tools are namespaced (`<ext>__<tool>`) and live in the registry.
        // Without this, the chat UI's ToolCardRouter falls through to
        // DefaultCard for every extension tool — including custom canvas
        // cards like claude-design's design-canvas.
        const endToolDef = ctx.builtinToolDefsMap.get(event.toolName);
        const endCardType = endToolDef?.cardType
          ?? (event.toolName.includes("__")
              ? ExtensionRegistry.getInstance().getRegisteredTool(event.toolName)?.cardType
              : undefined);
        if (event.toolName !== "invoke_agent") {
          if (event.isError) {
            host.bus.emit("tool:error", {
              conversationId, extensionId: "", toolName: event.toolName,
              error: typeof event.result === 'string' ? event.result : JSON.stringify(event.result), duration: 0,
              cardType: endCardType,
              invocationId: event.toolCallId,
            });
          } else {
            host.bus.emit("tool:complete", {
              conversationId, extensionId: "", toolName: event.toolName,
              output: event.result, duration: 0, success: true,
              cardType: endCardType,
              invocationId: event.toolCallId,
            });
          }
        }
        // Persist built-in tool calls to DB so diff panel survives page refresh.
        // Use event.toolCallId as the row id so streaming events and hydrated
        // DB rows share the same key — lets the client dedupe without fuzzy
        // matching when a page reload overlaps an in-flight run.
        if (host.persist) {
          const args = ctx.pendingToolArgs.get(event.toolCallId) ?? {};
          ctx.pendingToolArgs.delete(event.toolCallId);
          // Anchored to turn message in turn_end handler (messageId: null here).
          // persistToolCall is the single insert site for tool_calls — keeps
          // the four analytics dimensions (user/agent/model/provider) in
          // lockstep with the extension-tool write path.
          queueDb(() => persistToolCall({
            id: event.toolCallId,
            conversationId,
            messageId: null,
            extensionId: "builtin",
            toolName: event.toolName,
            input: args,
            output: { content: event.result?.content ?? [] },
            success: !event.isError,
            durationMs: 0,
            cardType: endCardType ?? null,
            userId: convRecord?.userId ?? null,
            agentConfigId: options.agentConfigId ?? convRecord?.agentConfigId ?? null,
            model: options.model ?? convRecord?.model ?? null,
            provider: options.provider ?? convRecord?.provider ?? null,
          }));
        }
        break;
      }
      case "turn_end": {
        const msg = event.message;
        if (msg && "role" in msg && msg.role === "assistant") {
          const am = msg as AssistantMessage;
          ctx.totalUsage = am.usage;
          host.bus.emit("run:usage", { runId: run.id, usage: am.usage });

          // Persist this turn as its own assistant message
          // Extract text and thinking separately from the final AssistantMessage content array
          const textContent = am.content
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { type: string; text?: string }) => c.text ?? "")
            .join("");
          const thinkingContent = am.content
            .filter((c: { type: string }) => c.type === "thinking")
            .map((c: { type: string; thinking?: string }) => c.thinking ?? "")
            .join("");
          // Fallback: use accumulated streaming text if the final message lacks text blocks
          // (some providers stream text_delta but don't include text in the final message)
          const resolvedText = textContent || ctx.turnText;
          const resolvedThinking = thinkingContent || ctx.turnThinking;

          if (!textContent && ctx.turnText) {
            log.warn("turn_end message missing text blocks but turnText has content", { turnTextPreview: ctx.turnText.slice(0, 100), contentTypes: am.content.map((c: { type: string }) => c.type).join(", ") });
          }
          if (!resolvedText && !ctx.turnHasToolCalls) {
            log.warn("turn_end with no text and no tool calls", { contentTypes: am.content.map((c: { type: string }) => c.type).join(", ") });
          }

          if (host.persist && (resolvedText || ctx.turnHasToolCalls)) {
            const capturedText = resolvedText;
            const capturedThinking = resolvedThinking || undefined;
            const capturedParent = ctx.lastSavedMessageId;
            queueDb(async () => {
              const { createMessage } = await import("../../db/queries/conversations");
              const turnMsg = await createMessage(conversationId, {
                role: "assistant",
                content: capturedText,
                thinkingContent: capturedThinking,
                model: options.model,
                provider: options.provider,
                usage: { inputTokens: am.usage.input, outputTokens: am.usage.output },
                runId: run.id,
                parentMessageId: capturedParent ?? undefined,
              });

              // Anchor unanchored tool calls to this turn's message
              await getDb()
                .update(toolCalls)
                .set({ messageId: turnMsg.id })
                .where(and(
                  eq(toolCalls.conversationId, conversationId),
                  isNull(toolCalls.messageId),
                ));
              // Also handle extension tools that used run.id as placeholder
              await getDb()
                .update(toolCalls)
                .set({ messageId: turnMsg.id })
                .where(and(
                  eq(toolCalls.conversationId, conversationId),
                  eq(toolCalls.messageId, run.id),
                ));

              // Anchor agent sub-conversations created during this turn to the assistant message
              await getDb()
                .update(conversations)
                .set({ parentMessageId: turnMsg.id })
                .where(and(
                  eq(conversations.parentConversationId, conversationId),
                  isNull(conversations.parentMessageId),
                ));

              ctx.lastSavedMessageId = turnMsg.id;

              host.bus.emit("run:turn_saved", {
                runId: run.id,
                conversationId,
                messageId: turnMsg.id,
                parentMessageId: capturedParent,
                content: capturedText,
              });
              host.bus.emit("run:turn_text_reset", { runId: run.id });
            });
          }
        }
        if (ctx.turnHasToolCalls) {
          host.bus.emit("run:status", { runId: run.id, status: "Analyzing results..." });
        }
        ctx.turnText = "";
        break;
      }
    }
  });

  // Sub-agent events also count as parent-run progress for the watchdog. invoke_agent
  // emits agent:spawn/agent:status/agent:complete with the parent's runId, so when a
  // multi-minute auto-spin-up is running, the parent watchdog sees these as liveness
  // signals and won't kill the outer turn.
  ctx.unsubAgentActivity = [
    host.bus.on("agent:spawn", (data) => {
      if ((data as { runId?: string }).runId === run.id) host.watchdog.bumpActivity(run.id);
    }),
    host.bus.on("agent:status", (data) => {
      if ((data as { runId?: string }).runId === run.id) host.watchdog.bumpActivity(run.id);
    }),
    host.bus.on("agent:complete", (data) => {
      if ((data as { runId?: string }).runId === run.id) host.watchdog.bumpActivity(run.id);
    }),
  ];
}
