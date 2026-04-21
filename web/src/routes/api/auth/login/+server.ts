import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { getUserByEmail } from "$server/db/queries/users";
import { verifyPassword } from "$server/auth/password";
import { signJWT, getJwtSecret } from "$server/auth/jwt";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { hashToken, createSession } from "$server/db/queries/sessions";
import { loginSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";

// sec-L1: constant-time login path. When the user lookup misses (or the
// account is inactive) we still invoke verifyPassword against a pre-computed
// dummy argon2id hash so the response timing matches the wrong-password
// branch for an existing account. Otherwise an attacker can enumerate valid
// emails by timing the ~100ms argon2id difference.
let dummyHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = Bun.password.hash(
      "dummy-password-for-constant-time-check",
      { algorithm: "argon2id" },
    );
  }
  return dummyHashPromise;
}

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  const result = loginSchema.safeParse(await request.json());
  if (!result.success) {
    return validationError(result.error);
  }
  const { email, password } = result.data;

  const user = await getUserByEmail(email);
  if (!user || user.status === "inactive") {
    // Equalize timing with the wrong-password branch: always run a
    // verifyPassword against a dummy hash before returning.
    const dummyHash = await getDummyPasswordHash();
    await verifyPassword(password, dummyHash).catch(() => false);
    await insertAuditEntry(null, "auth:failed_login", undefined, { email });
    return json({ error: "Invalid credentials" }, { status: 401 });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    await insertAuditEntry(null, "auth:failed_login", undefined, { email });
    return json({ error: "Invalid credentials" }, { status: 401 });
  }

  const secret = await getJwtSecret();
  const token = await signJWT(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    secret
  );

  // Create session record for revocation support
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const userAgent = request.headers.get("user-agent");
  let ipAddress: string | null = null;
  try { ipAddress = getClientAddress(); } catch { /* proxy not configured */ }
  await createSession({ userId: user.id, tokenHash, userAgent, ipAddress, expiresAt });

  const isSecure = process.env.FORCE_SECURE_COOKIES === "true" || request.url.startsWith("https");
  cookies.set("ezcorp_session", token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 3600,
    secure: isSecure,
  });

  await insertAuditEntry(user.id, "auth:login");

  return json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
};
