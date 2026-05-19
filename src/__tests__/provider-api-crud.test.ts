import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER } from "./helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────

let settingsStore: Record<string, unknown> = {};

const mockGetSetting = mock(async (key: string) => settingsStore[key]);
const mockUpsertSetting = mock(async (key: string, value: unknown) => {
  settingsStore[key] = value;
});
const mockDeleteSetting = mock(async (key: string) => {
  delete settingsStore[key];
  return true;
});

mock.module("../db/queries/settings", () => ({
  getSetting: mockGetSetting,
  upsertSetting: mockUpsertSetting,
  deleteSetting: mockDeleteSetting,
  getAllSettings: mock(async () => ({ ...settingsStore })),
  isListingInstalled: mock(async () => false),
}));

mock.module("../providers/encryption", () => ({
  encrypt: mock((plaintext: string) => `enc:${plaintext}`),
  decrypt: mock((ciphertext: string) => ciphertext.replace(/^enc:/, "")),
  _resetKeyCache: () => {},
}));

// updated for sec-C5: handler now calls requireRole(locals, "admin") and
// insertAuditEntry; mock passes the admin check for ADMIN_USER fixtures and
// the audit log is a no-op.
mock.module("../auth/middleware", () => ({
  requireAuth: mock((locals: any) => {
    if (!locals?.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return locals.user;
  }),
  requireRole: mock((locals: any, role: string) => {
    if (!locals?.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (locals.user.role !== role) {
      throw new Response(JSON.stringify({ error: "Insufficient permissions" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    return locals.user;
  }),
}));

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: mock(async () => {}),
}));

// Register $server aliases for SvelteKit route handler imports
mockServerAlias();

// Map $server aliases to the mock implementations directly
mock.module("$server/db/queries/settings", () => ({
  getSetting: mockGetSetting,
  upsertSetting: mockUpsertSetting,
  deleteSetting: mockDeleteSetting,
  getAllSettings: mock(async () => ({ ...settingsStore })),
  isListingInstalled: mock(async () => false),
}));
mock.module("$server/providers/encryption", () => ({
  encrypt: mock((plaintext: string) => `enc:${plaintext}`),
  decrypt: mock((ciphertext: string) => ciphertext.replace(/^enc:/, "")),
  _resetKeyCache: () => {},
}));
// updated for sec-C5: $server-aliased mock must also export requireRole.
mock.module("$server/auth/middleware", () => ({
  requireAuth: mock((locals: any) => {
    if (!locals?.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return locals.user;
  }),
  requireRole: mock((locals: any, role: string) => {
    if (!locals?.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (locals.user.role !== role) {
      throw new Response(JSON.stringify({ error: "Insufficient permissions" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    return locals.user;
  }),
}));

// updated for sec-C5: handler now audit-logs provider key writes/deletes.
mock.module("$server/db/queries/audit-log", () => ({
  insertAuditEntry: mock(async () => {}),
}));

// Mock $types for the route
mock.module("../../web/src/routes/api/providers/$types", () => ({}));

// ── Handler imports ──────────────────────────────────────────────

import { POST, DELETE } from "../../web/src/routes/api/providers/+server";

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  settingsStore = {};
  mockGetSetting.mockClear();
  mockUpsertSetting.mockClear();
  mockDeleteSetting.mockClear();
});

// ── POST tests ───────────────────────────────────────────────────

describe("POST /api/providers - save API key", () => {
  test("valid provider + apiKey saves encrypted key and returns success", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { provider: "anthropic", apiKey: "sk-ant-test-123" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(settingsStore["provider:apiKey:anthropic"]).toBe("enc:sk-ant-test-123");
  });

  test("valid openai provider saves encrypted key", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { provider: "openai", apiKey: "sk-openai-abc" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(settingsStore["provider:apiKey:openai"]).toBe("enc:sk-openai-abc");
  });

  test("valid google provider saves encrypted key", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { provider: "google", apiKey: "AIza-google-key" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(settingsStore["provider:apiKey:google"]).toBe("enc:AIza-google-key");
  });

  test("invalid provider returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { provider: "mistral", apiKey: "sk-test" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Invalid provider");
  });

  test("empty apiKey returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { provider: "anthropic", apiKey: "" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("API key is required");
  });

  test("missing apiKey returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { provider: "anthropic" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("API key is required");
  });

  test("whitespace-only apiKey returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { provider: "anthropic", apiKey: "   " },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("API key is required");
  });

  test("apiKey with leading/trailing whitespace is trimmed before saving", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { provider: "anthropic", apiKey: "  sk-trimmed  " },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    // The source trims before encrypting: encrypt(apiKey.trim())
    expect(settingsStore["provider:apiKey:anthropic"]).toBe("enc:sk-trimmed");
  });

  test("missing provider returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers",
      body: { apiKey: "sk-test" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Invalid provider");
  });
});

// ── DELETE tests ─────────────────────────────────────────────────

describe("DELETE /api/providers - delete API key", () => {
  test("valid provider deletes key and returns success", async () => {
    settingsStore["provider:apiKey:anthropic"] = "enc:sk-old";

    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/providers",
      body: { provider: "anthropic" },
      user: ADMIN_USER,
    });
    const res = await DELETE(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(settingsStore["provider:apiKey:anthropic"]).toBeUndefined();
  });

  test("invalid provider returns 400", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/providers",
      body: { provider: "deepseek" },
      user: ADMIN_USER,
    });
    const res = await DELETE(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Invalid provider");
  });

  test("missing provider returns 400", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/providers",
      body: {},
      user: ADMIN_USER,
    });
    const res = await DELETE(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Invalid provider");
  });

  test("empty string provider returns 400", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/providers",
      body: { provider: "" },
      user: ADMIN_USER,
    });
    const res = await DELETE(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Invalid provider");
  });

  test("delete for each valid provider works", async () => {
    for (const provider of ["anthropic", "openai", "google"]) {
      settingsStore[`provider:apiKey:${provider}`] = `enc:key-${provider}`;

      const event = createMockEvent({
        method: "DELETE",
        url: "http://localhost/api/providers",
        body: { provider },
        user: ADMIN_USER,
      });
      const res = await DELETE(event as any);
      const data = await jsonFromResponse(res);

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    }
  });
});
