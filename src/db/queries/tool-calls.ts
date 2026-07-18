import { eq, inArray } from "drizzle-orm";
import { getDb } from "../connection";
import { toolCalls } from "../schema";
import { redactToolCallOutputContent } from "../../extensions/audit-redaction";
import { persistError } from "./error-logs";
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
  /** "inline" | "dock" — drives the chat UI's DockHost auto-open. NULL/unset
   *  is treated as "inline" by the host (see canvas-dock-sdk plan §4). */
  cardLayout?: string | null;
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
 * Bulk-load minimal `(success)` rows for every tool call in a
 * conversation, ordered by `created_at` so the slice is sequence-faithful.
 *
 * Used by the lessons distiller's trigger gate
 * (`runtime/lessons/triggers.ts`) to compute two of the four signals:
 *   - `toolCallCount` (length of the returned array)
 *   - `errorRecoveryObserved` (an `error` row followed by an `ok` row)
 *
 * Selects only the `success` column — the gate doesn't need outputs,
 * names, or timing, so we keep the row footprint tiny. Row order is
 * load-bearing for the recovery detector; do not reorder.
 */
export async function listToolCallsByConversation(
  conversationId: string,
): Promise<Array<{ success: boolean }>> {
  if (!conversationId) return [];
  const db = getDb();
  const rows: Array<{ success: boolean }> = await db
    .select({ success: toolCalls.success })
    .from(toolCalls)
    .where(eq(toolCalls.conversationId, conversationId))
    .orderBy(toolCalls.createdAt);
  return rows;
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
// fallow-ignore-next-line unused-export
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

/**
 * Distinct extension ids that authored tool-call rows anchored to a
 * message. This IS the recorded extension identity of an
 * extension-authored message: the `messages` table carries no extension
 * column, but every `ezcorp/append-message` turn that a card can upload
 * to persists its tool-call rows with the calling extension's id
 * (append-message-handler.ts step 9). The uploads route uses this to
 * bind a target message to the uploading extension — a message with no
 * tool-call rows has no recorded identity and binds to nothing.
 */
export async function listToolCallExtensionIdsForMessage(
  messageId: string,
): Promise<string[]> {
  if (!messageId) return [];
  const rows: Array<{ extensionId: string }> = await getDb()
    .select({ extensionId: toolCalls.extensionId })
    .from(toolCalls)
    .where(eq(toolCalls.messageId, messageId));
  return [...new Set(rows.map((r) => r.extensionId))];
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
      output: {
        content: redactToolCallOutputContent("content" in row.output ? row.output.content : []),
      } as Record<string, unknown>,
      success: row.success,
      durationMs: row.durationMs,
      cardType: row.cardType ?? null,
      cardLayout: row.cardLayout ?? null,
      userId: row.userId ?? null,
      agentConfigId: row.agentConfigId ?? null,
      model: row.model ?? null,
      provider: row.provider ?? null,
    });
  } catch (err) {
    // Never-throw contract preserved: a DB persistence failure must not break
    // tool execution (the caller has already returned data to the LLM/user).
    // But it must not vanish silently either — a broken tool_calls insert
    // drops analytics dimensions, the message-detail tool-call UI, and the
    // extension-identity binding the uploads route relies on. Route the caught
    // error to persistError (fire-and-forget, itself never-throw) so the
    // failure stays observable — mirroring insertAuditEntry (audit-log.ts).
    await persistError({
      level: "warn",
      message: "tool-call-persist-failed: tool_calls",
      stack: err instanceof Error ? err.stack ?? null : null,
      metadata: {
        conversationId: row.conversationId,
        messageId: row.messageId,
        extensionId: row.extensionId,
        toolName: row.toolName,
        error: String(err),
      },
    });
  }
}
