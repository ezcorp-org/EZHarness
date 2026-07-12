import { and, eq, isNull } from "drizzle-orm";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "../../types";
import { logger } from "../../logger";
import { getDb } from "../../db/connection";
import { toolCalls, conversations } from "../../db/schema";
import { persistToolCall } from "../../db/queries/tool-calls";
import { appendSavedMessageEntry } from "../../db/session-sync";
import {
  computeTurnCacheStats,
  aggregateCacheStats,
  type CacheTurnInput,
} from "../usage/cache-stats";
import { ExtensionRegistry } from "../../extensions/registry";
import { DEFAULT_BUILTIN_CALL_TIMEOUT_MS } from "../executor-watchdog";
import {
  LONG_BLOCKING_ORCHESTRATION_TOOLS,
  LONG_BLOCKING_WATCHDOG_BUDGET_MS,
} from "../tools/filter";
import type { RoutingTier } from "../tier-classifier";
import type { StreamChatContext } from "./context";
import type { StreamChatHost } from "./host";

const log = logger.child("executor.streamChat.subscribe");

/**
 * Fail-open normalizer for `ToolDefinition.cardLayout`. Returns "inline"
 * or "dock" only — anything else (typo, future value, garbage) is folded
 * to undefined so downstream treats the row as inline. The warn-log path
 * surfaces typos to extension authors without breaking install (per the
 * canvas-dock-sdk plan §7.1).
 *
 * The toolName is included in the warning so authors can grep their
 * manifest for the offending entry. Only warns when the input is set
 * to a non-string truthy or a string that doesn't match the enum —
 * undefined/null are silent (the common no-op path).
 */
function normalizeCardLayout(
  raw: unknown,
  toolName: string,
): "inline" | "dock" | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "inline" || raw === "dock") return raw;
  log.warn("ignoring unknown cardLayout — defaulting to inline", {
    toolName, value: String(raw),
  });
  return undefined;
}

/** Subset of streamChat's options the subscribe handler reads. The
 *  executor's subscribe seam always passes the SERVED `provider`/`model`
 *  (the failover attempt that actually produced the turn) plus the routing
 *  provenance fields below, so persisted rows and the cache meter name the
 *  real serving model on routed turns too. */
export interface SubscribeBridgeOptions {
  agentConfigId?: string;
  model?: string;
  provider?: string;
  /** The user's pin for this turn; null ⇒ Auto/routed (no pin). Provenance
   *  only — the served identity is `provider`/`model` above. */
  requestedProvider?: string | null;
  requestedModel?: string | null;
  /** Tier the classifier routed this turn to — set only when routing fired
   *  (no pinned model). */
  routedTier?: RoutingTier;
  /** True when the serving attempt differs from the initially resolved one
   *  (a pre-stream failover rebuilt the agent). */
  failover?: boolean;
  /** When true, live-append each saved turn to the pi session tree (design
   *  §5). Resolved once per run by the executor from the history-producer
   *  kill-switch; absent/false skips the append entirely (no DB probe), so
   *  the legacy path stays a strict no-op here. */
  sessionHistoryProducer?: boolean;
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

