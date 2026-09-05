import { afterAll, beforeAll, expect, test } from "bun:test";
import { canonicalJson } from "@ezcorp/extension-contract";
import { mockDbConnection, setupTestDb, closeTestDb } from "./helpers/test-pglite";
import { mcpReleaseFixture } from "./helpers/mcp-release-fixture";
import { ReleaseMcpClient } from "../extensions/release-mcp-client";
import { getReleaseRuntime } from "../extensions/release-process";
import { persistMcpWorkspaceCredentials } from "../extensions/mcp-workspace-credentials";
mockDbConnection();
beforeAll(setupTestDb);
afterAll(closeTestDb);

async function connection(workspaceId: string) {
  const fixture = mcpReleaseFixture();
  const server = { name: "remote", transport: "http" as const, url: "https://example.com/mcp", headers: { Authorization: "" } };
  fixture.manifest.mcpServers = [server];
  fixture.manifest.permissions.network = ["example.com"];
  fixture.snapshot.release.workspaceId = workspaceId;
  fixture.snapshot.installation.grants.push(canonicalJson(["network", ["example.com"]]));
  const headers: Headers[] = [];
  const messages: unknown[] = [];
  const client = new ReleaseMcpClient(fixture.id, async () => { throw new Error("Host spawn forbidden"); }, getReleaseRuntime(), { fetch: async (url, init, options) => {
    await options.authorizeUrl!(new URL(url));
    headers.push(new Headers(init.headers));
    if (init.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(typeof init.body === "string" ? init.body : await new Response(init.body).text());
    messages.push(message);
    if (!Object.hasOwn(message, "id")) return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : message.method === "tools/list" ? { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: "ok" }], isError: false };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "application/json" } });
  } });
  await client.connect();
  return { fixture, server, client, headers, messages, close: async () => { await client.close(); fixture.cleanup(); } };
}

test("the active release rehydrates only its immutable workspace authentication at connect", async () => {
  const value = await connection("credentials-active");
  try {
    await persistMcpWorkspaceCredentials(value.fixture.id, "credentials-active", { ...value.server, headers: { Authorization: "Bearer active-secret" } });
    expect(await value.client.callTool("echo", {}, value.fixture.meta)).toMatchObject({ isError: false });
    expect(value.headers.some(headers => headers.get("authorization") === "Bearer active-secret")).toBe(true);
    expect(JSON.stringify(value.fixture.manifest)).not.toContain("active-secret");
    expect(JSON.stringify(value.messages)).not.toContain("active-secret");
    expect(JSON.stringify(value.messages)).not.toContain(value.fixture.token);
  } finally { await value.close(); }
});

test("a candidate workspace credential never replaces the active release credential", async () => {
  const value = await connection("credentials-stable");
  try {
    await persistMcpWorkspaceCredentials(value.fixture.id, "credentials-stable", { ...value.server, headers: { Authorization: "Bearer stable-secret" } });
    await persistMcpWorkspaceCredentials(value.fixture.id, "credentials-candidate", { ...value.server, headers: { Authorization: "Bearer candidate-secret" } });
    await value.client.callTool("echo", {}, value.fixture.meta);
    expect(value.headers.some(headers => headers.get("authorization") === "Bearer stable-secret")).toBe(true);
    expect(value.headers.some(headers => headers.get("authorization") === "Bearer candidate-secret")).toBe(false);
    expect(value.fixture.snapshot.installation.activeReleaseId).toBe("release");
  } finally { await value.close(); }
});
