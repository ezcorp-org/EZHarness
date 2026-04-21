// Regression test for sec-L1: login handler must take the same code path
// (and thus the same wall-clock time) whether or not the supplied email
// matches a real user. Pre-fix, when getUserByEmail returned null the
// handler short-circuited to the 401 without ever calling verifyPassword,
// so the response was ~100ms faster than a wrong-password attempt against
// an existing account. An attacker could enumerate valid emails by timing.
//
// Exploit narrative:
//   1. Attacker POSTs /api/auth/login with {email: "ceo@target.com",
//      password: "x"}. If ceo@target.com is NOT a user the response comes
//      back in a few milliseconds — no argon2id verify ran. If it IS a
//      user the response takes ~100ms because argon2id ran against the
//      real hash.
//   2. A few thousand POSTs later the attacker has a confirmed list of
//      valid accounts to phish, stuff credentials against, or reset.
//
// Fix (b493106):
//   - module-level cached-promise for a dummy argon2id hash
//   - in the user-not-found / inactive-user branch, the handler now
//     awaits verifyPassword(password, dummyHash) before returning, so
//     both branches run one argon2id verification before the 401
//
// Strategy: handler-level probe. Mock getUserByEmail, verifyPassword,
// and the audit log so we can assert:
//   1. verifyPassword IS called when getUserByEmail returns null
//      (the direct functional guarantee of the fix)
//   2. the error shape is identical to the wrong-password case
//   3. inactive users also go through verifyPassword (same branch)
//   4. (documentary) wall-clock delta between the unknown-email and
//      wrong-password branches is small. This is soft-assertion only —
//      marked flaky — because we can't make timing deterministic in a
//      test runner, but it locks in intent.
//
// Tests fix(sec-L1): b493106

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
} from "../helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockServerAlias();

// SvelteKit generated $types stub — not present at test time.
mock.module("../../../web/src/routes/api/auth/login/$types", () => ({}));

// ── Capture getUserByEmail calls; allow per-test control ─────────
let userLookupResult: any = null;
const userQueriesMock = () => ({
  getUserByEmail: async (_email: string) => userLookupResult,
});
mock.module("$server/db/queries/users", userQueriesMock);
mock.module("../../db/queries/users", userQueriesMock);

// ── Capture verifyPassword calls ─────────────────────────────────
// Tracks every call so we can assert the constant-time branch still
// runs an argon2id verify. We simulate a real argon2id cost with a
// small sleep so the wall-clock timing assertion at the bottom has
// something to compare against.
const verifyPasswordCalls: Array<{ password: string; hash: string }> = [];
const SIMULATED_ARGON2_MS = 25;

async function simulatedVerify(password: string, hash: string): Promise<boolean> {
  verifyPasswordCalls.push({ password, hash });
  await new Promise((resolve) => setTimeout(resolve, SIMULATED_ARGON2_MS));
  // Dummy hash used in the constant-time path → always false.
  // Wrong-password path → also false. We never exercise the happy path here.
  return false;
}

const passwordMock = () => ({
  verifyPassword: simulatedVerify,
  hashPassword: async (p: string) => `hash:${p}`,
});
mock.module("$server/auth/password", passwordMock);
mock.module("../../auth/password", passwordMock);

// ── Audit log — capture entries so we can assert both branches emit
//    the same `auth:failed_login` event.
const auditCalls: Array<{
  userId: string | null;
  action: string;
  target?: string;
  metadata?: unknown;
}> = [];
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

// ── JWT / sessions — unused on the 401 branches but stubbed so any
//    accidental happy-path fallthrough doesn't crash with module errors.
const jwtMock = () => ({
  signJWT: async () => "stub-token",
  getJwtSecret: async () => "stub-secret",
});
mock.module("$server/auth/jwt", jwtMock);
mock.module("../../auth/jwt", jwtMock);

const sessionsMock = () => ({
  hashToken: async (t: string) => `h:${t}`,
  createSession: async () => ({}),
});
mock.module("$server/db/queries/sessions", sessionsMock);
mock.module("../../db/queries/sessions", sessionsMock);

// ── Handler import (AFTER mocks) ─────────────────────────────────
import { POST as loginPost } from "../../../web/src/routes/api/auth/login/+server";

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  verifyPasswordCalls.length = 0;
  auditCalls.length = 0;
  userLookupResult = null;
});

// ── Helper: invoke the login handler with a standard body ───────
async function postLogin(body: { email: string; password: string }) {
  const event = createMockEvent({
    method: "POST",
    url: "http://localhost/api/auth/login",
    body,
  });
  return (await loginPost(event)) as Response;
}

