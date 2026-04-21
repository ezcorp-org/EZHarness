import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireAuth } from "$server/auth/middleware";
import { getUserById, updateUserPassword } from "$server/db/queries/users";
import { verifyPassword, hashPassword } from "$server/auth/password";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { validationError, passwordSchema as passwordFieldSchema } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: passwordFieldSchema,
});

export const PUT: RequestHandler = async ({ request, locals, cookies }) => {
  try {
    const scopeErr = requireScope(locals, "admin");
    if (scopeErr) return scopeErr;
    const authUser = requireAuth(locals);
    const result = passwordSchema.safeParse(await request.json());
    if (!result.success) return validationError(result.error);

    const { currentPassword, newPassword } = result.data;

    const user = await getUserById(authUser.id);
    if (!user) return json({ error: "User not found" }, { status: 404 });

    const valid = await verifyPassword(currentPassword, user.passwordHash);
    if (!valid) {
      return json({ error: "Current password is incorrect" }, { status: 400 });
    }

    const newHash = await hashPassword(newPassword);
    await updateUserPassword(authUser.id, newHash);
    await insertAuditEntry(authUser.id, "auth:password_changed");

    // Clear session to force re-login
    cookies.set("ezcorp_session", "", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
    });

    return json({ success: true, message: "Password changed. Please log in again." });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
