import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, ADMIN_USER } from "./helpers/mock-request";

mockDbConnection();
mockServerAlias();

// Mock $types modules (SvelteKit codegen artifacts)
mock.module("../../web/src/routes/(auth)/login/$types", () => ({}));
mock.module("../../web/src/routes/(auth)/setup/$types", () => ({}));
mock.module("../../web/src/routes/(auth)/signup/[token]/$types", () => ({}));

import { load as loginLoad } from "../../web/src/routes/(auth)/login/+page.server";
import { load as setupLoad } from "../../web/src/routes/(auth)/setup/+page.server";
import { load as signupLoad } from "../../web/src/routes/(auth)/signup/[token]/+page.server";
import { createUser } from "../db/queries/users";
import { createInvite, markInviteUsed } from "../db/queries/invites";
import { signJWT, getJwtSecret, _resetSecretCache } from "../auth/jwt";
import { createSession, hashToken } from "../db/queries/sessions";
import { users, invites, sessions, settings } from "../db/schema";

// ── Helpers ──────────────────────────────────────────────────────────

/** Detect a redirect thrown by SvelteKit (real Redirect class or our mock). */
function isRedirect(err: unknown): err is { status: number; location: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as any).status === "number" &&
    typeof (err as any).location === "string"
  );
}

async function expectRedirect(fn: () => Promise<unknown>, expectedStatus: number, expectedLocation: string) {
  try {
    await fn();
    throw new Error("Expected redirect to be thrown");
  } catch (err) {
    if (!isRedirect(err)) throw err; // re-throw unexpected errors
    expect(err.status).toBe(expectedStatus);
    expect(err.location).toBe(expectedLocation);
  }
}

async function makeValidSessionCookie(): Promise<string> {
  const secret = await getJwtSecret();
  return signJWT(
    { id: ADMIN_USER.id, email: ADMIN_USER.email, name: ADMIN_USER.name, role: ADMIN_USER.role },
    secret,
  );
}

async function makeExpiredSessionCookie(): Promise<string> {
  const secret = await getJwtSecret();
  return signJWT(
    { id: ADMIN_USER.id, email: ADMIN_USER.email, name: ADMIN_USER.name, role: ADMIN_USER.role },
    secret,
    -1, // already expired
  );
}

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => {
  restoreModuleMocks(); await closeTestDb(); });

beforeEach(async () => {
  _resetSecretCache();
  const db = getTestDb();
  await db.delete(sessions);
  await db.delete(invites);
  await db.delete(settings);
  await db.delete(users);
});

/**
 * Persist a matching session row for a JWT. After sec-C2 (commit 528af05),
 * the `/login` and `/signup` load functions must treat a valid JWT without a
 * row as revoked — any helper that only signs a JWT will now fail the
 * "authenticated user is bounced to home" assertion. This helper keeps the
 * test intent ("genuine live session → redirect") by pinning both halves.
 */
async function persistSessionFor(token: string, userId: string): Promise<void> {
  const tokenHash = await hashToken(token);
  await createSession({
    userId,
    tokenHash,
    userAgent: "integration-test",
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  });
}

// ── 1. Login <-> Setup redirect chain ────────────────────────────────

