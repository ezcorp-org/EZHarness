import { error } from "@sveltejs/kit";
import { mergeAuditForConversation } from "$server/db/queries/audit-merge";
import { getConversation, getMessages } from "$server/db/queries/conversations";
import { listExtensions } from "$server/db/queries/extensions";
import { requireAuth } from "$server/auth/middleware";
import type { PageServerLoad } from "./$types";

/**
 * Phase 52.3 — per-conversation audit drill-down loader.
 *
 * Auth: conversation owner only (mirrors the API endpoint). 404 on
 * not-owned mirrors the same fail-closed semantics as the API; we
 * deliberately don't 403 to avoid exposing the existence of a
 * conversation id the caller can't read.
 *
 * Loads:
 *   - the conversation row (title, mode, etc — header).
 *   - the first audit page + cursor.
 *   - the message list (light projection — id, role, createdAt) so
 *     the page can show capability calls aligned to the message
 *     timeline.
 *   - the active extension list (so per-extension chips can render
 *     "lessons-keeper · 12 calls" etc).
 */
export const load: PageServerLoad = async ({ params, locals }) => {
  const user = requireAuth(locals);
  const conv = await getConversation(params.convId);
  if (!conv) throw error(404, "Conversation not found");
  // Path scope guard: `params.id` is the project segment of the route.
  // If the caller pastes a convId that exists under a *different*
  // project, fail-closed with 404 — same surface as the not-found
  // case so we don't leak the existence of a foreign-project conv.
  if (conv.projectId !== params.id) {
    throw error(404, "Conversation not found");
  }
  if (conv.userId !== user.id && user.role !== "admin") {
    throw error(404, "Conversation not found");
  }

  const [{ entries, nextCursor }, allMessages, allExtensions] = await Promise.all([
    mergeAuditForConversation(params.convId, { limit: 200 }),
    getMessages(params.convId),
    listExtensions().catch(() => []),
  ]);

  // Light projection — only what the timeline needs. Avoids shipping
  // attachment metadata / streaming state to the audit page where it
  // would just be ignored.
  const messages = allMessages.map((m) => ({
    id: m.id,
    role: m.role,
    createdAt: m.createdAt,
    contentPreview: typeof m.content === "string" ? m.content.slice(0, 80) : "",
  }));

  // Index extensions by id so the page can render names + bundled flag
  // without a second fetch.
  const extensionsById = Object.fromEntries(
    allExtensions.map((e) => [e.id, { id: e.id, name: e.name, isBundled: e.isBundled }]),
  );

  return {
    conversation: {
      id: conv.id,
      title: conv.title ?? "Untitled",
      projectId: conv.projectId,
    },
    entries,
    nextCursor,
    messages,
    extensionsById,
  };
};
