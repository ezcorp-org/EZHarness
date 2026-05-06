/**
 * Handles `ezcorp/finalize-tool-call` reverse RPC.
 *
 * Lets an extension flip a previously-`running` tool_call row into its
 * terminal state. Used by extensions that author a turn via
 * `ezcorp/append-message` with a `running` tool-call (typically because
 * the card needs to do async work like uploading an attachment), then
 * call back here to swap in the final output once the work is done.
 *
 * Permission gate: callers must hold `appendMessages` (the same
 * permission that authorised the original insert) AND own the tool
 * call — ownership is established by matching `tool_calls.extensionId`
 * against the calling extension's id. A row whose `extensionId` doesn't
 * match the caller is rejected — no cross-extension finalize.
 *
 * Status enum: `"complete"` or `"error"`. The row's `success` column
 * gets `true` for complete, `false` for error; the existing card
 * machinery in `toolCallRowToSummary` derives the UI status string
 * from that pair.
 */

import { eq } from "drizzle-orm";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ExtensionPermissions,
  ToolCallResult,
} from "./types";
import { getDb } from "../db/connection";
import { toolCalls } from "../db/schema";
import { createRateLimiter } from "./rate-limit";
import { capabilityToolsDisabled } from "./capability-flags";
import { rpcError, rpcResult } from "./json-rpc";

const MAX_OPS_PER_SECOND = 50;
const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

export interface FinalizeToolCallContext {
  conversationId: string;
  userId: string;
  grantedPermissions: ExtensionPermissions;
}

/**
 * Wrap a caller-supplied `output` into the persisted `{ content }`
 * shape. Mirrors `coerceToolCallOutput` in `append-message-handler.ts`
 * — extracted into both files rather than shared because the two
 * handlers' responsibilities are independent (this one runs
 * post-message-insert, after the messages-table row is already
 * authoritative). Strings pass through; objects/primitives are
 * JSON-stringified into a single text part.
 */
function coerceFinalizedOutput(output: unknown): ToolCallResult {
  if (output === undefined || output === null) {
    return { content: [], isError: false };
  }
  if (typeof output === "object" && output !== null && Array.isArray((output as { content?: unknown }).content)) {
    return { content: ((output as ToolCallResult).content) ?? [], isError: false };
  }
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return { content: [{ type: "text", text }], isError: false };
}

export async function handleFinalizeToolCallRpc(
  extensionId: string,
  req: JsonRpcRequest,
  ctx: FinalizeToolCallContext,
): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (capabilityToolsDisabled()) {
    return rpcError(req.id, -32001, "appendMessages permission not granted");
  }

  if (!ctx.grantedPermissions.appendMessages) {
    return rpcError(req.id, -32001, "appendMessages permission not granted");
  }

  const toolCallId = params.toolCallId;
  const status = params.status;
  if (typeof toolCallId !== "string" || toolCallId.length === 0) {
    return rpcError(req.id, -32602, "toolCallId: required string");
  }
  if (status !== "complete" && status !== "error") {
    return rpcError(req.id, -32602, `status: must be "complete" | "error"`);
  }

  if (!consumeTokens(extensionId, 1)) {
    return rpcError(req.id, -32029, "Rate limited");
  }

  // Ownership lookup: the row's extensionId must match the caller. We
  // also pull conversationId so the response gate matches the caller's
  // wired scope — defense-in-depth against a future bug that lets
  // append-message slip a row in for the wrong conversation.
  const rows = await getDb()
    .select({
      id: toolCalls.id,
      extensionId: toolCalls.extensionId,
      conversationId: toolCalls.conversationId,
    })
    .from(toolCalls)
    .where(eq(toolCalls.id, toolCallId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return rpcError(req.id, -32602, "toolCallId not found");
  }
  if (row.extensionId !== extensionId) {
    return rpcError(req.id, -32001, "toolCall not owned by calling extension");
  }
  // Cross-conversation check. Tool-call-driven invocations have
  // ctx.conversationId populated (per-turn executor state); event-
  // driven invocations (kokoro-tts:save from the card) don't. When
  // ctx is unbound, the row's `extensionId === extensionId` check
  // already proved ownership above — same scope guarantee, just
  // arrived from a different direction.
  if (
    ctx.conversationId &&
    ctx.conversationId !== "unknown" &&
    row.conversationId !== ctx.conversationId
  ) {
    return rpcError(req.id, -32001, "toolCall not in calling extension's conversation");
  }

  const output = coerceFinalizedOutput(params.output);
  const success = status === "complete";

  await getDb()
    .update(toolCalls)
    .set({
      // Persist as the same `{ content }` envelope used by persistToolCall
      // so the read path in toolCallRowToSummary stays stable.
      output: { content: output.content } as Record<string, unknown>,
      success,
    })
    .where(eq(toolCalls.id, toolCallId));

  return rpcResult(req.id, { ok: true });
}
