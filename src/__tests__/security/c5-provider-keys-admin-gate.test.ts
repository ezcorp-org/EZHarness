// Regression test for sec-C5: POST and DELETE /api/providers must be
// gated on requireRole(locals, "admin"). Pre-fix the handlers were only
// gated by `requireScope(locals, "admin")` — a no-op for cookie auth —
// so any authenticated "member" could overwrite or delete the instance's
// LLM provider API key.
//
// Exploit narrative:
//   1. A normal member POSTs { provider: "anthropic", apiKey: "sk-ant-ATTACKER" }
//      — the setting is upserted verbatim. All subsequent LLM calls bill
//      the attacker's key (or fail if it's a stolen/revoked key).
//   2. Or: a normal member DELETEs { provider: "anthropic" } — the
//      setting is wiped, DoS'ing every other user of the instance.
//
// Fix (36f3667):
//   - requireRole(locals, "admin") on both POST and DELETE
//   - insertAuditEntry on successful writes (best-effort try/catch)
//
// Strategy: handler-level probe. Mock the settings queries to capture
// upsert/delete calls, mock the audit log to capture audit entries, then
// drive POST/DELETE with:
//   1. member user  → 403, upsert/delete NOT called, no audit entry
//   2. unauthenticated → 401, upsert/delete NOT called, no audit entry
//   3. admin happy paths → 200, upsert/delete called, audit entry written
//
// Tests fix(sec-C5): 36f3667

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  ADMIN_USER,
  MEMBER_USER,
} from "../helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockServerAlias();

// SvelteKit generated $types stub — not present at test time.
mock.module("../../../web/src/routes/api/providers/$types", () => ({}));

// requireScope must stay a no-op passthrough — we're exercising the NEW
// requireRole gate, not an api-key scope check.
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));
mock.module("../../../web/src/lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

// ── Capture settings writes/deletes ──────────────────────────────
let upsertCalls: Array<{ key: string; value: unknown }> = [];
let deleteCalls: Array<{ key: string }> = [];

const settingsMock = () => ({
  getSetting: async () => undefined,
  upsertSetting: async (key: string, value: unknown) => {
    upsertCalls.push({ key, value });
  },
  deleteSetting: async (key: string) => {
    deleteCalls.push({ key });
    return true;
  },
});
mock.module("$server/db/queries/settings", settingsMock);
mock.module("../../db/queries/settings", settingsMock);

// Encryption — pass-through for assertion purposes.
const encryptionMock = () => ({
  encrypt: (plaintext: string) => `enc:${plaintext}`,
  decrypt: (ciphertext: string) => ciphertext.replace(/^enc:/, ""),
  _resetKeyCache: () => {},
});
mock.module("$server/providers/encryption", encryptionMock);
mock.module("../../providers/encryption", encryptionMock);

// Audit log — capture for assertions.
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

// ── Handler import (AFTER mocks) ─────────────────────────────────
import { POST, DELETE } from "../../../web/src/routes/api/providers/+server";

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
  upsertCalls = [];
  deleteCalls = [];
  auditCalls.length = 0;
});

describe("sec-C5: POST /api/providers role gate", () => {
  test("member role → 403, upsertSetting NOT called, no audit entry", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { provider: "anthropic", apiKey: "sk-ant-ATTACKER" },
      user: MEMBER_USER,
    });
    const res = await call(POST, event);
    expect(res.status).toBe(403);
    // Pre-fix, the attacker key would have been written verbatim.
    expect(upsertCalls.length).toBe(0);
    expect(auditCalls.length).toBe(0);
  });

  test("unauthenticated → 401, upsertSetting NOT called", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { provider: "anthropic", apiKey: "sk-ant-ATTACKER" },
      // no user
    });
    const res = await call(POST, event);
    expect(res.status).toBe(401);
    expect(upsertCalls.length).toBe(0);
    expect(auditCalls.length).toBe(0);
  });

  test("admin happy path → 200, key encrypted and upserted, audit entry written", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { provider: "anthropic", apiKey: "sk-ant-valid-admin-key" },
      user: ADMIN_USER,
    });
    const res = await call(POST, event);
    const data = await jsonFromResponse(res);
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);

    // Write landed.
    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0]!.key).toBe("provider:apiKey:anthropic");
    expect(upsertCalls[0]!.value).toBe("enc:sk-ant-valid-admin-key");

    // Audit entry attempted with the admin's user id.
    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0]!.userId).toBe(ADMIN_USER.id);
    expect(auditCalls[0]!.action).toBe("provider:key_upsert");
    expect(auditCalls[0]!.target).toBe("anthropic");
  });

  test("admin + invalid provider → 400, upsertSetting NOT called (validation after role gate)", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { provider: "deepseek", apiKey: "sk-test" },
      user: ADMIN_USER,
    });
    const res = await call(POST, event);
    expect(res.status).toBe(400);
    expect(upsertCalls.length).toBe(0);
    expect(auditCalls.length).toBe(0);
  });
});

describe("sec-C5: DELETE /api/providers role gate", () => {
  test("member role → 403, deleteSetting NOT called, no audit entry", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/providers",
      body: { provider: "anthropic" },
      user: MEMBER_USER,
    });
    const res = await call(DELETE, event);
    expect(res.status).toBe(403);
    // Pre-fix, the member could wipe the instance key — DoS.
    expect(deleteCalls.length).toBe(0);
    expect(auditCalls.length).toBe(0);
  });

  test("unauthenticated → 401, deleteSetting NOT called", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/providers",
      body: { provider: "anthropic" },
      // no user
    });
    const res = await call(DELETE, event);
    expect(res.status).toBe(401);
    expect(deleteCalls.length).toBe(0);
    expect(auditCalls.length).toBe(0);
  });

  test("admin happy path → 200, key deleted, audit entry written", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/providers",
      body: { provider: "openai" },
      user: ADMIN_USER,
    });
    const res = await call(DELETE, event);
    const data = await jsonFromResponse(res);
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);

    // Delete landed.
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0]!.key).toBe("provider:apiKey:openai");

    // Audit entry attempted.
    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0]!.userId).toBe(ADMIN_USER.id);
    expect(auditCalls[0]!.action).toBe("provider:key_delete");
    expect(auditCalls[0]!.target).toBe("openai");
  });

  test("admin + invalid provider → 400, deleteSetting NOT called", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/providers",
      body: { provider: "mistral" },
      user: ADMIN_USER,
    });
    const res = await call(DELETE, event);
    expect(res.status).toBe(400);
    expect(deleteCalls.length).toBe(0);
    expect(auditCalls.length).toBe(0);
  });
});