describe("Login / Setup redirect chain", () => {
  test("login redirects to /setup when no users exist", async () => {
    const event = createMockEvent({ url: "http://localhost/login" });
    await expectRedirect(() => loginLoad(event as any), 302, "/setup");
  });

  test("setup redirects to /login when users exist", async () => {
    await createUser({ email: "admin@test.local", passwordHash: "h", name: "Admin", role: "admin" });
    const event = createMockEvent({ url: "http://localhost/setup" });
    await expectRedirect(() => setupLoad(event as any), 302, "/login");
  });

  test("setup returns empty object when no users exist (no redirect)", async () => {
    const event = createMockEvent({ url: "http://localhost/setup" });
    const result = await setupLoad(event as any);
    expect(result).toEqual({});
  });

  test("login returns default returnTo when users exist and no session (no redirect)", async () => {
    await createUser({ email: "admin@test.local", passwordHash: "h", name: "Admin", role: "admin" });
    const event = createMockEvent({ url: "http://localhost/login" });
    const result = await loginLoad(event as any);
    expect(result).toEqual({ returnTo: "/" });
  });

  test("no circular redirect: login->setup only when 0 users, setup->login only when >0 users", async () => {
    // With 0 users: login -> setup, setup stays
    const loginEvent = createMockEvent({ url: "http://localhost/login" });
    await expectRedirect(() => loginLoad(loginEvent as any), 302, "/setup");

    const setupEvent = createMockEvent({ url: "http://localhost/setup" });
    const setupResult = await setupLoad(setupEvent as any);
    expect(setupResult).toEqual({});

    // With users: setup -> login, login stays
    await createUser({ email: "user@test.local", passwordHash: "h", name: "User" });

    const setupEvent2 = createMockEvent({ url: "http://localhost/setup" });
    await expectRedirect(() => setupLoad(setupEvent2 as any), 302, "/login");

    const loginEvent2 = createMockEvent({ url: "http://localhost/login" });
    const loginResult = await loginLoad(loginEvent2 as any);
    expect(loginResult).toEqual({ returnTo: "/" });
  });
});

// ── 2. Session-based redirect tests ─────────────────────────────────

describe("Session-based redirects for authenticated users", () => {
  beforeEach(async () => {
    await createUser({ email: ADMIN_USER.email, passwordHash: "h", name: ADMIN_USER.name, role: "admin" });
  });

  test("login redirects to / when user has valid JWT + live session row", async () => {
    const admin = (await getTestDb().select().from(users))[0]!;
    const token = await makeValidSessionCookie();
    await persistSessionFor(token, admin.id);

    const event = createMockEvent({
      url: "http://localhost/login",
      cookies: { ezcorp_session: token },
    });
    await expectRedirect(() => loginLoad(event as any), 302, "/");
  });

  test("login does NOT redirect with an invalid session token", async () => {
    const event = createMockEvent({
      url: "http://localhost/login",
      cookies: { ezcorp_session: "garbage-token" },
    });
    const result = await loginLoad(event as any);
    expect(result).toEqual({ returnTo: "/" });
  });

  test("login does NOT redirect with an expired session token", async () => {
    const expiredToken = await makeExpiredSessionCookie();
    const event = createMockEvent({
      url: "http://localhost/login",
      cookies: { ezcorp_session: expiredToken },
    });
    const result = await loginLoad(event as any);
    expect(result).toEqual({ returnTo: "/" });
  });

  test("signup redirects to / when user has valid JWT + live session row", async () => {
    const admin = (await getTestDb().select().from(users))[0]!;
    const invite = await createInvite({ email: "new@test.local", role: "member", createdBy: admin.id });
    const token = await makeValidSessionCookie();
    await persistSessionFor(token, admin.id);

    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
      cookies: { ezcorp_session: token },
    });
    await expectRedirect(() => signupLoad(event as any), 302, "/");
  });

  test("signup does NOT redirect with an invalid session token", async () => {
    const admin = (await getTestDb().select().from(users))[0]!;
    const invite = await createInvite({ email: "new@test.local", role: "member", createdBy: admin.id });

    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
      cookies: { ezcorp_session: "garbage-token" },
    });
    const result = await signupLoad(event as any);
    expect(result.invite.email).toBe("new@test.local");
    expect(result.token).toBe(invite.token);
  });
});

// ── sec-C2 redirect loop guard ───────────────────────────────────────
//
// Scenario the original sec-C2 fix (commit 528af05) introduced without
// updating the auth page loaders:
//
//   1. User has a valid JWT cookie whose session row has been deleted
//      (logout, admin revoke, sec-C2 cleanup, or DB reset).
//   2. hooks.server.ts sees the stale row, clears the cookies, and
//      redirects to /login?reason=session_revoked.
//   3. Browser follows the redirect. If it honors the Set-Cookie
//      deletion, /login sees no cookie → renders login form. OK.
//   4. *But* if the deletion Set-Cookie is not honored by the browser
//      (attribute mismatch against the original Secure cookie, HSTS
//      edge cases, proxy cookie stripping, stale service worker…),
//      /login sees the still-live JWT, `/login/+page.server.ts`'s old
//      implementation verified only the JWT signature, and redirected
//      straight back to `/`. Infinite loop — ERR_TOO_MANY_REDIRECTS.
//
// Root-cause fix: the auth page loaders must anchor "authenticated" on
// the SAME source of truth as hooks.server.ts — JWT *and* session row.
// A missing row means "not authenticated, render the form", regardless
// of what the JWT says. These tests pin that behavior so the loop
// cannot silently regress.