describe("sec-L1: login must run verifyPassword in the user-not-found branch", () => {
  test("unknown email → verifyPassword IS called (constant-time guarantee)", async () => {
    userLookupResult = null;

    const res = await postLogin({ email: "nobody@test.local", password: "x" });

    expect(res.status).toBe(401);
    // The direct functional guarantee of the fix: even with no user,
    // the handler must have invoked an argon2id verification.
    expect(verifyPasswordCalls.length).toBe(1);
    // Body password must have been passed through (same argument shape
    // as the wrong-password branch).
    expect(verifyPasswordCalls[0]!.password).toBe("x");
    // The hash MUST NOT be the user's hash (there is no user). It's the
    // module-level dummy hash — assert it's a non-empty string the
    // handler pre-computed itself.
    expect(typeof verifyPasswordCalls[0]!.hash).toBe("string");
    expect(verifyPasswordCalls[0]!.hash.length).toBeGreaterThan(0);
  });

  test("inactive user → verifyPassword IS called (same branch, same guarantee)", async () => {
    userLookupResult = {
      id: "u1",
      email: "inactive@test.local",
      name: "Inactive",
      role: "member",
      status: "inactive",
      passwordHash: "inactive-user-real-hash",
    };

    const res = await postLogin({
      email: "inactive@test.local",
      password: "x",
    });

    expect(res.status).toBe(401);
    expect(verifyPasswordCalls.length).toBe(1);
    // The fix runs the dummy-hash verify for inactive users too — it
    // MUST NOT leak whether the row exists by skipping verification.
    expect(verifyPasswordCalls[0]!.hash).not.toBe("inactive-user-real-hash");
  });
});

describe("sec-L1: response shape for unknown email matches wrong-password", () => {
  test("unknown email and wrong password return identical error shape + status", async () => {
    // Call 1: unknown email
    userLookupResult = null;
    const res1 = await postLogin({ email: "nobody@test.local", password: "x" });
    const body1 = await jsonFromResponse(res1);

    // Call 2: known user, wrong password (simulatedVerify always returns false)
    userLookupResult = {
      id: "u2",
      email: "alice@test.local",
      name: "Alice",
      role: "member",
      status: "active",
      passwordHash: "alices-real-hash",
    };
    const res2 = await postLogin({ email: "alice@test.local", password: "x" });
    const body2 = await jsonFromResponse(res2);

    expect(res1.status).toBe(res2.status);
    expect(res1.status).toBe(401);
    expect(body1).toEqual(body2);
    expect(body1.error).toBe("Invalid credentials");

    // Defence-in-depth: headers shouldn't distinguish the two either.
    expect(res1.headers.get("content-type")).toBe(res2.headers.get("content-type"));
  });

  test("both branches write an auth:failed_login audit entry with the email", async () => {
    userLookupResult = null;
    await postLogin({ email: "nobody@test.local", password: "x" });

    userLookupResult = {
      id: "u3",
      email: "bob@test.local",
      name: "Bob",
      role: "member",
      status: "active",
      passwordHash: "bobs-real-hash",
    };
    await postLogin({ email: "bob@test.local", password: "x" });

    // Two audit entries, both auth:failed_login with null userId.
    expect(auditCalls.length).toBe(2);
    for (const call of auditCalls) {
      expect(call.action).toBe("auth:failed_login");
      expect(call.userId).toBeNull();
    }
  });
});

describe("sec-L1: wall-clock timing delta is small", () => {
  // flaky: timing assertion — documents intent. The simulated argon2id
  // cost above (SIMULATED_ARGON2_MS) runs on BOTH branches after the
  // fix, so the measured delta should be well under the cost itself.
  // Pre-fix, the unknown-email branch skipped verifyPassword entirely
  // and would be roughly SIMULATED_ARGON2_MS faster per iteration.
  test("10-iteration mean wall-clock for unknown-email vs wrong-password is within 20ms", async () => {
    const ITERATIONS = 10;

    async function measure(emailFactory: (i: number) => string, seedUser: boolean) {
      const times: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        userLookupResult = seedUser
          ? {
              id: `u-${i}`,
              email: emailFactory(i),
              name: "Seeded",
              role: "member",
              status: "active",
              passwordHash: `hash-${i}`,
            }
          : null;
        const start = performance.now();
        await postLogin({ email: emailFactory(i), password: "x" });
        times.push(performance.now() - start);
      }
      return times.reduce((a, b) => a + b, 0) / times.length;
    }

    const unknownMean = await measure((i) => `ghost-${i}@test.local`, false);
    const wrongPwMean = await measure((i) => `user-${i}@test.local`, true);

    // Both branches should have taken ~SIMULATED_ARGON2_MS per call.
    // Pre-fix the unknown-email mean would have been ~0ms, so the
    // delta would have been ~SIMULATED_ARGON2_MS (25ms). Post-fix it
    // should be well under 20ms.
    const delta = Math.abs(unknownMean - wrongPwMean);
    expect(delta).toBeLessThan(20);
  });
});
