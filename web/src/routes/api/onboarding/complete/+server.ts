import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { markUserOnboarded } from "$server/db/queries/users";

export const POST: RequestHandler = async ({ locals }) => {
  try {
    const user = requireAuth(locals);
    await markUserOnboarded(user.id);
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
