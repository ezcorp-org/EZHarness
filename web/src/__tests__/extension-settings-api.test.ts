/**
 * GET    /api/extensions/[id]/settings
 * PUT    /api/extensions/[id]/settings/user     (session)
 * DELETE /api/extensions/[id]/settings/user     (session)
 *
 * Boundary tests for the per-extension settings surface. Mocks the
 * auth middleware, the extension lookup, the settings query module,
 * and the audit log so the route's own logic is the only thing under
 * test.
 */

import { test, expect, describe, beforeEach, mock } from "bun:test";

let mockUser: { id: string; role: string } | null = {
  id: "user-1",
  email: "u@u.com",
  name: "U",
  role: "member",
} as never;

mock.module("$server/auth/middleware", () => ({
  requireAuth: () => {
    if (!mockUser) {
      throw new Response(JSON.stringify({ error: "auth" }), { status: 401 });
    }
    return mockUser;
  },
}));

mock.module("$lib/server/http-errors", () => ({
  errorJson: (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
}));

const SETTINGS_SCHEMA = {
  voice: {
    type: "select",
    label: "Voice",
    options: [
      { value: "af_bella", label: "Bella" },
      { value: "am_adam", label: "Adam" },
    ],
    default: "af_bella",
  },
  speed: {
    type: "number",
    label: "Speed",
    min: 0.5,
    max: 2.0,
    default: 1.0,
  },
};

let mockExt:
  | { id: string; manifest: { settings?: unknown } | null }
  | null = null;
const mockGetExtension = mock(async (_id: string) => mockExt);
mock.module("$server/db/queries/extensions", () => ({
  getExtension: mockGetExtension,
}));

let mockUserValues: Record<string, unknown> = {};
let mockResolved: Record<string, unknown> = {};

const mockSetUser = mock(
  async (_userId: string, _extensionId: string, values: Record<string, unknown>) => {
    mockUserValues = { ...values };
  },
);
const mockClearUser = mock(async (_userId: string, _extensionId: string) => {
  mockUserValues = {};
});

mock.module("$server/db/queries/extension-settings", () => ({
  getDeclaredDefaults: (schema: Record<string, { default?: unknown }> | undefined) => {
    if (!schema) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema)) {
      if (v.default !== undefined) out[k] = v.default;
    }
    return out;
  },
  getUserSettings: async (_userId: string, _extensionId: string) => mockUserValues,
  setUserSettings: mockSetUser,
  clearUserSettings: mockClearUser,
  resolveExtensionSettings: async (_extensionId: string, _userId: string | null) =>
    mockResolved,
}));

const mockAudit = mock(async (..._args: unknown[]) => {});
mock.module("$server/db/queries/audit-log", () => ({
  insertAuditEntry: mockAudit,
}));

// §5.2 — the route delegates held-capability resolution to the search
// policy module. Mock it so the route's projection is the only thing
// under test (the resolver itself is covered by search-policy.test.ts).
let mockCapabilities: unknown[] = [];
const mockGetHeldCapabilities = mock(async (_granted: unknown) => mockCapabilities);
mock.module("$server/search/policy", () => ({
  getHeldCapabilities: mockGetHeldCapabilities,
}));

const settingsRoute = await import(
  "../routes/api/extensions/[id]/settings/+server"
);
const userRoute = await import(
  "../routes/api/extensions/[id]/settings/user/+server"
);

interface RequestEventLike {
  request: Request;
  locals: Record<string, unknown>;
  params: { id: string };
}

