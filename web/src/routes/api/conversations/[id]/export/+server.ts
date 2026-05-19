import * as convQueries from "$server/db/queries/conversations";
import { requireAuth } from "$server/auth/middleware";
import { exportToMarkdown, exportToJson } from "$server/lib/export";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "-").slice(0, 100);
}

export const GET: RequestHandler = async ({ params, url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const format = url.searchParams.get("format") ?? "markdown";
  const leafMessageId = url.searchParams.get("leafMessageId");
  const conversationId = params.id;

  const conv = await convQueries.getConversation(conversationId);
  if (!conv) return errorJson(404, "Not found");
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return errorJson(404, "Not found");

  // Load branch-aware messages
  let msgs;
  if (leafMessageId) {
    msgs = await convQueries.getConversationPath(leafMessageId, conversationId);
  } else {
    const leaf = await convQueries.getLatestLeaf(conversationId);
    msgs = leaf
      ? await convQueries.getConversationPath(leaf.id, conversationId)
      : [];
  }

  const date = new Date().toISOString().slice(0, 10);
  const safeName = sanitizeFilename(conv.title);

  if (format === "json") {
    const content = exportToJson(conv, msgs);
    return new Response(content, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${safeName}-${date}.json"`,
      },
    });
  }

  // Default: markdown
  const content = exportToMarkdown(conv, msgs);
  return new Response(content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}-${date}.md"`,
    },
  });
};
