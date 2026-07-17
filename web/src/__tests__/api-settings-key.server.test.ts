/**
 * Server-handler unit tests for /api/settings/[key] (+server.ts).
 *
 * Covers the admin-role gate, the missing-body 400, and the sensitive-key
 * deny list (sec gate that prevents the generic settings API from
 * disclosing JWT/provider credential rows).
 *
 * Success-path GET/PUT/DELETE are intentionally omitted — they hit the
 * settings query layer, which would need PGlite + drizzle wiring.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(),
  upsertSetting: vi.fn(async () => undefined),
  deleteSetting: vi.fn(async () => true),
}));

const { getSetting, upsertSetting, deleteSetting } = await import(
  "$server/db/queries/settings"
);
const { GET, PUT, DELETE } = await import(
  "../routes/api/settings/[key]/+server.ts"
);

function makeEvent(opts: {
  key: string;
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: string;
}) {
  const req = new Request(`http://localhost/api/settings/${opts.key}`, {
    method: opts.method ?? "GET",
    ...(opts.body !== undefined
      ? { body: JSON.stringify(opts.body), headers: { "content-type": "application/json" } }
      : {}),
  });
  return {
    url: new URL(`http://localhost/api/settings/${opts.key}`),
    locals: opts.locals ?? {},
    params: { key: opts.key },
    request: req,
  } as any;
}

const adminLocals = {
  user: { id: "u1", email: "u@x", name: "u", role: "admin" },
};

describe("GET /api/settings/[key]", () => {
  test("non-admin RETURNS 403 Response (not thrown → no 500)", async () => {
    const res = await GET(
      makeEvent({
        key: "ui:theme",
        locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
  });

  // Track 1 regression: an API-key principal (admin SCOPE but member ROLE)
  // must get a clean 403 JSON — pre-fix requireRole threw a raw Response that
  // SvelteKit surfaced as a 500 for key callers.
  test("API-key caller (member role) RETURNS 403 JSON, never 500", async () => {
    const res = await GET(
      makeEvent({
        key: "ui:theme",
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "member" },
          apiKeyScopes: ["read", "admin"],
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error!.length).toBeGreaterThan(0);
  });

  // Scope-axis regression: an admin-ROLE key must ALSO hold the admin SCOPE.
  // A key minted `--scopes read --role admin` clears the role wall but not the
  // scope wall → a clean 403 "Insufficient scope", never a settings read.
  test("admin-role key WITHOUT admin scope RETURNS 403 (scope axis)", async () => {
    const res = await GET(
      makeEvent({
        key: "ui:theme",
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "admin" },
          apiKeyScopes: ["read"],
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("admin");
  });

  // An admin-role key that ALSO holds the admin scope clears BOTH walls and
  // reaches the handler — 404 for an unset key (past the gates, not refused).
  test("admin-role key WITH admin scope clears both gates (404 for unset key)", async () => {
    vi.mocked(getSetting).mockResolvedValueOnce(undefined as any);
    const res = await GET(
      makeEvent({
        key: "ui:theme",
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "admin" },
          apiKeyScopes: ["read", "admin"],
        },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("sensitive key (instance:jwtSecret) returns 403", async () => {
    const res = await GET(
      makeEvent({ key: "instance:jwtSecret", locals: adminLocals }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "This setting key is managed internally and cannot be accessed via the settings API",
    );
  });

  test("sensitive key (provider:apiKey:*) returns 403", async () => {
    const res = await GET(
      makeEvent({ key: "provider:apiKey:openai", locals: adminLocals }),
    );
    expect(res.status).toBe(403);
  });

  // API-key store rows are deny-listed so an admin can't read/forge key rows
  // via the generic settings API (bypassing canMintRole / the hash index).
  test("API-key store key (apikey:*) returns 403 even for an admin", async () => {
    const res = await GET(
      makeEvent({ key: "apikey:u1:kid", locals: adminLocals }),
    );
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/settings/[key]", () => {
  // Loops kill-switch toggle path: the admin Loops Safety control PUTs
  // `loops:kill_switch`. A non-admin must be refused with a clean 403 and the
  // write must never reach the settings store.
  test("non-admin PUT to loops:kill_switch RETURNS 403 (toggle write refused)", async () => {
    vi.mocked(upsertSetting).mockClear();
    const res = await PUT(
      makeEvent({
        key: "loops:kill_switch",
        locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
        body: { value: true },
        method: "PUT",
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  // Track 1 regression: key caller → 403 RETURNED (not 500).
  test("API-key caller (member role) RETURNS 403 JSON, never 500", async () => {
    const res = await PUT(
      makeEvent({
        key: "ui:theme",
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "member" },
          apiKeyScopes: ["admin"],
        },
        body: { value: "x" },
        method: "PUT",
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  test("missing body.value returns 400", async () => {
    const res = await PUT(
      makeEvent({
        key: "ui:theme",
        locals: adminLocals,
        body: {},
        method: "PUT",
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("value required");
  });

  test("sensitive key returns 403 even with valid body", async () => {
    const res = await PUT(
      makeEvent({
        key: "provider:oauth:google",
        locals: adminLocals,
        body: { value: "x" },
        method: "PUT",
      }),
    );
    expect(res.status).toBe(403);
  });

  // Forging an admin-role key row via the generic PUT is denied even for an
  // admin — the write never reaches the settings store.
  test("PUT to an apikey:* row returns 403 even for an admin", async () => {
    vi.mocked(upsertSetting).mockClear();
    const res = await PUT(
      makeEvent({
        key: "apikey:attacker:forged",
        locals: adminLocals,
        body: { value: { hash: "x", userId: "attacker", scopes: ["admin"], role: "admin" } },
        method: "PUT",
      }),
    );
    expect(res.status).toBe(403);
    expect(upsertSetting).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/settings/[key]", () => {
  test("non-admin RETURNS 403 (not thrown → no 500)", async () => {
    const res = await DELETE(
      makeEvent({
        key: "ui:theme",
        locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
        method: "DELETE",
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
  });

  // Track 1 regression: key caller → 403 RETURNED (not 500).
  test("API-key caller (member role) RETURNS 403 JSON, never 500", async () => {
    const res = await DELETE(
      makeEvent({
        key: "ui:theme",
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "member" },
          apiKeyScopes: ["admin"],
        },
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  test("sensitive key returns 403", async () => {
    const res = await DELETE(
      makeEvent({
        key: "provider:apiKey:anthropic",
        locals: adminLocals,
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(403);
  });

  test("returns 404 when deleteSetting reports no row", async () => {
    vi.mocked(deleteSetting).mockResolvedValueOnce(false as any);
    const res = await DELETE(
      makeEvent({
        key: "ui:theme",
        locals: adminLocals,
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("returns 200 { ok: true } on successful delete", async () => {
    vi.mocked(deleteSetting).mockResolvedValueOnce(true as any);
    const res = await DELETE(
      makeEvent({
        key: "ui:theme",
        locals: adminLocals,
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
    expect(deleteSetting).toHaveBeenCalledWith("ui:theme");
  });
});

describe("GET /api/settings/[key] — value paths (mocked queries)", () => {
  beforeEach(() => vi.mocked(getSetting).mockReset());

  test("returns 404 when the key is not stored", async () => {
    vi.mocked(getSetting).mockResolvedValueOnce(undefined as any);
    const res = await GET(
      makeEvent({ key: "ui:theme", locals: adminLocals }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("returns 200 with { value } on success", async () => {
    vi.mocked(getSetting).mockResolvedValueOnce("dark" as any);
    const res = await GET(
      makeEvent({ key: "ui:theme", locals: adminLocals }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { value?: unknown };
    expect(body.value).toBe("dark");
  });
});

describe("PUT /api/settings/[key] — value persistence", () => {
  beforeEach(() => vi.mocked(upsertSetting).mockClear());

  test("returns 200 { ok: true } on successful upsert", async () => {
    const res = await PUT(
      makeEvent({
        key: "ui:theme",
        locals: adminLocals,
        method: "PUT",
        body: { value: "light" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
    expect(upsertSetting).toHaveBeenCalledWith("ui:theme", "light");
  });
});
