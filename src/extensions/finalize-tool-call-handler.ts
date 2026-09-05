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
 * against the calling extension's id. The current principal must also
 * own the row's conversation and retain project access. These checks
 * and the update share one SQL transaction, including unbound calls.
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
import type { PermissionEngine } from "./permission-engine";
import { getDb, type DbTransaction } from "../db/connection";
import { toolCalls } from "../db/schema";
import { createRateLimiter } from "./rate-limit";
import { capabilityToolsDisabled } from "./capability-flags";
import { redactToolCallOutputContent } from "./audit-redaction";
import { rpcError, rpcResult } from "./json-rpc";
import { assertConversationEventOwner } from "./domain-event-outbox";
import { LifecycleError } from "./v4/types";
import { verifyInvocationLocks } from "./runtime-locks";

const MAX_OPS_PER_SECOND = 50;
const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

export interface FinalizeToolCallContext {
  conversationId: string;
  userId: string;
  grantedPermissions: ExtensionPermissions;
  /** Phase 6: PDP. Optional for back-compat with pre-PDP unit tests. */
  engine?: PermissionEngine;
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

  // Phase 6: PDP is the sole gate. Delegates the permission decision
  // when wired; legacy boolean fallback retained for pre-PDP test
  // contexts.
  if (ctx.engine) {
    const decision = await ctx.engine.authorize(
      {
        extensionId,
        userId: ctx.userId && ctx.userId !== "unknown" ? ctx.userId : null,
        conversationId:
          ctx.conversationId && ctx.conversationId !== "unknown"
            ? ctx.conversationId
            : null,
        toolName: "ezcorp/finalize-tool-call",
      },
      [{ kind: "ezcorp:chat:append" }],
    );
    if (decision.decision === "deny") {
      return rpcError(req.id, -32001, "appendMessages permission not granted");
    }
  } else if (!ctx.grantedPermissions.appendMessages) {
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
  return getDb().transaction(async (transaction: DbTransaction) => {
  await verifyInvocationLocks(transaction);
  const rows = await transaction
    .select({
      id: toolCalls.id,
      extensionId: toolCalls.extensionId,
      conversationId: toolCalls.conversationId,
    })
    .from(toolCalls)
    .where(eq(toolCalls.id, toolCallId))
    .for("update")
    .limit(1);

  const row = rows[0];
  if (!row) {
    return rpcError(req.id, -32602, "toolCallId not found");
  }
  if (row.extensionId !== extensionId) {
    return rpcError(req.id, -32001, "toolCall not owned by calling extension");
  }
  if (
    ctx.conversationId &&
    ctx.conversationId !== "unknown" &&
    row.conversationId !== ctx.conversationId
  ) {
    return rpcError(req.id, -32001, "toolCall not in calling extension's conversation");
  }
  if (!row.conversationId) return rpcError(req.id, -32001, "Tool call conversation access denied");
  try {
    await assertConversationEventOwner(transaction, ctx.userId, row.conversationId);
  } catch (error) {
    if (error instanceof LifecycleError && error.code === "event_not_found") return rpcError(req.id, -32001, "Tool call conversation access denied");
    throw error;
  }

  const output = coerceFinalizedOutput(params.output);
  const success = status === "complete";

  // Scrub credential-shaped strings from the finalized output before it
  // lands in tool_calls — mirrors the persistToolCall insert boundary so an
  // extension echoing e.g. a Bearer header into its output can't persist the
  // secret in plaintext. `redactToolCallOutputContent` never truncates, so
  // large UI-rendered outputs keep their shape.
  await transaction
    .update(toolCalls)
    .set({
      // Persist as the same `{ content }` envelope used by persistToolCall
      // so the read path in toolCallRowToSummary stays stable.
      output: { content: redactToolCallOutputContent(output.content) } as Record<string, unknown>,
      success,
    })
    .where(eq(toolCalls.id, toolCallId));

  return rpcResult(req.id, { ok: true });
  });
}
