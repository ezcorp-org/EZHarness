import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { checkRole } from "$server/auth/middleware";
import { createInvite, listInvites, deleteInvite } from "$server/db/queries/invites";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { createInviteSchema, deleteInviteSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";

/**
 * F6 — both authorization axes on the invite surface.
 *
 * Until F5 moved `/api/auth/invite` out of the hooks PUBLIC_PATHS allowlist
 * (only the `/:token` sub-path is genuinely anonymous) these handlers were
 * unreachable: `locals.user` was never populated on a public path, so the role
 * gate denied everyone. Now that they ARE reachable, role alone is not enough.
 * Minting an invite carries a `role` — an admin-role key minted `--scopes
 * read` could hand out an ADMIN invite, which is account creation with a
 * privilege grant attached, from a nominally read-only credential.
 *
 * `checkRole(locals, "admin")` is the single-call gate that enforces the role
 * AND (for key principals) the `admin` scope, and RETURNS its denial instead
 * of throwing — the same shape `/api/extensions/:id/activate`,
 * `/api/extensions/:id/permissions` and `/api/settings/:key` use. A cookie
 * session carries no `apiKeyScopes`, so browser admins are unaffected.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const user = checkRole(locals, "admin");
    if (user instanceof Response) return user;

    const result = createInviteSchema.safeParse(await request.json());
    if (!result.success) {
      return validationError(result.error);
    }
    const { email, role } = result.data;

    const invite = await createInvite({
      email,
      role,
      createdBy: user.id,
    });

    await insertAuditEntry(user.id, "user:invited", invite.id, { email, role });

    return json({
      invite: {
        id: invite.id,
        token: invite.token,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
      },
    }, { status: 201 });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

export const GET: RequestHandler = async ({ locals }) => {
  try {
    const admin = checkRole(locals, "admin");
    if (admin instanceof Response) return admin;
    const allInvites = await listInvites();
    return json({ invites: allInvites });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

/** Delete by private ID on the authenticated collection, not the public token route. */
export const DELETE: RequestHandler = async ({ request, locals, url }) => {
  const admin = checkRole(locals, "admin");
  if (admin instanceof Response) return admin;
  const origin = request.headers.get("origin");
  if (origin !== url.origin && !(origin === null && locals.apiKeyScopes)) {
    return json({ error: "Same-origin request required" }, { status: 403 });
  }
  const parsed = deleteInviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationError(parsed.error);
  if (!await deleteInvite(parsed.data.id)) return json({ error: "Invite not found" }, { status: 404 });
  await insertAuditEntry(admin.id, "invite:deleted", parsed.data.id);
  return json({ ok: true });
};
