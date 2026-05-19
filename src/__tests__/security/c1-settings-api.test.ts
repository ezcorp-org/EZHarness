// Regression test for sec-C1: settings API must gate on requireRole("admin")
// and deny-list sensitive keys (instance:jwtSecret, provider:apiKey:*,
// provider:oauth:*) for EVERYONE — including admins. The pre-fix code gated on
// requireScope("admin"), which is a no-op for cookie auth, so any logged-in
// user could GET /api/settings/instance:jwtSecret and recover the HS256 secret.
//
// Tests fix(sec-C1): 54bc523
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

mock.module("../../../web/src/routes/api/settings/$types", () => ({}));
mock.module("../../../web/src/routes/api/settings/[key]/$types", () => ({}));
mock.module("$lib/server/security/validation", () =>
  require("../../../web/src/lib/server/security/validation"),
);
// requireScope is a no-op in production for cookie auth. Keep it that way in
// tests so we're testing the *new* requireRole gate, not a stub of the old one.
// verifyApiKey: included so this mock doesn't leak an incomplete shape to
// sibling tests (e.g. c2-session-revocation) via Bun's module cache —
// mock.module() persists across test files.
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
  verifyApiKey: async () => null,
}));

// In-memory settings store backs the fake query module.
let store: Map<string, unknown>;
const settingsMock = () => ({
  async getAllSettings() {
    return Object.fromEntries(store.entries());
  },
  async getSetting(key: string) {
    return store.has(key) ? store.get(key) : undefined;
  },
  async upsertSetting(key: string, value: unknown) {
    store.set(key, value);
  },
  async deleteSetting(key: string) {
    return store.delete(key);
  },
  async isListingInstalled() {
    return false;
  },
});
mock.module("$server/db/queries/settings", settingsMock);
mock.module("../../db/queries/settings", settingsMock);

// ── Handler imports (AFTER mocks) ────────────────────────────────
import {
  GET as keyGet,
  PUT as keyPut,
  DELETE as keyDelete,
} from "../../../web/src/routes/api/settings/[key]/+server";
import { GET as listGet } from "../../../web/src/routes/api/settings/+server";

// SvelteKit handlers throw Responses on auth failure; unwrap either form.
async function call(handler: (ev: any) => any, event: any): Promise<Response> {
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
  store = new Map<string, unknown>([
    ["instance:jwtSecret", "super-secret-hs256-key-pre-fix-bug"],
    ["provider:apiKey:openai", "sk-live-leaked-openai-key"],
    ["provider:oauth:google", { clientSecret: "leaked-oauth-secret" }],
    ["ui:theme", "dark"],
  ]);
});

// ── The critical regressions ─────────────────────────────────────

describe("sec-C1: GET /api/settings/[key]", () => {
  test("member role → 403 on instance:jwtSecret (role gate)", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/settings/instance:jwtSecret",
      params: { key: "instance:jwtSecret" },
      user: MEMBER_USER,
    });
    const res = await call(keyGet, event);
    expect(res.status).toBe(403);
    // Must NOT have exposed the secret in the body.
    const body = await jsonFromResponse(res);
    expect(JSON.stringify(body)).not.toContain("super-secret-hs256-key-pre-fix-bug");
  });

  test("admin role → 403 on instance:jwtSecret (deny-list applies to admins)", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/settings/instance:jwtSecret",
      params: { key: "instance:jwtSecret" },
      user: ADMIN_USER,
    });
    const res = await call(keyGet, event);
    expect(res.status).toBe(403);
    const body = await jsonFromResponse(res);
    expect(JSON.stringify(body)).not.toContain("super-secret-hs256-key-pre-fix-bug");
  });

  test("admin role → 403 on provider:apiKey:openai (deny-list provider keys)", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/settings/provider:apiKey:openai",
      params: { key: "provider:apiKey:openai" },
      user: ADMIN_USER,
    });
    const res = await call(keyGet, event);
    expect(res.status).toBe(403);
    const body = await jsonFromResponse(res);
    expect(JSON.stringify(body)).not.toContain("sk-live-leaked-openai-key");
  });

  test("admin role → 403 on provider:oauth:google (deny-list oauth secrets)", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/settings/provider:oauth:google",
      params: { key: "provider:oauth:google" },
      user: ADMIN_USER,
    });
    const res = await call(keyGet, event);
    expect(res.status).toBe(403);
    const body = await jsonFromResponse(res);
    expect(JSON.stringify(body)).not.toContain("leaked-oauth-secret");
  });

  test("admin role → 200 on a benign key (positive case still works)", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/settings/ui:theme",
      params: { key: "ui:theme" },
      user: ADMIN_USER,
    });
    const res = await call(keyGet, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body.value).toBe("dark");
  });
});

