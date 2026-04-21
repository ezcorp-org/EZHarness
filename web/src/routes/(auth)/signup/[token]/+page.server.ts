import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getInviteByToken } from "$server/db/queries/invites";
import { verifyJWT, getJwtSecret } from "$server/auth/jwt";
import { hashToken, getSessionByTokenHash } from "$server/db/queries/sessions";

export const load: PageServerLoad = async ({ params, cookies }) => {
  // If already logged in, redirect to home. Same sec-C2 rule as /login: a
  // valid JWT without a matching session row is revoked, not authenticated.
  // See the note in (auth)/login/+page.server.ts for the loop this prevents.
  const session = cookies.get("ezcorp_session");
  if (session) {
    const secret = await getJwtSecret();
    const payload = await verifyJWT(session, secret);
    if (payload) {
      let sessionRowExists = false;
      try {
        const tokenHash = await hashToken(session);
        sessionRowExists = (await getSessionByTokenHash(tokenHash)) !== null;
      } catch {
        sessionRowExists = true; // DB unavailable — JWT-only fallback
      }
      if (sessionRowExists) {
        throw redirect(302, "/");
      }
      cookies.delete("ezcorp_session", { path: "/" });
    }
  }

  const invite = await getInviteByToken(params.token);
  if (!invite) {
    throw redirect(302, "/login");
  }

  return {
    invite: { email: invite.email, role: invite.role },
    token: params.token,
  };
};
