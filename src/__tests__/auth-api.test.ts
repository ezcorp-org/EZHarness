import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER, MEMBER_USER } from "./helpers/mock-request";

// Must be at module level BEFORE handler imports
mockDbConnection();
mockServerAlias();

// NOW import handlers
import { POST as setupPost, __rateLimiter as setupLimiter } from "../../web/src/routes/api/auth/setup/+server";
import { POST as loginPost, __rateLimiter as loginLimiter } from "../../web/src/routes/api/auth/login/+server";
import { POST as logoutPost } from "../../web/src/routes/api/auth/logout/+server";
import { GET as meGet } from "../../web/src/routes/api/auth/me/+server";
import { POST as invitePost, GET as inviteListGet } from "../../web/src/routes/api/auth/invite/+server";
import { GET as inviteTokenGet, POST as inviteTokenPost, __rateLimiter as inviteTokenLimiter } from "../../web/src/routes/api/auth/invite/[token]/+server";

import { users, invites, settings, auditLog } from "../db/schema";
import { hashPassword } from "../auth/password";
import { createInvite } from "../db/queries/invites";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  // Reset module-scoped rate limiters so attempt counters don't leak
  // between tests sharing the default 127.0.0.1 client address.
  setupLimiter.reset();
  loginLimiter.reset();
  inviteTokenLimiter.reset();

  const db = getTestDb();
  await db.delete(auditLog);
  await db.delete(invites);
  await db.delete(settings);
  await db.delete(users);
});

// ── POST /auth/setup ────────────────────────────────────────────────

describe("POST /auth/setup", () => {
  test("creates admin user when no users exist", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/setup",
      body: { name: "Admin", email: "admin@test.com", password: "Password123" },
    });

    const res = await setupPost(event);
    expect(res.status).toBe(201);

    const data = await jsonFromResponse(res);
    expect(data.user.role).toBe("admin");
    expect(data.user.email).toBe("admin@test.com");
    expect(data.user.name).toBe("Admin");
    expect(data.user.id).toBeDefined();
  });

  test("returns 403 when users already exist", async () => {
    const db = getTestDb();
    await db.insert(users).values({
      email: "existing@test.com",
      passwordHash: "hashed",
      name: "Existing",
      role: "admin",
    });

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/setup",
      body: { name: "Admin2", email: "admin2@test.com", password: "Password123" },
    });

    const res = await setupPost(event);
    expect(res.status).toBe(403);

    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Setup already completed");
  });

  test("returns 400 for missing fields", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/setup",
      body: { name: "", email: "", password: "" },
    });

    const res = await setupPost(event);
    expect(res.status).toBe(400);

    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Validation failed");
    expect(data.fields.name).toBe("Name is required");
    expect(data.fields.email).toBe("Valid email is required");
    expect(data.fields.password).toBeDefined();
  });

  test("returns 400 for invalid email format", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/setup",
      body: { name: "Admin", email: "not-an-email", password: "Password123" },
    });

    const res = await setupPost(event);
    expect(res.status).toBe(400);

    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Validation failed");
    expect(data.fields.email).toBe("Valid email is required");
  });

  test("sets ezcorp_session cookie on success", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/setup",
      body: { name: "Admin", email: "admin@test.com", password: "Password123" },
    });

    await setupPost(event);
    const cookie = event.cookies.get("ezcorp_session");
    expect(cookie).toBeTruthy();
  });
});

// ── POST /auth/login ────────────────────────────────────────────────

