/**
 * The ONLY IO layer of the chat-graph subsystem: fetch rows, hand them to
 * the pure builders. No graph logic lives here — that is what keeps both
 * builders testable without a database.
 *
 * Reads reuse the existing query surface rather than adding graph-specific
 * SQL: `getMessagesWithToolCalls` already returns messages + per-message
 * tool calls + sub-conversation summaries in one call, and its
 * `ToolCallSummary` already derives the success/error/interrupted status
 * the graph needs — re-deriving it here would fork that rule.
 *
 * DEGRADED MODE. `/tree` answers 409 when the `sessions:historyProducer`
 * flag is off, but the graph must not: a conversation map is still useful
 * without branch topology. So when the flag is off — or when the session
 * read fails outright, matching `loadHistory`'s documented fail-open
 * posture — the topology falls back to the flat `messages.parentMessageId`
 * chain and the payload carries `degraded: true`. That is a quiet notice
 * in the UI, not an error state.
 */

import {
  getMessagesWithToolCalls,
  type MessageWithToolCalls,
} from "../../db/queries/conversations";
import { getConversationObservability } from "../../db/queries/observability";
import { computeSessionTree, isSessionHistoryProducerEnabled } from "../../db/session-sync";
import { logger } from "../../logger";
import { buildConversationDag, type ConversationTreeNode } from "./build-conversation-dag";
import { buildTurnDag, type TurnDagMessage } from "./build-turn-dag";
import type { ChatGraph } from "./types";

const log = logger.child("chatGraph");

/** `createdAt` reaches the builders as ISO-8601 — the contract's axis. */
function iso(at: Date): string {
  return new Date(at).toISOString();
}

function toTurnMessage(m: MessageWithToolCalls): TurnDagMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    thinkingContent: m.thinkingContent,
    parentMessageId: m.parentMessageId,
    createdAt: iso(m.createdAt),
  };
}

/**
 * Branch topology for level 1, or the flat chain when the session tree is
 * unavailable. The synthesized fallback is deliberately the SAME shape the
 * session tree returns, so the builder keeps one code path.
 */
async function loadTopology(
  conversationId: string,
  messages: MessageWithToolCalls[],
): Promise<{ nodes: ConversationTreeNode[]; degraded: boolean }> {
  if (await isSessionHistoryProducerEnabled()) {
    try {
      const tree = await computeSessionTree(conversationId);
      return { nodes: tree.nodes, degraded: false };
    } catch (err) {
      log.warn("session tree unavailable — degrading to the flat message chain", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    nodes: messages.map((m) => ({
      id: m.id,
      parentId: m.parentMessageId,
      role: m.role,
      excluded: m.excluded,
      createdAt: iso(m.createdAt),
    })),
    degraded: true,
  };
}

/** Level 1 — the conversation map. */
export async function loadConversationGraph(conversationId: string): Promise<ChatGraph> {
  const { messages, subConversations } = await getMessagesWithToolCalls(conversationId);
  const topology = await loadTopology(conversationId, messages);
  return buildConversationDag({
    conversationId,
    treeNodes: topology.nodes,
    messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content })),
    // Same read, no extra query: roll each turn's activity onto its prompt.
    activity: messages.map((m) => ({
      messageId: m.id,
      toolCalls: m.toolCalls.length,
      hasThinking: (m.thinkingContent ?? "").length > 0,
      ...(m.usage?.inputTokens !== undefined ? { inputTokens: m.usage.inputTokens } : {}),
      ...(m.usage?.outputTokens !== undefined ? { outputTokens: m.usage.outputTokens } : {}),
    })),
    subConversations: subConversations.map((s) => ({
      id: s.id,
      agentName: s.agentName,
      parentMessageId: s.parentMessageId,
    })),
    ...(topology.degraded ? { degraded: true } : {}),
  });
}

/**
 * Level 2 — one turn's internals. `null` when `turnMessageId` is not a
 * user message OF THIS CONVERSATION; the route maps that to 404 so a turn
 * id from someone else's conversation cannot be probed. Only this
 * conversation's rows are ever fetched, so a foreign id simply is not
 * found.
 */
export async function loadTurnGraph(
  conversationId: string,
  turnMessageId: string,
): Promise<ChatGraph | null> {
  const [{ messages, subConversations }, observability] = await Promise.all([
    getMessagesWithToolCalls(conversationId),
    getConversationObservability(conversationId),
  ]);
  return buildTurnDag({
    conversationId,
    turnMessageId,
    messages: messages.map(toTurnMessage),
    toolCalls: messages.flatMap((m) =>
      m.toolCalls.map((tc) => ({
        id: tc.id,
        messageId: tc.messageId,
        toolName: tc.toolName,
        extensionId: tc.extensionId,
        status: tc.status,
        durationMs: tc.durationMs,
        createdAt: iso(tc.createdAt),
      })),
    ),
    subConversations: subConversations.map((s) => ({
      id: s.id,
      agentName: s.agentName,
      parentMessageId: s.parentMessageId,
    })),
    observability: observability.map((ev) => ({
      id: ev.id,
      eventType: ev.eventType,
      messageId: ev.messageId,
      data: (ev.data ?? {}) as Record<string, unknown>,
      durationMs: ev.durationMs,
      createdAt: iso(ev.createdAt),
    })),
  });
}
