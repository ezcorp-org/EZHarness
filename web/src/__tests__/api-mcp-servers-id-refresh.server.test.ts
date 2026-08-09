/**
 * Server-handler unit tests for /api/mcp-servers/[id]/refresh (+server.ts).
 *
 * Covers the auth gates, the missing-id pre-check that runs before any
 * registry call, and both terminal paths of the try/catch around
 * `refreshMcpTools` (200 + fresh tool list on success, 502 on failure).
 * The registry singleton is mocked so no MCP subprocess is launched.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectDenied } from "./fixtures/expect-denied";

const refreshMcpTools = vi.fn();
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ refreshMcpTools }),
  },
}));

const { POST } = await import("../routes/api/mcp-servers/[id]/refresh/+server");

function makeEvent(opts: { locals?: Record<string, unknown>; params?: { id?: string } }) {
  return {
    url: new URL("http://localhost/api/mcp-servers/x/refresh"),
    locals: opts.locals ?? {},
    params: opts.params ?? { id: "x" },
  } as any;
}

const adminUser = { user: { id: "u1", email: "u@x", name: "u", role: "admin" } };

describe("POST /api/mcp-servers/[id]/refresh", () => {
  beforeEach(() => {
    refreshMcpTools.mockReset();
  });

  // 403, not 401: this route's gate is now the role-only `requireAdmin`,
  // which RETURNS its denial (requireRole THREW one, so the caller actually
  // got a 500). requireAdmin answers "not an admin principal" uniformly — a
  // missing principal is not an admin either. Unreachable in production
  // regardless: hooks.server.ts 401s unauthenticated /api/* before the handler.
  test("rejects unauthenticated callers with 403", async () => {
    const res = await expectDenied(() => POST(makeEvent({})), 403);
    expect(res.status).toBe(403);
  });

  test("rejects non-admin authenticated user with 403", async () => {
    const res = await expectDenied(
      () =>
        POST(
          makeEvent({
            locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
          }),
        ),
      403,
    );
    expect(res.status).toBe(403);
  });

  test("returns 400 when id param is empty", async () => {
    const res = await POST(makeEvent({ locals: adminUser, params: { id: "" } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("id required");
  });

  test("returns 400 when id param is missing", async () => {
    const res = await POST(makeEvent({ locals: adminUser, params: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("id required");
  });

  test("returns 200 with fresh tool list on success", async () => {
    const tools = [
      { name: "echo", description: "echo a string" },
      { name: "add", description: "add two numbers" },
    ];
    refreshMcpTools.mockResolvedValueOnce(tools);
    const res = await POST(makeEvent({ locals: adminUser, params: { id: "ext-42" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string; tools?: unknown[] };
    expect(body.id).toBe("ext-42");
    expect(body.tools).toEqual(tools);
    expect(refreshMcpTools).toHaveBeenCalledWith("ext-42");
  });

  test("returns 502 when refreshMcpTools throws an Error", async () => {
    refreshMcpTools.mockRejectedValueOnce(new Error("mcp subprocess died"));
    const res = await POST(makeEvent({ locals: adminUser, params: { id: "ext-42" } }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("mcp subprocess died");
  });

  test("returns 502 with generic message when refreshMcpTools throws a non-Error", async () => {
    refreshMcpTools.mockRejectedValueOnce("pipe closed");
    const res = await POST(makeEvent({ locals: adminUser, params: { id: "ext-42" } }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Refresh failed");
  });
});
