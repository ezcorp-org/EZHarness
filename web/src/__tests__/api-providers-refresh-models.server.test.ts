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

  // F6: this used to assert the handler THREW a 401 — the `expect.fail("should
  // have thrown")` shape that PINS the 500-instead-of-403 bug as the contract.
  // The redundant `requireAuth` is gone; `requireAdmin` refuses a caller with
  // no `locals.user` and RETURNS its denial. hooks.server.ts still answers
  // unauthenticated `/api/*` with 401 before this handler is reached.
  test("returns (never throws) a 403 for an unauthenticated caller", async () => {
    const res = await POST(makeEvent({}));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Admin role required" });
    expect(vi.mocked(fetchProviderModels)).not.toHaveBeenCalled();
  });

  // The F6 gap: the comment claimed "BOTH axes" while only `requireAdmin` ran,
  // so an admin-role key minted `--scopes read` could overwrite
  // `provider:discoveredModels:*` — the list every routing decision reads.
  test("rejects 403 for an admin-role key scoped ['read'] and writes nothing", async () => {
    const res = await POST(
      makeEvent({
        locals: {
          user: { id: "u1", email: "a@x", name: "a", role: "admin" },
          apiKeyScopes: ["read"],
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Insufficient scope", required: "admin" });
    expect(vi.mocked(fetchProviderModels)).not.toHaveBeenCalled();
    expect(vi.mocked(upsertSetting)).not.toHaveBeenCalled();
  });

  test("rejects 403 for a non-admin member even with an admin api-key scope", async () => {
    // requireAdmin gates on ROLE on BOTH axes — an admin SCOPE on a member's
    // key is insufficient (FINDING A: scope ≠ role). Uses instance creds, so
    // admin-only like providers/test.
    const res = await POST(
      makeEvent({
        locals: {
          user: { id: "m1", email: "m@x", name: "m", role: "member" },
          apiKeyScopes: ["admin"],
        },
      }),
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

  test("openrouter is a valid provider: resolves credential, stores models", async () => {
    const cred = { type: "apikey", token: "sk-or-v1" };
    vi.mocked(getCredential).mockResolvedValue(cred as any);
    vi.mocked(fetchProviderModels).mockResolvedValue([
      { id: "openrouter/auto" },
      { id: "anthropic/claude-3.5-sonnet" },
    ] as any);

    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "openrouter" } }),
    );
    // openrouter is a VALID provider — not the 400 invalid-provider path.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      count: number;
      ids: string[];
    };
    expect(body.success).toBe(true);
    expect(body.count).toBe(2);
    expect(body.ids).toEqual(["openrouter/auto", "anthropic/claude-3.5-sonnet"]);

    expect(getCredential).toHaveBeenCalledWith("openrouter");
    expect(fetchProviderModels).toHaveBeenCalledWith("openrouter", cred);
    const [key, value] = vi.mocked(upsertSetting).mock.calls[0]!;
    expect(key).toBe("provider:discoveredModels:openrouter");
    expect(value).toEqual([
      { id: "openrouter/auto" },
      { id: "anthropic/claude-3.5-sonnet" },
    ]);
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