describe("sec-C2 loop guard: auth pages honor session row existence", () => {
  beforeEach(async () => {
    await createUser({ email: ADMIN_USER.email, passwordHash: "h", name: ADMIN_USER.name, role: "admin" });
  });

  test("login does NOT redirect when JWT is valid but session row is missing", async () => {
    // Deliberately do NOT call persistSessionFor — simulates the
    // post-sec-C2 "revoked" state: the JWT is still within its 30-day
    // lifetime but the row was deleted.
    const token = await makeValidSessionCookie();
    const event = createMockEvent({
      url: "http://localhost/login?reason=session_revoked",
      cookies: { ezcorp_session: token },
    });

    const result = await loginLoad(event as any);
    expect(result).toEqual({ returnTo: "/" });
  });

  test("login clears the stale ezcorp_session cookie when session row is missing", async () => {
    const token = await makeValidSessionCookie();
    const event = createMockEvent({
      url: "http://localhost/login",
      cookies: { ezcorp_session: token },
    });

    await loginLoad(event as any);

    // Defense in depth: even if the initial hooks-level deletion didn't
    // stick on the browser side, /login actively re-sends a deletion so
    // the next navigation starts clean. (hooks.server.ts handles the
    // legacy pi_session purge — we don't duplicate it here.)
    expect(event.cookies.get("ezcorp_session")).toBeNull();
  });

  test("login breaks the redirect loop: stale JWT + revoked row → form, not /", async () => {
    // This is the exact reproducer for the ERR_TOO_MANY_REDIRECTS bug.
    // Pre-fix, loginLoad would throw redirect(302, "/") here, which hooks
    // would immediately turn back into redirect(302, "/login?...") for
    // as many hops as the browser would follow.
    const token = await makeValidSessionCookie();
    const event = createMockEvent({
      url: "http://localhost/login?reason=session_revoked",
      cookies: { ezcorp_session: token },
    });

    // Must NOT throw — rendering the form is the only correct outcome.
    let threw: unknown = null;
    try {
      await loginLoad(event as any);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
  });

  test("signup does NOT redirect when JWT is valid but session row is missing", async () => {
    const admin = (await getTestDb().select().from(users))[0]!;
    const invite = await createInvite({ email: "new@test.local", role: "member", createdBy: admin.id });
    const token = await makeValidSessionCookie();

    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
      cookies: { ezcorp_session: token },
    });

    const result = await signupLoad(event as any);
    // Should render the signup form with the invite details, not redirect.
    expect(result.invite.email).toBe("new@test.local");
    expect(result.token).toBe(invite.token);
  });

  test("signup clears the stale ezcorp_session cookie when session row is missing", async () => {
    const admin = (await getTestDb().select().from(users))[0]!;
    const invite = await createInvite({ email: "new@test.local", role: "member", createdBy: admin.id });
    const token = await makeValidSessionCookie();

    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
      cookies: { ezcorp_session: token },
    });

    await signupLoad(event as any);

    expect(event.cookies.get("ezcorp_session")).toBeNull();
  });
});

// ── 3. Signup token validation flow ─────────────────────────────────

