/**
 * Server-handler unit tests for /api/auth/oauth/callback (+server.ts).
 *
 * Two things are covered here:
 *
 *  1. The AUTHORIZATION contract. POST writes and DELETE removes
 *     `provider:oauth:<provider>` — the INSTANCE LLM credential that
 *     `src/providers/credentials.ts:getOAuthCredential` resolves for every
 *     user's turns. That is the same room `provider:apiKey:<provider>`
 *     lives in, and the door to THAT room (`POST`/`DELETE /api/providers`)
 *     has been gated on BOTH authorization axes since sec-C5/F2:
 *     `requireAdmin(locals)` for the ROLE and `requireScope(locals,"admin")`
 *     for the API-key SCOPE. This door was gated on `requireAuth` alone, so
 *     any authenticated MEMBER could redirect the organisation's provider
 *     credential to an account they control, or delete it and take every
 *     user's LLM access down. The tests below assert the negative in both
 *     directions and on both axes independently, and assert the WRITE ITSELF
 *     never happens — a status-code-only assertion would still pass if the
 *     handler answered 403 after persisting.
 *
 *  2. The pre-existing body-validation gates (provider whitelist, required
 *     fields). These now run behind the admin gate, so they are exercised
 *     with an ADMIN principal.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

// The route persists through these two modules. Mock both: `upsertSetting` /
// `deleteSetting` are what "the credential was actually written/removed"
// MEANS, so they have to be observable; and the real `encrypt` derives a key
// by reading/writing a `.pi-secret` file under cwd, which a unit test must
// not touch.
vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(),
  upsertSetting: vi.fn(async () => {}),
  deleteSetting: vi.fn(async () => {}),
}));
vi.mock("$server/providers/encryption", () => ({
  encrypt: vi.fn((plain: string) => `enc(${plain})`),
}));

import { getSetting, upsertSetting, deleteSetting } from "$server/db/queries/settings";
import { POST, DELETE } from "../routes/api/auth/oauth/callback/+server.ts";

const VALID_STATE = "state-abc";

/** A well-formed sec-M2 pending record for `VALID_STATE` / openai. */
function pendingRecord() {
  return {
    state: VALID_STATE,
    codeVerifier: "verifier-xyz",
    redirectUri: "http://localhost:1455/auth/callback",
    provider: "openai",
    createdAt: Date.now(),
  };
}

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body: unknown;
  method: "POST" | "DELETE";
}) {
  return {
    url: new URL("http://localhost/api/auth/oauth/callback"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/auth/oauth/callback", {
      method: opts.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.body),
    }),
  } as never as Parameters<typeof POST>[0];
}

// ── Principals ────────────────────────────────────────────────────────────
// Named for the two axes they exercise. `authMethod` is stamped the way
// hooks.server.ts / bearer-auth.ts stamp it, so these are the shapes a real
// request produces.
const ANON = {};
/** Browser cookie, member role. The threat actor for this whole file. */
const MEMBER_COOKIE = {
  user: { id: "u-member", email: "m@x", name: "M", role: "member" },
  authMethod: "session",
};
/** Browser cookie, admin role — carries NO apiKeyScopes, so the scope gate
 *  is a deliberate no-op for it (hasRequiredScope treats undefined as
 *  allow-all). Browser admins must be unaffected by the scope axis. */
const ADMIN_COOKIE = {
  user: { id: "u-admin", email: "a@x", name: "A", role: "admin" },
  authMethod: "session",
};
/** A key whose OWNER is a member, minted with the admin SCOPE. Refused on
 *  the ROLE axis — holding a scope is not being an admin. */
const MEMBER_KEY = {
  user: { id: "u-member", email: "m@x", name: "M", role: "member" },
  apiKeyScopes: ["admin"],
  authMethod: "api-key",
};
/** `key mint --scopes read --role admin`: admin PRINCIPAL, narrow SCOPE.
 *  Refused on the SCOPE axis — which is the half `requireAdmin` alone
 *  cannot see, and the reason both gates are needed rather than either. */
const ADMIN_KEY_NARROW_SCOPE = {
  user: { id: "u-admin", email: "a@x", name: "A", role: "admin" },
  apiKeyScopes: ["read"],
  authMethod: "api-key",
};
/** Correctly minted admin key — admin on both axes. */
const ADMIN_KEY = {
  user: { id: "u-admin", email: "a@x", name: "A", role: "admin" },
  apiKeyScopes: ["admin"],
  authMethod: "api-key",
};

/** Every principal that must be REFUSED, with the axis it trips. */
const REFUSED: [name: string, locals: Record<string, unknown>, error: string][] = [
  ["an unauthenticated caller", ANON, "Admin role required"],
  ["a member-role cookie session", MEMBER_COOKIE, "Admin role required"],
  ["a member-role API key holding the admin scope", MEMBER_KEY, "Admin role required"],
  ["an admin-role API key scoped only for read", ADMIN_KEY_NARROW_SCOPE, "Insufficient scope"],
];

