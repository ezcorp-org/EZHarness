import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { getExtensionRunnerMode } from "$server/extensions/runner-mode";

export const GET: RequestHandler = async ({ locals }) => {
  try {
    const user = requireAuth(locals);
    // The app shell already fetches this on every load, and it is
    // authenticated — so it is where the "extensions are not sandboxed"
    // banner learns the mode without leaking it to anonymous callers the
    // way a field on the public /api/version would.
    return json({ user, extensionRunner: getExtensionRunnerMode() });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
