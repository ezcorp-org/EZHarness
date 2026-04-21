import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import {
  listAllSessions,
  revokeSession,
  revokeAllUserSessions,
} from "$server/db/queries/sessions";
import { validationError } from "$lib/server/security/validation";

const deleteSchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .refine((d) => d.userId || d.sessionId, {
    message: "Either userId or sessionId is required",
  });

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    requireRole(locals, "admin");

    const filterUserId = url.searchParams.get("userId");
    let sessions = await listAllSessions();

    if (filterUserId) {
      sessions = sessions.filter((s) => s.userId === filterUserId);
    }

    const mapped = sessions.map((s) => ({
      id: s.id,
      userId: s.userId,
      userName: s.userName,
      userEmail: s.userEmail,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      lastActiveAt: s.lastActiveAt,
      createdAt: s.createdAt,
    }));

    return json({ sessions: mapped });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    requireRole(locals, "admin");

    const result = deleteSchema.safeParse(await request.json());
    if (!result.success) return validationError(result.error);

    const { userId, sessionId } = result.data;

    if (userId) {
      const count = await revokeAllUserSessions(userId);
      return json({ success: true, revokedCount: count });
    }

    if (sessionId) {
      const deleted = await revokeSession(sessionId);
      if (!deleted) {
        return json({ error: "Session not found" }, { status: 404 });
      }
      return json({ success: true });
    }

    return json({ error: "Either userId or sessionId is required" }, { status: 400 });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
