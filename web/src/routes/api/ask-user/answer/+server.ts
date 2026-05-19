import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { getBus } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { getPendingAskUser } from "$server/runtime/ask-user-registry";

// Boundary validation. `toolCallId` matches the host-minted invocation
// id; `answer` is the option label or free-text the user submitted.
// Strict so unknown fields fail loud.
const askUserAnswerSchema = z
  .object({
    toolCallId: z.string().min(1),
    answer: z.string().min(1),
  })
  .strict();

/**
 * POST /api/ask-user/answer — resolves a pending `ask_user_question`
 * tool gate by emitting `ask-user:answer` on the host bus. The
 * `ask-user` extension's subscription handler picks this up and
 * resolves the matching pending-answer promise (keyed on
 * `toolCallId`).
 *
 * Auth chain:
 *   1. `requireScope(locals, "chat")` — same scope the legacy
 *      `/api/orchestrator/human-input` endpoint used.
 *   2. `requireAuth(locals)` — pulls the session user.
 *   3. Authorization: the tool call's conversation must be owned by
 *      the acting user. Owner is captured at wire time and stored in
 *      `ask-user-registry`. Mismatch → 404 (not 403) so we don't
 *      disclose existence of someone else's pending tool call.
 *
 * Why an in-memory registry and NOT a `tool_calls` SELECT:
 *   `ToolExecutor.recordToolCall` writes the `tool_calls` row AFTER
 *   the subprocess returns. For `ask_user_question`, the subprocess
 *   does not return until the user answers — so during the entire
 *   window the user can click an option, no DB row exists yet. A
 *   SELECT-by-id would silently miss every legitimate POST. The
 *   `ask-user-registry.ts` map is populated by
 *   `wireAskUserToolForTurn`'s execute wrapper and cleared in its
 *   `finally`, so the lookup is O(1) and race-free.
 *
 * Late-POST contract: when no entry exists, return `{ ok: true }`
 * without emitting. Mirrors the legacy human-input endpoint's
 * optimistic-dismissal — the gate may have already collapsed
 * (timeout, abort, server restart) and the UI has already locally
 * dismissed the card; surfacing an error here would just be noise.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const raw = await request.json().catch(() => null);
  const parsed = askUserAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    return errorJson(400, "Invalid body");
  }
  const { toolCallId, answer } = parsed.data;

  const pending = getPendingAskUser(toolCallId);
  // Gate already collapsed (no entry) — return ok without emitting.
  if (!pending) {
    return json({ ok: true });
  }

  // Authorization: only the conversation owner can answer the
  // question. 404 (not 403) so we don't leak existence of others'
  // pending tool calls.
  if (pending.userId !== user.id) {
    return errorJson(404, "Not found");
  }

  getBus().emit("ask-user:answer", {
    toolCallId,
    conversationId: pending.conversationId,
    answer,
  });

  return json({ ok: true });
};
