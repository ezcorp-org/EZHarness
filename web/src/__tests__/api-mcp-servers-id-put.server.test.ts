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
import { expectDenied } from "./fixtures/expect-denied";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

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

// The edit handler records the real failure reason server-side now that the
// 502 body is a constant. Stub the sink so this stays DB-free.
const persistError = vi.fn(async () => {});
vi.mock("$server/db/queries/error-logs", () => ({ persistError }));

const { getExtension, updateMcpExtension, rehydrateMcpServerSecrets } = await import(
  "$server/db/queries/extensions"
);
const { MCP_CONNECT_FAILED_MESSAGE } = await import("$server/mcp/connect-failure");
const { McpTargetBlockedError } = await import("$server/mcp/target-guard");
const { PUT } = await import("../routes/api/mcp-servers/[id]/+server");

function makeEvent(opts: { id?: string; locals?: Record<string, unknown>; body?: unknown }) {
  const id = opts.id ?? "ext-1";
  return makeRequestEvent(`http://localhost/api/mcp-servers/${id}`, {
    params: { id },
    locals: opts.locals ?? {},
    request: {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
  });
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

  // 403, not 401: this route's gate is now the role-only `requireAdmin`,
  // which RETURNS its denial (requireRole THREW one, so the caller actually
  // got a 500). requireAdmin answers "not an admin principal" uniformly — a
  // missing principal is not an admin either. Unreachable in production
  // regardless: hooks.server.ts 401s unauthenticated /api/* before the handler.
  test("rejects 403 when locals.user is missing", async () => {
    const res = await expectDenied(() => PUT(makeEvent({ body: validStdioBody() })), 403);
    expect(res.status).toBe(403);
  });

  test("rejects 403 when caller is not admin", async () => {
    const res = await expectDenied(() => PUT(makeEvent({ locals: memberUser, body: validStdioBody() })), 403);
    expect(res.status).toBe(403);
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
    // Uniform body — the edit route carried the same port-scan oracle as
    // install, and an admin can re-point an existing MCP row anywhere.
    expect(body.error).toBe(MCP_CONNECT_FAILED_MESSAGE);
    expect(body.error).not.toContain("ECONNREFUSED");
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

  test("#205 — a blank URL QUERY value keeps the stored secret and the client dials the real url", async () => {
    vi.mocked(getExtension).mockResolvedValueOnce(
      mcpExtension({
        manifest: {
          kind: "mcp",
          name: "ext-http",
          tools: [],
          permissions: {},
          mcpServers: [
            {
              transport: "http",
              name: "ext-http",
              url: "https://vendor.example/mcp?api_key=REAL-URL-SECRET&t=9",
            },
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
          description: "just the description",
          server: {
            transport: "http",
            name: "ext-http",
            // Exactly what the edit form prefills from the blanked manifest.
            url: "https://vendor.example/mcp?api_key=&t=",
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    // The re-probe must authenticate, or a description-only edit 502s.
    expect(lastClientSpec.url).toBe("https://vendor.example/mcp?api_key=REAL-URL-SECRET&t=9");
    expect(updateMcpExtension).toHaveBeenCalledWith(
      expect.objectContaining({
        server: expect.objectContaining({
          url: "https://vendor.example/mcp?api_key=REAL-URL-SECRET&t=9",
        }),
      }),
    );
  });

  test("#205 — a retyped URL query value REPLACES the stored one", async () => {
    vi.mocked(getExtension).mockResolvedValueOnce(
      mcpExtension({
        manifest: {
          kind: "mcp",
          name: "ext-http",
          tools: [],
          permissions: {},
          mcpServers: [
            { transport: "http", name: "ext-http", url: "https://vendor.example/mcp?api_key=OLD" },
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
          server: { transport: "http", name: "ext-http", url: "https://vendor.example/mcp?api_key=ROTATED" },
        },
      }),
    );
    expect(lastClientSpec.url).toBe("https://vendor.example/mcp?api_key=ROTATED");
  });

  test("#205 — a stdio edit keeps the blanked ARGV secret and the stored env", async () => {
    vi.mocked(getExtension).mockResolvedValueOnce(
      mcpExtension({
        manifest: {
          kind: "mcp",
          name: "ext-stdio",
          tools: [],
          permissions: {},
          mcpServers: [
            {
              transport: "stdio",
              name: "ext-stdio",
              command: "npx",
              args: ["-y", "srv", "--token=REAL-ARGV-SECRET"],
              env: { API_KEY: "REAL-ENV-SECRET" },
            },
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
          description: "just the description",
          // The form's stdio branch sends no `env` at all, and posts back the
          // blanked argv it prefilled.
          server: {
            transport: "stdio",
            name: "ext-stdio",
            command: "npx",
            args: ["-y", "srv", "--token="],
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(lastClientSpec.args).toEqual(["-y", "srv", "--token=REAL-ARGV-SECRET"]);
    // Pre-#205 the stdio branch returned the submitted spec verbatim, so every
    // stdio edit silently DROPPED the stored env — the API key with it.
    expect(lastClientSpec.env).toEqual({ API_KEY: "REAL-ENV-SECRET" });
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

  test("stdio edit persists a valid config and never carries headers (mergeMcpServerSecrets stdio branch)", async () => {
    const tools = [{ name: "echo" }];
    vi.mocked(getExtension).mockResolvedValueOnce(mcpExtension() as any);
    mcpListTools.mockResolvedValueOnce(tools as any);
    vi.mocked(updateMcpExtension).mockResolvedValueOnce({ id: "ext-1", manifest: { tools } } as any);

    const res = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));
    expect(res.status).toBe(200);

    // The throwaway client (and the persisted config) get the stdio spec
    // verbatim — no `headers` key is synthesized by mergeMcpServerSecrets.
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

  test("an SSRF-blocked target is byte-identical to a plain connect failure", async () => {
    // Edit is the route an attacker would use to re-point an EXISTING row at
    // an internal address, so its oracle closure needs its own pin rather
    // than relying on the install route's.
    vi.mocked(getExtension).mockResolvedValueOnce(mcpExtension() as any);
    mcpConnect.mockRejectedValueOnce(
      new McpTargetBlockedError("private-address", "mcp.lan → 169.254.169.254"),
    );
    const blocked = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));

    vi.mocked(getExtension).mockResolvedValueOnce(mcpExtension() as any);
    mcpConnect.mockRejectedValueOnce(new Error("connect ECONNREFUSED 93.184.216.34:443"));
    const connectFailure = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));

    expect(blocked.status).toBe(connectFailure.status);
    expect(await blocked.text()).toBe(await connectFailure.text());
    // And no mutation on either path.
    expect(updateMcpExtension).not.toHaveBeenCalled();
  });

  test("the blocked target never appears in the response body", async () => {
    vi.mocked(getExtension).mockResolvedValueOnce(mcpExtension() as any);
    mcpConnect.mockRejectedValueOnce(
      new McpTargetBlockedError("private-address", "mcp.lan → 169.254.169.254"),
    );
    const res = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));
    const body = await res.text();
    expect(body).not.toContain("169.254");
    expect(body).not.toContain("private-address");
  });

  test("a thrown non-Error returns the same body as everything else", async () => {
    vi.mocked(getExtension).mockResolvedValueOnce(mcpExtension() as any);
    mcpConnect.mockRejectedValueOnce("pipe closed");
    const res = await PUT(makeEvent({ locals: adminUser, body: validStdioBody() }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(MCP_CONNECT_FAILED_MESSAGE);
  });
});
