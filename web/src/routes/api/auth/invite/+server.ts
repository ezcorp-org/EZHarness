import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { createInvite, listInvites } from "$server/db/queries/invites";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { createInviteSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const user = requireRole(locals, "admin");

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
    requireRole(locals, "admin");
    const allInvites = await listInvites();
    return json({ invites: allInvites });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
