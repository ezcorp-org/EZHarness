/**
 * Server-handler unit tests for /api/auth/oauth (+server.ts).
 *
 * Covers the auth gate plus the provider-validation guards. The success
 * paths for `google` and `openai` are exercised here too — both branches
 * call `upsertSetting` to persist the PKCE pair server-side and start
 * the loopback callback server. Both side-effects are mocked so this
 * test stays off PGlite + the network.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/settings", () => ({
  upsertSetting: vi.fn(async () => undefined),
}));

vi.mock("$server/auth/oauth-callback-server", () => ({
  startOAuthCallbackServer: vi.fn(),
}));

const { upsertSetting } = await import("$server/db/queries/settings");
const { startOAuthCallbackServer } = await import(
  "$server/auth/oauth-callback-server"
);
const { GET } = await import("../routes/api/auth/oauth/+server.ts");

function makeEvent(opts: {
  provider?: string | null;
  appOrigin?: string;
  locals?: Record<string, unknown>;
}) {
  const params = new URLSearchParams();
  if (opts.provider !== null && opts.provider !== undefined) {
    params.set("provider", opts.provider);
  }
  if (opts.appOrigin) {
    params.set("app_origin", opts.appOrigin);
  }
  const href = `http://localhost/api/auth/oauth?${params.toString()}`;
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    request: new Request(href),
  } as any;
}

const adminLocals = {
  user: { id: "u1", email: "u@x", name: "u", role: "admin" },
};

describe("GET /api/auth/oauth", () => {
  beforeEach(() => {
    vi.mocked(upsertSetting).mockClear();
    vi.mocked(startOAuthCallbackServer).mockClear();
  });

  test("unauthenticated request throws 401 Response", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ provider: "google", locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error?: string };
    expect(body.error).toBe("Authentication required");
  });

  test("missing provider returns 400", async () => {
    const res = await GET(makeEvent({ provider: null, locals: adminLocals }));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "Invalid provider. Must be one of: openai, google, anthropic",
    );
  });

  test("unsupported provider returns 400", async () => {
    const res = await GET(makeEvent({ provider: "wat", locals: adminLocals }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "Invalid provider. Must be one of: openai, google, anthropic",
    );
  });

  test("anthropic provider returns 400 (no OAuth path)", async () => {
    const res = await GET(makeEvent({ provider: "anthropic", locals: adminLocals }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("OAuth not available for Anthropic. Use API keys.");
  });

  test("openai provider returns auth URL with codex/originator params and persists pending state", async () => {
    const res = await GET(makeEvent({ provider: "openai", locals: adminLocals }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      state: string;
      redirectUri: string;
    };
    expect(typeof body.url).toBe("string");
    expect(body.url).toContain("auth.openai.com/oauth/authorize");
    // openai-specific query params (sec-M2 path)
    expect(body.url).toContain("codex_cli_simplified_flow=true");
    expect(body.url).toContain("originator=pi");
    expect(body.url).toContain("id_token_add_organizations=true");
    // PKCE params present
    expect(body.url).toContain("code_challenge_method=S256");
    expect(body.url).toContain("code_challenge=");
    // sec-M2: codeVerifier must NOT leak into the response body
    expect(body).not.toHaveProperty("codeVerifier");
    expect(body.state.length).toBeGreaterThan(0);
    expect(body.redirectUri).toBe("http://localhost:1455/auth/callback");
    // verifier persisted server-side, keyed by state
    expect(upsertSetting).toHaveBeenCalledTimes(1);
    const [key, payload] = vi.mocked(upsertSetting).mock.calls[0]!;
    expect(key).toBe(`oauth:pending:${body.state}`);
    expect(payload).toMatchObject({
      state: body.state,
      provider: "openai",
      redirectUri: "http://localhost:1455/auth/callback",
    });
    expect((payload as { codeVerifier: string }).codeVerifier.length).toBeGreaterThan(0);
    expect(startOAuthCallbackServer).toHaveBeenCalledWith(
      1455,
      expect.stringContaining("/auth/callback"),
    );
  });

  test("google provider returns auth URL with access_type=offline and persists pending state", async () => {
    const res = await GET(makeEvent({ provider: "google", locals: adminLocals }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      state: string;
      redirectUri: string;
    };
    expect(body.url).toContain("accounts.google.com/o/oauth2/v2/auth");
    // google-specific query param
    expect(body.url).toContain("access_type=offline");
    // openai-specific params must NOT leak into google
    expect(body.url).not.toContain("codex_cli_simplified_flow");
    expect(body.url).not.toContain("originator=pi");
    expect(body.redirectUri).toBe("http://localhost:1456/auth/callback");
    expect(upsertSetting).toHaveBeenCalledTimes(1);
    const [, payload] = vi.mocked(upsertSetting).mock.calls[0]!;
    expect(payload).toMatchObject({
      provider: "google",
      redirectUri: "http://localhost:1456/auth/callback",
    });
    expect(startOAuthCallbackServer).toHaveBeenCalledWith(
      1456,
      expect.stringContaining("/auth/callback"),
    );
  });

  test("rejects untrusted app_origin and falls back to request origin", async () => {
    // sec-M1: an attacker-supplied app_origin must NOT be honored
    const res = await GET(
      makeEvent({
        provider: "openai",
        appOrigin: "https://evil.example.com",
        locals: adminLocals,
      }),
    );
    expect(res.status).toBe(200);
    expect(startOAuthCallbackServer).toHaveBeenCalledTimes(1);
    const [, callbackUrl] = vi.mocked(startOAuthCallbackServer).mock.calls[0]!;
    // fallback to url.origin (http://localhost), NOT evil
    expect(callbackUrl).toBe("http://localhost/auth/callback");
  });

  test("accepts matching app_origin and uses it for the callback URL", async () => {
    const res = await GET(
      makeEvent({
        provider: "openai",
        appOrigin: "http://localhost",
        locals: adminLocals,
      }),
    );
    expect(res.status).toBe(200);
    const [, callbackUrl] = vi.mocked(startOAuthCallbackServer).mock.calls[0]!;
    expect(callbackUrl).toBe("http://localhost/auth/callback");
  });

  test("malformed app_origin URL is silently ignored", async () => {
    const res = await GET(
      makeEvent({
        provider: "openai",
        appOrigin: "not-a-url",
        locals: adminLocals,
      }),
    );
    // The handler swallows URL-parse errors and falls back to url.origin
    expect(res.status).toBe(200);
    const [, callbackUrl] = vi.mocked(startOAuthCallbackServer).mock.calls[0]!;
    expect(callbackUrl).toBe("http://localhost/auth/callback");
  });
});
