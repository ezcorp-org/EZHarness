import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";

export const GET: RequestHandler = async ({ locals }) => {
  try {
    const user = requireAuth(locals);
    return json({ user });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
