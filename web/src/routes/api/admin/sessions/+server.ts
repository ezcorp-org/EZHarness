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

// Row shape mirrors the `select({...})` projection in
// `src/db/queries/sessions.ts#listAllSessions`. Declared here so web's tsc
// can type the `.filter`/`.map` callbacks — Drizzle's inferred result type
// doesn't flow through cleanly across the backend/web project boundary.
type SessionRow = {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  ipAddress: string | null;
  expiresAt: Date;
  lastActiveAt: Date;
  createdAt: Date;
  userName: string | null;
  userEmail: string | null;
};
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";

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
      sessions = sessions.filter((s: SessionRow) => s.userId === filterUserId);
    }

    const mapped = sessions.map((s: SessionRow) => ({
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
        return errorJson(404, "Session not found");
      }
      return json({ success: true });
    }

    return errorJson(400, "Either userId or sessionId is required");
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
