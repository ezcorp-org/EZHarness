/**
 * Server-handler unit tests for PUT /api/mcp-servers/[id] (+server.ts) —
 * edit-after-install (Phase 3/B).
 *
 * Handler is admin-gated, zod-validates the new server spec, loads the
 * existing extension (404 if missing / not mcp), opens a throwaway McpClient
 * to re-probe the NEW config (502 on failure, no mutation), then persists via
 * updateMcpExtension and reloads the registry. All boundaries mocked.
 *
 * Also covers the blank-header-preserves-secret merge: a blank header value
 * in the incoming config keeps the previously-stored secret.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

let lastClientSpec: any;
const mcpConnect = vi.fn(async () => undefined);
const mcpListTools = vi.fn(async () => [] as unknown[]);
const mcpClose = vi.fn(async () => undefined);
vi.mock("$server/mcp/client", () => ({
  McpClient: class {
    constructor(spec: any) {
      lastClientSpec = spec;
    }
    connect = mcpConnect;
    listTools = mcpListTools;
    close = mcpClose;
  },
}));

vi.mock("$server/db/queries/extensions", () => ({
  getExtension: vi.fn(),
  updateMcpExtension: vi.fn(),
  // The route rehydrates the previous server's real secrets (blanked in the
  // stored manifest) before merging. These fixtures carry the real secret in
  // the manifest directly, so identity rehydration is faithful here; the real
  // store-backed round-trip is covered in src/__tests__/mcp-secrets-query.test.ts.
  rehydrateMcpServerSecrets: vi.fn(async (_name: string, server: unknown) => server),
}));

const registryReload = vi.fn(async () => undefined);
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload: registryReload }),
  },
}));

const { getExtension, updateMcpExtension, rehydrateMcpServerSecrets } = await import(
  "$server/db/queries/extensions"
);
const { PUT } = await import("../routes/api/mcp-servers/[id]/+server");

function makeEvent(opts: { id?: string; locals?: Record<string, unknown>; body?: unknown }) {
  const id = opts.id ?? "ext-1";
  return {
    params: { id },
    url: new URL(`http://localhost/api/mcp-servers/${id}`),
    locals: opts.locals ?? {},
    request: new Request(`http://localhost/api/mcp-servers/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const adminUser = { user: { id: "admin-1", email: "a@x", name: "a", role: "admin" } };
const memberUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

function validStdioBody() {
  return {
    description: "updated",
    server: { transport: "stdio", name: "ext-stdio", command: "node", args: ["v2.js"] },
  };
}

function mcpExtension(overrides: Record<string, unknown> = {}) {
  return {
    id: "ext-1",
    name: "ext-stdio",
    manifest: {
      schemaVersion: 2,
      name: "ext-stdio",
      version: "0.0.0",
      kind: "mcp",
      mcpServers: [{ transport: "stdio", name: "ext-stdio", command: "node", args: ["v1.js"] }],
      tools: [],
      permissions: {},
    },
    ...overrides,
  };
}

describe("PUT /api/mcp-servers/[id]", () => {
  beforeEach(() => {
    lastClientSpec = undefined;
    mcpConnect.mockReset();
    mcpConnect.mockResolvedValue(undefined);
    mcpListTools.mockReset();
    mcpListTools.mockResolvedValue([]);
    mcpClose.mockReset();
    mcpClose.mockResolvedValue(undefined);
    vi.mocked(getExtension).mockReset();
    vi.mocked(updateMcpExtension).mockReset();
    vi.mocked(rehydrateMcpServerSecrets).mockClear();
    vi.mocked(rehydrateMcpServerSecrets).mockImplementation(async (_n, s) => s);
    registryReload.mockReset();
    registryReload.mockResolvedValue(undefined);
  });

  test("rejects 401 when locals.user is missing", async () => {
    let res: Response | undefined;
    try {
      await PUT(makeEvent({ body: validStdioBody() }));
      expect.fail("should have thrown");
    } catch (thrown) {
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 403 when caller is not admin", async () => {
    let res: Response | undefined;
    try {
      await PUT(makeEvent({ locals: memberUser, body: validStdioBody() }));
      expect.fail("should have thrown");
    } catch (thrown) {
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
  });

  test("rejects 400 on invalid body (bad transport)", async () => {
    const res = await PUT(
      makeEvent({ locals: adminUser, body: { server: { transport: "pigeon", name: "x" } } }),
    );
    expect(res.status).toBe(400);
    expect(getExtension).not.toHaveBeenCalled();
  });

  test("returns 404 when the extension id is missing", async () => {
    vi.mocked(getExtension).mockResolvedValueOnce(null as any);
    const res = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));
    expect(res.status).toBe(404);
    expect(mcpConnect).not.toHaveBeenCalled();
  });

  test("returns 404 when the extension is not an MCP extension", async () => {
    vi.mocked(getExtension).mockResolvedValueOnce(
      mcpExtension({ manifest: { kind: "local", tools: [], permissions: {} } }) as any,
    );
    const res = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("not an MCP extension");
    expect(mcpConnect).not.toHaveBeenCalled();
  });

  test("returns 502 when re-connect fails — no mutation", async () => {
    vi.mocked(getExtension).mockResolvedValueOnce(mcpExtension() as any);
    mcpConnect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("ECONNREFUSED");
    expect(updateMcpExtension).not.toHaveBeenCalled();
    expect(registryReload).not.toHaveBeenCalled();
    expect(mcpClose).toHaveBeenCalled();
  });

  test("success: re-lists tools, persists new config, reloads registry", async () => {
    const tools = [{ name: "echo" }, { name: "ping" }];
    vi.mocked(getExtension).mockResolvedValueOnce(mcpExtension() as any);
    mcpListTools.mockResolvedValueOnce(tools as any);
    vi.mocked(updateMcpExtension).mockResolvedValueOnce({
      id: "ext-1",
      name: "ext-stdio",
      manifest: { tools },
    } as any);

    const res = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string };
    expect(body.id).toBe("ext-1");
    expect(updateMcpExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ext-1",
        description: "updated",
        cachedTools: tools,
        server: expect.objectContaining({ transport: "stdio", args: ["v2.js"] }),
      }),
    );
    expect(registryReload).toHaveBeenCalled();
  });

  test("returns 404 if updateMcpExtension yields null (race: deleted mid-edit)", async () => {
    vi.mocked(getExtension).mockResolvedValueOnce(mcpExtension() as any);
    mcpListTools.mockResolvedValueOnce([] as any);
    vi.mocked(updateMcpExtension).mockResolvedValueOnce(null as any);
    const res = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));
    expect(res.status).toBe(404);
    expect(registryReload).not.toHaveBeenCalled();
  });

  test("blank header value preserves the previously-stored secret", async () => {
    vi.mocked(getExtension).mockResolvedValueOnce(
      mcpExtension({
        manifest: {
          kind: "mcp",
          name: "ext-http",
          tools: [],
          permissions: {},
          mcpServers: [
            { transport: "http", name: "ext-http", url: "https://old.example/mcp", headers: { Authorization: "Bearer SECRET" } },
          ],
        },
      }) as any,
    );
    mcpListTools.mockResolvedValueOnce([] as any);
    vi.mocked(updateMcpExtension).mockResolvedValueOnce({ id: "ext-1" } as any);

    const res = await PUT(
      makeEvent({
        locals: adminUser,
        body: {
          server: {
            transport: "http",
            name: "ext-http",
            url: "https://new.example/mcp",
            // Blank value = keep the existing Authorization secret.
            headers: { Authorization: "" },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    // Route rehydrated the previous server's real secrets from the store
    // (keyed by the extension's stable slug) before merging.
    expect(rehydrateMcpServerSecrets).toHaveBeenCalledWith(
      "ext-stdio",
      expect.objectContaining({ headers: { Authorization: "Bearer SECRET" } }),
    );
    // The throwaway client was constructed with the merged headers (secret kept).
    expect(lastClientSpec.headers.Authorization).toBe("Bearer SECRET");
    expect(lastClientSpec.url).toBe("https://new.example/mcp");
    expect(updateMcpExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        server: expect.objectContaining({ headers: { Authorization: "Bearer SECRET" } }),
      }),
    );
  });

  test("non-blank header value overwrites the stored secret", async () => {
    vi.mocked(getExtension).mockResolvedValueOnce(
      mcpExtension({
        manifest: {
          kind: "mcp",
          name: "ext-http",
          tools: [],
          permissions: {},
          mcpServers: [
            { transport: "http", name: "ext-http", url: "https://old.example/mcp", headers: { Authorization: "Bearer OLD" } },
          ],
        },
      }) as any,
    );
    mcpListTools.mockResolvedValueOnce([] as any);
    vi.mocked(updateMcpExtension).mockResolvedValueOnce({ id: "ext-1" } as any);

    await PUT(
      makeEvent({
        locals: adminUser,
        body: {
          server: { transport: "http", name: "ext-http", url: "https://new.example/mcp", headers: { Authorization: "Bearer NEW" } },
        },
      }),
    );
    expect(lastClientSpec.headers.Authorization).toBe("Bearer NEW");
  });

  test("stdio edit persists a valid config and never carries headers (mergeHeaders stdio branch)", async () => {
    const tools = [{ name: "echo" }];
    vi.mocked(getExtension).mockResolvedValueOnce(mcpExtension() as any);
    mcpListTools.mockResolvedValueOnce(tools as any);
    vi.mocked(updateMcpExtension).mockResolvedValueOnce({ id: "ext-1", manifest: { tools } } as any);

    const res = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));
    expect(res.status).toBe(200);

    // The throwaway client (and the persisted config) get the stdio spec
    // verbatim — no `headers` key is synthesized by mergeHeaders.
    expect(lastClientSpec.transport).toBe("stdio");
    expect(lastClientSpec.command).toBe("node");
    expect(lastClientSpec.args).toEqual(["v2.js"]);
    expect("headers" in lastClientSpec).toBe(false);

    const persisted = vi.mocked(updateMcpExtension).mock.calls[0]![0] as unknown as {
      server: Record<string, unknown>;
    };
    expect(persisted.server).toEqual({
      transport: "stdio",
      name: "ext-stdio",
      command: "node",
      args: ["v2.js"],
    });
    expect("headers" in persisted.server).toBe(false);
  });

  test("switching an http-with-headers server to stdio drops the stored headers", async () => {
    // Prior config was http carrying a secret; the edit changes the transport
    // to stdio. The stdio early-return must NOT graft the old headers on.
    vi.mocked(getExtension).mockResolvedValueOnce(
      mcpExtension({
        manifest: {
          kind: "mcp",
          name: "ext-was-http",
          tools: [],
          permissions: {},
          mcpServers: [
            { transport: "http", name: "ext-was-http", url: "https://old.example/mcp", headers: { Authorization: "Bearer SECRET" } },
          ],
        },
      }) as any,
    );
    mcpListTools.mockResolvedValueOnce([] as any);
    vi.mocked(updateMcpExtension).mockResolvedValueOnce({ id: "ext-1" } as any);

    const res = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));
    expect(res.status).toBe(200);
    expect("headers" in lastClientSpec).toBe(false);
    const persisted = vi.mocked(updateMcpExtension).mock.calls[0]![0] as unknown as {
      server: Record<string, unknown>;
    };
    expect("headers" in persisted.server).toBe(false);
  });

  test("falls back to generic message when McpClient throws a non-Error", async () => {
    vi.mocked(getExtension).mockResolvedValueOnce(mcpExtension() as any);
    mcpConnect.mockRejectedValueOnce("pipe closed");
    const res = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("MCP connect failed: MCP connect failed");
  });
});
