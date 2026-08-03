/**
 * F1 — the authorization gate on PUT/DELETE /api/extensions/:id/settings/user.
 *
 * These handlers had `requireAuth` as their ENTIRE gate; the route never
 * imported `requireScope`. PUT partitions secret-typed fields out of the body
 * and ENCRYPTS them into extension storage; DELETE wipes every stored user
 * value. So a key minted `--scopes read` — a nominally read-only credential —
 * performed both writes. They are now gated on the `extensions` scope, the
 * same scope the sibling extension-secret route uses.
 *
 * Why this file exists alongside `extension-settings-api.test.ts`: that suite
 * is bun:test (per-`beforeEach` `mock.module`, which has no hoisted `vi.mock`
 * equivalent), so the node/vitest v8 coverage leg cannot run it and the route
 * reached the patch-coverage gate with NO lcov data. This is the vitest-side
 * twin scoped to the authorization claims, so the F1 fix is measured rather
 * than merely asserted. `requireScope`/`requireAuth` are deliberately NOT
 * mocked — the real gate is the thing under test.
 */

import { test, expect, describe, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  getExtension: vi.fn(async (_id: string) => null as unknown),
  getUserSettings: vi.fn(async (_u: string, _e: string) => ({}) as Record<string, unknown>),
  setUserSettings: vi.fn(async (_u: string, _e: string, _v: Record<string, unknown>) => undefined),
  clearUserSettings: vi.fn(async (_u: string, _e: string) => undefined),
  setSecretSetting: vi.fn(async (_e: string, _u: string, _k: string, _v: string) => undefined),
  clearSecretSetting: vi.fn(async (_e: string, _u: string, _k: string) => undefined),
  probeSecretSettings: vi.fn(async () => ({}) as Record<string, { isSet: boolean }>),
  insertAuditEntry: vi.fn(async () => undefined),
}));

vi.mock("$server/db/queries/extensions", () => ({ getExtension: h.getExtension }));
vi.mock("$server/db/queries/extension-settings", () => ({
  getUserSettings: h.getUserSettings,
  setUserSettings: h.setUserSettings,
  clearUserSettings: h.clearUserSettings,
}));
vi.mock("$server/extensions/secret-settings", () => ({
  setSecretSetting: h.setSecretSetting,
  clearSecretSetting: h.clearSecretSetting,
  probeSecretSettings: h.probeSecretSettings,
}));
vi.mock("$server/db/queries/audit-log", () => ({ insertAuditEntry: h.insertAuditEntry }));
// `requireScope` lives in a module whose top-level imports pull the settings
// query layer; stub it so no PGlite is spun up. The gate itself stays real.
vi.mock("$server/db/queries/settings", () => ({
  getAllSettings: vi.fn(async () => ({})),
  getSetting: vi.fn(async () => undefined),
  upsertSetting: vi.fn(async () => undefined),
}));

const { PUT, DELETE } = await import(
  "../routes/api/extensions/[id]/settings/user/+server.ts"
);

const USER = { id: "user-1", email: "u@x", name: "U", role: "member" };

/** A schema with a secret-typed field, so PUT really does encrypt-and-store. */
const SCHEMA = {
  voice: { type: "select", label: "Voice", options: [], default: "a" },
  apiKey: { type: "secret", label: "API key", storageKey: "api_key" },
};

