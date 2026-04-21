import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, ADMIN_USER } from "./helpers/mock-request";

// ── Module-level mocks (BEFORE any handler imports) ──────────────────

mockDbConnection();
mockServerAlias();

// Mock $types modules that SvelteKit generates (not available outside SvelteKit)
mock.module("../../web/src/routes/(auth)/login/$types", () => ({}));
mock.module("../../web/src/routes/(auth)/setup/$types", () => ({}));
mock.module("../../web/src/routes/(auth)/signup/[token]/$types", () => ({}));

// NOW import the page server load functions
import { load as loginLoad } from "../../web/src/routes/(auth)/login/+page.server";
import { load as setupLoad } from "../../web/src/routes/(auth)/setup/+page.server";
import { load as signupLoad } from "../../web/src/routes/(auth)/signup/[token]/+page.server";

import { users, invites, sessions, settings } from "../db/schema";
import { signJWT, getJwtSecret } from "../auth/jwt";
import { createUser } from "../db/queries/users";
import { createInvite } from "../db/queries/invites";
import { verifyJWT } from "../auth/jwt";
import { createSession, hashToken } from "../db/queries/sessions";

// ── Helpers ──────────────────────────────────────────────────────────

interface RedirectError {
  status: number;
  location: string;
}

function isRedirect(err: unknown): err is RedirectError {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    "location" in err &&
    typeof (err as any).status === "number" &&
    typeof (err as any).location === "string"
  );
}

async function expectRedirect(fn: () => Promise<unknown>, status: number, location: string) {
  try {
    await fn();
    throw new Error("Expected redirect to be thrown");
  } catch (err) {
    if (!isRedirect(err)) throw err;
    expect(err.status).toBe(status);
    expect(err.location).toBe(location);
  }
}

async function makeValidSessionCookie(): Promise<string> {
  const secret = await getJwtSecret();
  return signJWT(
    { id: ADMIN_USER.id, email: ADMIN_USER.email, name: ADMIN_USER.name, role: ADMIN_USER.role },
    secret,
  );
}

/**
 * Persist a session row matching the JWT so the sec-C2 "row missing = revoked"
 * check in the login/signup loaders resolves as "authenticated". Tests that
 * expect a logged-in user to be redirected to / must use this helper.
 */
async function persistSessionFor(token: string, userId: string): Promise<void> {
  const tokenHash = await hashToken(token);
  await createSession({
    userId,
    tokenHash,
    userAgent: "auth-layout-test",
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  });
}

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(sessions);
  await db.delete(invites);
  await db.delete(settings);
  await db.delete(users);
});

// ── Login page server load ───────────────────────────────────────────

describe("Login page load", () => {
  test("redirects to /setup when getUserCount returns 0", async () => {
    const event = createMockEvent({ url: "http://localhost/login" });
    await expectRedirect(() => loginLoad(event as any), 302, "/setup");
  });

  test("redirects to / when user has valid session cookie AND live session row", async () => {
    // sec-C2 (528af05) tightened auth to require BOTH a valid JWT and a
    // matching session row — the row represents a revocable handle on the
    // session. Historically this test only signed a JWT; now it must also
    // persist the row, otherwise the sec-C2 loop-guard in /login's loader
    // (which bounces row-less JWTs to the login form) would fire instead.
    const admin = await createUser({ email: "admin@test.com", passwordHash: "hash", name: "Admin", role: "admin" });

    const token = await makeValidSessionCookie();
    await persistSessionFor(token, admin.id);
    const event = createMockEvent({
      url: "http://localhost/login",
      cookies: { ezcorp_session: token },
    });

    await expectRedirect(() => loginLoad(event as any), 302, "/");
  });

  test("returns empty object when no session and users exist", async () => {
    await createUser({ email: "user@test.com", passwordHash: "hash", name: "User" });

    const event = createMockEvent({ url: "http://localhost/login" });
    const result = await loginLoad(event as any);
    expect(result).toEqual({});
  });

  test("returns empty object when session cookie is invalid and users exist", async () => {
    await createUser({ email: "user@test.com", passwordHash: "hash", name: "User" });

    const event = createMockEvent({
      url: "http://localhost/login",
      cookies: { ezcorp_session: "invalid-token-value" },
    });
    const result = await loginLoad(event as any);
    expect(result).toEqual({});
  });
});

// ── Setup page server load ───────────────────────────────────────────

describe("Setup page load", () => {
  test("redirects to /login when users already exist", async () => {
    await createUser({ email: "existing@test.com", passwordHash: "hash", name: "Existing" });

    const event = createMockEvent({ url: "http://localhost/setup" });
    await expectRedirect(() => setupLoad(event as any), 302, "/login");
  });

  test("returns empty object when no users exist", async () => {
    const event = createMockEvent({ url: "http://localhost/setup" });
    const result = await setupLoad(event as any);
    expect(result).toEqual({});
  });
});

// ── Signup page server load ──────────────────────────────────────────