  // Provider/model that produced this run's turns — used to SEGMENT the cache
  // meter (cache benefit is provider-specific; never fold providers together).
  // The executor always passes the SERVED attempt identity in options, so
  // routed turns no longer meter as "unknown"; the convRecord/"unknown"
  // fallbacks remain only for direct callers outside the executor seam.
  const turnProvider = options.provider ?? convRecord?.provider ?? "unknown";
  const turnModel = options.model ?? convRecord?.model ?? "unknown";
  // Per-run accumulator of this run's turns, for the once-per-run conversation
  // cache summary logged on the terminal turn. Closure-local (subscribeBridge
  // runs once per streamChat) so it needs no ctx field.
  const runCacheTurns: CacheTurnInput[] = [];

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
      case "message_start": {
        // P4 §1.2 — steered-row reconciliation (PERSISTENCE LAYER seam; Phase 2's
        // session live-append should hook the same ordering here). When a steer
        // is DELIVERED, pi drains it and emits message_start carrying the exact
        // UserMessage object steerConversation queued. If the caller persisted a
        // DB row for that steer up-front (agent-chat, for immediate feed
        // visibility), its parent was the leaf-at-REQUEST — but the LLM sees the
        // steer HERE, at a later branch position. Re-parent the row to the current
        // branch leaf and thread later turns through it, so the NEXT run's
        // loadHistory rebuilds the exact sequence the LLM saw.
        //
        // Serialized on ctx.dbQueue with the turn-save chain (no double-write
        // race): the preceding turn's save — which advances ctx.lastSavedMessageId
        // — is queued before this, so when the reparent runs ctx.lastSavedMessageId
        // IS the pre-injection leaf; setting it to the steer row then makes the
        // next turn_end parent onto the steer. The executor's `consumeSteerPersistedId`
        // latch fires at most once per steer, and returns undefined for a steer
        // with no persisted row (send_to_agent — an ephemeral prompt, like every
        // sub-agent prompt: nothing to reconcile) or a non-steer message.
        const injected = event.message;
        if (
          host.persist &&
          injected &&
          typeof injected === "object" &&
          "role" in injected &&
          injected.role === "user"
        ) {
          const persistedId = host.executor.consumeSteerPersistedId(run.id, injected);
          if (persistedId) {
            queueDb(async () => {
              const currentLeaf = ctx.lastSavedMessageId;
              if (currentLeaf && currentLeaf !== persistedId) {
                const { reparentMessage } = await import("../../db/queries/conversations");
                await reparentMessage(conversationId, persistedId, currentLeaf);
              }
              // Thread subsequent turns through the steer row even when there was
              // no pre-injection leaf to reparent onto (injection at run start).
              ctx.lastSavedMessageId = persistedId;

              // Mirror the reconciled steer row into the session tree at its
              // injection position (parent = the pre-injection leaf), so the
              // session chain matches the reparented messages chain and the
              // next turn_end append threads through it (design §5). Gated on
              // the run's history-producer flag. Steer content is a plain
              // string; non-string content is left for the catch-up to heal.
              // Fail-open.
              const steerContent = (injected as { content?: unknown }).content;
              if (options.sessionHistoryProducer && typeof steerContent === "string") {
                await appendSavedMessageEntry(
                  conversationId,
                  { id: persistedId, role: "user", content: steerContent, createdAt: new Date() },
                  currentLeaf,
                );
              }
            });
          }
        }
        break;
      }
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          ctx.turnText += ame.delta;
          ctx.allTurnsText += ame.delta;
          // First client-visible output → past the pre-stream failover
          // boundary (see StreamChatContext.emittedToClient / WS2).
          ctx.emittedToClient = true;
          host.bus.emit("run:token", { runId: run.id, token: ame.delta, kind: "text" });
        } else if (ame.type === "thinking_delta") {
          ctx.turnThinking += ame.delta;
          ctx.emittedToClient = true;
          host.bus.emit("run:token", { runId: run.id, token: ame.delta, kind: "thinking" });
        }
        break;
      }
      case "tool_execution_start": {
        ctx.turnHasToolCalls = true;
        // A tool card is client-visible committed output → past the
        // pre-stream failover boundary (see WS2 / emittedToClient).
        ctx.emittedToClient = true;
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
        // cardLayout fan-out: normalize unknown values to "inline" (fail-open)
        // and only emit when explicitly declared. Mirrors cardType resolution.
        const startCardLayout = normalizeCardLayout(
          toolDef?.cardLayout ?? startRegistered?.cardLayout,
          event.toolName,
        );
        const startCardType = toolDef?.cardType ?? startRegistered?.cardType;
        host.bus.emit("tool:start", {
          conversationId, extensionId: "", toolName: event.toolName,
          input: event.args, timestamp: Date.now(),
          cardType: startCardType,
          ...(startCardLayout ? { cardLayout: startCardLayout } : {}),
          category: toolDef?.category,
          // Propagate the pi-agent tool call id so the client can correlate
          // this start with the later complete/error event (and with the
          // persisted DB row — see the DB insert in tool_execution_end).
          invocationId: event.toolCallId,
        });
        // Register the in-flight call with the watchdog so it (a) defers
        // the idle kill until the declared callTimeoutMs is exceeded —
        // pi-agent-core emits no events while awaiting the tool result, so
        // otherwise the activity tracker would trip — and (b) can
        // synthesize a `tool:error` event for this call if the watchdog
        // ends up killing the run anyway.
        //
        // Precedence: extension manifest `resources.callTimeoutMs` >
        // built-in `BuiltinToolDef.callTimeoutMs` > the principled default
        // (DEFAULT_BUILTIN_CALL_TIMEOUT_MS == WATCHDOG_IDLE_MS, i.e.
        // pre-Tier-2 behavior). The two paths are mutually exclusive in
        // practice (extensions are registered, built-ins are in
        // builtinToolDefsMap), so this is one fallback chain — no new
        // helper needed.
        const startManifest = startRegistered
          ? ExtensionRegistry.getInstance().getManifest(startRegistered.extensionId)
          : undefined;
        const manifestCallTimeout = startManifest?.resources?.callTimeoutMs;
        const builtinCallTimeout = toolDef?.callTimeoutMs;
        const callTimeoutMs =
          // F1: a host long-blocking orchestration tool (currently only
          // `collect_agent_result` reaches this — `invoke_agent`'s tool:start is
          // suppressed above) gets a BOUNDED, widened watchdog defer budget so a
          // synchronous collect isn't idle-killed at ~90s while legitimately
          // awaiting a background child. Keyed on the BARE `event.toolName`
          // because the orchestration tool is wired bare and `startRegistered`
          // (resolved from that bare name) is null — the same reason the manifest
          // path below can't see its `resources.callTimeoutMs`. Host-controlled:
          // only host wiring produces these bare names (see filter.ts).
          LONG_BLOCKING_ORCHESTRATION_TOOLS.has(event.toolName)
            ? LONG_BLOCKING_WATCHDOG_BUDGET_MS
            : typeof manifestCallTimeout === "number" && manifestCallTimeout > 0
              ? manifestCallTimeout
              : typeof builtinCallTimeout === "number" && builtinCallTimeout > 0
                ? builtinCallTimeout
                : DEFAULT_BUILTIN_CALL_TIMEOUT_MS;
        host.watchdog.noteToolStart(run.id, event.toolCallId, {
          toolName: event.toolName,
          conversationId,
          extensionId: startRegistered?.extensionId ?? "",
          startedAt: Date.now(),
          callTimeoutMs,
          ...(startCardType ? { cardType: startCardType } : {}),
          ...(startCardLayout ? { cardLayout: startCardLayout } : {}),
          ...(startRegistered?.requiresUserInput === true
            ? { requiresUserInput: true }
            : {}),
        });
        break;
      }
      case "tool_execution_end": {
        // Drop the watchdog inflight entry on both success and error
        // paths — the run is no longer waiting on this call. Safe if the
        // entry was never recorded (e.g. invoke_agent below skips
        // noteToolStart, the matching noteToolEnd is then a no-op).
        host.watchdog.noteToolEnd(run.id, event.toolCallId);
        // invoke_agent uses agent:spawn/agent:complete — skip tool:complete/error WS events
        // but still persist to DB below
        // cardType lookup: built-ins are in builtinToolDefsMap; extension
        // tools are namespaced (`<ext>__<tool>`) and live in the registry.
        // Without this, the chat UI's ToolCardRouter falls through to
        // DefaultCard for every extension tool — including custom canvas
        // cards like claude-design's design-canvas.
        const endToolDef = ctx.builtinToolDefsMap.get(event.toolName);
        const endRegistered = !endToolDef && event.toolName.includes("__")
          ? ExtensionRegistry.getInstance().getRegisteredTool(event.toolName)
          : undefined;
        const endCardType = endToolDef?.cardType ?? endRegistered?.cardType;
        // Same normalization as tool:start. Only emitted when explicitly
        // "dock" — undefined keeps the wire payload identical to today.
        const endCardLayout = normalizeCardLayout(
          endToolDef?.cardLayout ?? endRegistered?.cardLayout,
          event.toolName,
        );
        if (event.toolName !== "invoke_agent") {
          if (event.isError) {
            host.bus.emit("tool:error", {
              conversationId, extensionId: "", toolName: event.toolName,
              error: typeof event.result === 'string' ? event.result : JSON.stringify(event.result), duration: 0,
              cardType: endCardType,
              ...(endCardLayout ? { cardLayout: endCardLayout } : {}),
              invocationId: event.toolCallId,
            });
          } else {
            host.bus.emit("tool:complete", {
              conversationId, extensionId: "", toolName: event.toolName,
              output: event.result, duration: 0, success: true,
              cardType: endCardType,
              ...(endCardLayout ? { cardLayout: endCardLayout } : {}),
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
            cardLayout: endCardLayout ?? null,
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

          // ── Prompt-cache observability (WS0) ──────────────────────────────
          // pi-ai already parses cacheRead/cacheWrite off the stream; surface
          // it. Once-per-turn `info` summary (segmented by provider+model);
          // per-block detail at `debug` (raise via EZCORP_DEBUG). Token counts
          // only — never secrets.
          const cacheStats = computeTurnCacheStats(am.usage);
          runCacheTurns.push({
            provider: turnProvider,
            model: turnModel,
            input: am.usage.input,
            output: am.usage.output,
            cacheRead: am.usage.cacheRead,
            cacheWrite: am.usage.cacheWrite,
            cacheWrite1h: am.usage.cacheWrite1h ?? 0,
          });
          log.info("turn cache", {
            provider: turnProvider,
            model: turnModel,
            hitRate: Number(cacheStats.hitRate.toFixed(4)),
            cachedTokens: cacheStats.cachedTokens,
            cacheWriteTokens: cacheStats.cacheWriteTokens,
            cacheWrite1hTokens: cacheStats.cacheWrite1hTokens,
            promptTokens: cacheStats.promptTokens,
          });
          log.debug("turn cache detail", {
            input: am.usage.input,
            output: am.usage.output,
            cacheRead: am.usage.cacheRead,
            cacheWrite: am.usage.cacheWrite,
          });

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
            // A turn with no tool calls terminates the agent loop — no further
            // turn will stream into a follow-up placeholder. Captured here
            // because turnHasToolCalls is reset on the next turn_start, which
            // can run before this queued DB callback fires.
            const isFinalTurn = !ctx.turnHasToolCalls;
            queueDb(async () => {
              // Read the branch leaf at dbQueue-EXECUTION time (NOT a sync
              // capture): the queue is FIFO, so any task queued before this one
              // — a preceding turn's save, or a P4 §1.2 steer reconcile queued at
              // an intervening message_start — has already advanced
              // lastSavedMessageId. Reading it here makes the parent chain
              // structural instead of dependent on inter-turn latency happening
              // to drain the queue: a steered turn threads through the steer row,
              // and back-to-back turns can't fork off a shared stale leaf.
              // (text/thinking/isFinalTurn stay sync — they snapshot per-turn
              // state that the next turn_start resets; lastSavedMessageId is
              // never reset, only advanced forward by queued task completions.)
              const capturedParent = ctx.lastSavedMessageId;
              const { createMessage } = await import("../../db/queries/conversations");
              const turnMsg = await createMessage(conversationId, {
                role: "assistant",
                content: capturedText,
                thinkingContent: capturedThinking,
                model: options.model,
                provider: options.provider,
                usage: {
                  inputTokens: am.usage.input,
                  outputTokens: am.usage.output,
                  cacheReadTokens: cacheStats.cachedTokens,
                  cacheWriteTokens: cacheStats.cacheWriteTokens,
                  cacheWrite1hTokens: cacheStats.cacheWrite1hTokens,
                  cacheHitRate: cacheStats.hitRate,
                  // Routing provenance (WS3) — written only when the caller
                  // (the executor's subscribe seam) supplied it, so direct
                  // subscribeBridge callers keep today's usage shape. The
                  // SERVED identity is NOT duplicated here — it lives in the
                  // message row's model/provider columns above.
                  ...(options.requestedProvider !== undefined ? { requestedProvider: options.requestedProvider } : {}),
                  ...(options.requestedModel !== undefined ? { requestedModel: options.requestedModel } : {}),
                  ...(options.routedTier !== undefined ? { routedTier: options.routedTier } : {}),
                  ...(options.failover !== undefined ? { failover: options.failover } : {}),
                },
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

              // Live-append this assistant turn to the pi session tree
              // (design §5) so the session mirror stays hot for the next
              // run's read. Keyed by the row id (mirror invariant), parented
              // on the SAME structural parent the messages row got. Gated on
              // the run's history-producer flag; fail-open — the replay-
              // authority catch-up on the next loadHistory is the backstop
              // for a dropped append.
              if (options.sessionHistoryProducer) {
                await appendSavedMessageEntry(
                  conversationId,
                  { id: turnMsg.id, role: "assistant", content: capturedText, createdAt: turnMsg.createdAt },
                  capturedParent,
                );
              }

              host.bus.emit("run:turn_saved", {
                runId: run.id,
                conversationId,
                messageId: turnMsg.id,
                parentMessageId: capturedParent,
                content: capturedText,
                thinkingContent: capturedThinking,
                final: isFinalTurn,
              });
              host.bus.emit("run:turn_text_reset", { runId: run.id });
            });
          }
        }
        if (ctx.turnHasToolCalls) {
          host.bus.emit("run:status", { runId: run.id, status: "Analyzing results..." });
        } else if (runCacheTurns.length > 0) {
          // Terminal turn (no tool calls → the agent loop ends here): emit a
          // once-per-run conversation cache summary, segmented by provider+model.
          const convCache = aggregateCacheStats(runCacheTurns);
          log.info("conversation cache summary", {
            turns: runCacheTurns.length,
            overallHitRate: Number(convCache.overall.hitRate.toFixed(4)),
            cachedTokens: convCache.overall.cachedTokens,
            promptTokens: convCache.overall.promptTokens,
            segments: convCache.segments.map((s) => ({
              provider: s.provider,
              model: s.model,
              hitRate: Number(s.hitRate.toFixed(4)),
              cachedTokens: s.cachedTokens,
              cacheWrite1hTokens: s.cacheWrite1hTokens,
              turns: s.turnCount,
            })),
          });
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
