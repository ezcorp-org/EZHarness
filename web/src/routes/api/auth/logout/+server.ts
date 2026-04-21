import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { hashToken, getSessionByTokenHash, revokeSession } from "$server/db/queries/sessions";

export const POST: RequestHandler = async ({ cookies }) => {
  const token = cookies.get("ezcorp_session");

  if (token) {
    // Revoke the session record so the token can't be reused
    try {
      const tokenHash = await hashToken(token);
      const session = await getSessionByTokenHash(tokenHash);
      if (session) {
        await revokeSession(session.id);
      }
    } catch {
      // Best-effort revocation; cookie deletion below ensures logout
    }
  }

  cookies.set("ezcorp_session", "", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
  });

  return json({ success: true });
};
