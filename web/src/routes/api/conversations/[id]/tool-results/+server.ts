import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import * as convQueries from "$server/db/queries/conversations";
import {
  getPendingEzClientTool,
  resolveEzClientTool,
} from "$server/runtime/ez-client-tool-registry";

/**
 * POST /api/conversations/[id]/tool-results
 *
 * Phase 48 — resumes a suspended Ez client-side tool call. The runtime
 * emits `ez:client-tool` over SSE when the LLM invokes `fill_form` or
 * `navigate_to`; the Ez panel dispatches the call locally and POSTs the
 * result here, which resolves the registry-pending Promise and the
 * agent loop continues.
 *
 * Mirrors the contract used by `/api/ask-user/answer/+server.ts`:
 *   1. `requireScope(locals, "chat")` — same scope as message-send.
 *   2. `requireAuth(locals)` — pulls the session user.
 *   3. Authorization: the pending entry's `userId` (captured at wire time)
 *      must match the acting user, AND the URL [id] must match the
 *      pending entry's `conversationId`. Mismatch → 404, not 403, so
 *      we don't leak existence of others' pending tool calls.
 *
 * Late-POST contract: when no entry exists, return `{ ok: true }`
 * without emitting. Mirrors the legacy human-input endpoint's
 * optimistic-dismissal — the gate may have already collapsed
 * (timeout, abort, server restart) and the panel has already moved on.
 *
 * The body's `result` is forwarded verbatim to the registry. The
 * fill_form / navigate_to tool body normalizes any shape into a stable
 * `AgentToolResult` for the LLM (see fill-form.ts:panelResultToToolResult).
 */
const toolResultBodySchema = z
  .object({
    toolCallId: z.string().min(1),
    // `result` is the panel's `DispatchResult` (see
    // web/src/lib/ez/client-tool-dispatcher.ts) — but we accept any JSON
    // shape so a future panel refactor doesn't require a coupled server
    // change. The tool body normalizes whatever arrives.
    result: z.unknown(),
  })
  .strict();

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conversationId = params.id;

  const raw = await request.json().catch(() => null);
  const parsed = toolResultBodySchema.safeParse(raw);
  if (!parsed.success) return errorJson(400, "Invalid body");
  const { toolCallId, result } = parsed.data;

  // Late-POST: registry entry already cleared (timeout/abort/server
  // restart). Return ok without emitting — mirrors ask-user/answer.
  const pending = getPendingEzClientTool(toolCallId);
  if (!pending) return json({ ok: true, late: true });

  // Authorization: the URL [id] must agree with the registered
  // conversation. A mismatch implies a malicious / buggy caller — return
  // 404 (not 403) so we don't leak pending-tool-call existence across
  // conversations.
  if (pending.conversationId !== conversationId) {
    return errorJson(404, "Not found");
  }

  // Owner check: the registry captured the conversation owner at wire
  // time (see ez-tools-host.ts → fill-form.ts ctx.userId). Mismatch ⇒
  // 404 (not 403) — same posture as ask-user/answer's auth chain.
  if (pending.userId !== null && pending.userId !== user.id) {
    return errorJson(404, "Not found");
  }

  // Defense-in-depth: confirm the conversation actually exists and is
  // owned by the user. The registry's userId match above SHOULD be
  // sufficient (it was captured server-side), but a stale registration
  // after a server crash could theoretically outlive a deleted
  // conversation. The DB hop here is the same one /api/conversations/[id]
  // makes on every read.
  const conv = await convQueries.getConversation(conversationId);
  if (!conv || (conv.userId !== user.id && user.role !== "admin")) {
    return errorJson(404, "Not found");
  }

  const resolved = resolveEzClientTool(toolCallId, result);
  return json({ ok: true, resolved });
};
