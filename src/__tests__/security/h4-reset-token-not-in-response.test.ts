// Regression test for sec-H4: password reset tokens must NOT appear in the
// HTTP response body of POST /api/auth/reset-password, and the consumer
// endpoint POST /api/auth/reset-password/[token] must NOT require or rely on
// the client-supplied `email` field matching the token's owner.
//
// Exploit narrative (pre-fix):
//   1. The admin-only generator endpoint returned
//      `{ token, resetUrl: "/reset-password/<token>" }` in the JSON body.
//      Any caller with visibility into that response (admin UI logs, proxy
//      trace, browser devtools, hijacked admin session, screenshot, etc.)
//      recovered the raw single-use token and could claim the password
//      reset themselves, taking over the target user's account without
//      ever touching the victim's email.
//   2. The consumer endpoint additionally verified that the caller-supplied
//      `email` field equaled the reset-token's user's email. Since the
//      attacker controls the body they POST, they trivially supply the
//      correct email — the check adds no security beyond possession of
//      the token. It did, however, create the illusion of defence in
//      depth, masking the severity of (1).
//
// Fix (landed in the tree via 17bd34d, traced by sec-H4 commit 1c6b348):
//   - generator returns `{ ok: true, masked }` where masked is
//     `first4 + "..." + last4`. No `token`, no `resetUrl`.
//   - the full /reset-password/<token> URL is recorded via
//     insertAuditEntry metadata for out-of-band delivery.
//   - consumer no longer reads the `email` field. possession of the
//     single-use token — atomically bound to a user by
//     claimPasswordResetToken — is authoritative.
//
// Strategy: handler-level probe with in-memory mocks of the DB query
// modules and hashPassword. Drive the two handlers directly, then assert
// on the Response body and on calls captured from the mocks. No real DB.
// Follows the sec-C5 template (src/__tests__/security/c5-provider-keys-admin-gate.test.ts).

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  ADMIN_USER,
} from "../helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockServerAlias();

// SvelteKit generated $types stubs — not present at test time.
mock.module("../../../web/src/routes/api/auth/reset-password/$types", () => ({}));
mock.module("../../../web/src/routes/api/auth/reset-password/[token]/$types", () => ({}));

// ── In-memory stores for the mocked query modules ────────────────
interface StoredToken {
  userId: string;
  token: string;
  expiresAt: Date;
  used: boolean;
}
let tokens: StoredToken[];

const VICTIM = {
  id: "victim-user-001",
  email: "victim@test.local",
  name: "Victim User",
  role: "member" as const,
};

let passwordUpdates: Array<{ userId: string; hash: string }>;

const auditCalls: Array<{
  userId: string | null;
  action: string;
  target?: string;
  metadata?: unknown;
}> = [];

// ── Mock the query modules (dual-specifier: $server alias + relative) ──

const passwordResetsMock = () => ({
  createPasswordResetToken: async ({
    userId,
    token,
    expiresAt,
  }: {
    userId: string;
    token: string;
    expiresAt: Date;
  }) => {
    tokens.push({ userId, token, expiresAt, used: false });
    return { id: "tok-" + tokens.length, userId, token, expiresAt, usedAt: null };
  },
  claimPasswordResetToken: async (token: string) => {
    const row = tokens.find(
      (t) => t.token === token && !t.used && t.expiresAt.getTime() > Date.now(),
    );
    if (!row) return undefined;
    row.used = true;
    return { userId: row.userId, token: row.token, usedAt: new Date() };
  },
});
mock.module("$server/db/queries/password-resets", passwordResetsMock);
mock.module("../../db/queries/password-resets", passwordResetsMock);

const usersMock = () => ({
  getUserById: async (id: string) => {
    if (id === VICTIM.id) return { ...VICTIM, passwordHash: "old-hash" };
    return undefined;
  },
  updateUserPassword: async (userId: string, hash: string) => {
    passwordUpdates.push({ userId, hash });
  },
});
mock.module("$server/db/queries/users", usersMock);
mock.module("../../db/queries/users", usersMock);

const auditLogMock = () => ({
  insertAuditEntry: async (
    userId: string | null,
    action: string,
    target?: string,
    metadata?: unknown,
  ) => {
    auditCalls.push({ userId, action, target, metadata });
  },
});
mock.module("$server/db/queries/audit-log", auditLogMock);
mock.module("../../db/queries/audit-log", auditLogMock);

const passwordMock = () => ({
  hashPassword: async (pw: string) => `hashed:${pw}`,
  verifyPassword: async () => true,
});
mock.module("$server/auth/password", passwordMock);
mock.module("../../auth/password", passwordMock);

// ── Handler imports (AFTER mocks) ────────────────────────────────
import {
  POST as generatePost,
  __rateLimiter as generateLimiter,
} from "../../../web/src/routes/api/auth/reset-password/+server";
import {
  POST as consumePost,
  __rateLimiter as consumeLimiter,
} from "../../../web/src/routes/api/auth/reset-password/[token]/+server";

// SvelteKit handlers may throw a Response on auth failure; unwrap.
async function call(
  handler: (ev: any) => unknown,
  event: any,
): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  tokens = [];
  passwordUpdates = [];
  auditCalls.length = 0;
  // Generator is keyed by admin id and capped at 5/hour; consumer is
  // keyed by IP and capped at 10/15min. Without resetting, repeated
  // issueToken() calls across tests exhaust the admin's per-hour quota.
  generateLimiter.reset();
  consumeLimiter.reset();
});

