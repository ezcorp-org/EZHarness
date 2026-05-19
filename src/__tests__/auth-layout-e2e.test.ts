import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";

// Must be at module level BEFORE handler imports
mockDbConnection();
mockServerAlias();

// NOW import handlers
import { POST as setupPost, __rateLimiter as setupLimiter } from "../../web/src/routes/api/auth/setup/+server";
import { POST as loginPost, __rateLimiter as loginLimiter } from "../../web/src/routes/api/auth/login/+server";
import { POST as logoutPost } from "../../web/src/routes/api/auth/logout/+server";
import { GET as meGet } from "../../web/src/routes/api/auth/me/+server";
import { POST as invitePost } from "../../web/src/routes/api/auth/invite/+server";
import { GET as inviteTokenGet, POST as inviteTokenPost, __rateLimiter as inviteTokenLimiter } from "../../web/src/routes/api/auth/invite/[token]/+server";

import { users, invites, settings, auditLog, sessions } from "../db/schema";
import { verifyJWT, getJwtSecret, _resetSecretCache } from "../auth/jwt";

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => { await closeTestDb(); });

// Reset module-scoped rate limiters before every test. createMockEvent
// always returns 127.0.0.1 as the client address, so setup (3/hour) and
// login (5/15min) caps would otherwise fire mid-suite as 429s.
beforeEach(() => {
  setupLimiter.reset();
  loginLimiter.reset();
  inviteTokenLimiter.reset();
});

async function cleanDb() {
  const db = getTestDb();
  await db.delete(auditLog);
  await db.delete(sessions);
  await db.delete(invites);
  await db.delete(settings);
  await db.delete(users);
  _resetSecretCache();
}

// ── Helper: extract AuthUser from session cookie ─────────────────────

async function userFromCookie(event: any) {
  const token = event.cookies.get("ezcorp_session");
  if (!token) return undefined;
  const secret = await getJwtSecret();
  const payload = await verifyJWT(token, secret);
  if (!payload) return undefined;
  return { id: payload.id, email: payload.email, name: payload.name, role: payload.role };
}

// ── 1. Setup -> Login -> Me chain ────────────────────────────────────

describe("setup -> login -> me chain", () => {
  beforeAll(async () => { await cleanDb(); });
  const ADMIN_EMAIL = "admin@e2e.com";
  const ADMIN_PASSWORD = "SecurePassword123";
  let adminId: string;

  test("setup creates admin and returns session cookie", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/setup",
      body: { name: "E2E Admin", email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    const res = await setupPost(event);
    expect(res.status).toBe(201);

    const data = await jsonFromResponse(res);
    expect(data.user.role).toBe("admin");
    expect(data.user.email).toBe(ADMIN_EMAIL);
    adminId = data.user.id;

    // Cookie was set
    const cookie = event.cookies.get("ezcorp_session");
    expect(cookie).toBeTruthy();
  });

  test("login with valid credentials returns 200 + cookie", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    const res = await loginPost(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.user.email).toBe(ADMIN_EMAIL);
    expect(data.user.id).toBe(adminId);

    const cookie = event.cookies.get("ezcorp_session");
    expect(cookie).toBeTruthy();
  });

  test("login with wrong password returns 401", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: ADMIN_EMAIL, password: "wrongpassword" },
    });

    const res = await loginPost(event);
    expect(res.status).toBe(401);

    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Invalid credentials");
  });

  test("GET /me with valid session returns user identity", async () => {
    // Clear sessions to avoid duplicate token_hash from same-second JWT
    await getTestDb().delete(sessions);

    // Login to get a session
    const loginEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    await loginPost(loginEvent);

    // Extract user from the cookie to populate locals
    const user = await userFromCookie(loginEvent);
    expect(user).toBeDefined();

    // Call /me with the authenticated user
    const meEvent = createMockEvent({
      method: "GET",
      url: "http://localhost/api/auth/me",
      user: user as any,
    });

    const res = await meGet(meEvent);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.user.email).toBe(ADMIN_EMAIL);
    expect(data.user.id).toBe(adminId);
    expect(data.user.role).toBe("admin");
  });

  test("GET /me without session returns 401", async () => {
    const event = createMockEvent({
      method: "GET",
      url: "http://localhost/api/auth/me",
    });

    const res = await meGet(event);
    expect(res.status).toBe(401);

    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Authentication required");
  });
});

