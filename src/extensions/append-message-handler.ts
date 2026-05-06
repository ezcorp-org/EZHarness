/**
 * Handles `ezcorp/append-message` reverse RPC.
 *
 * Lets an extension author a turn directly into the conversation it's
 * wired to. The new turn is always `role: "extension"` and forced
 * `excluded: true` — `role: "extension"` rows are filtered out of LLM
 * history by `src/runtime/stream-chat/build-pi-agent.ts` (only
 * user/assistant/toolResult survive `convertToLlm`), but we also flip
 * `excluded` so the chat UI's "excluded from chat context" pill renders.
 * The `appendMessages.excludedDefault` field on the manifest grant is
 * reserved for a future opt-in tier; for now it has no runtime effect.
 *
 * Enforcement ladder (strict order, mirrors `task-events-handler.ts`):
 *   1. Kill-switch (`EZCORP_DISABLE_CAPABILITY_TOOLS=1`)
 *   2. `granted.appendMessages` present
 *   3. Parent conversationId bound (not "unknown")
 *   4. Extension wired to the parent conversation
 *   5. Caller-supplied `conversationId` (if present) === host's forced one
 *   6. Instantaneous rate limit (50 ops/sec)
 *   7. Payload validation: parentMessageId, role, content length
 *   8. attachmentIds (when supplied) all belong to the caller's
 *      conversation
 *
 * On accept: createMessage(role:"extension", excluded:true) → persist
 * tool calls (one row per item) → update each attachmentId's
 * `messageId` to the new message id. The whole thing is best-effort
 * non-transactional today (mirrors the messages POST handler), so a
 * partial failure on attachments leaves the message in place — same
 * tradeoff documented at messages/+server.ts.
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  ExtensionPermissions,
  ToolCallResult,
} from "./types";
import { eq, and, inArray } from "drizzle-orm";
import { getDb } from "../db/connection";
import { messageAttachments } from "../db/schema";
import { getConversationExtensionIds } from "../db/queries/conversation-extensions";
import * as convQueries from "../db/queries/conversations";
import { persistToolCall } from "../db/queries/tool-calls";
import { createRateLimiter } from "./rate-limit";
import { capabilityToolsDisabled } from "./capability-flags";
import { rpcError, rpcResult } from "./json-rpc";

const MAX_OPS_PER_SECOND = 50;
const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

const MAX_CONTENT_LEN = 100_000;
const MAX_TOOL_CALLS = 32;

/**
 * Per-tool-call shape extensions can pass alongside an append. The status
 * is restricted to the two states a card-bearing tool can be in at the
 * moment of message authorship — `running` (synthesis in progress, the
 * card finalises later via `ezcorp/finalize-tool-call`) and `complete`
 * (output already known).
 */
export interface AppendToolCallSpec {
  name: string;
  input: unknown;
  cardType?: string;
  cardLayout?: "inline" | "dock";
  status: "running" | "complete";
  output?: unknown;
}

export interface AppendMessageContext {
  conversationId: string;
  userId: string;
  grantedPermissions: ExtensionPermissions;
}

// ── Validation helpers ─────────────────────────────────────────────

interface ValidationResult { ok: true; }
interface ValidationFailure { ok: false; errors: string[]; }
type Validation = ValidationResult | ValidationFailure;

function isString(v: unknown): v is string { return typeof v === "string"; }
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateToolCallSpec(tc: unknown, idx: number, errors: string[]): void {
  if (!isObj(tc)) { errors.push(`toolCalls[${idx}]: not an object`); return; }
  if (!isString(tc.name) || tc.name.length === 0) errors.push(`toolCalls[${idx}].name: required string`);
  if (tc.input === undefined) errors.push(`toolCalls[${idx}].input: required`);
  if (tc.cardType !== undefined && !isString(tc.cardType))
    errors.push(`toolCalls[${idx}].cardType: must be string when present`);
  if (tc.cardLayout !== undefined && tc.cardLayout !== "inline" && tc.cardLayout !== "dock")
    errors.push(`toolCalls[${idx}].cardLayout: must be "inline" | "dock"`);
  if (tc.status !== "running" && tc.status !== "complete")
    errors.push(`toolCalls[${idx}].status: must be "running" | "complete"`);
}