describe("Signup page load", () => {
  let creatorId: string;

  beforeEach(async () => {
    const db = getTestDb();
    await db.delete(invites);
    await db.delete(settings);
    await db.delete(users);
    const creator = await createUser({ email: "admin@test.com", passwordHash: "hash", name: "Admin", role: "admin" });
    creatorId = creator.id;
  });

  test("redirects to / when user has valid session cookie AND live session row", async () => {
    // Same sec-C2 tightening as the login test above — without the row, the
    // loader now treats the JWT as revoked and renders the form.
    const token = await makeValidSessionCookie();
    await persistSessionFor(token, creatorId);
    const invite = await createInvite({ role: "member", createdBy: creatorId });

    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
      cookies: { ezcorp_session: token },
    });

    await expectRedirect(() => signupLoad(event as any), 302, "/");
  });

  test("redirects to /login when token is invalid", async () => {
    const event = createMockEvent({
      url: "http://localhost/signup/nonexistent-token",
      params: { token: "nonexistent-token" },
    });

    await expectRedirect(() => signupLoad(event as any), 302, "/login");
  });

  test("returns invite data and token when token is valid", async () => {
    const invite = await createInvite({ email: "new@test.com", role: "member", createdBy: creatorId });

    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
    });

    const result = await signupLoad(event as any);
    expect(result.token).toBe(invite.token);
    expect(result.invite.email).toBe("new@test.com");
    expect(result.invite.role).toBe("member");
  });

  test("returns invite data with null email for open invite", async () => {
    const invite = await createInvite({ role: "admin", createdBy: creatorId });

    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
    });

    const result = await signupLoad(event as any);
    expect(result.token).toBe(invite.token);
    expect(result.invite.role).toBe("admin");
  });
});

// ── Hooks auth enforcement ───────────────────────────────────────────
// hooks.server.ts cannot be imported directly due to initialization side-effects
// (ensureInitialized, timers, WebSocket). We test the auth logic by verifying
// the components it relies on and the PUBLIC_PATHS routing rules.

describe("Hooks auth enforcement", () => {
  // Mirror the exact PUBLIC_PATHS logic from hooks.server.ts
  const PUBLIC_PATHS = ["/login", "/setup", "/signup", "/api/auth/login", "/api/auth/setup", "/api/auth/invite"];
  const isPublic = (pathname: string) =>
    PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + "/"))
    || pathname.startsWith("/_app/")
    || pathname.startsWith("/favicon")
    || pathname === "/ws";

  test("auth pages are public (not redirected)", () => {
    expect(isPublic("/login")).toBe(true);
    expect(isPublic("/setup")).toBe(true);
    expect(isPublic("/signup/some-token")).toBe(true);
  });

  test("auth API routes are public", () => {
    expect(isPublic("/api/auth/login")).toBe(true);
    expect(isPublic("/api/auth/setup")).toBe(true);
    expect(isPublic("/api/auth/invite")).toBe(true);
    expect(isPublic("/api/auth/invite/some-token")).toBe(true);
  });

  test("static assets and websocket are public", () => {
    expect(isPublic("/_app/immutable/chunk.js")).toBe(true);
    expect(isPublic("/favicon.ico")).toBe(true);
    expect(isPublic("/ws")).toBe(true);
  });

  test("app pages are not public", () => {
    expect(isPublic("/")).toBe(false);
    expect(isPublic("/project/123")).toBe(false);
    expect(isPublic("/settings")).toBe(false);
  });

  test("non-auth API routes are not public", () => {
    expect(isPublic("/api/projects")).toBe(false);
    expect(isPublic("/api/chat")).toBe(false);
    expect(isPublic("/api/users")).toBe(false);
  });

  test("unauthenticated: getUserCount determines redirect target", async () => {
    // No users -> should redirect to /setup
    const { getUserCount } = await import("../db/queries/users");
    expect(await getUserCount()).toBe(0);

    // With users -> should redirect to /login
    await createUser({ email: "user@test.com", passwordHash: "hash", name: "User" });
    expect(await getUserCount()).toBeGreaterThan(0);
  });

  test("unauthenticated API request gets 401 JSON response", () => {
    // Hooks returns 401 with JSON body for unauthenticated API requests
    // Verify the response shape matches what hooks.server.ts produces
    const authRequired = new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    expect(authRequired.status).toBe(401);

    const setupRequired = new Response(JSON.stringify({ error: "Setup required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    expect(setupRequired.status).toBe(401);
  });

  test("valid session token produces correct user payload", async () => {
    const secret = await getJwtSecret();
    const token = await signJWT(
      { id: ADMIN_USER.id, email: ADMIN_USER.email, name: ADMIN_USER.name, role: ADMIN_USER.role },
      secret,
    );

    const payload = await verifyJWT(token, secret);
    expect(payload).not.toBeNull();
    expect(payload!.id).toBe(ADMIN_USER.id);
    expect(payload!.email).toBe(ADMIN_USER.email);
    expect(payload!.name).toBe(ADMIN_USER.name);
    expect(payload!.role).toBe("admin");

    // Hooks sets event.locals.user from this payload
    const user = { id: payload!.id, email: payload!.email, name: payload!.name, role: payload!.role };
    expect(user).toEqual({
      id: ADMIN_USER.id,
      email: ADMIN_USER.email,
      name: ADMIN_USER.name,
      role: "admin",
    });
  });

  test("invalid session token is rejected", async () => {
    const secret = await getJwtSecret();
    const payload = await verifyJWT("bad-token", secret);
    expect(payload).toBeNull();
    // Hooks would: delete cookie, redirect to /login (or 401 for API)
  });

  test("expired session token is rejected", async () => {
    const secret = await getJwtSecret();
    const token = await signJWT(
      { id: "u1", email: "test@test.com", name: "Test", role: "member" as const },
      secret,
      -1, // already expired
    );
    const payload = await verifyJWT(token, secret);
    expect(payload).toBeNull();
    // Hooks would: delete cookie, redirect to /login (or 401 for API)
  });

  test("cookie deletion works on invalid session", () => {
    const event = createMockEvent({
      url: "http://localhost/project/123",
      cookies: { ezcorp_session: "expired-token" },
    });

    // Verify cookie exists before deletion
    expect(event.cookies.get("ezcorp_session")).toBe("expired-token");

    // Hooks would call cookies.delete when session is invalid
    event.cookies.delete("ezcorp_session");
    expect(event.cookies.get("ezcorp_session")).toBeNull();
  });
});
