import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, ADMIN_USER } from "./helpers/mock-request";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { getDb } from "../db/connection";
import { users } from "../db/schema";

mockDbConnection();
mockServerAlias();
const realEgress = await import("../search/egress");
let failConnection = false;
let files: Record<string, string> = {};
let staged = 0;
const operations: unknown[] = [];
const lifecycle = {
  createWorkspace: async (_actor: unknown, input: { files: Record<string, string> }) => { files = input.files; staged++; return { installation: { id: "installation" }, workspace: { id: `workspace-${staged}`, revision: 1, sourceDigest: `source-${staged}` } }; },
  build: async () => { const operation = { id: `operation-${staged}`, state: "queued" }; operations.push(operation); return operation; },
  runBuild: async () => {},
};
mock.module("../extensions/extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => lifecycle }));
mock.module("../search/egress", () => ({ ...realEgress, guardedStreamingFetch: async (url: string, init: RequestInit, options: Parameters<typeof realEgress.guardedStreamingFetch>[2]) => {
  if (new URL(url).hostname !== "mcp.example.com") return realEgress.guardedStreamingFetch(url, init, options);
  await options.authorizeUrl!(new URL(url));
  if (failConnection) throw new Error("Private connection diagnostic");
  if (init.method !== "POST") return new Response(null, { status: 405 });
  const message = JSON.parse(typeof init.body === "string" ? init.body : await new Response(init.body).text());
  if (!Object.hasOwn(message, "id")) return new Response(null, { status: 202 });
  expect(["initialize", "tools/list"]).toContain(message.method);
  const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "application/json" } });
} }));
mock.module("$server/extensions/mcp-control", () => require("../extensions/mcp-control"));
mock.module("$lib/server/extensions/mcp-request", () => require("../../web/src/lib/server/extensions/mcp-request"));
const { POST } = await import("../../web/src/routes/api/mcp-servers/+server");
const { PUT } = await import("../../web/src/routes/api/mcp-servers/[id]/+server");
const { POST: refresh } = await import("../../web/src/routes/api/mcp-servers/[id]/refresh/+server");
beforeAll(async () => { await setupTestDb(); await getDb().insert(users).values({ id: ADMIN_USER.id, email: ADMIN_USER.email, name: ADMIN_USER.name, role: "admin", status: "active", passwordHash: "hash" }); });
beforeEach(() => { failConnection = false; staged = 0; files = {}; operations.length = 0; });
afterAll(async () => { restoreModuleMocks(); await closeTestDb(); });
const server = { transport: "http", name: "remote", url: "https://mcp.example.com/mcp" };
const body = { name: "remote", server };
function event(input: unknown = body, overrides: Partial<Parameters<typeof createMockEvent>[0]> = {}) { return createMockEvent({ method: "POST", url: "http://localhost/api/mcp-servers", user: ADMIN_USER, authMethod: "session", body: input, ...overrides }); }

test("add, edit and refresh require an administrator browser session", async () => {
  for (const handler of [POST, PUT, refresh]) for (const authMethod of [undefined, "api-key", "bearer", "unknown"]) {
    const response = await handler(event(body, { authMethod, params: { id: "extension" } }) as never);
    expect([401, 403]).toContain(response.status);
  }
  expect((await POST(event(body, { user: { ...ADMIN_USER, role: "member" } }))).status).toBe(403);
  expect(staged).toBe(0);
});

test("invalid and oversized source bodies never start a probe or build", async () => {
  for (const input of [{}, { name: "remote" }, { ...body, server: { ...server, transport: "unknown" } }, { ...body, server: { transport: "stdio", name: "empty" } }]) expect((await POST(event(input))).status).toBe(400);
  expect((await POST(event({ ...body, description: "x".repeat(70_000) }))).status).toBe(413);
  expect(staged).toBe(0);
});

test("successful catalog probe stages redacted source and a queued build without activation", async () => {
  const response = await POST(event({ ...body, server: { ...server, headers: { Authorization: "Bearer secret-header" }, url: `${server.url}?token=secret-query` } }));
  expect(response.status, await response.clone().text()).toBe(202);
  const result = await response.json();
  expect(result.operation.state).toBe("queued");
  expect(result.openUrl).toContain("/extensions/author?");
  expect(result.installation.activeReleaseId).toBeUndefined();
  expect(operations).toHaveLength(1);
  expect(JSON.stringify(files)).not.toContain("secret-header");
  expect(JSON.stringify(files)).not.toContain("secret-query");
  expect(JSON.parse(files["mcp.manifest.json"]!).tools[0].name).toBe("echo");
});

for (const target of ["http://127.0.0.1/mcp", "http://169.254.169.254/latest/meta-data", "http://10.1.2.3/mcp", "http://[::1]/mcp", "http://0x7f000001/mcp"]) test(`private target ${target} fails before staging`, async () => {
  const response = await POST(event({ ...body, server: { ...server, url: target } }));
  expect(response.status).toBe(500);
  expect((await response.json()).code).toBe("mcp_probe_failed");
  expect(staged).toBe(0);
});

test("blocked targets and connection failures have the same public error", async () => {
  const blocked = await POST(event({ ...body, server: { ...server, url: "http://127.0.0.1/mcp" } }));
  failConnection = true;
  const failed = await POST(event());
  expect(await blocked.text()).toBe(await failed.text());
  expect(staged).toBe(0);
});

test("the offline stdio profile rejects runtime installers, credentials and network hosts", async () => {
  for (const definition of [{ command: "npx" }, { command: "/packaged/server", env: { TOKEN: "secret" } }, { command: "/packaged/server", args: ["https://example.com"] }]) {
    const response = await POST(event({ name: "offline", server: { name: "offline", transport: "stdio", ...definition } }));
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe("unsupported_mcp_profile");
  }
  expect(staged).toBe(0);
  expect((await POST(event({ name: "offline", server: { name: "offline", transport: "stdio", command: "/packaged/server" } }))).status).toBe(202);
});

test("edit and refresh report missing installations without creating source", async () => {
  expect((await PUT(event({ server }, { method: "PUT", params: { id: "missing" } }))).status).toBe(404);
  expect((await refresh(event(undefined, { params: { id: "missing" } }))).status).toBe(404);
  expect(staged).toBe(0);
});
