import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { claimPasswordResetToken } from "$server/db/queries/password-resets";
import { getUserById, updateUserPassword } from "$server/db/queries/users";
import { hashPassword } from "$server/auth/password";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { consumeResetSchema } from "../schema";
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const result = consumeResetSchema.safeParse(await request.json());
    if (!result.success) {
      return validationError(result.error);
    }

    const { password } = result.data;

    // SEC F-H4: trust the single-use token's own user binding.
    // `claimPasswordResetToken` atomically marks the token used and returns the
    // userId it was issued for, so requiring the caller to re-assert the email
    // adds no security value and leaks which address owns the token.
    const resetToken = await claimPasswordResetToken(params.token);
    if (!resetToken) {
      return errorJson(400, "Invalid or expired reset link");
    }

    const user = await getUserById(resetToken.userId);
    if (!user) {
      return errorJson(400, "Invalid or expired reset link");
    }

    const passwordHash = await hashPassword(password);
    await updateUserPassword(user.id, passwordHash);
    await insertAuditEntry(user.id, "auth:password_reset");

    return json({ success: true });
  } catch (e) {
    if (e instanceof Response) throw e;
    return errorJson(500, "Failed to reset password");
  }
};