function evt(
  method: "PUT" | "DELETE",
  opts: { body?: unknown; scopes?: string[]; id?: string } = {},
) {
  const id = opts.id ?? "ext-1";
  return {
    url: new URL(`http://localhost/api/extensions/${id}/settings/user`),
    params: { id },
    locals: opts.scopes ? { user: USER, apiKeyScopes: opts.scopes } : { user: USER },
    request: new Request(`http://localhost/api/extensions/${id}/settings/user`, {
      method,
      headers: { "content-type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  } as never;
}

/** The route may still THROW a Response from `requireAuth`; normalize so a
 *  denial is inspectable either way. */
async function call(handler: (e: never) => unknown, event: never): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockClear();
  h.getExtension.mockResolvedValue({ id: "ext-1", manifest: { settings: SCHEMA } });
  h.getUserSettings.mockResolvedValue({});
  h.probeSecretSettings.mockResolvedValue({ apiKey: { isSet: true } });
});

describe("PUT /api/extensions/:id/settings/user — F1 scope gate", () => {
  test("a read-only key is refused 403 and NO secret is stored", async () => {
    const res = await call(PUT, evt("PUT", { body: { values: { apiKey: "sk-attacker" } }, scopes: ["read"] }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("extensions");
    expect(h.setSecretSetting).not.toHaveBeenCalled();
    expect(h.setUserSettings).not.toHaveBeenCalled();
  });

  test("the scope gate runs BEFORE the extension lookup (no existence oracle)", async () => {
    const res = await call(PUT, evt("PUT", { body: { values: {} }, scopes: ["read"] }));
    expect(res.status).toBe(403);
    expect(h.getExtension).not.toHaveBeenCalled();
  });

  test("a COOKIE session still succeeds and stores the secret", async () => {
    const res = await call(PUT, evt("PUT", { body: { values: { apiKey: "sk-legit" } } }));
    expect(res.status).toBe(200);
    expect(h.setSecretSetting).toHaveBeenCalledWith("ext-1", "user-1", "api_key", "sk-legit");
  });

  test("a correctly-scoped 'extensions' key still succeeds", async () => {
    const res = await call(PUT, evt("PUT", { body: { values: { apiKey: "sk-legit" } }, scopes: ["extensions"] }));
    expect(res.status).toBe(200);
    expect(h.setSecretSetting).toHaveBeenCalled();
  });

  test("an empty-string secret CLEARS it rather than storing one", async () => {
    const res = await call(PUT, evt("PUT", { body: { values: { apiKey: "" } }, scopes: ["extensions"] }));
    expect(res.status).toBe(200);
    expect(h.clearSecretSetting).toHaveBeenCalledWith("ext-1", "user-1", "api_key");
    expect(h.setSecretSetting).not.toHaveBeenCalled();
  });

  test("a non-string secret is rejected 400 before anything is applied", async () => {
    const res = await call(PUT, evt("PUT", { body: { values: { apiKey: 42 } }, scopes: ["extensions"] }));
    expect(res.status).toBe(400);
    expect(h.setUserSettings).not.toHaveBeenCalled();
  });

  test("an over-long secret is rejected 400 and nothing is applied", async () => {
    const res = await call(
      PUT,
      evt("PUT", { body: { values: { apiKey: "x".repeat(513) } }, scopes: ["extensions"] }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("at most 512 characters");
    expect(h.setSecretSetting).not.toHaveBeenCalled();
    expect(h.setUserSettings).not.toHaveBeenCalled();
  });

  test("unauthenticated is refused 401", async () => {
    const event = { ...(evt("PUT", { body: { values: {} } }) as object), locals: {} } as never;
    const res = await call(PUT, event);
    expect(res.status).toBe(401);
    expect(h.setUserSettings).not.toHaveBeenCalled();
  });

  test("unknown extension is 404", async () => {
    h.getExtension.mockResolvedValue(null);
    const res = await call(PUT, evt("PUT", { body: { values: {} }, scopes: ["extensions"] }));
    expect(res.status).toBe(404);
  });

  test("an extension with no settings schema is 409", async () => {
    h.getExtension.mockResolvedValue({ id: "ext-1", manifest: {} });
    const res = await call(PUT, evt("PUT", { body: { values: {} }, scopes: ["extensions"] }));
    expect(res.status).toBe(409);
  });

  test("a non-object `values` is rejected 400", async () => {
    const res = await call(PUT, evt("PUT", { body: { values: [1, 2] }, scopes: ["extensions"] }));
    expect(res.status).toBe(400);
    expect(h.setUserSettings).not.toHaveBeenCalled();
  });

  test("still 200 when the audit write throws (best-effort)", async () => {
    h.insertAuditEntry.mockRejectedValueOnce(new Error("audit-fail"));
    const res = await call(PUT, evt("PUT", { body: { values: { voice: "b" } }, scopes: ["extensions"] }));
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/extensions/:id/settings/user — F1 scope gate", () => {
  test("a read-only key is refused 403 and NOTHING is cleared", async () => {
    const res = await call(DELETE, evt("DELETE", { scopes: ["read"] }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.required).toBe("extensions");
    expect(h.clearUserSettings).not.toHaveBeenCalled();
    expect(h.getExtension).not.toHaveBeenCalled();
  });

  test("a COOKIE session still succeeds", async () => {
    const res = await call(DELETE, evt("DELETE"));
    expect(res.status).toBe(200);
    expect(h.clearUserSettings).toHaveBeenCalledWith("user-1", "ext-1");
  });

  test("a correctly-scoped 'extensions' key still succeeds", async () => {
    const res = await call(DELETE, evt("DELETE", { scopes: ["extensions"] }));
    expect(res.status).toBe(200);
    expect(h.clearUserSettings).toHaveBeenCalled();
  });

  test("unauthenticated is refused 401", async () => {
    const event = { ...(evt("DELETE") as object), locals: {} } as never;
    const res = await call(DELETE, event);
    expect(res.status).toBe(401);
    expect(h.clearUserSettings).not.toHaveBeenCalled();
  });

  test("unknown extension is 404", async () => {
    h.getExtension.mockResolvedValue(null);
    const res = await call(DELETE, evt("DELETE", { scopes: ["extensions"] }));
    expect(res.status).toBe(404);
  });

  test("an extension with no settings schema is 409", async () => {
    h.getExtension.mockResolvedValue({ id: "ext-1", manifest: {} });
    const res = await call(DELETE, evt("DELETE", { scopes: ["extensions"] }));
    expect(res.status).toBe(409);
  });

  test("still 200 when the audit write throws (best-effort)", async () => {
    h.insertAuditEntry.mockRejectedValueOnce(new Error("audit-fail"));
    const res = await call(DELETE, evt("DELETE", { scopes: ["extensions"] }));
    expect(res.status).toBe(200);
  });
});
