/**
 * Server-handler unit tests for /api/mcp-servers (+server.ts) — POST only.
 *
 * Handler is admin-gated, zod-validates the MCP server spec, opens a
 * throwaway `McpClient` to probe the target server, then persists via
 * `installMcpExtension` and reloads the registry. We mock every one of
 * those boundaries so no real MCP subprocess or DB is spawned.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

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

// ExtensionRegistry singleton mock.
const registryReload = vi.fn(async () => undefined);
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload: registryReload }),
  },
}));

const { installMcpExtension } = await import("$server/db/queries/extensions");
const { POST } = await import("../routes/api/mcp-servers/+server");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  return {
    url: new URL("http://localhost/api/mcp-servers"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/mcp-servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
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

  test("rejects 401 when locals.user is missing", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ body: validStdioBody() }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 403 when caller is not admin", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ locals: memberUser, body: validStdioBody() }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
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

  test("returns 502 when McpClient.connect() fails", async () => {
    mcpConnect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await POST(
      makeEvent({ locals: adminUser, body: validStdioBody() }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("MCP connect failed");
    expect(body.error).toContain("ECONNREFUSED");
    expect(mcpClose).toHaveBeenCalled();
    expect(installMcpExtension).not.toHaveBeenCalled();
  });

  test("returns 502 when listTools() fails", async () => {
    mcpListTools.mockRejectedValueOnce(new Error("tools/list not supported"));
    const res = await POST(
      makeEvent({ locals: adminUser, body: validStdioBody() }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("MCP connect failed");
    expect(body.error).toContain("tools/list not supported");
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

  test("falls back to generic message when McpClient throws a non-Error", async () => {
    mcpConnect.mockRejectedValueOnce("pipe closed");
    const res = await POST(
      makeEvent({ locals: adminUser, body: validStdioBody() }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("MCP connect failed: MCP connect failed");
  });
});
