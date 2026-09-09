import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import type { GuardedFetchOptions } from "../../search/egress";

const actor = { principalId: "admin", scope: "global", kind: "human" as const };
let role = "admin";
let active = true;
let currentExtension: unknown;
let recordedFiles: Record<string, string>;
let storedScope = "";
let storedServer: unknown;
let requests: string[] = [];
let transport = "http";
let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
let denyHop = false;
const encoder = new TextEncoder();
const lifecycle = {
  createWorkspace: mock(async (_actor: unknown, input: { files: Record<string, string> }) => { recordedFiles = input.files; return { installation: { id: "installation" }, workspace: { id: "workspace-new", revision: 1, sourceDigest: "source" } }; }),
  build: mock(async () => ({ id: "operation" })),
  runBuild: mock(async () => {}),
  inspect: mock(async () => ({ installation: { activeReleaseId: "release" }, releases: { release: { workspaceId: "workspace-old" } } })),
};
async function fetcher(url: string, init: RequestInit, options: GuardedFetchOptions): Promise<Response> {
  expect(options.mode).toBe("read");
  expect(options.retryConnectionFailures).toBe(false);
  await options.authorizeUrl!(new URL(denyHop ? "https://foreign.example/messages" : url));
  if (init.method === "GET" && transport === "sse") return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
  if (init.method !== "POST") return new Response(null, { status: 405 });
  const message = JSON.parse(typeof init.body === "string" ? init.body : await new Response(init.body).text());
  requests.push(message.method);
  if (!Object.hasOwn(message, "id")) return new Response(null, { status: 202 });
  const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  const response = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
  if (transport === "sse") { stream!.enqueue(encoder.encode(`event: message\ndata: ${response}\n\n`)); return new Response(null, { status: 202 }); }
  return new Response(response, { headers: { "content-type": "application/json" } });
}
mock.module("../../search/egress", () => ({ guardedStreamingFetch: fetcher }));
mock.module("../../db/queries/users", () => ({ getUserById: async () => ({ id: "admin", role, status: active ? "active" : "disabled" }) }));
mock.module("../../db/queries/extensions", () => ({ getExtension: async () => currentExtension, persistMcpSecret: async (scope: string, server: unknown) => { storedScope = scope; storedServer = server; }, rehydrateMcpServerSecrets: async (scope: string, server: unknown) => { expect(scope).toBe("mcp-workspace:workspace-old"); return server; } }));
mock.module("../../db/queries/audit-log", () => ({ insertAuditEntry: async () => {} }));
mock.module("../mcp-workspace-credentials", () => ({ persistMcpWorkspaceCredentials: async (_installation: string, workspace: string, server: unknown) => { storedScope = workspace; storedServer = server; }, rehydrateMcpWorkspaceCredentials: async (_installation: string, workspace: string, server: unknown) => { expect(workspace).toBe("workspace-old"); return server; } }));
mock.module("../extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => lifecycle }));
const { probeRemoteMcp, stageMcpExtension, restageMcpExtension } = await import("../mcp-control");
afterAll(restoreModuleMocks);
beforeEach(() => { role = "admin"; active = true; currentExtension = undefined; requests = []; transport = "http"; denyHop = false; storedScope = ""; lifecycle.createWorkspace.mockClear(); lifecycle.build.mockClear(); });

test("remote probes support HTTP and SSE without invoking tools", async () => {
  for (const protocol of ["http", "sse"] as const) {
    transport = protocol;
    const catalog = await probeRemoteMcp({ transport: protocol, name: "remote", url: "https://example.com/mcp" }, async () => {}, fetcher);
    expect(catalog.map(tool => tool.name)).toEqual(["echo"]);
  }
  expect(requests).not.toContain("tools/call");
  await expect(probeRemoteMcp({ transport: "http", name: "remote", url: "file:///secret" }, async () => {}, fetcher)).rejects.toThrow("HTTP URL");
  denyHop = true;
  await expect(probeRemoteMcp({ transport: "http", name: "remote", url: "https://example.com/mcp" }, async () => {}, fetcher)).rejects.toThrow();
});

test("staging writes only redacted source and workspace-scoped auth before build", async () => {
  const server = { transport: "http" as const, name: "remote", url: "https://example.com/mcp?token=secret-query", headers: { Authorization: "Bearer private-secret" } };
  const result = await stageMcpExtension(actor, { name: "remote", server });
  expect(result.operation.id).toBe("operation");
  expect(storedScope).toBe("workspace-new");
  expect(storedServer).toEqual(server);
  expect(JSON.stringify(recordedFiles)).not.toContain("private-secret");
  expect(JSON.stringify(recordedFiles)).not.toContain("secret-query");
  const manifest = JSON.parse(recordedFiles["mcp.manifest.json"]!);
  expect(manifest.permissions).toEqual({ network: ["example.com"], mcpInvoke: true });
  expect(manifest.tools[0].capabilities.custom["ezcorp:mcp:invoke"]).toBe(true);
  expect(lifecycle.build).toHaveBeenCalledTimes(1);
});

test("unapproved actors and unsafe native source profiles never stage", async () => {
  const server = { transport: "stdio" as const, name: "offline", command: "/opt/mcp/server" };
  for (const change of [() => { role = "member"; }, () => { role = "admin"; active = false; }]) {
    change();
    await expect(stageMcpExtension(actor, { name: "offline", server })).rejects.toThrow("human administrator");
  }
  active = true;
  await expect(stageMcpExtension({ ...actor, kind: "agent" }, { name: "offline", server })).rejects.toThrow("human administrator");
  for (const unsupported of [{ ...server, env: { TOKEN: "secret" } }, { ...server, command: "npx" }]) await expect(stageMcpExtension(actor, { name: "offline", server: unsupported })).rejects.toThrow();
  expect(lifecycle.createWorkspace).not.toHaveBeenCalled();
  await stageMcpExtension(actor, { name: "offline", server });
  expect(lifecycle.createWorkspace).toHaveBeenCalledTimes(1);
  await stageMcpExtension(actor, { name: "networked", server: { ...server, args: ["https://example.com/api", "--endpoint=https://example.com/api", "http://plain.example/api"] } });
  const manifest = JSON.parse(recordedFiles["mcp.manifest.json"]!);
  expect(manifest.permissions).toEqual({ network: ["example.com", "plain.example"], networkTcp: ["example.com:443"], mcpInvoke: true });
  expect(lifecycle.createWorkspace).toHaveBeenCalledTimes(2);
});

test("restaging keeps the active connection unchanged and uses its scoped credentials", async () => {
  await expect(restageMcpExtension(actor, "missing")).rejects.toThrow("not found");
  currentExtension = { name: "remote", manifest: { schemaVersion: 2, kind: "mcp", mcpServers: [{ transport: "http", name: "remote", url: "https://example.com/mcp" }] } };
  await expect(restageMcpExtension(actor, "old")).rejects.toThrow("Legacy MCP");
  const original = { name: "remote", manifest: { schemaVersion: 4, kind: "mcp", description: "Remote", mcpServers: [{ transport: "http", name: "remote", url: "https://example.com/mcp" }] } };
  currentExtension = original;
  await restageMcpExtension(actor, "installation");
  expect(currentExtension).toEqual(original);
  expect(lifecycle.createWorkspace.mock.calls[0]?.[1]).toMatchObject({ installationId: "installation" });
  await restageMcpExtension(actor, "installation", { server: { transport: "http", name: "remote", url: "https://example.com/changed" }, description: "Changed" });
  expect(storedScope).toBe("workspace-new");
});

test("a connection origin change never carries existing authentication into the probe", async () => {
  currentExtension = { name: "remote", manifest: { schemaVersion: 4, kind: "mcp", description: "Remote", mcpServers: [{ transport: "http", name: "remote", url: "https://example.com/mcp", headers: { Authorization: "old-secret" } }] } };
  await restageMcpExtension(actor, "installation", { server: { transport: "http", name: "remote", url: "https://different.example/mcp", headers: { Authorization: "" } } });
  expect(storedServer).toMatchObject({ url: "https://different.example/mcp", headers: { Authorization: "" } });
});
