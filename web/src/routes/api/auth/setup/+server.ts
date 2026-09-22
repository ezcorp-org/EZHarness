import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { getUserCount, createUser } from "$server/db/queries/users";
import { hashPassword } from "$server/auth/password";
import { signJWT, getJwtSecret } from "$server/auth/jwt";
import { upsertSetting } from "$server/db/queries/settings";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { hashToken, createSession } from "$server/db/queries/sessions";
import { setupSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";
import { RateLimiter } from "$lib/server/security/rate-limiter";
import { getSessionConfig, setSessionCookie } from "$lib/server/auth/session-cookie";
import { ensureBundledExtensions } from "$server/extensions/bundled";
import { getDb } from "$server/db/connection";
import { factoryBootstrapHost } from "$server/factory/provisioning/bootstrap";
import { verifyFactoryBootstrapInvitation } from "$server/factory/provisioning/invitation";

// First-boot bootstrap: 3 attempts / 1 hour per IP. Generous for a
// legitimate single-shot setup, tight enough to block brute-forcing
// the `users.length === 0` check on a freshly-deployed instance.
// Limiter fires BEFORE the user-count gate so a busy attacker can't
// keep us in DB-read loops. Exported for test reset.
export const __rateLimiter = new RateLimiter(3, 60 * 60_000);

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  let ip = "unknown";
  try { ip = getClientAddress(); } catch { /* proxy not configured */ }
  const rl = __rateLimiter.check(ip);
  if (!rl.allowed) {
    return errorJson(429, "Too many requests", { retryAfter: rl.retryAfter }, {
      "Retry-After": String(rl.retryAfter ?? 1),
    });
  }

  const count = await getUserCount();
  if (count > 0) {
    return errorJson(403, "Setup already completed");
  }

  const result = setupSchema.safeParse(await request.json());
  if (!result.success) {
    return validationError(result.error);
  }
  const { name, email, password } = result.data;

  // A provisioned installation creates its first administrator only for the
  // invited person holding the invitation token. Every refusal answers the
  // same 403, so the response does not say which part was wrong.
  let bootstrap: Awaited<ReturnType<typeof factoryBootstrapHost>>;
  try {
    bootstrap = await factoryBootstrapHost(process.env, getDb());
    if (bootstrap) verifyFactoryBootstrapInvitation(bootstrap.invitation, { token: result.data.invitationToken, email }, Date.now());
  } catch {
    return errorJson(403, "A valid first-administrator invitation is required");
  }

  const passwordHash = await hashPassword(password);
  const user = await createUser({
    email: email.toLowerCase(),
    passwordHash,
    name: name.trim(),
    role: "admin",
  });

  const cfg = getSessionConfig();
  const secret = await getJwtSecret();
  const token = await signJWT(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    secret,
    cfg.lifetimeSeconds,
  );

  await upsertSetting("instance:initialized", true);
  await insertAuditEntry(user.id, "user:registered");
  // Identity only: consent is the administrator's separate, explicit act.
  if (bootstrap) await bootstrap.bootstrap.recordRedeemed(bootstrap.invitation, user.id);

  // Mirror the login handler: create a session row so hooks.server.ts's
  // sec-C2 revocation check (missing row = revoked) accepts the cookie on
  // the very next navigation. Without this, /setup hands out a JWT, the
  // browser stores it, and the post-setup GET / immediately bounces the
  // brand-new admin to /login because no session row matches the token.
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + cfg.lifetimeSeconds * 1000);
  const userAgent = request.headers.get("user-agent");
  let ipAddress: string | null = null;
  try { ipAddress = getClientAddress(); } catch { /* proxy not configured */ }
  await createSession({ userId: user.id, tokenHash, userAgent, ipAddress, expiresAt });

  // Boot starts before any initial administrator exists, so its normal bundled
  // source staging has no eligible owner and deliberately does nothing. Retry
  // the same reviewed staging path after the first admin is durable. It creates
  // queued releases only; review and activation remain explicit human actions.
  await ensureBundledExtensions().catch((error) => {
    console.error("Bundled source staging unavailable after initial admin setup; it will retry on next boot", { error: String(error) });
  });

  setSessionCookie(cookies, token);

  return json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  }, { status: 201 });
};
