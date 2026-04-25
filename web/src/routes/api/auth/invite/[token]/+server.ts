import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { getInviteByToken, markInviteUsed } from "$server/db/queries/invites";
import { createUser, getUserByEmail } from "$server/db/queries/users";
import { hashPassword } from "$server/auth/password";
import { signJWT, getJwtSecret } from "$server/auth/jwt";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { passwordSchema } from "$lib/server/security/validation";
import { RateLimiter } from "$lib/server/security/rate-limiter";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Pre-auth account-creation surface: 10 attempts / 15 min per IP caps
// brute-force guessing on invite tokens (random, but a noisy attacker
// still pollutes audit logs). Limiter check fires BEFORE body parse
// and BEFORE the DB lookup so a spraying attacker can't keep us busy.
export const __rateLimiter = new RateLimiter(10, 15 * 60_000);

export const GET: RequestHandler = async ({ params }) => {
  const invite = await getInviteByToken(params.token);
  if (!invite) {
    return errorJson(404, "Invite not found or expired");
  }

  // Only reveal that the token is valid; email/role are disclosed during POST (account creation)
  return json({ valid: true });
};

export const POST: RequestHandler = async ({ params, request, cookies, getClientAddress }) => {
  let ip = "unknown";
  try { ip = getClientAddress(); } catch { /* proxy not configured */ }
  const rl = __rateLimiter.check(ip);
  if (!rl.allowed) {
    return errorJson(429, "Too many requests", { retryAfter: rl.retryAfter }, {
      "Retry-After": String(rl.retryAfter ?? 1),
    });
  }

  const invite = await getInviteByToken(params.token);
  if (!invite) {
    return errorJson(404, "Invite not found or expired");
  }

  const body = await request.json();
  const { name, email, password } = body as { name?: string; email?: string; password?: string };

  // Validation
  const errors: string[] = [];
  if (!name || name.trim().length === 0) errors.push("Name is required");
  if (!email || !EMAIL_REGEX.test(email)) errors.push("Valid email is required");
  const pwResult = passwordSchema.safeParse(password);
  if (!pwResult.success) errors.push(pwResult.error.issues.map(i => i.message).join("; "));
  if (errors.length > 0) {
    return errorJson(400, errors.join("; "));
  }

  // If invite has a locked email, it must match
  if (invite.email && invite.email.toLowerCase() !== email!.toLowerCase()) {
    return errorJson(400, "Email does not match invite");
  }

  // Check email not already taken
  const existing = await getUserByEmail(email!);
  if (existing) {
    return errorJson(409, "Email already registered");
  }

  const passwordHash = await hashPassword(password!);
  const user = await createUser({
    email: email!.toLowerCase(),
    passwordHash,
    name: name!.trim(),
    role: invite.role,
  });

  await markInviteUsed(invite.id);
  await insertAuditEntry(user.id, "user:registered");

  const secret = await getJwtSecret();
  const token = await signJWT(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    secret
  );

  const isSecure = process.env.FORCE_SECURE_COOKIES === "true" || request.url.startsWith("https");
  cookies.set("ezcorp_session", token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 3600,
    secure: isSecure,
  });

  return json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  }, { status: 201 });
};
