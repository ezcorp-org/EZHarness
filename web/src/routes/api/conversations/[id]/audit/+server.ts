import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import * as convQueries from "$server/db/queries/conversations";
import { mergeAuditForConversation } from "$server/db/queries/audit-merge";

/**
 * GET /api/conversations/[id]/audit
 *
 * Phase 52.3 — per-conversation audit timeline. Auth: conversation
 * owner only (mirrors the existing `verifyConversationOwnership` in
 * `/api/conversations/[id]/+server.ts:16` — owners only, with admin
 * fallback for unowned rows). 404 on unknown / not-owned so a
 * non-owner can't probe the conversation id space.
 *
 * Returns sdk_capability_calls rows scoped to conversation_id. The
 * resource audit logs (memory/lessons) don't carry a conversation_id
 * column today; surface them via the per-extension drill-down using
 * the same resource id (links available from the timeline rows).
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const conv = await convQueries.getConversation(params.id);
  if (!conv) return errorJson(404, "Not found");
  // sec-H3 fail-closed mirroring the existing pattern: unowned rows
  // (null userId) are admin-only.
  if (conv.userId !== user.id && user.role !== "admin") {
    return errorJson(404, "Not found");
  }

  const KNOWN_CAPS = new Set(["llm", "memory", "lessons", "schedule", "events"]);
  const cap = url.searchParams.get("capability");
  const capability = cap && KNOWN_CAPS.has(cap)
    ? (cap as "llm" | "memory" | "lessons" | "schedule" | "events")
    : undefined;
  const status = url.searchParams.get("status") === "denial" ? "denial" : undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const sinceDate = since ? new Date(since) : undefined;
  const untilDate = until ? new Date(until) : undefined;
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;

  const { entries, nextCursor } = await mergeAuditForConversation(params.id, {
    capability,
    status,
    cursor,
    since: sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : undefined,
    until: untilDate && !Number.isNaN(untilDate.getTime()) ? untilDate : undefined,
    limit,
  });

  return json({ entries, nextCursor });
};