// ── 2. Setup -> Invite -> Signup -> Login chain ──────────────────────

describe("setup -> invite -> signup -> login chain", () => {
  beforeAll(async () => { await cleanDb(); });
  const ADMIN_EMAIL = "admin@e2e-invite.com";
  const ADMIN_PASSWORD = "Adminpass123";
  const INVITE_EMAIL = "newuser@e2e-invite.com";
  const INVITE_PASSWORD = "Newuserpass123";
  let inviteToken: string;

  test("setup admin account", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/setup",
      body: { name: "Admin", email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    const res = await setupPost(event);
    expect(res.status).toBe(201);
  });

  test("admin creates invite for new user", async () => {
    // Login as admin to get user identity
    const loginEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    await loginPost(loginEvent);
    const adminUser = await userFromCookie(loginEvent);

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/invite",
      body: { email: INVITE_EMAIL, role: "member" },
      user: adminUser as any,
    });

    const res = await invitePost(event);
    expect(res.status).toBe(201);

    const data = await jsonFromResponse(res);
    expect(data.invite.email).toBe(INVITE_EMAIL);
    expect(data.invite.token).toBeDefined();
    inviteToken = data.invite.token;
  });

  test("GET invite token returns valid:true (no email/role disclosure)", async () => {
    const event = createMockEvent({
      method: "GET",
      url: `http://localhost/api/auth/invite/${inviteToken}`,
      params: { token: inviteToken },
    });

    const res = await inviteTokenGet(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.valid).toBe(true);
  });

  test("new user signs up with invite and gets session", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/invite/${inviteToken}`,
      params: { token: inviteToken },
      body: { name: "New User", email: INVITE_EMAIL, password: INVITE_PASSWORD },
    });

    const res = await inviteTokenPost(event);
    expect(res.status).toBe(201);

    const data = await jsonFromResponse(res);
    expect(data.user.email).toBe(INVITE_EMAIL);
    expect(data.user.name).toBe("New User");
    expect(data.user.role).toBe("member");

    const cookie = event.cookies.get("ezcorp_session");
    expect(cookie).toBeTruthy();
  });

  test("new user can login with their credentials", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: INVITE_EMAIL, password: INVITE_PASSWORD },
    });

    const res = await loginPost(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.user.email).toBe(INVITE_EMAIL);
    expect(data.user.role).toBe("member");
  });

  test("same invite token cannot be reused (returns 404)", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/invite/${inviteToken}`,
      params: { token: inviteToken },
      body: { name: "Another", email: "another@e2e.com", password: "Password123" },
    });

    const res = await inviteTokenPost(event);
    expect(res.status).toBe(404);
  });

  test("invite with wrong email returns 400", async () => {
    // Clear sessions to avoid duplicate token_hash from same-second JWT
    await getTestDb().delete(sessions);

    // Create a fresh invite for this sub-test
    const loginEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    await loginPost(loginEvent);
    const adminUser = await userFromCookie(loginEvent);

    const invEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/invite",
      body: { email: "locked@e2e.com", role: "member" },
      user: adminUser as any,
    });
    const invRes = await invitePost(invEvent);
    const invData = await jsonFromResponse(invRes);
    const freshToken = invData.invite.token;

    // Try to sign up with a different email
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/invite/${freshToken}`,
      params: { token: freshToken },
      body: { name: "Wrong", email: "wrong@e2e.com", password: "Password123" },
    });

    const res = await inviteTokenPost(event);
    expect(res.status).toBe(400);

    const data = await jsonFromResponse(res);
    expect(data.error).toContain("does not match");
  });
});

// ── 3. Login -> Logout -> Me fails chain ─────────────────────────────

describe("login -> logout -> me fails chain", () => {
  beforeAll(async () => { await cleanDb(); });
  const EMAIL = "session@e2e.com";
  const PASSWORD = "Sessionpass123";

  test("setup and login", async () => {
    const setupEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/setup",
      body: { name: "Session User", email: EMAIL, password: PASSWORD },
    });
    const setupRes = await setupPost(setupEvent);
    expect(setupRes.status).toBe(201);
  });

  test("logout clears session cookie", async () => {
    // Login first
    const loginEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: EMAIL, password: PASSWORD },
    });
    const loginRes = await loginPost(loginEvent);
    expect(loginRes.status).toBe(200);

    const cookieBefore = loginEvent.cookies.get("ezcorp_session");
    expect(cookieBefore).toBeTruthy();

    // Logout using the same cookie store
    const logoutEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/logout",
      cookies: { ezcorp_session: cookieBefore! },
    });

    const logoutRes = await logoutPost(logoutEvent);
    expect(logoutRes.status).toBe(200);

    const data = await jsonFromResponse(logoutRes);
    expect(data.success).toBe(true);

    // Cookie is cleared (set to empty)
    const cookieAfter = logoutEvent.cookies.get("ezcorp_session");
    expect(cookieAfter).toBe("");
  });

  test("GET /me after logout returns 401", async () => {
    // No user in locals simulates a cleared/invalid session
    const meEvent = createMockEvent({
      method: "GET",
      url: "http://localhost/api/auth/me",
    });

    const res = await meGet(meEvent);
    expect(res.status).toBe(401);

    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Authentication required");
  });
});

// ── 4. Duplicate setup blocked ───────────────────────────────────────

describe("duplicate setup blocked", () => {
  beforeAll(async () => { await cleanDb(); });
  test("first setup succeeds, second setup returns 403", async () => {
    const event1 = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/setup",
      body: { name: "First Admin", email: "first@e2e.com", password: "Password123" },
    });
    const res1 = await setupPost(event1);
    expect(res1.status).toBe(201);

    const data1 = await jsonFromResponse(res1);
    expect(data1.user.role).toBe("admin");

    // Second setup attempt
    const event2 = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/setup",
      body: { name: "Second Admin", email: "second@e2e.com", password: "Password123" },
    });
    const res2 = await setupPost(event2);
    expect(res2.status).toBe(403);

    const data2 = await jsonFromResponse(res2);
    expect(data2.error).toBe("Setup already completed");
  });
});

// ── 5. Public path enforcement ───────────────────────────────────────

describe("public path enforcement", () => {
  beforeAll(async () => { await cleanDb(); });
  test("auth endpoints work without session (public paths)", async () => {
    // Setup works without auth
    const setupEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/setup",
      body: { name: "Admin", email: "admin@public.com", password: "Password123" },
    });
    const setupRes = await setupPost(setupEvent);
    expect(setupRes.status).toBe(201);

    // Login works without auth
    const loginEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: "admin@public.com", password: "Password123" },
    });
    const loginRes = await loginPost(loginEvent);
    expect(loginRes.status).toBe(200);

    // Invite token GET works without auth (for signup page rendering)
    const tokenEvent = createMockEvent({
      method: "GET",
      url: "http://localhost/api/auth/invite/nonexistent-token",
      params: { token: "nonexistent-token" },
    });
    const tokenRes = await inviteTokenGet(tokenEvent);
    // Returns 404 (not 401) -- no auth required to check invite
    expect(tokenRes.status).toBe(404);
  });

  test("protected endpoint /me returns 401 without session", async () => {
    const event = createMockEvent({
      method: "GET",
      url: "http://localhost/api/auth/me",
    });

    const res = await meGet(event);
    expect(res.status).toBe(401);
  });

  test("admin-only endpoint /invite POST returns 401 without session", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/invite",
      body: { email: "someone@test.com", role: "member" },
    });

    const res = await invitePost(event);
    expect(res.status).toBe(401);
  });
});
