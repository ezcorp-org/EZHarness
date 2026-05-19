/**
 * Developer settings API -- publish token generation, check, and revocation.
 */

import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { getSetting, upsertSetting, deleteSetting } from "$server/db/queries/settings";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

/**
 * POST: Generate a new 64-char hex publish token for the authenticated user.
 */
export const POST: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

  await upsertSetting(`publish:token:${user.id}`, {
    token,
    createdAt: Date.now(),
  });

  return json({ token });
};

/**
 * GET: Check whether the authenticated user has a publish token (does not return the token).
 */
export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const value = await getSetting(`publish:token:${user.id}`);
  return json({ hasToken: !!value });
};

/**
 * DELETE: Revoke the authenticated user's publish token.
 */
export const DELETE: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  await deleteSetting(`publish:token:${user.id}`);
  return new Response(null, { status: 204 });
};
