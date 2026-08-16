import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import * as convQueries from "$server/db/queries/conversations";
import { getVisibleMode } from "$server/db/queries/modes";
import { getProject } from "$server/db/queries/projects";
import { requireAuth } from "$server/auth/middleware";
import type { AuthUser } from "$server/auth/types";
import { updateConversationSchema } from "../schema";
import { validationError } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";
import { deleteForConversation as deleteAttachmentsFromDisk } from "$server/chat/attachments/storage";
import { logger } from "$server/logger";
import type { RequestHandler } from "./$types";

const log = logger.child("api.conversations");

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
  if (!conv) return errorJson(404, "Not found");
  return json(conv);
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conv = await verifyConversationOwnership(params.id, user);
  if (!conv) return errorJson(404, "Not found");

  const result = updateConversationSchema.safeParse(await request.json());
  if (!result.success) {
    return validationError(result.error);
  }

  // Phase 48: the Ez concierge conversation is locked to the builtin 'ez'
  // mode. Sibling guard to the existing builtin-mode-mutation rejection in
  // src/db/queries/modes.ts:78. Surfaces as 403 with an actionable error so
  // a buggy client can't silently re-mode the user's Ez thread.
  if (conv.kind === "ez" && Object.hasOwn(result.data, "modeId")) {
    return errorJson(
      403,
      "Cannot change the mode of an Ez conversation. The Ez panel is locked to the builtin 'ez' mode.",
    );
  }

  // The mode being written must be one this caller can see. This route used to
  // check NEITHER existence nor owner and leaned on the FK, so it was the
  // looser half of a pair: POST /api/conversations resolves the same id
  // through the same helper, and a create path stricter than the update path
  // is not a boundary — you just do it in two calls. Both now answer one
  // fail-closed 404 for "no such mode" and "not yours" alike.
  //
  // `null` is NOT a lookup: it clears the conversation's mode, which needs no
  // authorization beyond the ownership check already passed above.
  const nextModeId = result.data.modeId;
  if (typeof nextModeId === "string" && nextModeId) {
    if (!(await getVisibleMode(nextModeId, user.id))) {
      return errorJson(404, "Mode not found");
    }
  }

  const updated = await convQueries.updateConversation(params.id, result.data);
  if (!updated) return errorJson(404, "Not found");
  return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conv = await verifyConversationOwnership(params.id, user);
  if (!conv) return errorJson(404, "Not found");

  // DB rows cascade via FK; but attachment files live on disk and need manual GC.
  // Resolve project root before the cascade nukes the conversation row.
  const project = await getProject(conv.projectId);

  // Secure-preview reaping (Phase 3b): kill any dev-server process running
  // under this conversation's preview uid + release the uid + drop the
  // watcher's watch BEFORE the cascade. The preview_sessions rows cascade
  // via FK, but the untrusted PROCESS won't stop itself — reap it explicitly.
  try {
    const { reapPreviewConversation } = await import("$server/runtime/preview/preview-reaper");
    const { getPreviewPortWatcher } = await import("$server/startup/background-timers");
    await reapPreviewConversation(params.id, { unwatch: (c) => getPreviewPortWatcher()?.unwatch(c) });
  } catch (err) {
    log.warn("preview reap on conversation delete failed", {
      conversationId: params.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const deleted = await convQueries.deleteConversation(params.id);
  if (!deleted) return errorJson(404, "Not found");

  if (project?.path) {
    await deleteAttachmentsFromDisk({ projectRoot: project.path, conversationId: params.id })
      .catch((err) => log.warn("attachment GC failed", { error: err instanceof Error ? err.message : String(err), conversationId: params.id }));
  }

  return new Response(null, { status: 204 });
};
