import { expect, test } from "bun:test";
import { canonicalJson, normalizeMcpCatalog } from "@ezcorp/extension-contract";
import { ReleaseMcpClient } from "../release-mcp-client";
import type { ReleaseMcpServices } from "../release-mcp-client";
import type { ActiveExtensionRelease, ReleaseRuntimeDependencies } from "../release-process";
import { registerCallProvenance, releaseCallProvenance } from "../call-provenance";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";

function fixture() {
  const catalog = [{ name: "echo", inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false } }];
  const snapshot: ActiveExtensionRelease = {
    installation: { id: "mcp", ownerId: "alice", scope: "project", activeReleaseId: "release", generation: 1, enabled: true, uninstalled: false, status: "active", grants: [canonicalJson(["network", ["example.com"]])], acknowledgedGeneration: 1 },
    release: { id: "release", installationId: "mcp", workspaceId: "workspace", workspaceRevision: 1, sourceDigest: "source", artifactDigest: "artifact", imageDigest: "image", runnerProfile: "secure", releaseDigest: "digest", policyDigest: "policy", createdAt: "2026-09-04", evidence: { protocolVersion: 4, validatorVersion: "4.0.0", tests: [], discoveryDigest: "discovery" }, manifest: { schemaVersion: 4, name: "mcp-test", version: "1.0.0", description: "Test", author: { name: "Tests" }, permissions: { network: ["example.com"] }, kind: "mcp", mcpServers: [{ name: "remote", transport: "http", url: "https://example.com/mcp" }], tools: normalizeMcpCatalog(catalog) } },
    limits: { memoryBytes: 512 * 1024 * 1024, cpuMillis: 1000, pids: 64, tmpBytes: 64 * 1024 * 1024, outputBytes: 1024 * 1024, timeoutMs: 60_000 },
  };
  const token = registerCallProvenance({ actorExtensionId: "mcp", onBehalfOf: "alice", conversationId: "conversation", ownerless: false, runId: null, parentCallId: null, kind: "tool" });
  const requests: unknown[] = [];
  let changed = false;
  let deny = false;
  let hop: string | undefined;
  const runtime: ReleaseRuntimeDependencies = { resolve: async () => structuredClone(snapshot), runner: async () => { throw new Error("No local worker for remote MCP"); } };
  const remote: Partial<ReleaseMcpServices> = {
    secrets: async (_name, server) => server,
    permissionEngine: () => createStubPermissionEngine(deny ? "deny-all" : "allow-all"),
    fetch: async (url, init, options) => {
      await options.authorizeUrl!(new URL(hop ?? url));
      if (init.method !== "POST") return new Response(null, { status: 405 });
      const request = JSON.parse(typeof init.body === "string" ? init.body : await new Response(init.body).text());
      requests.push(request);
      if (!Object.hasOwn(request, "id")) return new Response(null, { status: 202 });
      const result = request.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } : request.method === "tools/list" ? { tools: changed ? [] : catalog } : { content: [{ type: "text", text: request.params.arguments.text }], isError: false };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json" } });
    },
  };
  const client = new ReleaseMcpClient("mcp", async () => { throw new Error("No host process"); }, runtime, remote);
  return { client, token, snapshot, requests, remote, change: () => { changed = true; }, deny: () => { deny = true; }, hop: (url: string) => { hop = url; }, cleanup: async () => { await client.close(); releaseCallProvenance(token); } };
}

test("remote MCP uses approved catalog and a live scoped token over real HTTP protocol", async () => {
  const value = fixture();
  try {
    await value.client.connect();
    expect(value.client.isConnected).toBe(true);
    expect(value.client.getChildProcess()).toBeNull();
    expect(await value.client.listTools()).toEqual(value.snapshot.release.manifest.tools!);
    expect(await value.client.callTool("echo", { text: "hello" }, { ezCallId: value.token })).toMatchObject({ content: [{ type: "text", text: "hello" }] });
    expect(JSON.stringify(value.requests)).not.toContain(value.token);
    await expect(value.client.callTool("echo", { text: "hi" })).rejects.toThrow("active extension");
    await expect(value.client.callTool("unknown", {}, { ezCallId: value.token })).rejects.toThrow("not approved");
  } finally { await value.cleanup(); }
});

test("remote MCP denies catalog drift, missing grants, revoked policy and cross-origin hops", async () => {
  for (const mutate of ["catalog", "grants", "policy", "hop", "generation"] as const) {
    const value = fixture();
    try {
      await value.client.connect();
      if (mutate === "catalog") value.change();
      if (mutate === "grants") value.snapshot.installation.grants = [];
      if (mutate === "policy") value.deny();
      if (mutate === "hop") value.hop("https://attacker.example/mcp");
      if (mutate === "generation") value.snapshot.installation.generation++;
      await expect(value.client.callTool("echo", { text: "hello" }, { ezCallId: value.token })).rejects.toThrow();
      expect(value.requests.some(request => (request as { method: string }).method === "tools/call")).toBe(false);
    } finally { await value.cleanup(); }
  }
});
