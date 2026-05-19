import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";

/**
 * No-op endpoint used by the client-side keepalive (`web/src/lib/auth-keepalive.ts`).
 *
 * The actual work is done by `hooks.server.ts`'s sliding-refresh path on the
 * way through — issuing this request from a visible tab on a 20-minute timer
 * lets the rotation happen during quiet moments instead of mid-flow, so a
 * user who keeps the app open never notices a refresh boundary.
 */
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ ok: false }, { status: 401 });
  }
  return json({ ok: true });
};
