import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { claimPasswordResetToken } from "$server/db/queries/password-resets";
import { getUserById, updateUserPassword } from "$server/db/queries/users";
import { hashPassword } from "$server/auth/password";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { consumeResetSchema } from "../schema";
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";
import { RateLimiter } from "$lib/server/security/rate-limiter";

// 10 / 15 min per IP. The 32-byte random token is already
// cryptographically infeasible to guess, but a per-IP limit caps the
// noise an attacker can generate in audit logs and against the DB.
export const __rateLimiter = new RateLimiter(10, 15 * 60_000);

export const POST: RequestHandler = async ({ request, params, getClientAddress }) => {
  try {
    let ip = "unknown";
    try { ip = getClientAddress(); } catch { /* proxy not configured */ }
    const rl = __rateLimiter.check(ip);
    if (!rl.allowed) {
      return errorJson(429, "Too many requests", { retryAfter: rl.retryAfter }, {
        "Retry-After": String(rl.retryAfter ?? 1),
      });
    }

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
