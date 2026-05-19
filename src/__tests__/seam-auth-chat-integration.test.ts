// Seam 1 — Auth Session ↔ Chat API
//
// The individual auth and conversation routes are exercised in isolation by
// auth-api.test.ts and the conversations handler tests, but no existing test
// proves the join: a cookie minted by POST /api/auth/login is accepted as
// valid authentication by POST /api/conversations. The session cookie format,
// JWT payload shape, and `locals.user` contract are load-bearing across those
// two modules — if any drifts, authenticated chat start silently breaks.
//
// This test exercises the full seam:
//   1. Seed a user with a real argon2id password hash.
//   2. Call the real `POST /api/auth/login` handler → receive the
//      `ezcorp_session` cookie it writes.
//   3. Replay what hooks.server.ts does on the next request: verify the JWT,
//      confirm the corresponding `sessions` row exists, populate locals.user
//      with the decoded payload.
//   4. Call the real `POST /api/conversations` handler with that locals.user
//      → assert 201 and that the conversation is persisted.
//
// A second case uses a tampered cookie to prove the seam is genuinely
// verifying the signature (regression guard against "we pass locals through
// without checking the cookie").

import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";

// ── Module-level mocks (must run BEFORE handler imports) ─────────────

mockDbConnection();
mockRealSettings();
mockServerAlias();

// The conversations handler imports `$lib/server/security/api-keys` which is
// not covered by mockServerAlias. Use the dual-specifier pattern and return
// a passthrough `requireScope` since cookie auth (no apiKeyScopes) is what
// the seam is testing.
const apiKeysMock = () => ({
  requireScope: () => null,
});
mock.module("$lib/server/security/api-keys", apiKeysMock);
mock.module("../../web/src/lib/server/security/api-keys", apiKeysMock);

// $types stubs (SvelteKit codegen artifacts).
mock.module("../../web/src/routes/api/auth/login/$types", () => ({}));
mock.module("../../web/src/routes/api/conversations/$types", () => ({}));

// ── Handler imports (AFTER mocks) ────────────────────────────────────

import { POST as loginPost } from "../../web/src/routes/api/auth/login/+server";
import { POST as conversationsPost } from "../../web/src/routes/api/conversations/+server";
import { hashPassword } from "../auth/password";
import { verifyJWT, getJwtSecret, _resetSecretCache } from "../auth/jwt";
import { hashToken, getSessionByTokenHash } from "../db/queries/sessions";
import { createProject } from "../db/queries/projects";
import { getConversation } from "../db/queries/conversations";
import { users, sessions, auditLog, settings, conversations, projects } from "../db/schema";

// ── Setup ────────────────────────────────────────────────────────────

const TEST_EMAIL = "seam1@test.local";
const TEST_PASSWORD = "SeamPassword123";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  _resetSecretCache();
  const db = getTestDb();
  await db.delete(conversations);
  await db.delete(auditLog);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(projects);
  await db.delete(settings);

  const passwordHash = await hashPassword(TEST_PASSWORD);
  await db.insert(users).values({
    email: TEST_EMAIL,
    passwordHash,
    name: "Seam User",
    role: "member",
    status: "active",
  });
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Replay the relevant portion of hooks.server.ts for a given session cookie.
 * This is what the production request pipeline does on every request before
 * dispatching to a handler: verify the JWT, confirm a session row exists,
 * and populate locals.user. We do NOT use a hand-crafted payload here — the
 * point of the seam is that the cookie from login is acceptable AS-IS.
 */
async function buildLocalsFromCookie(cookie: string): Promise<App.Locals> {
  const secret = await getJwtSecret();
  const payload = await verifyJWT(cookie, secret);
  if (!payload) throw new Error("seam precondition: JWT failed to verify");

  const tokenHash = await hashToken(cookie);
  const session = await getSessionByTokenHash(tokenHash);
  if (!session) throw new Error("seam precondition: no session row for token");

  return {
    user: {
      id: payload.id,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    },
  } as App.Locals;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Seam: login cookie → /api/conversations", () => {
  test("cookie minted by login authenticates a subsequent POST /api/conversations", async () => {
    // Step 1 — login
    const loginEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });

    const loginRes = await loginPost(loginEvent);
    expect(loginRes.status).toBe(200);

    const loginBody = await jsonFromResponse(loginRes);
    expect(loginBody.user.email).toBe(TEST_EMAIL);

    const sessionCookie = loginEvent.cookies.get("ezcorp_session");
    expect(sessionCookie).toBeTruthy();

    // Step 2 — replay hooks.server for the next request
    const locals = await buildLocalsFromCookie(sessionCookie as string);
    expect((locals as { user?: { email: string } }).user?.email).toBe(TEST_EMAIL);

    // Step 3 — create a project to hang the conversation off of
    const project = await createProject({ name: "Seam 1", path: "/tmp/seam-1" });

    // Step 4 — call the real conversations POST handler with the locals
    //          derived purely from the login cookie
    const convEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/conversations",
      body: { projectId: project.id, title: "Seam 1 chat" },
      cookies: { ezcorp_session: sessionCookie as string },
    });
    convEvent.locals = locals;

    const convRes = await conversationsPost(convEvent);
    expect(convRes.status).toBe(201);

    const convBody = await jsonFromResponse(convRes);
    expect(convBody.id).toBeDefined();
    expect(convBody.title).toBe("Seam 1 chat");
    expect(convBody.projectId).toBe(project.id);

    // Step 5 — persisted + tagged with the logged-in user
    const persisted = await getConversation(convBody.id);
    expect(persisted).toBeDefined();
    expect(persisted!.userId).toBe(loginBody.user.id);
  });

  test("tampered cookie does NOT produce valid locals (seam verifies signature)", async () => {
    // Mint a real cookie, tamper with the payload, confirm verifyJWT rejects.
    // This guards against a future refactor that accidentally skips signature
    // verification and trusts the caller-supplied payload.
    const loginEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    await loginPost(loginEvent);
    const realCookie = loginEvent.cookies.get("ezcorp_session") as string;

    const [h, p, s] = realCookie.split(".");
    const tamperedPayload = btoa(JSON.stringify({ ...JSON.parse(atob(p!)), role: "admin" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const tamperedCookie = `${h}.${tamperedPayload}.${s}`;

    const secret = await getJwtSecret();
    const verifiedTampered = await verifyJWT(tamperedCookie, secret);
    expect(verifiedTampered).toBeNull();
  });

  test("rejected login produces no cookie, so no locals can be built", async () => {
    const loginEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/login",
      body: { email: TEST_EMAIL, password: "wrong-password" },
    });

    const loginRes = await loginPost(loginEvent);
    expect(loginRes.status).toBe(401);

    const cookie = loginEvent.cookies.get("ezcorp_session");
    expect(cookie).toBeNull();

    // And the downstream handler would see locals.user === undefined and
    // requireAuth() would throw. We assert the behavior end-to-end:
    const project = await createProject({ name: "Seam 1 reject", path: "/tmp/seam-1r" });
    const convEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/conversations",
      body: { projectId: project.id },
    });

    let thrown: unknown = null;
    try {
      await conversationsPost(convEvent);
    } catch (e) {
      thrown = e;
    }
    // requireAuth throws a Response with status 401
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });
});
