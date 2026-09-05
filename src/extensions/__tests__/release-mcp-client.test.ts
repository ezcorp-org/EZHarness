import { expect, test } from "bun:test";
import { canonicalJson, normalizeMcpCatalog } from "@ezcorp/extension-contract";
import { ReleaseMcpClient } from "../release-mcp-client";
import type { ReleaseMcpServices } from "../release-mcp-client";
import type { ActiveExtensionRelease, ReleaseRuntimeDependencies } from "../release-process";
import { registerCallProvenance, releaseCallProvenance } from "../call-provenance";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";

function fixture(block?: { method: string; arrived: () => void; signals: AbortSignal[] }) {
  const waitForAbort = async (signal: AbortSignal) => {
    block!.signals.push(signal);
    block!.arrived();
    await new Promise<void>((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const catalog = [{ name: "echo", inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false } }];
  const snapshot: ActiveExtensionRelease = {
    installation: { id: "mcp", ownerId: "alice", scope: "project", activeReleaseId: "release", generation: 1, enabled: true, uninstalled: false, status: "active", grants: [canonicalJson(["network", ["example.com"]])], acknowledgedGeneration: 1 },
    release: { id: "release", installationId: "mcp", workspaceId: "workspace", workspaceRevision: 1, sourceDigest: "source", artifactDigest: "artifact", imageDigest: "image", runnerProfile: "secure", releaseDigest: "digest", policyDigest: "policy", createdAt: "2026-09-04", evidence: { protocolVersion: 4, validatorVersion: "4.0.0", tests: [], discoveryDigest: "discovery" }, manifest: { schemaVersion: 4, name: "mcp-test", version: "1.0.0", description: "Test", author: { name: "Tests" }, permissions: { network: ["example.com"] }, kind: "mcp", mcpServers: [{ name: "remote", transport: "http", url: "https://example.com/mcp" }], tools: normalizeMcpCatalog(catalog) } },
    limits: { memoryBytes: 512 * 1024 * 1024, cpuMillis: 1000, pids: 64, tmpBytes: 64 * 1024 * 1024, outputBytes: 1024 * 1024, timeoutMs: 60_000 },
  };
  snapshot.installation.grants.push(canonicalJson(["mcpInvoke", true]));
  snapshot.release.manifest.permissions.mcpInvoke = true;
  const token = registerCallProvenance({ actorExtensionId: "mcp", onBehalfOf: "alice", conversationId: "conversation", ownerless: false, runId: null, parentCallId: null, kind: "tool" });
  const requests: unknown[] = [];
  let changed = false;
  let deny = false;
  let hop: string | undefined;
  const runtime: ReleaseRuntimeDependencies = { resolve: async () => structuredClone(snapshot), runner: async () => { throw new Error("No local worker for remote MCP"); } };
  const remote: Partial<ReleaseMcpServices> = {
    secrets: async (_installation, _workspace, server) => server,
    permissionEngine: () => createStubPermissionEngine(deny ? "deny-all" : "allow-all"),
    fetch: async (url, init, options) => {
      await options.authorizeUrl!(new URL(hop ?? url));
      if (init.method !== "POST") {
        if (block?.method === "sse") await waitForAbort(init.signal!);
        return new Response(null, { status: 405 });
      }
      const request = JSON.parse(typeof init.body === "string" ? init.body : await new Response(init.body).text());
      requests.push(request);
      if (block && request.method === block.method) {
        await waitForAbort(init.signal!);
      }
      if (!Object.hasOwn(request, "id")) return new Response(null, { status: 202 });
      const result = request.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } : request.method === "tools/list" ? { tools: changed ? [] : catalog } : { content: [{ type: "text", text: request.params.arguments.text }], isError: false };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json" } });
    },
  };
  const client = new ReleaseMcpClient("mcp", async () => { throw new Error("No host process"); }, runtime, remote);
  return { client, token, snapshot, requests, remote, runtime, change: () => { changed = true; }, deny: () => { deny = true; }, hop: (url: string) => { hop = url; }, cleanup: async () => { await client.close(); releaseCallProvenance(token); } };
}

test("stdio forwards the caller signal and rechecks it after process resolution", async () => {
  const value = fixture();
  value.snapshot.release.manifest.mcpServers = [{ name: "stdio", transport: "stdio", command: "server" }];
  const controller = new AbortController();
  const seen: unknown[] = [];
  let abortDuringResolve = false;
  const client = new ReleaseMcpClient("mcp", async () => {
    if (abortDuringResolve) controller.abort(new Error("Stopped while resolving"));
    return { callTool: async (_name: string, _args: unknown, _meta: unknown, options: unknown) => { seen.push(options); return { content: [], isError: false }; } } as unknown as import("../subprocess").ExtensionProcess;
  }, value.runtime, value.remote);
  try {
    await client.connect();
    await client.callTool("echo", { text: "first" }, { ezCallId: value.token }, { signal: controller.signal });
    expect(seen).toEqual([{ skipTimeout: false, signal: controller.signal }]);
    abortDuringResolve = true;
    await expect(client.callTool("echo", { text: "second" }, { ezCallId: value.token }, { signal: controller.signal })).rejects.toThrow("Stopped while resolving");
    expect(seen).toHaveLength(1);
  } finally { await client.close(); await value.cleanup(); }
});

test("pre-aborted remote MCP calls make no transport requests", async () => {
  const value = fixture();
  const controller = new AbortController();
  controller.abort(new Error("Caller stopped"));
  try {
    await value.client.connect();
    await expect(value.client.callTool("echo", { text: "unused" }, { ezCallId: value.token }, { signal: controller.signal })).rejects.toThrow("Caller stopped");
    expect(value.requests).toEqual([]);
  } finally { await value.cleanup(); }
});

test("stdio forwards the exact host invocation guard without exposing it to child metadata", async () => {
  const value = fixture();
  value.snapshot.release.manifest.mcpServers = [{ name: "stdio", transport: "stdio", command: "server" }];
  const observed: unknown[] = [];
  const guard = async () => {};
  const client = new ReleaseMcpClient("mcp", async () => ({ callTool: async (_name: string, _args: unknown, meta: unknown, options: unknown) => { observed.push({ meta, options }); return { content: [], isError: false }; } }) as unknown as import("../subprocess").ExtensionProcess, value.runtime, value.remote);
  try {
    await client.connect();
    await client.callTool("echo", { text: "hello" }, { ezCallId: value.token }, { invocationGuard: guard });
    expect(observed).toEqual([{ meta: { ezCallId: value.token }, options: { skipTimeout: false, signal: undefined, invocationGuard: guard } }]);
  } finally { await client.close(); await value.cleanup(); }
});

test("remote MCP guard denial makes no transport request", async () => {
  const value = fixture();
  try {
    await value.client.connect();
    await expect(value.client.callTool("echo", { text: "hello" }, { ezCallId: value.token }, { invocationGuard: async () => { throw new Error("claim cancelled"); } })).rejects.toThrow("claim cancelled");
    expect(value.requests).toEqual([]);
  } finally { await value.cleanup(); }
});

test("remote MCP rechecks its guard after asynchronous network policy resolution", async () => {
  const value = fixture();
  let allowed = true;
  const policy = createStubPermissionEngine("allow-all");
  const original = policy.authorize.bind(policy);
  let networkChecks = 0;
  policy.authorize = async (context, needed) => { const result = await original(context, needed); if (needed.some(capability => capability.kind === "network") && ++networkChecks === 2) allowed = false; return result; };
  const client = new ReleaseMcpClient("mcp", async () => { throw new Error("unused"); }, value.runtime, { ...value.remote, permissionEngine: () => policy });
  try {
    await client.connect();
    await expect(client.callTool("echo", { text: "hello" }, { ezCallId: value.token }, { invocationGuard: async () => { if (!allowed) throw new Error("claim cancelled during policy"); } })).rejects.toThrow("claim cancelled during policy");
    expect(value.requests).toEqual([]);
  } finally { await client.close(); await value.cleanup(); }
});

for (const method of ["initialize", "tools/list", "tools/call", "sse"]) {
  test(`remote MCP abort cancels ${method} transport without retrying`, async () => {
    let arrived!: () => void;
    const started = new Promise<void>(resolve => { arrived = resolve; });
    const signals: AbortSignal[] = [];
    const value = fixture({ method, arrived, signals });
    if (method === "sse") value.snapshot.release.manifest.mcpServers = [{ name: "remote", transport: "sse", url: "https://example.com/mcp" }];
    const controller = new AbortController();
    try {
      await value.client.connect();
      const pending = value.client.callTool("echo", { text: "stop" }, { ezCallId: value.token }, { signal: controller.signal });
      const outcome = pending.then(() => ({ rejected: false }), () => ({ rejected: true }));
      await started;
      controller.abort(new Error("Caller stopped"));
      expect(await outcome).toEqual({ rejected: true });
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
      expect(value.requests.filter(request => (request as { method: string }).method === method)).toHaveLength(method === "sse" ? 0 : 1);
      if (method !== "tools/call") expect(value.requests.some(request => (request as { method: string }).method === "tools/call")).toBe(false);
    } finally { await value.cleanup(); }
  });
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
