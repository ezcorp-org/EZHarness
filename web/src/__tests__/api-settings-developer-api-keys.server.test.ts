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
import { expectThrownResponse as expectThrown, makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/db/queries/settings", () => ({
  getAllSettings: vi.fn(async () => ({})),
  getSetting: vi.fn(async () => undefined),
  upsertSetting: vi.fn(async () => undefined),
  deleteSetting: vi.fn(async () => true),
}));
// `toolPolicy.lockedModeId` is validated against the modes the KEY OWNER can
// see, so the mint route reads the modes table. `MODE_OK` is the one visible
// mode; every other id resolves to null (the fail-closed answer).
const MODE_OK = "11111111-1111-4111-8111-111111111111";
vi.mock("$server/db/queries/modes", () => ({
  getVisibleMode: vi.fn(async (id: string) => (id === MODE_OK ? { id } : null)),
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
  return makeRequestEvent("http://localhost/api/settings/developer/api-keys", {
    locals: opts.locals ?? {},
    request: init,
  });
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "member" } };
const adminUser = { user: { id: "a1", email: "a@x", name: "a", role: "admin" } };

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

  // ── Role axis + anti-escalation ─────────────────────────────────────
  test("defaults a minted key to role member (201)", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: { name: "default-role", scopes: ["read"] },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { role?: string };
    expect(body.role).toBe("member");
  });

  test("an admin ACTOR may mint an admin-role key (201, role echoed)", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: { name: "admin-role", scopes: ["read"], role: "admin" },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { role?: string };
    expect(body.role).toBe("admin");
  });

  // The core anti-escalation case: a MEMBER-role key that holds the admin
  // SCOPE (enough to reach this route) must NOT be able to mint itself an
  // admin-ROLE key. Scope is fine, role is refused.
  test("rejects an admin-role mint by a member-role key with admin scope (403, nothing minted)", async () => {
    vi.mocked(upsertSetting).mockClear();
    const res = await POST(
      makeEvent({
        method: "POST",
        // member ROLE principal, but carries the admin SCOPE.
        locals: { ...authedUser, apiKeyScopes: ["admin"] },
        body: { name: "escalate", scopes: ["read"], role: "admin" },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("requires admin role");
    // Refused BEFORE the mint — no settings written.
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  test("the same member-role key MAY still mint a member-role key (201, unchanged posture)", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { ...authedUser, apiKeyScopes: ["admin"] },
        body: { name: "member-ok", scopes: ["read"], role: "member" },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { role?: string };
    expect(body.role).toBe("member");
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

// ── Per-API-key TOOL POLICY (mint) ──────────────────────────────────────
//
// Four checks run in a fixed order — `scopesOverCeiling` → `canMintRole` →
// `policyOverCeiling` → `validateToolPolicy` — and the order is the contract:
// what the ACTOR may hand out is decided before whether the request is
// intrinsically well-formed, so a member can never learn from a 400 that its
// policy would otherwise have been legal.
describe("POST … api-keys — toolPolicy", () => {
  const BUNDLE = [
    "POST /api/conversations",
    "PUT /api/conversations/[id]",
    "GET /api/conversations/[id]",
    "POST /api/conversations/[id]/messages",
    "PUT /api/conversations/[id]/caller-tools",
    "GET /api/conversations/[id]/caller-tools",
    "DELETE /api/conversations/[id]/caller-tools",
    "POST /api/conversations/[id]/tool-results",
    "GET /api/conversations/[id]/active-run",
    "POST /api/tool-calls/[id]/permission",
    "GET /api/runtime-events",
    "GET /api/runs/[id]",
    "GET /api/tools",
    "GET /api/modes",
  ];

  /** An ADMIN-SCOPED, POLICIED acting key: unusual but valid, and the only
   *  configuration in which the `policyOverCeiling` branch is reachable —
   *  this route is admin-scoped, so the common actor is an unpolicied admin. */
  const policiedAdmin = {
    ...adminUser,
    apiKeyScopes: ["admin"],
    apiKeyToolPolicy: {
      routeAllowlist: ["GET /api/tools", "GET /api/modes"],
      allowedCallerTools: ["open_app"],
      maxCallerTools: 2,
      lockedModeId: MODE_OK,
    },
  };

  beforeEach(() => vi.mocked(upsertSetting).mockClear());

  test("an UNPOLICIED admin mints a policied key from a bundle NAME (201)", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: {
          name: "companion",
          scopes: ["read", "write", "chat"],
          toolPolicy: {
            routeBundle: "desktop-companion",
            allowedCallerTools: ["open_app"],
            maxCallerTools: 1,
            lockedModeId: MODE_OK,
          },
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { toolPolicy?: Record<string, unknown> };
    // The bundle NAME is expanded and never stored: a stored name would
    // silently change meaning the day the bundle is edited.
    expect(body.toolPolicy).toEqual({
      routeAllowlist: BUNDLE,
      allowedCallerTools: ["open_app"],
      maxCallerTools: 1,
      lockedModeId: MODE_OK,
    });
    expect(body.toolPolicy).not.toHaveProperty("routeBundle");
    // …and it is what was persisted on the canonical row.
    const [, entry] = vi.mocked(upsertSetting).mock.calls[0]!;
    expect((entry as { toolPolicy?: unknown }).toolPolicy).toEqual(body.toolPolicy);
  });

  test("an unpolicied key's stored row carries NO toolPolicy field at all", async () => {
    const res = await POST(
      makeEvent({ method: "POST", locals: adminUser, body: { name: "plain", scopes: ["read"] } }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty("toolPolicy");
    const [, entry] = vi.mocked(upsertSetting).mock.calls[0]!;
    expect(Object.keys(entry as object)).not.toContain("toolPolicy");
  });

  test("routeBundle and routeAllowlist together is a 400", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: {
          name: "n",
          scopes: ["read"],
          toolPolicy: { routeBundle: "desktop-companion", routeAllowlist: ["GET /api/tools"] },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Specify routeBundle or routeAllowlist, not both");
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  test("an unknown routeBundle is a 400 that lists the known names", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: { name: "n", scopes: ["read"], toolPolicy: { routeBundle: "nope" } },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("desktop-companion");
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  test("a raw routeAllowlist naming an unregistered route is a 400, not a silent deny", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: {
          name: "n",
          scopes: ["read"],
          toolPolicy: { routeAllowlist: ["GET /api/conversations/[idd]"] },
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; details?: string[] };
    expect(body.error).toBe("Invalid toolPolicy");
    expect(body.details![0]).toContain("is not a registered route");
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  test("a lockedModeId the OWNER cannot see is a 400", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: adminUser,
        body: {
          name: "n",
          scopes: ["read"],
          toolPolicy: { lockedModeId: "22222222-2222-4222-8222-222222222222" },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).details![0]).toContain("not a mode visible to the key owner");
  });

  test("an empty toolPolicy is a 400 (policied but confining nothing)", async () => {
    const res = await POST(
      makeEvent({ method: "POST", locals: adminUser, body: { name: "n", scopes: ["read"], toolPolicy: {} } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual(["toolPolicy must constrain at least one field"]);
  });

  test("a POLICIED actor cannot mint an UNPOLICIED key — every field is named", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: policiedAdmin,
        body: { name: "escape", scopes: ["read"] },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Cannot mint a key that widens your own policy");
    for (const f of ["routeAllowlist", "allowedCallerTools", "maxCallerTools", "lockedModeId"]) {
      expect(body.error).toContain(f);
    }
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  test("a POLICIED actor cannot widen one field either", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: policiedAdmin,
        body: {
          name: "wider",
          scopes: ["read"],
          toolPolicy: {
            routeAllowlist: ["GET /api/tools", "GET /api/modes", "GET /api/runs/[id]"],
            allowedCallerTools: ["open_app"],
            maxCallerTools: 2,
            lockedModeId: MODE_OK,
          },
        },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("routeAllowlist");
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  test("a POLICIED actor CAN mint an equal-or-narrower key (201)", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: policiedAdmin,
        body: {
          name: "narrower",
          scopes: ["read"],
          toolPolicy: {
            routeAllowlist: ["GET /api/tools"],
            allowedCallerTools: ["open_app"],
            maxCallerTools: 1,
            lockedModeId: MODE_OK,
          },
        },
      }),
    );
    expect(res.status).toBe(201);
  });

  test("the ceiling is checked BEFORE validity — a widening request never reaches validateToolPolicy", async () => {
    // Both would fail: the policy widens AND names an unregistered route. The
    // 403 (not the 400) is what pins the order.
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: policiedAdmin,
        body: {
          name: "both-wrong",
          scopes: ["read"],
          toolPolicy: { routeAllowlist: ["GET /api/nope"], maxCallerTools: 99 },
        },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("the SCOPE ceiling still outranks the policy ceiling", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { ...authedUser, apiKeyScopes: ["admin"], apiKeyToolPolicy: { maxCallerTools: 1 } },
        body: { name: "n", scopes: ["admin"] },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("Cannot mint scope(s) you lack: admin");
  });
});
