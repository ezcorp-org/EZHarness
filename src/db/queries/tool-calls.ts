import { eq, inArray } from "drizzle-orm";
import { getDb } from "../connection";
import { toolCalls } from "../schema";
import type { ToolCallResult } from "../../extensions/types";

/**
 * Shape shared by both tool_calls writers — the built-in path in
 * `executor.ts:tool_execution_end` and the extension path in
 * `tool-executor.ts:recordToolCall`. Kept narrow on purpose: callers hand
 * us the values they have in closure and we own the insert shape so the
 * four analytics dimensions (userId / agentConfigId / model / provider)
 * can't be silently dropped by a future refactor on one of the two sides.
 */
export interface ToolCallRow {
  /** Optional row id — built-in path pins it to the pi-agent toolCallId for
   *  dedup across streaming events + DB hydration. Extension path lets the
   *  column default kick in. */
  id?: string;
  conversationId: string;
  messageId: string | null;
  extensionId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: ToolCallResult | { content: unknown[] };
  success: boolean;
  durationMs: number;
  cardType?: string | null;
  userId?: string | null;
  agentConfigId?: string | null;
  model?: string | null;
  provider?: string | null;
}

/**
 * Persist a tool_calls row. Single write site for the denormalized
 * analytics dimensions — both the built-in and extension-tool paths call
 * through here so the schema contract lives in one place.
 *
 * Never throws: the caller has already started returning data to the
 * LLM / user, and a DB glitch must not block that path.
 */
/**
 * Bulk-load `(messageId, output)` pairs for a set of message IDs.
 *
 * Used by the assistant-message image rehydrator: tool results often carry
 * `![](…)` markdown pointing at generated images, and models following the
 * extension's guidance don't echo that URL into their text reply. Scanning
 * the raw tool output closes that gap.
 *
 * Rows whose `messageId` is null (orphan tool calls) are excluded — this
 * helper is for tool calls anchored to a specific assistant turn.
 */
export async function listToolCallOutputsForMessages(
  messageIds: string[],
): Promise<Array<{ messageId: string; output: unknown }>> {
  if (messageIds.length === 0) return [];
  const db = getDb();
  const rows: Array<{ messageId: string | null; output: unknown }> = await db
    .select({ messageId: toolCalls.messageId, output: toolCalls.output })
    .from(toolCalls)
    .where(inArray(toolCalls.messageId, messageIds));
  return rows.filter(
    (r: { messageId: string | null; output: unknown }): r is { messageId: string; output: unknown } =>
      r.messageId !== null,
  );
}

/**
 * Look up the (id, conversationId) pair for a tool call. Returns null
 * when the row doesn't exist (yet — extension tools persist after the
 * subprocess returns, so very fresh ids may be missing).
 *
 * Used by the generic events route to cross-check that a posted
 * `toolCallId` actually belongs to the body's `conversationId`,
 * closing the F2 forgery surface from the Phase A security review:
 * without this check, a user authenticated for conv-A could fire
 * events tagged with toolCallIds from conv-B as long as both are
 * theirs.
 */
export async function getToolCallConversationById(
  id: string,
): Promise<{ id: string; conversationId: string | null } | null> {
  const rows = await getDb()
    .select({ id: toolCalls.id, conversationId: toolCalls.conversationId })
    .from(toolCalls)
    .where(eq(toolCalls.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function persistToolCall(row: ToolCallRow): Promise<void> {
  try {
    await getDb().insert(toolCalls).values({
      ...(row.id ? { id: row.id } : {}),
      conversationId: row.conversationId,
      messageId: row.messageId,
      extensionId: row.extensionId,
      toolName: row.toolName,
      input: row.input,
      output: { content: "content" in row.output ? row.output.content : [] } as Record<string, unknown>,
      success: row.success,
      durationMs: row.durationMs,
      cardType: row.cardType ?? null,
      userId: row.userId ?? null,
      agentConfigId: row.agentConfigId ?? null,
      model: row.model ?? null,
      provider: row.provider ?? null,
    });
  } catch {
    // Swallow — DB persistence failure must not break tool execution.
    // (Prior behaviour; error logging is the EventBus's job, not ours.)
  }
}
