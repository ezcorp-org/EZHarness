/**
 * Server-handler unit tests for /api/providers (+server.ts).
 *
 * Covers all three methods — GET (read BYOK/env/OAuth status), POST (upsert
 * API key, admin-gated), DELETE (remove API key, admin-gated). Mocks the
 * settings query layer and the audit-log writer so no PGlite is touched;
 * encryption is mocked so we don't need on-disk .pi-secret.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

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

const { getSetting, upsertSetting, deleteSetting } = await import(
  "$server/db/queries/settings"
);
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
  });

  test("rejects 401 when locals.user is missing", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ method: "GET" }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
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
    expect(body).toHaveLength(3);
    const providers = body.map((b) => b.provider).sort();
    expect(providers).toEqual(["anthropic", "google", "openai"]);
    for (const entry of body) {
      expect(entry.hasKey).toBe(false);
      expect(entry.source).toBe("none");
      expect(entry.oauthConnected).toBe(false);
    }
    expect(body.find((b) => b.provider === "anthropic")?.oauthSupported).toBe(
      false,
    );
    expect(body.find((b) => b.provider === "openai")?.oauthSupported).toBe(true);
    expect(body.find((b) => b.provider === "google")?.oauthSupported).toBe(true);
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

  test("rejects 401 when locals.user is missing", async () => {
    let res: Response | undefined;
    try {
      await POST(
        makeEvent({
          method: "POST",
          body: { provider: "openai", apiKey: "sk-x" },
        }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 403 when caller is not admin", async () => {
    let res: Response | undefined;
    try {
      await POST(
        makeEvent({
          method: "POST",
          locals: memberUser,
          body: { provider: "openai", apiKey: "sk-x" },
        }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
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
    expect(upsertSetting).toHaveBeenCalledWith(
      "provider:apiKey:openai",
      "enc:sk-abc",
    );
    expect(insertAuditEntry).toHaveBeenCalledWith(
      "admin-1",
      "provider:key_upsert",
      "openai",
      {},
    );
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

  test("rejects 401 when locals.user is missing", async () => {
    let res: Response | undefined;
    try {
      await DELETE(
        makeEvent({ method: "DELETE", body: { provider: "openai" } }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 403 when caller is not admin", async () => {
    let res: Response | undefined;
    try {
      await DELETE(
        makeEvent({
          method: "DELETE",
          locals: memberUser,
          body: { provider: "openai" },
        }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
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
    const res = await DELETE(
      makeEvent({ method: "DELETE", locals: adminUser, body: {} }),
    );
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
