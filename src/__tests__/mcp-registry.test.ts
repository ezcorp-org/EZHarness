import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { ExtensionRegistry } from "../extensions/registry";
import {
  createExtension,
  installMcpExtension,
  deleteExtension,
  getExtension,
} from "../db/queries/extensions";
import type { ExtensionManifestV2 } from "../extensions/types";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(() => {
  ExtensionRegistry.resetInstance();
});

describe("ExtensionRegistry getMcpClient", () => {
  test("throws when extension is not in registry", async () => {
    const registry = ExtensionRegistry.getInstance();
    await expect(registry.getMcpClient("never-loaded")).rejects.toThrow(/not found in registry/);
  });

  test("throws when extension is not MCP-kind", async () => {
    const registry = ExtensionRegistry.getInstance();
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "local-ext",
      version: "1.0.0",
      description: "",
      author: { name: "t" },
      kind: "local",
      entrypoint: "./x.ts",
      tools: [{ name: "t", description: "d", inputSchema: {} }],
      permissions: {},
    };
    registry.setManifestForTest("local-1", manifest);
    await expect(registry.getMcpClient("local-1")).rejects.toThrow(/not an MCP extension/);
  });

  test("throws when MCP manifest is missing mcpServers entry", async () => {
    const registry = ExtensionRegistry.getInstance();
    const manifest = {
      schemaVersion: 2 as const,
      name: "bad-mcp",
      version: "1.0.0",
      description: "",
      author: { name: "t" },
      kind: "mcp" as const,
      mcpServers: [],
      permissions: {},
    };
    registry.setManifestForTest("bad-1", manifest);
    await expect(registry.getMcpClient("bad-1")).rejects.toThrow(/no mcpServers entry/);
  });

  test("removes the client from the cache and propagates when connect fails", async () => {
    const registry = ExtensionRegistry.getInstance();
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "connect-fails",
      version: "1.0.0",
      description: "",
      author: { name: "t" },
      kind: "mcp",
      mcpServers: [{ transport: "stdio", name: "connect-fails", command: "node" }],
      permissions: {},
    };
    registry.setManifestForTest("fails-1", manifest);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (registry as any).mcpClients.set("fails-1", {
      isConnected: false,
      connect: async () => { throw new Error("boom"); },
      close: async () => {},
      listTools: async () => [],
      callTool: async () => ({ content: [], isError: false }),
    });

    await expect(registry.getMcpClient("fails-1")).rejects.toThrow(/boom/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((registry as any).mcpClients.has("fails-1")).toBe(false);
  });

  // Phase 7 fix-pass C3 — reload() must stop and drop the per-MCP
  // forward-proxy for any extension whose DB row has been removed
  // (uninstalled). Pre-fix-pass, mcpProxies.clear() ran only in
  // killAll(), leaking listener + bearer token until process exit.
  test("reload() stops + drops proxy for an uninstalled extension (fix-pass C3)", async () => {
    const registry = ExtensionRegistry.getInstance();
    // Seed the registry with a manifest and a fake proxy. The
    // manifest entry is what `reload() → loadFromDb()` populates from
    // the DB; we don't need a real DB row for the inverse direction
    // (the test asserts that an extension NOT in the post-reload map
    // gets its proxy stopped).
    let stopped = 0;
    const fakeProxy = {
      start: async () => {},
      stop: async () => {
        stopped += 1;
      },
      proxyUrl: () => "http://_:tok@127.0.0.1:1",
      bytesTransferred: () => ({ rx: 0, tx: 0 }),
      connectionsCount: () => 0,
      _resetCountersForTests: () => {},
    };
    // White-box poke at the registry's private map — the public API
    // doesn't expose a way to seed a proxy without going through
    // `getMcpClient`, which would require a full subprocess setup.
    type RegInternals = { mcpProxies: Map<string, typeof fakeProxy> };
    const internals = registry as unknown as RegInternals;
    internals.mcpProxies.set("uninstalled-1", fakeProxy);
    // Don't seed manifests — after reload(), the manifests map will
    // be rebuilt from the (empty) DB and "uninstalled-1" won't be
    // there. The reload() pass is what should stop the proxy.

    await registry.reload();

    expect(stopped).toBe(1);
    expect(internals.mcpProxies.has("uninstalled-1")).toBe(false);
  });

  test("caches and returns the same connected client on subsequent calls", async () => {
    const registry = ExtensionRegistry.getInstance();
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "cached-mcp",
      version: "1.0.0",
      description: "",
      author: { name: "t" },
      kind: "mcp",
      mcpServers: [{ transport: "stdio", name: "cached-mcp", command: "node" }],
      permissions: {},
    };
    registry.setManifestForTest("cached-1", manifest);

    // Stub McpClient connect to avoid spawning a real process
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeClient: any = { _connected: false, isConnected: false, connect: async function () { this._connected = true; this.isConnected = true; }, close: async () => {}, listTools: async () => [], callTool: async () => ({ content: [], isError: false }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (registry as any).mcpClients.set("cached-1", fakeClient);

    const a = await registry.getMcpClient("cached-1");
    const b = await registry.getMcpClient("cached-1");
    expect(a).toBe(b);
    expect((a as { isConnected: boolean }).isConnected).toBe(true);
  });
});