async function call(
  handler: (e: never) => unknown,
  event: RequestEventLike,
): Promise<Response> {
  try {
    return (await handler(event as never)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

function makeEvent(
  method: string,
  body: unknown,
  id = "ext-1",
): RequestEventLike {
  return {
    request: new Request(`http://localhost/api/extensions/${id}/settings`, {
      method,
      headers: { "Content-Type": "application/json" },
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    }),
    locals: { user: mockUser },
    params: { id },
  };
}

describe("extension settings API", () => {
  beforeEach(() => {
    mockUser = {
      id: "user-1",
      email: "u@u.com",
      name: "U",
      role: "member",
    } as never;
    mockExt = {
      id: "ext-1",
      manifest: { settings: SETTINGS_SCHEMA },
    };
    mockUserValues = {};
    mockResolved = { voice: "af_bella", speed: 1.0 };
    mockGetExtension.mockClear();
    mockSetUser.mockClear();
    mockClearUser.mockClear();
    mockAudit.mockClear();
    mockCapabilities = [];
    mockGetHeldCapabilities.mockClear();
    // Default ext carries an (empty) grant so the route passes it through.
    (mockExt as { grantedPermissions?: unknown }).grantedPermissions = { grantedAt: {} };
  });

  describe("auth gate (logged-out 401 on all 3 routes)", () => {
    test("GET /settings → 401 when caller has no session", async () => {
      mockUser = null;
      const res = await call(settingsRoute.GET, makeEvent("GET", undefined));
      expect(res.status).toBe(401);
      expect(mockGetExtension).not.toHaveBeenCalled();
    });

    test("PUT /settings/user → 401 when caller has no session", async () => {
      mockUser = null;
      const res = await call(
        userRoute.PUT,
        makeEvent("PUT", { values: { voice: "am_adam" } }),
      );
      expect(res.status).toBe(401);
      expect(mockGetExtension).not.toHaveBeenCalled();
      expect(mockSetUser).not.toHaveBeenCalled();
    });

    test("DELETE /settings/user → 401 when caller has no session", async () => {
      mockUser = null;
      const res = await call(userRoute.DELETE, makeEvent("DELETE", undefined));
      expect(res.status).toBe(401);
      expect(mockGetExtension).not.toHaveBeenCalled();
      expect(mockClearUser).not.toHaveBeenCalled();
    });
  });

  describe("GET /settings", () => {
    test("404 when extension not found", async () => {
      mockExt = null;
      const res = await call(settingsRoute.GET, makeEvent("GET", undefined));
      expect(res.status).toBe(404);
    });

    test("schema=null + empty objects when manifest has no settings", async () => {
      mockExt = { id: "ext-1", manifest: { settings: undefined } };
      const res = await call(settingsRoute.GET, makeEvent("GET", undefined));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        schema: null,
        declaredDefaults: {},
        userValues: {},
        resolved: {},
        capabilities: [],
      });
    });

    test("returns full payload when settings declared", async () => {
      mockUserValues = { speed: 1.5 };
      mockResolved = { voice: "af_bella", speed: 1.5 };

      const res = await call(settingsRoute.GET, makeEvent("GET", undefined));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schema).toEqual(SETTINGS_SCHEMA);
      expect(body.declaredDefaults).toEqual({ voice: "af_bella", speed: 1.0 });
      expect(body.userValues).toEqual({ speed: 1.5 });
      expect(body.resolved).toEqual({ voice: "af_bella", speed: 1.5 });
    });

    test("manifest === null is treated as no settings", async () => {
      mockExt = { id: "ext-1", manifest: null };
      const res = await call(settingsRoute.GET, makeEvent("GET", undefined));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schema).toBeNull();
    });

    test("manifest === {} (no settings key) → schema:null", async () => {
      mockExt = { id: "ext-1", manifest: {} as never };
      const res = await call(settingsRoute.GET, makeEvent("GET", undefined));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schema).toBeNull();
      expect(body.declaredDefaults).toEqual({});
      expect(body.userValues).toEqual({});
      expect(body.resolved).toEqual({});
    });

    test("manifest.settings === {} (declared but empty) → schema:{} (NOT null)", async () => {
      mockExt = { id: "ext-1", manifest: { settings: {} } as never };
      const res = await call(settingsRoute.GET, makeEvent("GET", undefined));
      expect(res.status).toBe(200);
      const body = await res.json();
      // Empty-but-declared schema is currently treated as falsy by the
      // route (truthy guard `!schema` short-circuits on `{}`-coerced
      // checks of `manifest?.settings`). The actual JS behavior: `{}`
      // is truthy, so the guard `if (!schema)` does NOT trigger and we
      // hit the resolver path — schema is returned as `{}`.
      expect(body.schema).toEqual({});
    });
  });

  // §5.2 — host-capability schemas + effective policy ride alongside the
  // per-user settings payload. The route delegates to getHeldCapabilities
  // (mocked) and surfaces whatever it returns, passing the ext's grant.
  describe("GET /settings — capabilities (§5.2)", () => {
    const SEARCH_CAP = {
      cap: "search",
      schema: [
        { key: "providers", field: { type: "select", label: "Allowed providers", options: [], default: "inherit" } },
        { key: "quota", field: { type: "number", label: "Daily quota", default: 100 } },
      ],
      effective: { denied: false, quota: 100, maxResults: 5, providers: "all" },
      grant: "inherit",
    };

    test("returns capabilities for a held capability (alongside per-user settings)", async () => {
      mockCapabilities = [SEARCH_CAP];
      const res = await call(settingsRoute.GET, makeEvent("GET", undefined));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.capabilities).toEqual([SEARCH_CAP]);
      // Per-user settings are unaffected — still returned.
      expect(body.schema).toEqual(SETTINGS_SCHEMA);
    });

    test("omits (empty array) when the extension holds no host capability", async () => {
      mockCapabilities = [];
      const res = await call(settingsRoute.GET, makeEvent("GET", undefined));
      const body = await res.json();
      expect(body.capabilities).toEqual([]);
    });

    test("capabilities ride along even when the manifest declares no per-user settings", async () => {
      mockExt = {
        id: "ext-1",
        manifest: { settings: undefined },
      } as never;
      (mockExt as { grantedPermissions?: unknown }).grantedPermissions = { grantedAt: {}, search: "inherit" };
      mockCapabilities = [SEARCH_CAP];
      const res = await call(settingsRoute.GET, makeEvent("GET", undefined));
      const body = await res.json();
      expect(body.schema).toBeNull();
      expect(body.capabilities).toEqual([SEARCH_CAP]);
    });

    test("passes the ext's grantedPermissions to the resolver", async () => {
      const grant = { grantedAt: {}, search: { quota: 500 } };
      (mockExt as { grantedPermissions?: unknown }).grantedPermissions = grant;
      mockCapabilities = [];
      await call(settingsRoute.GET, makeEvent("GET", undefined));
      expect(mockGetHeldCapabilities).toHaveBeenCalledWith(grant);
    });
  });

  describe("PUT /settings/user", () => {
    test("session user persists their own settings", async () => {
      const res = await call(userRoute.PUT, makeEvent("PUT", { values: { voice: "am_adam" } }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.userValues).toEqual({ voice: "am_adam" });

      expect(mockSetUser).toHaveBeenCalledTimes(1);
      const args = mockSetUser.mock.calls[0]!;
      expect(args[0]).toBe("user-1");
      expect(args[1]).toBe("ext-1");
      expect(args[2]).toEqual({ voice: "am_adam" });
    });

    test("404 when extension not found", async () => {
      mockExt = null;
      const res = await call(userRoute.PUT, makeEvent("PUT", { values: { voice: "am_adam" } }));
      expect(res.status).toBe(404);
    });

    test("409 when extension has no settings schema", async () => {
      mockExt = { id: "ext-1", manifest: { settings: undefined } };
      const res = await call(userRoute.PUT, makeEvent("PUT", { values: { voice: "am_adam" } }));
      expect(res.status).toBe(409);
      expect(mockSetUser).not.toHaveBeenCalled();
    });

    test("409 when manifest === {} (no settings key)", async () => {
      mockExt = { id: "ext-1", manifest: {} as never };
      const res = await call(userRoute.PUT, makeEvent("PUT", { values: { voice: "am_adam" } }));
      expect(res.status).toBe(409);
      expect(mockSetUser).not.toHaveBeenCalled();
    });

    test("manifest.settings === {} → PUT current behavior (declared empty schema)", async () => {
      // FINDING: an empty-but-declared schema (`settings: {}`) bypasses
      // the `if (!manifest?.settings)` 409 guard because `{}` is truthy.
      // The route accepts the PUT and clamping drops every field
      // (no schema entries to validate against), so the persisted blob
      // ends up `{}`. Worth flagging as inconsistent with the GET path
      // and with the spec brief's expectation of "PUT returns 409".
      mockExt = { id: "ext-1", manifest: { settings: {} } as never };
      const res = await call(userRoute.PUT, makeEvent("PUT", { values: { voice: "am_adam" } }));
      // Pin the *current* behavior so any future fix to the route
      // surfaces here as a deliberate update.
      expect(res.status).toBe(200);
    });

    test("PUT writes ext:settings.user.update audit row", async () => {
      // Pre-existing user values become the `before` snapshot.
      mockUserValues = { voice: "af_bella" };
      await call(userRoute.PUT, makeEvent("PUT", { values: { voice: "am_adam" } }));

      expect(mockAudit).toHaveBeenCalledTimes(1);
      const args = mockAudit.mock.calls[0]!;
      expect(args[0]).toBe("user-1");
      expect(args[1]).toBe("ext:settings.user.update");
      expect(args[2]).toBe("ext-1");
      const meta = args[3] as Record<string, unknown>;
      expect(meta.permission).toBe("settings.user");
      expect(meta.actor).toBe("user-1");
      expect(meta.before).toEqual({ voice: "af_bella" });
      expect(meta.after).toEqual({ voice: "am_adam" });
      expect(meta.submitted).toEqual({ voice: "am_adam" });
    });

    test("400 when values missing or not an object", async () => {
      const a = await call(userRoute.PUT, makeEvent("PUT", { other: "x" }));
      expect(a.status).toBe(400);
      const b = await call(
        userRoute.PUT,
        makeEvent("PUT", { values: "string" }),
      );
      expect(b.status).toBe(400);
      const c = await call(userRoute.PUT, makeEvent("PUT", "not-json"));
      expect(c.status).toBe(400);
    });

    test("400 on malformed body edge cases", async () => {
      // null body — looseObject rejects non-object root.
      const nullRes = await call(userRoute.PUT, makeEvent("PUT", null));
      expect(nullRes.status).toBe(400);

      // [] body — array isn't a plain object.
      const arrRes = await call(userRoute.PUT, makeEvent("PUT", []));
      expect(arrRes.status).toBe(400);

      // 42 body — number isn't an object.
      const numRes = await call(userRoute.PUT, makeEvent("PUT", 42));
      expect(numRes.status).toBe(400);

      // {values: null} — explicit null fails the "object" guard.
      const nullValsRes = await call(
        userRoute.PUT,
        makeEvent("PUT", { values: null }),
      );
      expect(nullValsRes.status).toBe(400);

      // {values: []} — array fails the explicit Array.isArray guard.
      const arrValsRes = await call(
        userRoute.PUT,
        makeEvent("PUT", { values: [] }),
      );
      expect(arrValsRes.status).toBe(400);
      expect(mockSetUser).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /settings/user", () => {
    test("clears the row, returns ok", async () => {
      mockUserValues = { voice: "am_adam" };
      const res = await call(userRoute.DELETE, makeEvent("DELETE", undefined));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(mockClearUser).toHaveBeenCalledTimes(1);
      expect(mockClearUser.mock.calls[0]).toEqual(["user-1", "ext-1"]);
    });

    test("404 when extension not found", async () => {
      mockExt = null;
      const res = await call(userRoute.DELETE, makeEvent("DELETE", undefined));
      expect(res.status).toBe(404);
      expect(mockClearUser).not.toHaveBeenCalled();
    });

    test("409 when extension has no settings schema (PUT parity)", async () => {
      mockExt = { id: "ext-1", manifest: { settings: undefined } };
      const res = await call(userRoute.DELETE, makeEvent("DELETE", undefined));
      expect(res.status).toBe(409);
      expect(mockClearUser).not.toHaveBeenCalled();
    });

    test("DELETE writes ext:settings.user.reset audit row", async () => {
      mockUserValues = { voice: "am_adam", speed: 1.5 };
      await call(userRoute.DELETE, makeEvent("DELETE", undefined));

      expect(mockAudit).toHaveBeenCalledTimes(1);
      const args = mockAudit.mock.calls[0]!;
      expect(args[0]).toBe("user-1");
      expect(args[1]).toBe("ext:settings.user.reset");
      expect(args[2]).toBe("ext-1");
      const meta = args[3] as Record<string, unknown>;
      expect(meta.permission).toBe("settings.user");
      expect(meta.actor).toBe("user-1");
      expect(meta.before).toEqual({ voice: "am_adam", speed: 1.5 });
    });
  });
});