describe("POST /auth/login", () => {
  const TEST_PASSWORD = "Password123";

  async function seedUser(overrides: Partial<{ email: string; status: string }> = {}) {
    const db = getTestDb();
    const hash = await hashPassword(TEST_PASSWORD);
    const rows = await db.insert(users).values({
      email: overrides.email ?? "user@test.com",
      passwordHash: hash,
      name: "Test User",
      role: "member",
      status: (overrides.status as any) ?? "active",
    }).returning();
    return rows[0]!;
  }

  test("returns 200 and user for valid credentials", async () => {
    await seedUser();

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: "user@test.com", password: TEST_PASSWORD },
    });

    const res = await loginPost(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.user.email).toBe("user@test.com");

    const cookie = event.cookies.get("ezcorp_session");
    expect(cookie).toBeTruthy();
  });

  test("returns 401 for unknown email", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: "nobody@test.com", password: "Password123" },
    });

    const res = await loginPost(event);
    expect(res.status).toBe(401);

    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Invalid credentials");
  });

  test("returns 401 for wrong password", async () => {
    await seedUser();

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: "user@test.com", password: "wrongpassword" },
    });

    const res = await loginPost(event);
    expect(res.status).toBe(401);

    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Invalid credentials");
  });

  test("returns 401 for inactive user", async () => {
    await seedUser({ status: "inactive" });

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: "user@test.com", password: TEST_PASSWORD },
    });

    const res = await loginPost(event);
    expect(res.status).toBe(401);

    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Invalid credentials");
  });

  test("returns 400 when email or password missing", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: "user@test.com" },
    });

    const res = await loginPost(event);
    expect(res.status).toBe(400);

    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Validation failed");
    expect(data.fields.password).toBeDefined();
  });
});

// ── POST /auth/logout ───────────────────────────────────────────────

describe("POST /auth/logout", () => {
  test("clears cookie and returns success", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/logout",
      cookies: { ezcorp_session: "some-token" },
    });

    const res = await logoutPost(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.success).toBe(true);

    // Cookie is set to empty (cleared via maxAge: 0 on the real response)
    const cookie = event.cookies.get("ezcorp_session");
    expect(cookie).toBe("");
  });
});

// ── GET /auth/me ────────────────────────────────────────────────────

describe("GET /auth/me", () => {
  test("returns user when authenticated", async () => {
    const event = createMockEvent({
      method: "GET",
      url: "http://localhost/api/auth/me",
      user: ADMIN_USER,
    });

    const res = await meGet(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.user.id).toBe(ADMIN_USER.id);
    expect(data.user.email).toBe(ADMIN_USER.email);
  });

  test("returns 401 when not authenticated", async () => {
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

// ── POST /auth/invite ───────────────────────────────────────────────

describe("POST /auth/invite", () => {
  async function seedAdminUser() {
    const db = getTestDb();
    const rows = await db.insert(users).values({
      id: ADMIN_USER.id,
      email: ADMIN_USER.email,
      passwordHash: "hashed",
      name: ADMIN_USER.name,
      role: "admin",
    }).returning();
    return rows[0]!;
  }

  test("admin creates invite successfully", async () => {
    await seedAdminUser();

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/invite",
      body: { email: "newuser@test.com", role: "member" },
      user: ADMIN_USER,
    });

    const res = await invitePost(event);
    expect(res.status).toBe(201);

    const data = await jsonFromResponse(res);
    expect(data.invite.email).toBe("newuser@test.com");
    expect(data.invite.role).toBe("member");
    expect(data.invite.token).toBeDefined();
  });

  test("member gets 403", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/invite",
      body: { email: "newuser@test.com", role: "member" },
      user: MEMBER_USER,
    });

    const res = await invitePost(event);
    expect(res.status).toBe(403);
  });
});

// ── GET /auth/invite ────────────────────────────────────────────────

describe("GET /auth/invite", () => {
  test("admin lists invites", async () => {
    const db = getTestDb();
    await db.insert(users).values({
      id: ADMIN_USER.id,
      email: ADMIN_USER.email,
      passwordHash: "hashed",
      name: ADMIN_USER.name,
      role: "admin",
    });

    // Create an invite via the query function
    await createInvite({ email: "invited@test.com", role: "member", createdBy: ADMIN_USER.id });

    const event = createMockEvent({
      method: "GET",
      url: "http://localhost/api/auth/invite",
      user: ADMIN_USER,
    });

    const res = await inviteListGet(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.invites).toBeArrayOfSize(1);
    expect(data.invites[0].email).toBe("invited@test.com");
  });

  test("member gets 403", async () => {
    const event = createMockEvent({
      method: "GET",
      url: "http://localhost/api/auth/invite",
      user: MEMBER_USER,
    });

    const res = await inviteListGet(event);
    expect(res.status).toBe(403);
  });
});