beforeEach(() => {
  vi.mocked(getSetting).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(upsertSetting).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(deleteSetting).mockReset().mockResolvedValue(undefined as never);
});

/** Arm the sec-M2 pending lookup + the provider token endpoint so a POST
 *  that CLEARS the gate reaches the credential write. Without this the
 *  "no write happened" assertions below would pass vacuously. */
function armSuccessfulExchange() {
  vi.mocked(getSetting).mockImplementation(async (key: string) =>
    key === `oauth:pending:${VALID_STATE}` ? (pendingRecord() as never) : (undefined as never),
  );
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

/** Calls to `upsertSetting` that target the instance provider credential. */
function credentialWrites() {
  return vi.mocked(upsertSetting).mock.calls.filter(([k]) =>
    String(k).startsWith("provider:oauth:"),
  );
}

describe("POST /api/auth/oauth/callback — admin gate (both axes)", () => {
  test.each(REFUSED)(
    "%s is refused with 403 and NO credential is written",
    async (_name, locals, error) => {
      armSuccessfulExchange();

      const res = await POST(
        makeEvent({
          method: "POST",
          locals,
          body: { provider: "openai", code: "auth-code", state: VALID_STATE },
        }),
      );

      // Returned, never thrown: SvelteKit renders a thrown Response as a 500.
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error?: string }).error).toBe(error);

      // THE CONSEQUENCE. Pre-fix this handler answered 200 here and stored the
      // caller's token as the instance credential every user is billed against.
      expect(credentialWrites()).toEqual([]);
      // Nor may it consume the one-shot pending record on a refused call.
      expect(deleteSetting).not.toHaveBeenCalled();
    },
  );

  test("an admin cookie session still connects the provider", async () => {
    armSuccessfulExchange();

    const res = await POST(
      makeEvent({
        method: "POST",
        locals: ADMIN_COOKIE,
        body: { provider: "openai", code: "auth-code", state: VALID_STATE },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, provider: "openai" });
    expect(credentialWrites()).toHaveLength(1);
    expect(credentialWrites()[0]![0]).toBe("provider:oauth:openai");
    // The sec-M2 one-shot record is consumed only on success.
    expect(deleteSetting).toHaveBeenCalledWith(`oauth:pending:${VALID_STATE}`);
  });

  test("an admin-role API key holding the admin scope also connects", async () => {
    armSuccessfulExchange();

    const res = await POST(
      makeEvent({
        method: "POST",
        locals: ADMIN_KEY,
        body: { provider: "openai", code: "auth-code", state: VALID_STATE },
      }),
    );

    expect(res.status).toBe(200);
    expect(credentialWrites()).toHaveLength(1);
  });
});

describe("POST /api/auth/oauth/callback — body validation (admin principal)", () => {
  test("rejects unknown provider with 400", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: ADMIN_COOKIE,
        body: { provider: "evil", code: "c", state: "s" },
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain("Invalid provider");
  });

  test("rejects missing code with 400", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: ADMIN_COOKIE,
        body: { provider: "openai", state: "s" },
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("code is required");
  });

  test("rejects missing state with 400", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: ADMIN_COOKIE,
        body: { provider: "openai", code: "c" },
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("state is required");
  });

  test("rejects an unknown/expired state with 400", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: ADMIN_COOKIE,
        body: { provider: "openai", code: "c", state: "never-issued" },
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("Invalid or expired state");
  });
});

describe("DELETE /api/auth/oauth/callback — admin gate (both axes)", () => {
  test.each(REFUSED)(
    "%s is refused with 403 and the credential SURVIVES",
    async (_name, locals, error) => {
      const res = await DELETE(
        makeEvent({ method: "DELETE", locals, body: { provider: "openai" } }),
      );

      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error?: string }).error).toBe(error);

      // THE CONSEQUENCE. Pre-fix any member could delete the instance's
      // provider credential — an outage for every other user.
      expect(deleteSetting).not.toHaveBeenCalled();
    },
  );

  test("an admin cookie session still disconnects the provider", async () => {
    const res = await DELETE(
      makeEvent({ method: "DELETE", locals: ADMIN_COOKIE, body: { provider: "openai" } }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(deleteSetting).toHaveBeenCalledWith("provider:oauth:openai");
  });

  test("an admin-role API key holding the admin scope also disconnects", async () => {
    const res = await DELETE(
      makeEvent({ method: "DELETE", locals: ADMIN_KEY, body: { provider: "openai" } }),
    );

    expect(res.status).toBe(200);
    expect(deleteSetting).toHaveBeenCalledWith("provider:oauth:openai");
  });

  test("rejects unknown provider with 400 and deletes nothing", async () => {
    const res = await DELETE(
      makeEvent({ method: "DELETE", locals: ADMIN_COOKIE, body: { provider: "evil" } }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain("Invalid provider");
    expect(deleteSetting).not.toHaveBeenCalled();
  });
});