describe("ExtensionRegistry refreshMcpTools", () => {
  test("throws for non-MCP extensions", async () => {
    const registry = ExtensionRegistry.getInstance();
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2, name: "nm", version: "1.0.0", description: "",
      author: { name: "t" }, kind: "local", entrypoint: "./x.ts",
      tools: [], permissions: {},
    };
    registry.setManifestForTest("nonmcp-1", manifest);
    await expect(registry.refreshMcpTools("nonmcp-1")).rejects.toThrow(/not an MCP extension/);
  });

  test("updates in-memory maps and persists fresh tools to DB", async () => {
    // Create a real DB row so refreshMcpTools's updateExtension call can target it.
    const installed = await installMcpExtension({
      name: "refresh-mcp",
      server: { transport: "stdio", name: "refresh-mcp", command: "node" },
      cachedTools: [
        { name: "old", description: "old", inputSchema: { type: "object" } },
      ],
    });

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    expect(registry.getToolExtension("refresh-mcp__old")).toBe(installed.id);

    // Inject fake MCP client returning a fresh tool list
    const fresh = [
      { name: "new-one", description: "new1", inputSchema: { type: "object" } },
      { name: "new-two", description: "new2", inputSchema: { type: "object" } },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (registry as any).mcpClients.set(installed.id, {
      isConnected: true,
      connect: async () => {},
      listTools: async () => fresh,
      close: async () => {},
      callTool: async () => ({ content: [], isError: false }),
    });

    const result = await registry.refreshMcpTools(installed.id);
    expect(result).toEqual(fresh);

    // In-memory: old namespaced name dropped, new ones registered
    expect(registry.getToolExtension("refresh-mcp__old")).toBeNull();
    expect(registry.getToolExtension("refresh-mcp__new-one")).toBe(installed.id);
    expect(registry.getToolExtension("refresh-mcp__new-two")).toBe(installed.id);

    // DB: manifest.tools updated
    const row = await getExtension(installed.id);
    expect(row?.manifest.tools).toEqual(fresh);

    await deleteExtension(installed.id);
  });
});

describe("ExtensionRegistry.loadFromDb with MCP-kind rows", () => {
  test("loads cached tools even though installPath is null", async () => {
    const installed = await installMcpExtension({
      name: "load-mcp",
      server: { transport: "http", name: "load-mcp", url: "https://ex.com/mcp" },
      cachedTools: [
        { name: "h", description: "", inputSchema: { type: "object" } },
      ],
    });
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    expect(registry.getToolExtension("load-mcp__h")).toBe(installed.id);
    expect(registry.getInstallPath(installed.id)).toBeNull();
    await deleteExtension(installed.id);
  });
});

describe("ExtensionRegistry.killAll closes MCP clients", () => {
  test("calls close() on every registered MCP client and clears the map", () => {
    const registry = ExtensionRegistry.getInstance();
    let closedA = false;
    let closedB = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (registry as any).mcpClients as Map<string, { close: () => Promise<void>; isConnected: boolean }>;
    map.set("a", { close: async () => { closedA = true; }, isConnected: true });
    map.set("b", { close: async () => { closedB = true; }, isConnected: true });

    registry.killAll();

    // close is fire-and-forget (void ... .catch), give microtasks a tick to run
    return Promise.resolve().then(() => {
      expect(closedA).toBe(true);
      expect(closedB).toBe(true);
      expect(map.size).toBe(0);
    });
  });
});

describe("ExtensionRegistry.loadFromDb with a legacy extension row (no kind field)", () => {
  test("treats absent kind as local — skips MCP path entirely", async () => {
    // Create a row directly (not via installMcpExtension) so manifest has no `kind`.
    const ext = await createExtension({
      name: "legacy-ext",
      version: "1.0.0",
      description: "",
      manifest: {
        schemaVersion: 2,
        name: "legacy-ext",
        version: "1.0.0",
        description: "",
        author: { name: "t" },
        entrypoint: "./x.ts",
        tools: [{ name: "tk", description: "", inputSchema: {} }],
        permissions: {},
      },
      source: "local:/tmp/nowhere",
      installPath: "/tmp/nowhere",
      enabled: true,
      grantedPermissions: { grantedAt: {} },
      checksumVerified: false,
      consecutiveFailures: 0,
    });
    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    expect(registry.getToolExtension("legacy-ext__tk")).toBe(ext.id);
    await deleteExtension(ext.id);
  });
});