// ── GET /auth/invite/[token] ────────────────────────────────────────

describe("GET /auth/invite/[token]", () => {
  test("returns { valid: true } for valid token without revealing email/role", async () => {
    const db = getTestDb();
    await db.insert(users).values({
      id: ADMIN_USER.id,
      email: ADMIN_USER.email,
      passwordHash: "hashed",
      name: ADMIN_USER.name,
      role: "admin",
    });

    const invite = await createInvite({ email: "invited@test.com", role: "member", createdBy: ADMIN_USER.id });

    const event = createMockEvent({
      method: "GET",
      url: `http://localhost/api/auth/invite/${invite.token}`,
      params: { token: invite.token },
    });

    const res = await inviteTokenGet(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.valid).toBe(true);
    // Should NOT reveal email or role to prevent enumeration
    expect(data.invite).toBeUndefined();
    expect(data.email).toBeUndefined();
    expect(data.role).toBeUndefined();
  });

  test("returns 404 for invalid token", async () => {
    const event = createMockEvent({
      method: "GET",
      url: "http://localhost/api/auth/invite/nonexistent",
      params: { token: "nonexistent" },
    });

    const res = await inviteTokenGet(event);
    expect(res.status).toBe(404);

    const data = await jsonFromResponse(res);
    expect(data.error).toContain("not found");
  });
});

// ── POST /auth/invite/[token] ───────────────────────────────────────

describe("POST /auth/invite/[token]", () => {
  async function seedInvite(email?: string) {
    const db = getTestDb();
    await db.insert(users).values({
      id: ADMIN_USER.id,
      email: ADMIN_USER.email,
      passwordHash: "hashed",
      name: ADMIN_USER.name,
      role: "admin",
    });
    return createInvite({ email, role: "member", createdBy: ADMIN_USER.id });
  }

  test("registers user with valid invite", async () => {
    const invite = await seedInvite("new@test.com");

    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/invite/${invite.token}`,
      params: { token: invite.token },
      body: { name: "New User", email: "new@test.com", password: "Password123" },
    });

    const res = await inviteTokenPost(event);
    expect(res.status).toBe(201);

    const data = await jsonFromResponse(res);
    expect(data.user.email).toBe("new@test.com");
    expect(data.user.name).toBe("New User");
    expect(data.user.role).toBe("member");

    const cookie = event.cookies.get("ezcorp_session");
    expect(cookie).toBeTruthy();
  });

  test("returns 404 for invalid token", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/invite/badtoken",
      params: { token: "badtoken" },
      body: { name: "User", email: "u@test.com", password: "Password123" },
    });

    const res = await inviteTokenPost(event);
    expect(res.status).toBe(404);
  });

  test("returns 404 for already-used invite", async () => {
    const invite = await seedInvite("used@test.com");

    // Use the invite first
    const event1 = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/invite/${invite.token}`,
      params: { token: invite.token },
      body: { name: "First", email: "used@test.com", password: "Password123" },
    });
    const res1 = await inviteTokenPost(event1);
    expect(res1.status).toBe(201);

    // Try to use it again
    const event2 = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/invite/${invite.token}`,
      params: { token: invite.token },
      body: { name: "Second", email: "used@test.com", password: "Password123" },
    });
    const res2 = await inviteTokenPost(event2);
    expect(res2.status).toBe(404);
  });

  test("returns 400 when email does not match locked invite", async () => {
    const invite = await seedInvite("locked@test.com");

    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/invite/${invite.token}`,
      params: { token: invite.token },
      body: { name: "User", email: "different@test.com", password: "Password123" },
    });

    const res = await inviteTokenPost(event);
    expect(res.status).toBe(400);

    const data = await jsonFromResponse(res);
    expect(data.error).toContain("does not match");
  });
});
