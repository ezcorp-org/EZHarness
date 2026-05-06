/**
 * GET    /api/extensions/[id]/settings
 * PUT    /api/extensions/[id]/settings/global   (admin)
 * PUT    /api/extensions/[id]/settings/user     (session)
 * DELETE /api/extensions/[id]/settings/user     (session)
 *
 * Boundary tests for the lazy-foraging-hammock per-extension settings
 * surface. Mocks the auth middleware, the extension lookup, the
 * settings query module, and the audit log so the route's own logic
 * is the only thing under test.
 *
 * Mirrors the pattern in extensions-events-route.test.ts.
 */

import { test, expect, describe, beforeEach, mock } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────────────

let mockUser: { id: string; role: string } | null = {
  id: "user-1",
  email: "u@u.com",
  name: "U",
  role: "admin",
} as never;

mock.module("$server/auth/middleware", () => ({
  requireAuth: () => {
    if (!mockUser) {
      throw new Response(JSON.stringify({ error: "auth" }), { status: 401 });
    }
    return mockUser;
  },
  requireRole: (_locals: unknown, role: "admin") => {
    if (!mockUser) {
      throw new Response(JSON.stringify({ error: "auth" }), { status: 401 });
    }
    if (mockUser.role !== role) {
      throw new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
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

let mockGlobalValues: Record<string, unknown> = {};
let mockUserValues: Record<string, unknown> = {};
let mockResolved: Record<string, unknown> = {};

const mockSetGlobal = mock(
  async (_extensionId: string, values: Record<string, unknown>, _actor: string | null) => {
    mockGlobalValues = { ...values };
  },
);
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
  getGlobalSettings: async (_extensionId: string) => mockGlobalValues,
  setGlobalSettings: mockSetGlobal,
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

// ── Imports AFTER mocks ────────────────────────────────────────────

const settingsRoute = await import(
  "../routes/api/extensions/[id]/settings/+server"
);
const globalRoute = await import(
  "../routes/api/extensions/[id]/settings/global/+server"
);
const userRoute = await import(
  "../routes/api/extensions/[id]/settings/user/+server"
);

// ── Helpers ────────────────────────────────────────────────────────

interface RequestEventLike {
  request: Request;
  locals: Record<string, unknown>;
  params: { id: string };
}

/** Invoke a route handler and unwrap thrown `Response`s (requireAuth /
 *  requireRole throw, SvelteKit catches them in production). */
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

// ── Tests ──────────────────────────────────────────────────────────

describe("extension settings API", () => {
  beforeEach(() => {
    mockUser = {
      id: "user-1",
      email: "u@u.com",
      name: "U",
      role: "admin",
    } as never;
    mockExt = {
      id: "ext-1",
      manifest: { settings: SETTINGS_SCHEMA },
    };
    mockGlobalValues = {};
    mockUserValues = {};
    mockResolved = { voice: "af_bella", speed: 1.0 };
    mockGetExtension.mockClear();
    mockSetGlobal.mockClear();
    mockSetUser.mockClear();
    mockClearUser.mockClear();
    mockAudit.mockClear();
  });

  // ── GET ────────────────────────────────────────────────────────

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
        globalValues: {},
        userValues: {},
        resolved: {},
      });
    });

    test("returns full payload when settings declared", async () => {
      mockGlobalValues = { voice: "am_adam" };
      mockUserValues = { speed: 1.5 };
      mockResolved = { voice: "am_adam", speed: 1.5 };

      const res = await call(settingsRoute.GET, makeEvent("GET", undefined));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schema).toEqual(SETTINGS_SCHEMA);
      expect(body.declaredDefaults).toEqual({ voice: "af_bella", speed: 1.0 });
      expect(body.globalValues).toEqual({ voice: "am_adam" });
      expect(body.userValues).toEqual({ speed: 1.5 });
      expect(body.resolved).toEqual({ voice: "am_adam", speed: 1.5 });
    });

    test("manifest === null is treated as no settings", async () => {
      mockExt = { id: "ext-1", manifest: null };
      const res = await call(settingsRoute.GET, makeEvent("GET", undefined));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schema).toBeNull();
    });
  });

  // ── PUT /global ───────────────────────────────────────────────

  describe("PUT /settings/global", () => {
    test("non-admin → 403", async () => {
      mockUser = { id: "user-1", role: "member" } as never;
      const res = await call(globalRoute.PUT, makeEvent("PUT", { values: { voice: "am_adam" } }));
      expect(res.status).toBe(403);
      expect(mockSetGlobal).not.toHaveBeenCalled();
    });

    test("404 when extension not found", async () => {
      mockExt = null;
      const res = await call(globalRoute.PUT, makeEvent("PUT", { values: { voice: "am_adam" } }));
      expect(res.status).toBe(404);
    });

    test("409 when extension has no settings schema", async () => {
      mockExt = { id: "ext-1", manifest: { settings: undefined } };
      const res = await call(globalRoute.PUT, makeEvent("PUT", { values: { voice: "am_adam" } }));
      expect(res.status).toBe(409);
      expect(mockSetGlobal).not.toHaveBeenCalled();
    });

    test("400 when body has no values key", async () => {
      const res = await call(globalRoute.PUT, makeEvent("PUT", { other: "x" }));
      expect(res.status).toBe(400);
    });

    test("400 when values is an array", async () => {
      const res = await call(globalRoute.PUT, makeEvent("PUT", { values: [1, 2, 3] }));
      expect(res.status).toBe(400);
    });

    test("400 when body is malformed JSON", async () => {
      const res = await call(globalRoute.PUT, makeEvent("PUT", "not-json"));
      expect(res.status).toBe(400);
    });

    test("admin happy path → persists, audits, returns 200 with globalValues", async () => {
      const res = await call(globalRoute.PUT, makeEvent("PUT", { values: { voice: "am_adam" } }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.globalValues).toEqual({ voice: "am_adam" });

      expect(mockSetGlobal).toHaveBeenCalledTimes(1);
      const args = mockSetGlobal.mock.calls[0]!;
      expect(args[0]).toBe("ext-1");
      expect(args[1]).toEqual({ voice: "am_adam" });
      expect(args[2]).toBe("user-1");

      // Audit row
      expect(mockAudit).toHaveBeenCalledTimes(1);
      const auditArgs = mockAudit.mock.calls[0] as [
        string,
        string,
        string,
        Record<string, unknown>,
      ];
      expect(auditArgs[0]).toBe("user-1");
      expect(auditArgs[1]).toBe("ext:settings.global.update");
      expect(auditArgs[2]).toBe("ext-1");
      expect(auditArgs[3].actor).toBe("user-1");
      expect(auditArgs[3].before).toEqual({}); // initial empty
      expect(auditArgs[3].after).toEqual({ voice: "am_adam" });
      expect(auditArgs[3].submitted).toEqual({ voice: "am_adam" });
    });
  });

  // ── PUT /user ──────────────────────────────────────────────────

  describe("PUT /settings/user", () => {
    test("session user with no admin role can persist their own settings", async () => {
      mockUser = { id: "user-1", role: "member" } as never;
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

    test("no user audit row written (per-user own-data is silent)", async () => {
      await call(userRoute.PUT, makeEvent("PUT", { values: { voice: "am_adam" } }));
      expect(mockAudit).not.toHaveBeenCalled();
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
  });

  // ── DELETE /user ───────────────────────────────────────────────

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
  });
});
