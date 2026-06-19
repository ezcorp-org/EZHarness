/**
 * Server-handler unit tests for /api/settings/developer/api-keys/+server.ts.
 *
 * Covers:
 *  - requireScope gates (read for GET, admin for POST/DELETE).
 *  - requireAuth 401 for missing locals.user.
 *  - Zod validation (400) on POST (missing name/scopes) and DELETE (non-UUID keyId).
 *  - Happy paths for GET (filtered list), POST (201 + raw key), DELETE (204 / 404).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/settings", () => ({
  getAllSettings: vi.fn(async () => ({})),
  getSetting: vi.fn(async () => undefined),
  upsertSetting: vi.fn(async () => undefined),
  deleteSetting: vi.fn(async () => true),
}));

const { getAllSettings, upsertSetting, deleteSetting } = await import(
  "$server/db/queries/settings"
);
const { GET, POST, DELETE } = await import(
  "../routes/api/settings/developer/api-keys/+server"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: "GET" | "POST" | "DELETE";
}) {
  const method = opts.method ?? "GET";
  const init: RequestInit = { method };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "content-type": "application/json" };
  }
  return {
    url: new URL("http://localhost/api/settings/developer/api-keys"),
    locals: opts.locals ?? {},
    request: new Request(
      "http://localhost/api/settings/developer/api-keys",
      init,
    ),
  } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "member" } };
const adminUser = { user: { id: "a1", email: "a@x", name: "a", role: "admin" } };

async function expectThrown(
  fn: () => Promise<Response> | Response,
  status: number,
): Promise<Response> {
  let res: Response | undefined;
  try {
    res = await fn();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    res = thrown as Response;
  }
  expect(res!.status).toBe(status);
  return res!;
}

describe("GET /api/settings/developer/api-keys", () => {
  beforeEach(() => vi.mocked(getAllSettings).mockReset());

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => GET(makeEvent({})), 401);
  });

  test("rejects 403 when API-key lacks 'read' scope", async () => {
    const res = await GET(
      makeEvent({ locals: { ...authedUser, apiKeyScopes: ["chat"] } }),
    );
    expect(res.status).toBe(403);
  });

  test("returns filtered keys for caller's prefix only", async () => {
    vi.mocked(getAllSettings).mockResolvedValue({
      "apikey:u1:key-a": { name: "A", scopes: ["read"], createdAt: 1, hash: "h" },
      "apikey:u1:key-b": { name: "B", scopes: ["chat"], createdAt: 2, hash: "h" },
      "apikey:u2:other": { name: "X", scopes: ["read"], createdAt: 3, hash: "h" },
      "ui:theme": "dark",
    } as any);
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys?: { keyId: string; name: string; scopes: string[] }[];
    };
    expect(body.keys).toHaveLength(2);
    const ids = body.keys!.map((k) => k.keyId).sort();
    expect(ids).toEqual(["key-a", "key-b"]);
    // Raw hash must not be disclosed
    for (const k of body.keys!) {
      expect(k).not.toHaveProperty("hash");
    }
  });
});

describe("POST /api/settings/developer/api-keys", () => {
  beforeEach(() => vi.mocked(upsertSetting).mockClear());

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(
      () => POST(makeEvent({ method: "POST", body: { name: "n", scopes: ["read"] } })),
      401,
    );
  });

  test("rejects 403 when API-key lacks 'admin' scope", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { ...authedUser, apiKeyScopes: ["read"] },
        body: { name: "n", scopes: ["read"] },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("rejects 400 when name is missing", async () => {
    const res = await POST(
      makeEvent({ method: "POST", locals: authedUser, body: { scopes: ["read"] } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("rejects 400 when scopes is empty", async () => {
    const res = await POST(
      makeEvent({ method: "POST", locals: authedUser, body: { name: "n", scopes: [] } }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects 400 when scopes contains an unknown scope", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: authedUser,
        body: { name: "n", scopes: ["superuser"] },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 201 with raw key + keyId on success", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: authedUser,
        body: { name: "ci", scopes: ["read", "chat"] },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      key?: string;
      keyId?: string;
      name?: string;
      scopes?: string[];
    };
    expect(body.key!).toMatch(/^ezk_/);
    expect(typeof body.keyId).toBe("string");
    expect(body.name).toBe("ci");
    expect(body.scopes).toEqual(["read", "chat"]);
    // Dual-write: canonical per-user row + hash-index pointer (FINDING C).
    expect(upsertSetting).toHaveBeenCalledTimes(2);
  });

  // FINDING B: scope ceiling enforced at the HTTP boundary.
  test("rejects 403 when a non-admin self-mints an admin-scoped key", async () => {
    vi.mocked(upsertSetting).mockClear();
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: authedUser, // role: "member"
        body: { name: "evil", scopes: ["read", "admin"] },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Cannot mint scope(s) you lack: admin");
    // Nothing minted — the ceiling check runs before mintApiKeyForUser.
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  test("allows an admin to self-mint an admin-scoped key (201)", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: { name: "admin-key", scopes: ["read", "admin"] },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scopes?: string[] };
    expect(body.scopes).toEqual(["read", "admin"]);
  });

  test("allows a non-admin to mint a non-privileged key (201)", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: authedUser,
        body: { name: "ok", scopes: ["read", "chat", "extensions"] },
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe("DELETE /api/settings/developer/api-keys", () => {
  beforeEach(() => vi.mocked(deleteSetting).mockReset());

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(
      () =>
        DELETE(
          makeEvent({
            method: "DELETE",
            body: { keyId: "00000000-0000-0000-0000-000000000000" },
          }),
        ),
      401,
    );
  });

  test("rejects 403 when API-key lacks 'admin' scope", async () => {
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: { ...authedUser, apiKeyScopes: ["read"] },
        body: { keyId: "00000000-0000-0000-0000-000000000000" },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("rejects 400 when keyId is not a UUID", async () => {
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: authedUser,
        body: { keyId: "not-a-uuid" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 404 when deleteSetting reports no row", async () => {
    vi.mocked(deleteSetting).mockResolvedValue(false as any);
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: authedUser,
        body: { keyId: "00000000-0000-0000-0000-000000000000" },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Key not found");
  });

  test("returns 204 on successful delete", async () => {
    vi.mocked(deleteSetting).mockResolvedValue(true as any);
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: authedUser,
        body: { keyId: "00000000-0000-0000-0000-000000000000" },
      }),
    );
    expect(res.status).toBe(204);
  });
});