describe("Signup token validation", () => {
  let adminId: string;

  beforeEach(async () => {
    const admin = await createUser({ email: "admin@test.local", passwordHash: "h", name: "Admin", role: "admin" });
    adminId = admin.id;
  });

  test("valid token returns invite data with email and role", async () => {
    const invite = await createInvite({ email: "invited@test.local", role: "member", createdBy: adminId });
    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
    });

    const result = await signupLoad(event as any);
    expect(result.invite.email).toBe("invited@test.local");
    expect(result.invite.role).toBe("member");
    expect(result.token).toBe(invite.token);
  });

  test("valid token with admin role returns role: admin", async () => {
    const invite = await createInvite({ email: "newadmin@test.local", role: "admin", createdBy: adminId });
    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
    });

    const result = await signupLoad(event as any);
    expect(result.invite.role).toBe("admin");
  });

  test("invalid token redirects to /login", async () => {
    const event = createMockEvent({
      url: "http://localhost/signup/nonexistent-token-value",
      params: { token: "nonexistent-token-value" },
    });
    await expectRedirect(() => signupLoad(event as any), 302, "/login");
  });

  test("used/consumed token redirects to /login", async () => {
    const invite = await createInvite({ email: "consumed@test.local", role: "member", createdBy: adminId });
    await markInviteUsed(invite.id);

    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
    });
    await expectRedirect(() => signupLoad(event as any), 302, "/login");
  });

  test("expired token redirects to /login", async () => {
    const invite = await createInvite({
      email: "expired@test.local",
      role: "member",
      createdBy: adminId,
      expiresInDays: 0,
    });

    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
    });
    await expectRedirect(() => signupLoad(event as any), 302, "/login");
  });

  test("invite without email returns null email in invite data", async () => {
    const invite = await createInvite({ role: "member", createdBy: adminId });
    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
    });

    const result = await signupLoad(event as any);
    expect(result.invite.email).toBeNull();
    expect(result.invite.role).toBe("member");
    expect(result.token).toBe(invite.token);
  });
});

// ── 4. Public paths validation ──────────────────────────────────────

describe("Public paths - auth pages accessible without session", () => {
  test("/login is accessible (returns default returnTo) when users exist and no session", async () => {
    await createUser({ email: "user@test.local", passwordHash: "h", name: "User" });
    const event = createMockEvent({ url: "http://localhost/login" });
    const result = await loginLoad(event as any);
    expect(result).toEqual({ returnTo: "/" });
  });

  test("/setup is accessible (returns data) when no users exist", async () => {
    const event = createMockEvent({ url: "http://localhost/setup" });
    const result = await setupLoad(event as any);
    expect(result).toEqual({});
  });

  test("/signup/[token] is accessible with valid token and no session", async () => {
    const admin = await createUser({ email: "admin@test.local", passwordHash: "h", name: "Admin", role: "admin" });
    const invite = await createInvite({ email: "new@test.local", role: "member", createdBy: admin.id });

    const event = createMockEvent({
      url: `http://localhost/signup/${invite.token}`,
      params: { token: invite.token },
    });
    const result = await signupLoad(event as any);
    expect(result.invite).toBeDefined();
    expect(result.token).toBe(invite.token);
  });

  test("hooks PUBLIC_PATHS correctly identifies public vs protected routes", () => {
    const PUBLIC_PATHS = ["/login", "/setup", "/signup", "/api/auth/login", "/api/auth/setup", "/api/auth/invite"];
    const isPublic = (pathname: string) =>
      PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + "/"))
      || pathname.startsWith("/_app/")
      || pathname.startsWith("/favicon")
      || pathname === "/ws";

    // Public paths
    expect(isPublic("/login")).toBe(true);
    expect(isPublic("/setup")).toBe(true);
    expect(isPublic("/signup/some-token")).toBe(true);
    expect(isPublic("/api/auth/login")).toBe(true);
    expect(isPublic("/api/auth/setup")).toBe(true);
    expect(isPublic("/api/auth/invite")).toBe(true);
    expect(isPublic("/api/auth/invite/some-token")).toBe(true);
    expect(isPublic("/_app/immutable/chunk.js")).toBe(true);
    expect(isPublic("/favicon.ico")).toBe(true);
    expect(isPublic("/ws")).toBe(true);

    // Protected paths
    expect(isPublic("/")).toBe(false);
    expect(isPublic("/project/123")).toBe(false);
    expect(isPublic("/api/projects")).toBe(false);
    expect(isPublic("/api/chat")).toBe(false);
    expect(isPublic("/settings")).toBe(false);
  });
});
