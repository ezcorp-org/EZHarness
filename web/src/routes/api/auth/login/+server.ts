import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { getUserByEmail } from "$server/db/queries/users";
import { verifyPassword } from "$server/auth/password";
import { signJWT, getJwtSecret } from "$server/auth/jwt";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { hashToken, createSession } from "$server/db/queries/sessions";
import { loginSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";
import { RateLimiter } from "$lib/server/security/rate-limiter";

// sec-L1: per-IP brute-force throttle. 5 attempts / 15 min hits before
// any body parse so an attacker spraying credentials can't even keep
// us busy validating shape. Exported for test isolation only — see
// reset() in beforeEach hooks.
export const __rateLimiter = new RateLimiter(5, 15 * 60_000);

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
  // Rate-limit BEFORE body parse so we don't burn cycles on attackers
  // we're already throttling.
  let ip = "unknown";
  try { ip = getClientAddress(); } catch { /* proxy not configured */ }
  const rl = __rateLimiter.check(ip);
  if (!rl.allowed) {
    // sec-L1 (Option C): emit a single `auth:rate_limited` audit row
    // per (IP, window) when the limiter first fires. Subsequent blocked
    // attempts in the same window do NOT re-audit — the limiter's
    // `firstBlock` signal self-throttles to one row per window so an
    // attacker cannot flood audit_log via repeated 429s. We still write
    // BEFORE returning 429 so the response shape is unchanged.
    if (rl.firstBlock) {
      await insertAuditEntry(null, "auth:rate_limited", undefined, { ip });
    }
    return errorJson(429, "Too many requests", { retryAfter: rl.retryAfter }, {
      "Retry-After": String(rl.retryAfter ?? 1),
    });
  }

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
    return errorJson(401, "Invalid credentials");
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    await insertAuditEntry(null, "auth:failed_login", undefined, { email });
    return errorJson(401, "Invalid credentials");
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

  // Only opt-in via FORCE_SECURE_COOKIES. We can't trust request.url to
  // detect HTTPS reliably — svelte-adapter-bun's get_origin() defaults the
  // protocol to "https" when ORIGIN env is unset, which would mark the
  // cookie Secure on a plain-HTTP deployment. Browsers then refuse to
  // store it, producing an infinite login loop with no audit-log signal.
  const isSecure = process.env.FORCE_SECURE_COOKIES === "true";
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