function validateParams(params: Record<string, unknown>, forcedConvId: string): Validation {
  const errors: string[] = [];

  if (!isString(params.parentMessageId) || params.parentMessageId.length === 0) {
    errors.push("parentMessageId: required string");
  }

  // Role is the only field with a fixed enum today. Reject all other
  // role strings up front so the column never gets a value the LLM
  // history filter doesn't recognise.
  if (params.role !== "extension") {
    errors.push(`role: must be "extension"`);
  }

  if (!isString(params.content) || params.content.length === 0 || params.content.length > MAX_CONTENT_LEN) {
    errors.push(`content: required string of 1-${MAX_CONTENT_LEN} chars`);
  }

  // Caller may pass `conversationId` for clarity but it must match the
  // host's forced one. Cross-conversation forgery is the headline
  // attack we're defending against here (mirrors the comment in
  // task-events-handler.ts).
  if (params.conversationId !== undefined && params.conversationId !== forcedConvId) {
    errors.push("conversationId: must match the calling extension's wired conversation");
  }

  if (params.toolCalls !== undefined) {
    if (!Array.isArray(params.toolCalls)) {
      errors.push("toolCalls: must be an array when present");
    } else if (params.toolCalls.length > MAX_TOOL_CALLS) {
      errors.push(`toolCalls: at most ${MAX_TOOL_CALLS} entries`);
    } else {
      params.toolCalls.forEach((tc, i) => validateToolCallSpec(tc, i, errors));
    }
  }

  if (params.attachmentIds !== undefined) {
    if (!Array.isArray(params.attachmentIds)) {
      errors.push("attachmentIds: must be an array of strings when present");
    } else {
      params.attachmentIds.forEach((id, i) => {
        if (!isString(id) || id.length === 0) errors.push(`attachmentIds[${i}]: must be a non-empty string`);
      });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Coerce a caller-supplied tool-call output into the `ToolCallResult`
 * shape `persistToolCall` expects. We don't trust extensions to ship
 * the canonical `{ content: [...] }` envelope, so wrap plain values in
 * a single text part. Strings pass through unchanged; objects /
 * primitives get JSON-stringified for stability.
 */
function coerceToolCallOutput(output: unknown, isError: boolean): ToolCallResult {
  if (output === undefined || output === null) {
    return { content: [], isError };
  }
  if (typeof output === "object" && output !== null && Array.isArray((output as { content?: unknown }).content)) {
    // Already a ToolCallResult-shaped envelope — accept as-is, but
    // override `isError` from the caller's status (the explicit signal
    // wins over a stale flag inside the envelope).
    return { content: ((output as ToolCallResult).content) ?? [], isError };
  }
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return { content: [{ type: "text", text }], isError };
}

// ── Main handler ───────────────────────────────────────────────────

/**
 * Persist an extension-authored turn + its inline tool-calls + reattribute
 * any pre-uploaded attachments. The forced `excluded: true` is a
 * belt-and-suspenders defense — `role: "extension"` rows are already
 * filtered from LLM history by `build-pi-agent.ts`'s `convertToLlm`,
 * but flipping `excluded` makes the UI's pill render and survives any
 * future widening of the role enum.
 */
export async function handleAppendMessageRpc(
  extensionId: string,
  req: JsonRpcRequest,
  ctx: AppendMessageContext,
): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as Record<string, unknown>;

  // 1. Kill-switch.
  if (capabilityToolsDisabled()) {
    return rpcError(req.id, -32001, "appendMessages permission not granted");
  }

  // 2. Permission check — the manifest+grant must declare appendMessages.
  if (!ctx.grantedPermissions.appendMessages) {
    return rpcError(req.id, -32001, "appendMessages permission not granted");
  }

  // 3. Conversation scope. Tool-call-driven invocations have ctx
  // populated by the executor's per-turn state; event-driven
  // invocations (messageToolbar contributions) don't, but the
  // subprocess always carries conversationId in its params (it
  // received it on the inbound bus event). Fall back to params when
  // ctx is unbound — wiring + cross-conversation defenses still
  // apply below, so accepting it here doesn't widen the trust
  // boundary.
  let effectiveConvId = ctx.conversationId;
  if (!effectiveConvId || effectiveConvId === "unknown") {
    if (typeof params.conversationId === "string" && params.conversationId.length > 0) {
      effectiveConvId = params.conversationId;
    } else {
      return rpcError(req.id, -32602, "Conversation scope unavailable in this context");
    }
  }

  // 4. Wiring check — extension must be declared on this conversation.
  const wiredIds = await getConversationExtensionIds(effectiveConvId);
  if (!wiredIds.includes(extensionId)) {
    return rpcError(req.id, -32001, "Extension not wired to this conversation");
  }

  // 5. Validate the params shape (catches cross-conversation forgery via
  // the `conversationId` mismatch check inside).
  const validation = validateParams(params, effectiveConvId);
  if (!validation.ok) {
    return rpcError(req.id, -32602, `Invalid params: ${validation.errors[0] ?? "unknown error"}`);
  }

  // 6. Rate limit.
  if (!consumeTokens(extensionId, 1)) {
    return rpcError(req.id, -32029, "Rate limited");
  }

  const parentMessageId = params.parentMessageId as string;
  const content = params.content as string;
  const toolCalls = (params.toolCalls as AppendToolCallSpec[] | undefined) ?? [];
  const attachmentIds = (params.attachmentIds as string[] | undefined) ?? [];

  // 7. If attachments were supplied, verify each row belongs to the
  // caller's conversation BEFORE inserting the message. We run this
  // pre-flight check rather than after the message insert so a
  // mismatch never leaves an empty turn behind. NOTE: the schema
  // makes `messageId` NOT NULL, so the upload route sets it to a
  // pre-allocated message id (route plan option (c)) rather than null
  // — we re-key here regardless of the prior anchor.
  if (attachmentIds.length > 0) {
    const rows = await getDb()
      .select({ id: messageAttachments.id, conversationId: messageAttachments.conversationId })
      .from(messageAttachments)
      .where(inArray(messageAttachments.id, attachmentIds));
    if (rows.length !== attachmentIds.length) {
      return rpcError(req.id, -32602, "One or more attachmentIds do not exist");
    }
    for (const r of rows) {
      if (r.conversationId !== effectiveConvId) {
        return rpcError(req.id, -32001, "attachmentIds must belong to the calling conversation");
      }
    }
  }

  // 8. Insert the message with role forced to "extension" and
  // excluded=true. createMessage doesn't expose `excluded`, so we
  // patch it via setMessageExcluded immediately after — same row, two
  // statements. The brief window between create + flip is invisible
  // because the caller is awaiting our response (no SSE flush yet).
  const newMsg = await convQueries.createMessage(effectiveConvId, {
    role: "extension",
    content,
    parentMessageId,
  });
  await convQueries.setMessageExcluded(effectiveConvId, newMsg.id, true);

  // 9. Persist tool-call rows. Each one gets the new message's id as
  // its anchor; the executor's path keys on the same column when it
  // hydrates inline cards onto a turn. We mint our own row ids so the
  // response can return them — the subprocess uses them to call back
  // via `ezcorp/finalize-tool-call` once the card finishes async work.
  const toolCallIds: string[] = [];
  for (const tc of toolCalls) {
    const id = crypto.randomUUID();
    const isError = false;
    const out = coerceToolCallOutput(tc.output, isError);
    await persistToolCall({
      id,
      conversationId: effectiveConvId,
      messageId: newMsg.id,
      extensionId,
      toolName: tc.name,
      input: (typeof tc.input === "object" && tc.input !== null
        ? (tc.input as Record<string, unknown>)
        : { value: tc.input }),
      output: out,
      // Always start as success=true: a `running` call that errors out
      // later flips this via `ezcorp/finalize-tool-call`. The
      // interrupted-status discriminator in `toolCallRowToSummary`
      // only fires when BOTH success=null AND output=null — neither is
      // true for an append, so a fresh running row renders correctly.
      success: true,
      durationMs: 0,
      cardType: tc.cardType ?? null,
      cardLayout: tc.cardLayout ?? null,
      userId: ctx.userId !== "unknown" ? ctx.userId : null,
    });
    toolCallIds.push(id);
  }

  // 10. Reattribute pre-uploaded attachments to the new message. This
  // happens last so a failure here doesn't strand tool_call rows
  // pointing at a message-less attachment.
  if (attachmentIds.length > 0) {
    await getDb()
      .update(messageAttachments)
      .set({ messageId: newMsg.id })
      .where(and(
        inArray(messageAttachments.id, attachmentIds),
        eq(messageAttachments.conversationId, effectiveConvId),
      ));
  }

  return rpcResult(req.id, { messageId: newMsg.id, toolCallIds });
}