// Issue a token via the generator, then fish the raw token out of the
// in-memory store (since the response deliberately hides it — the whole
// point of this fix).
async function issueToken(): Promise<{ res: Response; rawToken: string }> {
  const event = createMockEvent({
    method: "POST",
    url: "http://localhost/api/auth/reset-password",
    body: { userId: VICTIM.id },
    user: ADMIN_USER,
  });
  const res = await call(generatePost, event);
  expect(res.status).toBe(200);
  expect(tokens.length).toBeGreaterThan(0);
  return { res, rawToken: tokens[tokens.length - 1]!.token };
}

// ── Generator: response body must not leak the token ────────────

describe("sec-H4: POST /api/auth/reset-password response body", () => {
  test("200 with {ok:true, masked} — no `token` field", async () => {
    const { res, rawToken } = await issueToken();
    const body = await jsonFromResponse(res);

    // Positive shape.
    expect(body.ok).toBe(true);
    expect(typeof body.masked).toBe("string");

    // The critical H4 assertion: raw token is NOT in the response.
    expect(body.token).toBeUndefined();
    expect("token" in body).toBe(false);

    // Belt and braces: the masked preview must not be the full token,
    // and the full raw token must not appear anywhere in the serialized body.
    expect(body.masked).not.toBe(rawToken);
    expect(JSON.stringify(body)).not.toContain(rawToken);
  });

  test("no `resetUrl` field in the response (delivered out-of-band)", async () => {
    const { res, rawToken } = await issueToken();
    const body = await jsonFromResponse(res);

    expect(body.resetUrl).toBeUndefined();
    expect("resetUrl" in body).toBe(false);

    // The /reset-password/<token> URL must not appear in the body either,
    // even if someone reintroduces it under a different key name.
    expect(JSON.stringify(body)).not.toContain(rawToken);
    expect(JSON.stringify(body)).not.toContain("/reset-password/");
  });

  test("masked preview is short and shaped like first4 + '...' + last4", async () => {
    const { res, rawToken } = await issueToken();
    const body = await jsonFromResponse(res);

    // Shape: 4 + 3 + 4 = 11 chars, middle literal "..."
    expect(body.masked).toMatch(/^[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
    // Must not be a substring long enough to uniquely identify the token.
    // Raw token is 64 hex chars; masked shares 8 of them but not contiguously.
    expect(body.masked.length).toBeLessThan(rawToken.length);
  });

  test("full reset URL IS delivered via the audit log (out-of-band path)", async () => {
    // This isn't strictly an H4 requirement, but it documents the chosen
    // out-of-band delivery mechanism so future refactors don't silently
    // drop the URL on the floor (which would break admin workflows).
    const { rawToken } = await issueToken();

    const auditEntry = auditCalls.find(
      (c) => c.action === "auth:password_reset_generated",
    );
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.userId).toBe(ADMIN_USER.id);
    expect(auditEntry!.target).toBe(VICTIM.id);
    // The URL should be in metadata (not target), with the raw token.
    const meta = auditEntry!.metadata as { resetUrl?: string } | undefined;
    expect(meta?.resetUrl).toBe(`/reset-password/${rawToken}`);
  });
});

// ── Consumer: the redundant email comparison must be gone ──────

describe("sec-H4: POST /api/auth/reset-password/[token] ignores email field", () => {
  test("wrong email + correct token → 200 (email check removed)", async () => {
    // Pre-fix, this would 400 with "Invalid email for this reset link",
    // creating the illusion the email was doing security work. It wasn't:
    // the attacker already possessed the token and could trivially supply
    // the matching email. Now: possession of the single-use token alone
    // is authoritative.
    const { rawToken } = await issueToken();

    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/reset-password/${rawToken}`,
      body: { email: "completely-unrelated@attacker.example", password: "NewPassword456" },
      params: { token: rawToken },
    });
    const res = await call(consumePost, event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res);
    expect(body.success).toBe(true);

    // Password actually got updated on the victim's user row.
    expect(passwordUpdates).toHaveLength(1);
    expect(passwordUpdates[0]!.userId).toBe(VICTIM.id);
    expect(passwordUpdates[0]!.hash).toBe("hashed:NewPassword456");
  });

  test("invalid token → 400 regardless of email", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/reset-password/nope-not-a-real-token",
      body: { email: VICTIM.email, password: "NewPassword456" },
      params: { token: "nope-not-a-real-token" },
    });
    const res = await call(consumePost, event);
    expect(res.status).toBe(400);
    const body = await jsonFromResponse(res);
    expect(body.error).toBe("Invalid or expired reset link");
    // No password update happened.
    expect(passwordUpdates).toHaveLength(0);
  });

  test("token is single-use — second claim with same token fails", async () => {
    const { rawToken } = await issueToken();

    // First claim succeeds (with a deliberately wrong email to prove the
    // email check really is gone on the happy path too).
    const event1 = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/reset-password/${rawToken}`,
      body: { email: "wrong@attacker.example", password: "NewPassword456" },
      params: { token: rawToken },
    });
    const res1 = await call(consumePost, event1);
    expect(res1.status).toBe(200);

    // Second claim with the same token — must fail even with the "right"
    // email, because the token is now consumed.
    const event2 = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/reset-password/${rawToken}`,
      body: { email: VICTIM.email, password: "AnotherPass789" },
      params: { token: rawToken },
    });
    const res2 = await call(consumePost, event2);
    expect(res2.status).toBe(400);
    const body2 = await jsonFromResponse(res2);
    expect(body2.error).toBe("Invalid or expired reset link");

    // Only the first update landed.
    expect(passwordUpdates).toHaveLength(1);
    expect(passwordUpdates[0]!.hash).toBe("hashed:NewPassword456");
  });
});
