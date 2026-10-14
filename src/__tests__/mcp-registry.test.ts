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
import { mcpReleaseFixture } from "./helpers/mcp-release-fixture";

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
    await expect(registry.getMcpClient("never-loaded")).rejects.toThrow(/approved v4 release/);
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
    await expect(registry.getMcpClient("local-1")).rejects.toThrow(/approved v4 release/);
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
    await expect(registry.getMcpClient("bad-1")).rejects.toThrow(/approved v4 release/);
  });

  test("rejects a legacy connection even when its old client remains in cache", async () => {
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

    await expect(registry.getMcpClient("fails-1")).rejects.toThrow(/approved v4 release/);
    registry.killAll();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((registry as any).mcpClients.has("fails-1")).toBe(false);
  });

  // Phase 7 fix-pass C3 — reload() must release what an uninstalled MCP
  // extension holds. The host forward-proxy is gone (MCP runs in a runner
  // worker), so what it holds now is its MCP client, which owns that worker.
  test("reload() closes + drops the MCP client of an uninstalled extension (fix-pass C3)", async () => {
    const registry = ExtensionRegistry.getInstance();
    let closed = 0;
    const fakeClient = { close: async () => { closed += 1; } };
    // White-box poke at the registry's private map: the public API seeds a
    // client only through `getMcpClient`, which needs a release runtime.
    type RegInternals = { mcpClients: Map<string, typeof fakeClient> };
    const internals = registry as unknown as RegInternals;
    internals.mcpClients.set("uninstalled-1", fakeClient);
    // No manifest is seeded, so after reload() the (empty) DB leaves
    // "uninstalled-1" out of the live set and its client must go.

    await registry.reload();

    expect(closed).toBe(1);
    expect(internals.mcpClients.has("uninstalled-1")).toBe(false);
  });

  test("caches and returns the same connected client on subsequent calls", async () => {
    const fixture = mcpReleaseFixture();
    try {
      const first = await fixture.registry.getMcpClient(fixture.id);
      expect(await fixture.registry.getMcpClient(fixture.id)).toBe(first);
      expect(first.isConnected).toBe(true);
      expect(fixture.starts()).toBe(0);
    } finally { fixture.cleanup(); }
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
    await expect(registry.refreshMcpTools("nonmcp-1")).rejects.toThrow(/approved v4 release/);
  });

  test("refresh refuses a legacy catalog and does not persist unapproved tools", async () => {
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

    await expect(registry.refreshMcpTools(installed.id)).rejects.toThrow(/approved v4 release/);

    expect(registry.getToolExtension("refresh-mcp__old")).toBe(installed.id);
    expect(registry.getToolExtension("refresh-mcp__new-one")).toBeNull();
    expect(registry.getToolExtension("refresh-mcp__new-two")).toBeNull();

    const row = await getExtension(installed.id);
    expect(row?.manifest.tools).toEqual(
      [{ name: "old", description: "old", inputSchema: { type: "object" }, capabilities: { custom: { "ezcorp:mcp:invoke": true } } }],
    );

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
