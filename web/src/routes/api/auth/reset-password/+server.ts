import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { getUserById } from "$server/db/queries/users";
import { createPasswordResetToken } from "$server/db/queries/password-resets";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { generateResetSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const admin = requireRole(locals, "admin");

    const result = generateResetSchema.safeParse(await request.json());
    if (!result.success) {
      return validationError(result.error);
    }

    const { userId } = result.data;

    const user = await getUserById(userId);
    if (!user) {
      return json({ error: "User not found" }, { status: 404 });
    }

    // Generate 32-byte random hex token
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await createPasswordResetToken({ userId, token, expiresAt });

    // SEC F-H4: do NOT return the raw token in the response body.
    // Surface the full reset URL through the audit log / admin notification path,
    // and return only a short masked preview so admins can confirm which token was issued.
    const resetUrl = `/reset-password/${token}`;
    await insertAuditEntry(admin.id, "auth:password_reset_generated", userId, { resetUrl });

    const masked = token.slice(0, 4) + "..." + token.slice(-4);
    return json({ ok: true, masked });
  } catch (e) {
    if (e instanceof Response) throw e;
    return json({ error: "Failed to generate reset token" }, { status: 500 });
  }
};
