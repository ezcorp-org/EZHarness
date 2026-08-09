/**
 * Server-handler unit tests for /api/providers/[provider]/test (+server.ts).
 *
 * Covers auth/scope gates, the provider whitelist (anthropic/openai/google
 * vs unknown), the no-tier-model fallback, and the LLM happy/error paths.
 * The pi-ai `complete` call, registry lookups, the routing ladder/overlay
 * readers, and credential lookup are all mocked so no real LLM round-trip
 * (and no DB access) happens.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", () => ({
  complete: vi.fn(),
}));

vi.mock("$server/providers/credentials", () => ({
  getCredential: vi.fn(),
}));

vi.mock("$server/providers/registry", () => ({
  findModelForProviderInTier: vi.fn(),
  resolveModelObject: vi.fn(),
}));

// The handler resolves its probe model the way ROUTING does — ladder + the
// custom/kilo overlay — so a provider whose models are not in pi-ai's catalog
// (kilo, ollama) is testable at all. Both readers hit `settings`, so they are
// mocked here alongside the registry; without this the suite fails with
// "Database not initialized" rather than exercising the handler.
vi.mock("$server/providers/router", () => ({
  getConfiguredTierLadder: vi.fn(async () => undefined),
  getRoutableOverlayModels: vi.fn(async () => []),
}));

const { complete } = await import("@earendil-works/pi-ai/compat");
const { getCredential } = await import("$server/providers/credentials");
const { findModelForProviderInTier, resolveModelObject } = await import(
  "$server/providers/registry"
);
const { getConfiguredTierLadder, getRoutableOverlayModels } = await import(
  "$server/providers/router"
);
const { POST } = await import("../routes/api/providers/[provider]/test/+server");

function makeEvent(opts: { locals?: Record<string, unknown>; params?: { provider?: string } }) {
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
    vi.mocked(getConfiguredTierLadder).mockReset().mockResolvedValue(undefined);
    vi.mocked(getRoutableOverlayModels).mockReset().mockResolvedValue([]);
  });

  // F6: this used to assert the handler THREW a 401 — the `expect.fail("should
  // have thrown")` shape that PINS the 500-instead-of-403 bug as the contract
  // (SvelteKit renders a thrown Response from a +server.ts handler as a generic
  // 500). The redundant `requireAuth` that produced the throw is gone;
  // `requireAdmin` already refuses a caller with no `locals.user` and RETURNS
  // its denial, so an anonymous caller now gets the same uniform 403 "Admin
  // role required" as a non-admin — matching the sibling `POST /api/providers`.
  // Nothing is loosened: hooks.server.ts answers unauthenticated `/api/*` with
  // 401 long before this handler runs.
  test("returns (never throws) a 403 for an unauthenticated caller", async () => {
    const res = await POST(makeEvent({}));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Admin role required" });
    expect(vi.mocked(getCredential)).not.toHaveBeenCalled();
  });

  // The F6 gap this route carried: its own comment claimed "admin-only, on
  // BOTH axes" while calling only `requireAdmin`. An admin-role key minted
  // `--scopes read` therefore reached a live completion paid for with the
  // instance's BYOK credential.
  test("rejects 403 for an admin-role key scoped ['read'] and never reads the credential", async () => {
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
    expect(vi.mocked(getCredential)).not.toHaveBeenCalled();
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
    const res = await POST(makeEvent({ locals: adminUser, params: { provider: "bogus" } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid provider");
  });

  test("returns 400 when provider is empty", async () => {
    const res = await POST(makeEvent({ locals: adminUser, params: { provider: "" } }));
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
    const res = await POST(makeEvent({ locals: adminUser, params: { provider: "anthropic" } }));
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

    const res = await POST(makeEvent({ locals: adminUser, params: { provider: "anthropic" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(findModelForProviderInTier).toHaveBeenCalledWith("anthropic", "fast", undefined, []);
    expect(resolveModelObject).toHaveBeenCalledWith("anthropic", "claude-haiku", undefined);
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

    const res = await POST(makeEvent({ locals: adminUser, params: { provider: "openai" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(getCredential).toHaveBeenCalledWith("openai");
    expect(findModelForProviderInTier).toHaveBeenCalledWith("openai", "fast", undefined, []);
    const callArgs = vi.mocked(complete).mock.calls[0]!;
    expect(callArgs[2]).toMatchObject({ apiKey: "sk-openai" });
  });

  test("happy path: openrouter is a valid provider and walks the same flow", async () => {
    vi.mocked(getCredential).mockResolvedValue({
      type: "api-key",
      token: "sk-or-v1",
    } as any);
    vi.mocked(findModelForProviderInTier).mockReturnValue({
      id: "openrouter/auto",
    } as any);
    vi.mocked(resolveModelObject).mockReturnValue({
      ...piModelStub,
      provider: "openrouter",
      api: "openai-completions",
    } as any);
    vi.mocked(complete).mockResolvedValue({
      stopReason: "stop",
      content: [],
    } as any);

    const res = await POST(makeEvent({ locals: adminUser, params: { provider: "openrouter" } }));
    // openrouter is a VALID provider — not the 400 invalid-provider path.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(getCredential).toHaveBeenCalledWith("openrouter");
    expect(findModelForProviderInTier).toHaveBeenCalledWith("openrouter", "fast", undefined, []);
    expect(resolveModelObject).toHaveBeenCalledWith("openrouter", "openrouter/auto", undefined);
    const callArgs = vi.mocked(complete).mock.calls[0]!;
    expect(callArgs[2]).toMatchObject({ apiKey: "sk-or-v1" });
  });

  test("auth failure: missing credential bubbles up as success=false", async () => {
    vi.mocked(getCredential).mockRejectedValue(new Error("No credential for openai"));
    const res = await POST(makeEvent({ locals: adminUser, params: { provider: "openai" } }));
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

    const res = await POST(makeEvent({ locals: adminUser, params: { provider: "google" } }));
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

    const res = await POST(makeEvent({ locals: adminUser, params: { provider: "google" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("network blew up");
  });
});
