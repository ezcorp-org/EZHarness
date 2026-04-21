import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getUserCount } from "$server/db/queries/users";
import { verifyJWT, getJwtSecret } from "$server/auth/jwt";
import { hashToken, getSessionByTokenHash } from "$server/db/queries/sessions";

export const load: PageServerLoad = async ({ cookies }) => {
  const count = await getUserCount();
  if (count === 0) {
    throw redirect(302, "/setup");
  }

  // If already logged in, redirect to home. "Logged in" requires BOTH a valid
  // JWT *and* a matching session row — sec-C2 treats a missing row as revoked,
  // and hooks.server.ts will bounce any authenticated page back to /login.
  // Without the row check here, a stale JWT whose session was revoked would
  // ping-pong between / (clears cookie, redirects to /login) and /login
  // (sees the JWT, redirects to /) if the browser — for any reason, e.g. an
  // attribute mismatch on the deletion Set-Cookie — fails to honor the
  // cookie deletion. Anchoring both checks on the same source of truth
  // breaks the loop unconditionally.
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
        // DB unavailable — fall back to JWT-only auth, matching the
        // hooks.server.ts dbAvailable fallback.
        sessionRowExists = true;
      }
      if (sessionRowExists) {
        throw redirect(302, "/");
      }
      // Stale JWT + missing row: clear the cookie here so the next
      // navigation starts clean regardless of what the original
      // deletion Set-Cookie from hooks.server.ts looked like.
      cookies.delete("ezcorp_session", { path: "/" });
    }
  }

  return {};
};