describe("sec-C1: PUT /api/settings/[key]", () => {
  test("member role → 403 on sensitive key (role gate)", async () => {
    const event = createMockEvent({
      method: "PUT",
      url: "http://localhost/api/settings/instance:jwtSecret",
      params: { key: "instance:jwtSecret" },
      body: { value: "attacker-chosen-secret" },
      user: MEMBER_USER,
    });
    const res = await call(keyPut, event);
    expect(res.status).toBe(403);
    // Must NOT have been written.
    expect(store.get("instance:jwtSecret")).toBe("super-secret-hs256-key-pre-fix-bug");
  });

  test("member role → 403 even on a benign key (role gate blocks all writes)", async () => {
    const event = createMockEvent({
      method: "PUT",
      url: "http://localhost/api/settings/ui:theme",
      params: { key: "ui:theme" },
      body: { value: "pwned" },
      user: MEMBER_USER,
    });
    const res = await call(keyPut, event);
    expect(res.status).toBe(403);
    expect(store.get("ui:theme")).toBe("dark");
  });

  test("admin role → 403 on deny-listed key (admins can't write it either)", async () => {
    const event = createMockEvent({
      method: "PUT",
      url: "http://localhost/api/settings/instance:jwtSecret",
      params: { key: "instance:jwtSecret" },
      body: { value: "admin-overwrite-attempt" },
      user: ADMIN_USER,
    });
    const res = await call(keyPut, event);
    expect(res.status).toBe(403);
    expect(store.get("instance:jwtSecret")).toBe("super-secret-hs256-key-pre-fix-bug");
  });

  test("admin role → 200 on a benign key (positive case still works)", async () => {
    const event = createMockEvent({
      method: "PUT",
      url: "http://localhost/api/settings/ui:theme",
      params: { key: "ui:theme" },
      body: { value: "light" },
      user: ADMIN_USER,
    });
    const res = await call(keyPut, event);
    expect(res.status).toBe(200);
    expect(store.get("ui:theme")).toBe("light");
  });
});

describe("sec-C1: DELETE /api/settings/[key]", () => {
  test("member role → 403 on benign key (role gate blocks delete)", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/settings/ui:theme",
      params: { key: "ui:theme" },
      user: MEMBER_USER,
    });
    const res = await call(keyDelete, event);
    expect(res.status).toBe(403);
    expect(store.has("ui:theme")).toBe(true);
  });

  test("admin role → 403 on deny-listed key (can't delete sensitive key)", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/settings/instance:jwtSecret",
      params: { key: "instance:jwtSecret" },
      user: ADMIN_USER,
    });
    const res = await call(keyDelete, event);
    expect(res.status).toBe(403);
    expect(store.has("instance:jwtSecret")).toBe(true);
  });
});

describe("sec-C1: GET /api/settings (list)", () => {
  test("member role → 403 (no leak of any keys)", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/settings",
      user: MEMBER_USER,
    });
    const res = await call(listGet, event);
    expect(res.status).toBe(403);
    const body = await jsonFromResponse(res);
    expect(JSON.stringify(body)).not.toContain("super-secret-hs256-key-pre-fix-bug");
    expect(JSON.stringify(body)).not.toContain("sk-live-leaked-openai-key");
  });

  test("admin role → 200 but deny-listed keys are scrubbed from list", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/settings",
      user: ADMIN_USER,
    });
    const res = await call(listGet, event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res);
    expect(body["instance:jwtSecret"]).toBeUndefined();
    expect(body["provider:apiKey:openai"]).toBeUndefined();
    expect(body["provider:oauth:google"]).toBeUndefined();
    expect(body["ui:theme"]).toBe("dark");
  });
});
