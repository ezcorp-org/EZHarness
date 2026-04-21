import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { getInviteByToken, markInviteUsed } from "$server/db/queries/invites";
import { createUser, getUserByEmail } from "$server/db/queries/users";
import { hashPassword } from "$server/auth/password";
import { signJWT, getJwtSecret } from "$server/auth/jwt";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { passwordSchema } from "$lib/server/security/validation";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const GET: RequestHandler = async ({ params }) => {
  const invite = await getInviteByToken(params.token);
  if (!invite) {
    return json({ error: "Invite not found or expired" }, { status: 404 });
  }

  // Only reveal that the token is valid; email/role are disclosed during POST (account creation)
  return json({ valid: true });
};

export const POST: RequestHandler = async ({ params, request, cookies }) => {
  const invite = await getInviteByToken(params.token);
  if (!invite) {
    return json({ error: "Invite not found or expired" }, { status: 404 });
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
    return json({ error: errors.join("; ") }, { status: 400 });
  }

  // If invite has a locked email, it must match
  if (invite.email && invite.email.toLowerCase() !== email!.toLowerCase()) {
    return json({ error: "Email does not match invite" }, { status: 400 });
  }

  // Check email not already taken
  const existing = await getUserByEmail(email!);
  if (existing) {
    return json({ error: "Email already registered" }, { status: 409 });
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
