/**
 * Server-handler unit tests for /api/providers (+server.ts).
 *
 * Covers all three methods — GET (read BYOK/env/OAuth status), POST (upsert
 * API key, admin-gated), DELETE (remove API key, admin-gated). Mocks the
 * settings query layer and the audit-log writer so no PGlite is touched;
 * encryption is mocked so we don't need on-disk .pi-secret.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectDenied } from "./fixtures/expect-denied";

vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(),
  upsertSetting: vi.fn(async () => undefined),
  deleteSetting: vi.fn(async () => true),
}));
vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));
vi.mock("$server/providers/encryption", () => ({
  encrypt: vi.fn((plain: string) => `enc:${plain}`),
  decrypt: vi.fn((ct: string) => ct.replace(/^enc:/, "")),
}));

const { getSetting, upsertSetting, deleteSetting } = await import("$server/db/queries/settings");
const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { encrypt } = await import("$server/providers/encryption");
const { GET, POST, DELETE } = await import("../routes/api/providers/+server");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: "GET" | "POST" | "DELETE";
}) {
  const method = opts.method ?? "GET";
  return {
    url: new URL("http://localhost/api/providers"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/providers", {
      method,
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const adminUser = {
  user: { id: "admin-1", email: "a@x", name: "a", role: "admin" },
};
const memberUser = {
  user: { id: "u1", email: "u@x", name: "u", role: "user" },
};

describe("GET /api/providers", () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockReset();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  // GET is gated by the THROWING `requireAuth`, deliberately left alone by the
  // returned-denial sweep: unlike the admin ROLE gates, a `requireAuth` denial
  // is not reachable by a real caller. `hooks.server.ts` answers every
  // unauthenticated `/api/*` request with 401 BEFORE the handler runs, so
  // `locals.user` is always populated here in production. This case is
  // therefore synthetic, and the throw it asserts never reaches a client.
  test("throws 401 when locals.user is missing (hook-unreachable path)", async () => {
    let thrown: unknown;
    try {
      await GET(makeEvent({ method: "GET" }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });

  test("rejects 403 when apiKeyScopes lacks 'read'", async () => {
    const res = await GET(
      makeEvent({
        method: "GET",
        locals: { apiKeyScopes: ["chat"] },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Insufficient scope");
  });

  test("returns status list (all 'none') for authenticated caller with empty DB/env", async () => {
    vi.mocked(getSetting).mockResolvedValue(undefined);
    const res = await GET(makeEvent({ method: "GET", locals: adminUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      provider: string;
      hasKey: boolean;
      source: string;
      oauthConnected: boolean;
      oauthSupported: boolean;
    }>;
    expect(body).toHaveLength(5);
    const providers = body.map((b) => b.provider).sort();
    expect(providers).toEqual(["anthropic", "google", "kilo", "openai", "openrouter"]);
    for (const entry of body) {
      expect(entry.hasKey).toBe(false);
      expect(entry.source).toBe("none");
      expect(entry.oauthConnected).toBe(false);
    }
    expect(body.find((b) => b.provider === "anthropic")?.oauthSupported).toBe(false);
    expect(body.find((b) => b.provider === "openai")?.oauthSupported).toBe(true);
    expect(body.find((b) => b.provider === "google")?.oauthSupported).toBe(true);
    // openrouter and kilo are BYOK-only — never OAuth.
    expect(body.find((b) => b.provider === "openrouter")?.oauthSupported).toBe(false);
    expect(body.find((b) => b.provider === "kilo")?.oauthSupported).toBe(false);
    // Kilo's `hasKey: false` above is NOT "unusable": its free models answer
    // with no credential. That distinction lives in provider AVAILABILITY
    // (`resolveProviderAvailability`), not in this status payload, which
    // reports only what is CONFIGURED.
  });

  test("reports source='env' when env var is set and no BYOK stored", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env";
    vi.mocked(getSetting).mockResolvedValue(undefined);
    const res = await GET(makeEvent({ method: "GET", locals: adminUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ provider: string; source: string; hasKey: boolean }>;
    const anthropic = body.find((b) => b.provider === "anthropic");
    expect(anthropic?.source).toBe("env");
    expect(anthropic?.hasKey).toBe(true);
  });

  test("reports source='byok' when a BYOK setting is present", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "provider:apiKey:anthropic") return "enc:stored-key";
      return undefined;
    });
    const res = await GET(makeEvent({ method: "GET", locals: adminUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ provider: string; source: string }>;
    expect(body.find((b) => b.provider === "anthropic")?.source).toBe("byok");
  });
});

describe("POST /api/providers", () => {
  beforeEach(() => {
    vi.mocked(upsertSetting).mockReset();
    vi.mocked(upsertSetting).mockResolvedValue(undefined);
    vi.mocked(insertAuditEntry).mockClear();
    vi.mocked(encrypt).mockClear();
  });

  // 403, not 401: the gate is now `requireAdmin`, which answers "not an admin
  // principal" uniformly (a missing principal is not an admin either). The old
  // 401 came from `requireRole`'s inner `requireAuth` — but it was THROWN, so
  // the caller actually received a 500. This path is hook-unreachable anyway
  // (`hooks.server.ts` 401s unauthenticated `/api/*` before the handler).
  test("rejects 403 when locals.user is missing", async () => {
    const res = await expectDenied(
      () =>
        POST(
          makeEvent({
            method: "POST",
            body: { provider: "openai", apiKey: "sk-x" },
          }),
        ),
      403,
    );
    expect(res.status).toBe(403);
  });

  test("rejects 403 when caller is not admin", async () => {
    const res = await expectDenied(
      () =>
        POST(
          makeEvent({
            method: "POST",
            locals: memberUser,
            body: { provider: "openai", apiKey: "sk-x" },
          }),
        ),
      403,
    );
    expect(res.status).toBe(403);
  });

  test("rejects 400 for unknown provider", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: { provider: "bogus", apiKey: "sk-x" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid provider");
  });

  test("rejects 400 when provider is missing", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: { apiKey: "sk-x" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid provider");
  });

  test("rejects 400 when apiKey is missing", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: { provider: "openai" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("API key is required");
  });

  test("rejects 400 when apiKey is whitespace only", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: { provider: "openai", apiKey: "   " },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("API key is required");
  });

  test("returns 200 {success:true} on successful upsert and writes audit entry", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: { provider: "openai", apiKey: " sk-abc " },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);
    expect(encrypt).toHaveBeenCalledWith("sk-abc");
    expect(upsertSetting).toHaveBeenCalledWith("provider:apiKey:openai", "enc:sk-abc");
    expect(insertAuditEntry).toHaveBeenCalledWith("admin-1", "provider:key_upsert", "openai", {});
  });

  test("still returns 200 if audit-log write throws (best-effort)", async () => {
    vi.mocked(insertAuditEntry).mockRejectedValueOnce(new Error("audit-fail"));
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: { provider: "google", apiKey: "sk-ok" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);
  });
});

describe("DELETE /api/providers", () => {
  beforeEach(() => {
    vi.mocked(deleteSetting).mockReset();
    vi.mocked(deleteSetting).mockResolvedValue(true);
    vi.mocked(insertAuditEntry).mockClear();
  });

  // 403, not 401 — see the POST case above for why `requireAdmin` collapses
  // "no principal" and "not an admin" into one denial.
  test("rejects 403 when locals.user is missing", async () => {
    const res = await expectDenied(
      () => DELETE(makeEvent({ method: "DELETE", body: { provider: "openai" } })),
      403,
    );
    expect(res.status).toBe(403);
  });

  test("rejects 403 when caller is not admin", async () => {
    const res = await expectDenied(
      () =>
        DELETE(
          makeEvent({
            method: "DELETE",
            locals: memberUser,
            body: { provider: "openai" },
          }),
        ),
      403,
    );
    expect(res.status).toBe(403);
  });

  test("rejects 400 for unknown provider", async () => {
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: adminUser,
        body: { provider: "bogus" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid provider");
  });

  test("rejects 400 when provider is missing", async () => {
    const res = await DELETE(makeEvent({ method: "DELETE", locals: adminUser, body: {} }));
    expect(res.status).toBe(400);
  });

  test("returns 200 {success:true} on successful delete and writes audit entry", async () => {
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: adminUser,
        body: { provider: "anthropic" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);
    expect(deleteSetting).toHaveBeenCalledWith("provider:apiKey:anthropic");
    expect(insertAuditEntry).toHaveBeenCalledWith(
      "admin-1",
      "provider:key_delete",
      "anthropic",
      {},
    );
  });

  test("still returns 200 if audit-log write throws (best-effort)", async () => {
    vi.mocked(insertAuditEntry).mockRejectedValueOnce(new Error("audit-fail"));
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: adminUser,
        body: { provider: "google" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean };
    expect(body.success).toBe(true);
  });
});
