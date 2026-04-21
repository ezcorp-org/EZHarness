import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireAuth } from "$server/auth/middleware";
import { getUserById, updateUserName, updateUserEmail } from "$server/db/queries/users";
import { verifyPassword } from "$server/auth/password";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { validationError } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";

const updateSchema = z.object({
  name: z.string().min(1, "Name cannot be empty").optional(),
  email: z.string().email("Invalid email address").optional(),
  currentPassword: z.string().optional(),
});

export const GET: RequestHandler = async ({ locals }) => {
  try {
    const scopeErr = requireScope(locals, "read");
    if (scopeErr) return scopeErr;
    const authUser = requireAuth(locals);
    const user = await getUserById(authUser.id);
    if (!user) {
      return json({ error: "User not found" }, { status: 404 });
    }
    return json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  try {
    const scopeErr = requireScope(locals, "admin");
    if (scopeErr) return scopeErr;
    const authUser = requireAuth(locals);
    const result = updateSchema.safeParse(await request.json());
    if (!result.success) return validationError(result.error);

    const { name, email, currentPassword } = result.data;

    if (!name && !email) {
      return json({ error: "Nothing to update" }, { status: 400 });
    }

    // Email change requires current password verification
    if (email) {
      if (!currentPassword) {
        return json({ error: "Current password is required to change email" }, { status: 400 });
      }
      const user = await getUserById(authUser.id);
      if (!user) return json({ error: "User not found" }, { status: 404 });

      const valid = await verifyPassword(currentPassword, user.passwordHash);
      if (!valid) {
        return json({ error: "Current password is incorrect" }, { status: 400 });
      }

      await updateUserEmail(authUser.id, email);
      await insertAuditEntry(authUser.id, "auth:email_changed", undefined, {
        oldEmail: user.email,
        newEmail: email,
      });
    }

    if (name) {
      await updateUserName(authUser.id, name);
      await insertAuditEntry(authUser.id, "auth:name_changed");
    }

    const updated = await getUserById(authUser.id);
    return json({
      id: updated!.id,
      email: updated!.email,
      name: updated!.name,
      role: updated!.role,
      createdAt: updated!.createdAt,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
