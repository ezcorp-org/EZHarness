import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireAuth } from "$server/auth/middleware";
import {
  hashToken,
  listSessionsByUser,
  revokeSession,
} from "$server/db/queries/sessions";
import { validationError } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";

const deleteSchema = z.object({
  sessionId: z.string().min(1, "Session ID is required"),
});

export const GET: RequestHandler = async ({ cookies, locals }) => {
  try {
    const scopeErr = requireScope(locals, "read");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);
    const sessions = await listSessionsByUser(user.id);

    // Determine current session by hashing the cookie token
    const token = cookies.get("ezcorp_session");
    let currentTokenHash: string | null = null;
    if (token) {
      currentTokenHash = await hashToken(token);
    }

    const mapped = sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      lastActiveAt: s.lastActiveAt,
      createdAt: s.createdAt,
      isCurrent: s.tokenHash === currentTokenHash,
    }));

    return json({ sessions: mapped });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

export const DELETE: RequestHandler = async ({ request, cookies, locals }) => {
  try {
    const scopeErr = requireScope(locals, "admin");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);
    const result = deleteSchema.safeParse(await request.json());
    if (!result.success) return validationError(result.error);

    const { sessionId } = result.data;

    // Verify the session belongs to the current user
    const sessions = await listSessionsByUser(user.id);
    const target = sessions.find((s) => s.id === sessionId);
    if (!target) {
      return json({ error: "Session not found" }, { status: 404 });
    }

    // Prevent revoking the current session
    const token = cookies.get("ezcorp_session");
    if (token) {
      const currentHash = await hashToken(token);
      if (target.tokenHash === currentHash) {
        return json(
          { error: "Cannot revoke your current session. Use logout instead." },
          { status: 400 },
        );
      }
    }

    await revokeSession(sessionId);
    return json({ success: true });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
