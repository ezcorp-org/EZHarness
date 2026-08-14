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
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const refreshMcpTools = vi.fn();
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ refreshMcpTools }),
  },
}));

// The 502 body is a constant now, so the real reason goes here instead.
const persistError = vi.fn(async (_opts: Record<string, unknown>) => {});
vi.mock("$server/db/queries/error-logs", () => ({ persistError }));

// The handler reads the PRE-refresh manifest to shape the audit row's `before`
// side. Mocked so the audit leg is deterministic instead of incidentally
// throwing on an uninitialized database.
const getExtension = vi.fn();
vi.mock("$server/db/queries/extensions", () => ({ getExtension }));
const insertAuditEntry = vi.fn(
  async (
    _userId: string | null,
    _action: string,
    _target: string,
    _metadata: unknown,
  ) => "audit-1",
);
vi.mock("$server/db/queries/audit-log", () => ({ insertAuditEntry }));

/** A stored `kind:"mcp"` row carrying `tools` as they were BEFORE the refresh. */
function storedRow(tools: Array<{ name: string; description: string }>) {
  return {
    id: "ext-42",
    name: "weather",
    manifest: {
      kind: "mcp",
      mcpServers: [{ transport: "http", name: "weather", url: "https://mcp.example.com/mcp" }],
      tools,
    },
  };
}

const { MCP_CONNECT_FAILED_MESSAGE } = await import("$server/mcp/connect-failure");
const { POST } = await import("../routes/api/mcp-servers/[id]/refresh/+server");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  params?: { id?: string };
}) {
  return makeRequestEvent("http://localhost/api/mcp-servers/x/refresh", {
    locals: opts.locals ?? {},
    params: opts.params ?? { id: "x" },
    request: null,
  });
}

const adminUser = { user: { id: "u1", email: "u@x", name: "u", role: "admin" } };

describe("POST /api/mcp-servers/[id]/refresh", () => {
  beforeEach(() => {
    refreshMcpTools.mockReset();
    getExtension.mockReset();
    getExtension.mockResolvedValue(storedRow([{ name: "old", description: "o" }]));
    insertAuditEntry.mockClear();
    // Cleared here rather than per-test: a call recorded by an earlier case
    // otherwise counts against a later "was never reported" assertion.
    persistError.mockClear();
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
    const res = await expectDenied(() => POST(
            makeEvent({
              locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
            }),
          ), 403);
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
    const res = await POST(
      makeEvent({ locals: adminUser, params: { id: "ext-42" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string; tools?: unknown[] };
    expect(body.id).toBe("ext-42");
    expect(body.tools).toEqual(tools);
    expect(refreshMcpTools).toHaveBeenCalledWith("ext-42");
  });

  test("returns 502 without echoing the underlying error", async () => {
    refreshMcpTools.mockRejectedValueOnce(new Error("mcp subprocess died"));
    const res = await POST(
      makeEvent({ locals: adminUser, params: { id: "ext-42" } }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    // Refresh re-connects to the STORED config, so it echoed the transport's
    // error for a target the caller chose at install time — the same oracle,
    // repeatable on demand without creating a new row.
    expect(body.error).toBe(MCP_CONNECT_FAILED_MESSAGE);
    expect(body.error).not.toContain("subprocess");
  });

  test("a thrown non-Error returns the same body", async () => {
    refreshMcpTools.mockRejectedValueOnce("pipe closed");
    const res = await POST(
      makeEvent({ locals: adminUser, params: { id: "ext-42" } }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(MCP_CONNECT_FAILED_MESSAGE);
  });

  test("an unknown id is indistinguishable from an unreachable target", async () => {
    // Both paths throw out of refreshMcpTools. If "not found" answered
    // differently, a caller could enumerate which extension ids exist.
    refreshMcpTools.mockRejectedValueOnce(new Error("Extension zzz not found in registry"));
    const unknown = await POST(makeEvent({ locals: adminUser, params: { id: "zzz" } }));

    refreshMcpTools.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:6379"));
    const unreachable = await POST(makeEvent({ locals: adminUser, params: { id: "ext-42" } }));

    expect(unknown.status).toBe(unreachable.status);
    expect(await unknown.text()).toBe(await unreachable.text());
  });

  test("the real reason is handed to the server-side sink", async () => {
    refreshMcpTools.mockRejectedValueOnce(new Error("mcp subprocess died"));
    await POST(makeEvent({ locals: adminUser, params: { id: "ext-42" } }));

    expect(persistError).toHaveBeenCalledTimes(1);
    const arg = persistError.mock.calls[0]![0] as {
      message: string;
      metadata: Record<string, unknown>;
    };
    expect(arg.message).toContain("mcp subprocess died");
    expect(arg.metadata.route).toBe("POST /api/mcp-servers/[id]/refresh");
    expect(arg.metadata.extension).toBe("ext-42");
  });

  test("the audit row diffs the PRE-refresh tools against the fresh ones", async () => {
    // `refreshMcpTools` writes the new manifest back, so the `before` side has
    // to be read first. Read it after and both sides would show the new list,
    // and every refresh would look like a no-op.
    refreshMcpTools.mockResolvedValueOnce([
      { name: "one", description: "1" },
      { name: "two", description: "2" },
    ]);
    const res = await POST(makeEvent({ locals: adminUser, params: { id: "ext-42" } }));

    expect(res.status).toBe(200);
    expect(insertAuditEntry).toHaveBeenCalledTimes(1);
    const meta = insertAuditEntry.mock.calls[0]![3] as {
      oldValue: { toolNames: string[] };
      newValue: { toolNames: string[] };
    };
    expect(meta.oldValue.toolNames).toEqual(["old"]);
    expect(meta.newValue.toolNames).toEqual(["one", "two"]);
  });

  test("a failing audit READ degrades the trail, not the refresh", async () => {
    // The pre-refresh read exists only to shape the audit row. Audit is
    // best-effort by contract, so a database problem here must not fail a
    // refresh that otherwise succeeded — and must not be reported to the
    // caller as an unreachable MCP server, which would blame the wrong system.
    getExtension.mockRejectedValueOnce(new Error("Database not initialized"));
    const tools = [{ name: "echo", description: "e" }];
    refreshMcpTools.mockResolvedValueOnce(tools);

    const res = await POST(makeEvent({ locals: adminUser, params: { id: "ext-42" } }));

    expect(res.status).toBe(200);
    expect((await res.json()) as { tools?: unknown[] }).toEqual({ id: "ext-42", tools });
    expect(refreshMcpTools).toHaveBeenCalledWith("ext-42");
    // No `before` side to diff against, so no row is written…
    expect(insertAuditEntry).not.toHaveBeenCalled();
    // …and nothing was misfiled as a connect failure.
    expect(persistError).not.toHaveBeenCalled();
  });
});
