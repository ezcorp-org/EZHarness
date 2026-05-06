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
