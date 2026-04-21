import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { getUserCount, createUser } from "$server/db/queries/users";
import { hashPassword } from "$server/auth/password";
import { signJWT, getJwtSecret } from "$server/auth/jwt";
import { upsertSetting } from "$server/db/queries/settings";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { setupSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";

export const POST: RequestHandler = async ({ request, cookies }) => {
  const count = await getUserCount();
  if (count > 0) {
    return json({ error: "Setup already completed" }, { status: 403 });
  }

  const result = setupSchema.safeParse(await request.json());
  if (!result.success) {
    return validationError(result.error);
  }
  const { name, email, password } = result.data;

  const passwordHash = await hashPassword(password);
  const user = await createUser({
    email: email.toLowerCase(),
    passwordHash,
    name: name.trim(),
    role: "admin",
  });

  const secret = await getJwtSecret();
  const token = await signJWT(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    secret
  );

  await upsertSetting("instance:initialized", true);
  await insertAuditEntry(user.id, "user:registered");

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
