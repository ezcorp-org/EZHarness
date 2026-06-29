/**
 * Server-handler unit tests for /api/providers/[provider]/test (+server.ts).
 *
 * Covers auth/scope gates, the provider whitelist (anthropic/openai/google
 * vs unknown), the no-tier-model fallback, and the LLM happy/error paths.
 * The pi-ai `complete` call, registry lookups, and credential lookup are
 * all mocked so no real LLM round-trip happens.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
  complete: vi.fn(),
}));

vi.mock("$server/providers/credentials", () => ({
  getCredential: vi.fn(),
}));

vi.mock("$server/providers/registry", () => ({
  findModelForProviderInTier: vi.fn(),
  resolveModelObject: vi.fn(),
}));

const { complete } = await import("@earendil-works/pi-ai");
const { getCredential } = await import("$server/providers/credentials");
const { findModelForProviderInTier, resolveModelObject } = await import(
  "$server/providers/registry"
);
const { POST } = await import(
  "../routes/api/providers/[provider]/test/+server"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  params?: { provider?: string };
}) {
  return {
    url: new URL("http://localhost/api/providers/x/test"),
    locals: opts.locals ?? {},
    params: opts.params ?? { provider: "anthropic" },
  } as any;
}

const adminUser = { user: { id: "u1", email: "u@x", name: "u", role: "admin" } };

const piModelStub = {
  id: "claude-haiku",
  api: "anthropic-messages",
  provider: "anthropic",
  reasoning: false,
};

describe("POST /api/providers/[provider]/test", () => {
  beforeEach(() => {
    vi.mocked(complete).mockReset();
    vi.mocked(getCredential).mockReset();
    vi.mocked(findModelForProviderInTier).mockReset();
    vi.mocked(resolveModelObject).mockReset();
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

  test("rejects 403 for a non-admin MEMBER cookie session (FINDING A)", async () => {
    // A logged-in member (role:"member") must NOT be able to trigger a live
    // provider-credential test against instance secrets. requireScope("admin")
    // alone allow-alled this; requireAdmin gates on role.
    const res = await POST(
      makeEvent({ locals: { user: { id: "u2", email: "m@x", name: "m", role: "member" } } }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Admin role required");
  });

  test("rejects 403 for an API-key principal even with admin scope (role member)", async () => {
    // bearer-auth mints API-key principals as role:"member"; the admin SCOPE
    // can't substitute for the admin ROLE on this instance-secret operation.
    const res = await POST(
      makeEvent({
        locals: {
          user: { id: "u3", email: "k@x", name: "k", role: "member" },
          apiKeyScopes: ["admin"],
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Admin role required");
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
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid provider");
  });

  test("returns 400 when provider param is absent", async () => {
    const res = await POST(makeEvent({ locals: adminUser, params: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid provider");
  });

  test("returns success=false when provider has no fast-tier model", async () => {
    vi.mocked(getCredential).mockResolvedValue({
      type: "api-key",
      token: "sk-...",
    } as any);
    vi.mocked(findModelForProviderInTier).mockReturnValue(null as any);
    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "anthropic" } }),
    );
    // The handler maps "no model" → 200 + { success: false } body, NOT a 4xx
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("No models available for anthropic");
    // complete() never gets called when no model is available
    expect(complete).not.toHaveBeenCalled();
  });

  test("happy path: anthropic provider returns success=true after complete()", async () => {
    vi.mocked(getCredential).mockResolvedValue({
      type: "api-key",
      token: "sk-anth",
    } as any);
    vi.mocked(findModelForProviderInTier).mockReturnValue({
      id: "claude-haiku",
    } as any);
    vi.mocked(resolveModelObject).mockReturnValue(piModelStub as any);
    vi.mocked(complete).mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
    } as any);

    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "anthropic" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(findModelForProviderInTier).toHaveBeenCalledWith("anthropic", "fast");
    expect(resolveModelObject).toHaveBeenCalledWith("anthropic", "claude-haiku");
    expect(complete).toHaveBeenCalledTimes(1);
    // The handler wires apiKey + maxTokens=1 into the second arg
    const callArgs = vi.mocked(complete).mock.calls[0]!;
    expect(callArgs[2]).toMatchObject({ apiKey: "sk-anth", maxTokens: 1 });
  });

  test("happy path: openai provider walks the same flow with its own credential", async () => {
    vi.mocked(getCredential).mockResolvedValue({
      type: "api-key",
      token: "sk-openai",
    } as any);
    vi.mocked(findModelForProviderInTier).mockReturnValue({
      id: "gpt-fast",
    } as any);
    vi.mocked(resolveModelObject).mockReturnValue({
      ...piModelStub,
      provider: "openai",
    } as any);
    vi.mocked(complete).mockResolvedValue({
      stopReason: "stop",
      content: [],
    } as any);

    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "openai" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(getCredential).toHaveBeenCalledWith("openai");
    expect(findModelForProviderInTier).toHaveBeenCalledWith("openai", "fast");
    const callArgs = vi.mocked(complete).mock.calls[0]!;
    expect(callArgs[2]).toMatchObject({ apiKey: "sk-openai" });
  });

  test("auth failure: missing credential bubbles up as success=false", async () => {
    vi.mocked(getCredential).mockRejectedValue(
      new Error("No credential for openai"),
    );
    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "openai" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("No credential for openai");
    expect(complete).not.toHaveBeenCalled();
  });

  test("LLM error: complete() rejects, response surfaces error message", async () => {
    vi.mocked(getCredential).mockResolvedValue({
      type: "api-key",
      token: "sk-google",
    } as any);
    vi.mocked(findModelForProviderInTier).mockReturnValue({
      id: "gemini-flash",
    } as any);
    vi.mocked(resolveModelObject).mockReturnValue({
      ...piModelStub,
      provider: "google",
    } as any);
    vi.mocked(complete).mockRejectedValue(new Error("401 Unauthorized"));

    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "google" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("401 Unauthorized");
  });

  test("LLM throws non-Error: stringified message returned", async () => {
    vi.mocked(getCredential).mockResolvedValue({
      type: "api-key",
      token: "sk-google",
    } as any);
    vi.mocked(findModelForProviderInTier).mockReturnValue({
      id: "gemini-flash",
    } as any);
    vi.mocked(resolveModelObject).mockReturnValue(piModelStub as any);
    // pi-ai sometimes throws strings; handler does String(err) fallback
    vi.mocked(complete).mockRejectedValue("network blew up");

    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "google" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("network blew up");
  });
});
