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
