/**
 * Server-handler unit tests for /api/mcp-servers (+server.ts) — POST only.
 *
 * Handler is admin-gated, zod-validates the MCP server spec, opens a
 * throwaway `McpClient` to probe the target server, then persists via
 * `installMcpExtension` and reloads the registry. We mock every one of
 * those boundaries so no real MCP subprocess or DB is spawned.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectDenied } from "./fixtures/expect-denied";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

// McpClient mock — constructor captures args, instance methods are spied.
const mcpConnect = vi.fn(async () => undefined);
const mcpListTools = vi.fn(async () => [] as unknown[]);
const mcpClose = vi.fn(async () => undefined);
vi.mock("$server/mcp/client", () => ({
  McpClient: class {
    connect = mcpConnect;
    listTools = mcpListTools;
    close = mcpClose;
  },
}));

vi.mock("$server/db/queries/extensions", () => ({
  installMcpExtension: vi.fn(),
}));

// The handler now records the REAL failure reason server-side (that is what
// pays for the constant response body). Stub the sink so these unit tests
// stay DB-free.
const persistError = vi.fn(async () => {});
vi.mock("$server/db/queries/error-logs", () => ({ persistError }));

// ExtensionRegistry singleton mock.
const registryReload = vi.fn(async () => undefined);
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload: registryReload }),
  },
}));

const { installMcpExtension } = await import("$server/db/queries/extensions");
const { MCP_CONNECT_FAILED_MESSAGE } = await import("$server/mcp/connect-failure");
const { POST } = await import("../routes/api/mcp-servers/+server");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  return makeRequestEvent("http://localhost/api/mcp-servers", {
    locals: opts.locals ?? {},
    request: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
  });
}

const adminUser = {
  user: { id: "admin-1", email: "a@x", name: "a", role: "admin" },
};
const memberUser = {
  user: { id: "u1", email: "u@x", name: "u", role: "user" },
};

function validStdioBody() {
  return {
    name: "ext-stdio",
    description: "stdio example",
    server: {
      transport: "stdio",
      name: "ext-stdio",
      command: "node",
      args: ["server.js"],
    },
  };
}

describe("POST /api/mcp-servers", () => {
  beforeEach(() => {
    mcpConnect.mockReset();
    mcpConnect.mockResolvedValue(undefined);
    mcpListTools.mockReset();
    mcpListTools.mockResolvedValue([]);
    mcpClose.mockReset();
    mcpClose.mockResolvedValue(undefined);
    vi.mocked(installMcpExtension).mockReset();
    registryReload.mockReset();
    registryReload.mockResolvedValue(undefined);
  });

  // 403, not 401: this route's gate is now the role-only `requireAdmin`,
  // which RETURNS its denial (requireRole THREW one, so the caller actually
  // got a 500). requireAdmin answers "not an admin principal" uniformly — a
  // missing principal is not an admin either. Unreachable in production
  // regardless: hooks.server.ts 401s unauthenticated /api/* before the handler.
  test("rejects 403 when locals.user is missing", async () => {
    const res = await expectDenied(() => POST(makeEvent({ body: validStdioBody() })), 403);
    expect(res.status).toBe(403);
  });

  test("rejects 403 when caller is not admin", async () => {
    const res = await expectDenied(() => POST(makeEvent({ locals: memberUser, body: validStdioBody() })), 403);
    expect(res.status).toBe(403);
  });

  test("rejects 400 when name is missing (zod validation)", async () => {
    const body = validStdioBody();
    delete (body as any).name;
    const res = await POST(makeEvent({ locals: adminUser, body }));
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error?: string; fields?: Record<string, string> };
    expect(parsed.error).toBe("Validation failed");
    expect(parsed.fields).toBeDefined();
  });

  test("rejects 400 when transport is unknown (discriminator mismatch)", async () => {
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: {
          name: "x",
          server: { transport: "carrier-pigeon", name: "x" },
        },
      }),
    );
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error?: string };
    expect(parsed.error).toBe("Validation failed");
  });

  test("rejects 400 when http transport lacks a valid url", async () => {
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: {
          name: "ext-http",
          server: { transport: "http", name: "ext-http", url: "not-a-url" },
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 502 when McpClient.connect() fails, without echoing the errno", async () => {
    mcpConnect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await POST(
      makeEvent({ locals: adminUser, body: validStdioBody() }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    // The errno used to be echoed. Distinguishing ECONNREFUSED from a
    // timeout is the port-scan oracle, so the body is now one constant.
    expect(body.error).toBe(MCP_CONNECT_FAILED_MESSAGE);
    expect(body.error).not.toContain("ECONNREFUSED");
    expect(mcpClose).toHaveBeenCalled();
    expect(installMcpExtension).not.toHaveBeenCalled();
  });

  test("returns 502 when listTools() fails, with the same body", async () => {
    mcpListTools.mockRejectedValueOnce(new Error("tools/list not supported"));
    const res = await POST(
      makeEvent({ locals: adminUser, body: validStdioBody() }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    // A different failure STAGE must not be observable either: reaching
    // tools/list proves the port is open and speaking MCP.
    expect(body.error).toBe(MCP_CONNECT_FAILED_MESSAGE);
    expect(body.error).not.toContain("tools/list");
  });

  test("returns 400 when installMcpExtension throws (persist failure)", async () => {
    mcpListTools.mockResolvedValueOnce([{ name: "echo" }] as any);
    vi.mocked(installMcpExtension).mockRejectedValueOnce(
      new Error("duplicate name"),
    );
    const res = await POST(
      makeEvent({ locals: adminUser, body: validStdioBody() }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("duplicate name");
  });

  test("returns 201 with the persisted extension on success", async () => {
    const tools = [{ name: "echo", description: "e" }];
    mcpListTools.mockResolvedValueOnce(tools as any);
    vi.mocked(installMcpExtension).mockResolvedValueOnce({
      id: "ext-1",
      name: "ext-stdio",
    } as any);
    const res = await POST(
      makeEvent({ locals: adminUser, body: validStdioBody() }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string; name?: string };
    expect(body.id).toBe("ext-1");
    expect(body.name).toBe("ext-stdio");
    expect(installMcpExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ext-stdio",
        description: "stdio example",
        cachedTools: tools,
        server: expect.objectContaining({ transport: "stdio" }),
      }),
    );
    expect(registryReload).toHaveBeenCalled();
    expect(mcpClose).toHaveBeenCalled();
  });

  test("a thrown non-Error returns the same body as everything else", async () => {
    mcpConnect.mockRejectedValueOnce("pipe closed");
    const res = await POST(
      makeEvent({ locals: adminUser, body: validStdioBody() }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(MCP_CONNECT_FAILED_MESSAGE);
  });

  test("every failure class produces a byte-identical 502", async () => {
    // The oracle collapse, asserted directly: three different underlying
    // causes, one indistinguishable response. A future change that
    // reintroduces per-error detail fails here first.
    mcpConnect.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:6379"));
    const refused = await POST(makeEvent({ locals: adminUser, body: validStdioBody() }));

    mcpConnect.mockRejectedValueOnce(new Error("connect ETIMEDOUT 10.0.0.6:6379"));
    const timedOut = await POST(makeEvent({ locals: adminUser, body: validStdioBody() }));

    mcpListTools.mockRejectedValueOnce(new Error("HTTP 401 Unauthorized"));
    const protocolError = await POST(makeEvent({ locals: adminUser, body: validStdioBody() }));

    expect(refused.status).toBe(timedOut.status);
    expect(refused.status).toBe(protocolError.status);
    const bodies = await Promise.all([refused.text(), timedOut.text(), protocolError.text()]);
    expect(new Set(bodies).size).toBe(1);
  });
});
