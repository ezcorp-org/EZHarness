import { json } from "@sveltejs/kit";
import * as convQueries from "$server/db/queries/conversations";
import { getProject } from "$server/db/queries/projects";
import { requireAuth } from "$server/auth/middleware";
import type { AuthUser } from "$server/auth/types";
import { updateConversationSchema } from "../schema";
import { validationError } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";
import { deleteForConversation as deleteAttachmentsFromDisk } from "$server/chat/attachments/storage";
import type { RequestHandler } from "./$types";

async function verifyConversationOwnership(id: string, user: AuthUser) {
  const conv = await convQueries.getConversation(id);
  if (!conv) return null;
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return null;
  return conv;
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conv = await verifyConversationOwnership(params.id, user);
  if (!conv) return json({ error: "Not found" }, { status: 404 });
  return json(conv);
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conv = await verifyConversationOwnership(params.id, user);
  if (!conv) return json({ error: "Not found" }, { status: 404 });

  const result = updateConversationSchema.safeParse(await request.json());
  if (!result.success) {
    return validationError(result.error);
  }
  const updated = await convQueries.updateConversation(params.id, result.data);
  if (!updated) return json({ error: "Not found" }, { status: 404 });
  return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conv = await verifyConversationOwnership(params.id, user);
  if (!conv) return json({ error: "Not found" }, { status: 404 });

  // DB rows cascade via FK; but attachment files live on disk and need manual GC.
  // Resolve project root before the cascade nukes the conversation row.
  const project = await getProject(conv.projectId);

  const deleted = await convQueries.deleteConversation(params.id);
  if (!deleted) return json({ error: "Not found" }, { status: 404 });

  if (project?.path) {
    await deleteAttachmentsFromDisk({ projectRoot: project.path, conversationId: params.id })
      .catch((err) => console.error("[conversations] attachment GC failed:", err));
  }

  return new Response(null, { status: 204 });
};
