/**
 * Server-handler unit tests for /api/providers/[provider]/refresh-models.
 *
 * Covers auth/scope gates, the provider whitelist, credential resolution
 * (best-effort — a missing credential still discovers via the catalog),
 * the persisted setting key, the success payload shape, and error
 * surfacing. fetchProviderModels + getCredential + upsertSetting are
 * mocked so no network or DB is touched.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/providers/model-discovery", () => ({
  fetchProviderModels: vi.fn(),
}));

vi.mock("$server/providers/credentials", () => ({
  getCredential: vi.fn(),
}));

vi.mock("$server/db/queries/settings", () => ({
  upsertSetting: vi.fn(),
}));

const { fetchProviderModels } = await import(
  "$server/providers/model-discovery"
);
const { getCredential } = await import("$server/providers/credentials");
const { upsertSetting } = await import("$server/db/queries/settings");
const { POST } = await import(
  "../routes/api/providers/[provider]/refresh-models/+server"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  params?: { provider?: string };
}) {
  return {
    url: new URL("http://localhost/api/providers/x/refresh-models"),
    locals: opts.locals ?? {},
    params: opts.params ?? { provider: "openai" },
  } as any;
}

const adminUser = { user: { id: "u1", email: "u@x", name: "u", role: "admin" } };

describe("POST /api/providers/[provider]/refresh-models", () => {
  beforeEach(() => {
    vi.mocked(fetchProviderModels).mockReset();
    vi.mocked(getCredential).mockReset();
    vi.mocked(upsertSetting).mockReset();
    vi.mocked(upsertSetting).mockResolvedValue(undefined as any);
  });

  test("rejects unauthenticated callers with 401", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({}));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 403 when apiKeyScopes lacks 'admin'", async () => {
    const res = await POST(
      makeEvent({ locals: { apiKeyScopes: ["read", "chat"] } }),
    );
    expect(res.status).toBe(403);
  });

  test("returns 400 for unknown provider", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "bogus" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid provider");
  });

  test("returns 400 when provider is empty", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "" } }),
    );
    expect(res.status).toBe(400);
  });

  test("happy path: resolves credential, stores models, returns summary", async () => {
    const cred = { type: "apikey", token: "sk-openai" };
    vi.mocked(getCredential).mockResolvedValue(cred as any);
    vi.mocked(fetchProviderModels).mockResolvedValue([
      { id: "gpt-5.2" },
      { id: "gpt-4o" },
    ] as any);

    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "openai" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      count: number;
      ids: string[];
      fetchedAt: string;
    };
    expect(body.success).toBe(true);
    expect(body.count).toBe(2);
    expect(body.ids).toEqual(["gpt-5.2", "gpt-4o"]);
    expect(typeof body.fetchedAt).toBe("string");

    expect(getCredential).toHaveBeenCalledWith("openai");
    expect(fetchProviderModels).toHaveBeenCalledWith("openai", cred);
    const [key, value] = vi.mocked(upsertSetting).mock.calls[0]!;
    expect(key).toBe("provider:discoveredModels:openai");
    expect(value).toEqual([{ id: "gpt-5.2" }, { id: "gpt-4o" }]);
  });

  test("missing credential still discovers via catalog (undefined passed)", async () => {
    vi.mocked(getCredential).mockRejectedValue(new Error("no creds"));
    vi.mocked(fetchProviderModels).mockResolvedValue([{ id: "gpt-4o" }] as any);

    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "openai" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; count: number };
    expect(body.success).toBe(true);
    expect(body.count).toBe(1);
    expect(fetchProviderModels).toHaveBeenCalledWith("openai", undefined);
  });

  test("discovery failure surfaces success=false + error", async () => {
    vi.mocked(getCredential).mockResolvedValue({
      type: "apikey",
      token: "k",
    } as any);
    vi.mocked(fetchProviderModels).mockRejectedValue(
      new Error("models.dev returned 503"),
    );

    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "anthropic" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("models.dev returned 503");
    expect(upsertSetting).not.toHaveBeenCalled();
  });
});
