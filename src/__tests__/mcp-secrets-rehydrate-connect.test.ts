/**
 * MCP credential isolation — connect-path rehydration (db-audit/mcp-secrets
 * integration follow-up).
 *
 * The manifest is value-blanked at rest, so the runtime connect path must
 * rehydrate the real transport auth from the encrypted store before opening
 * the live MCP connection. `registry.getMcpClient()` now calls
 * `rehydrateMcpServerSecrets`; this test proves the definition handed to the
 * sandbox/connect layer carries the REAL header, not the blank.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

// Capture the (rehydrated) server definition handed to the connect path.
let capturedServer: {
  headers?: Record<string, string>;
  env?: Record<string, string>;
  url?: string;
  command?: string;
  args?: string[];
} | null = null;
mock.module("../extensions/mcp-sandbox", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildSandboxedMcpSpec: async (server: any) => {
    capturedServer = server;
    return { spec: { ...server }, proxyHandle: null };
  },
  runMcpSeccompSoakReader: () => {},
}));

const { ExtensionRegistry } = await import("../extensions/registry");
const { installMcpExtension } = await import("../db/queries/extensions");

describe("getMcpClient rehydrates blanked MCP secrets before connecting", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => {
    await closeTestDb();
    mock.restore();
  });

  test("the connect path receives the REAL header, not the blanked manifest value", async () => {
    capturedServer = null;
    // install redacts-at-rest + stores the real secret in extension_secrets.
    const ext = await installMcpExtension({
      name: "rehydrate-mcp",
      server: {
        transport: "http",
        name: "rehydrate-mcp",
        url: "https://x/mcp",
        headers: { Authorization: "Bearer REAL-TOKEN" },
      },
      cachedTools: [],
    });

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    // Pre-inject a fake (unconnected) client so no real subprocess/socket is
    // opened — getMcpClient still runs the rehydrate + buildSandboxedMcpSpec path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeClient: any = {
      isConnected: false,
      connect: async function () { this.isConnected = true; },
      close: async () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (registry as any).mcpClients.set(ext.id, fakeClient);

    await registry.getMcpClient(ext.id);

    expect(capturedServer).not.toBeNull();
    expect(capturedServer!.headers?.Authorization).toBe("Bearer REAL-TOKEN");
  });

  test("issue #205 — the URL it DIALS carries the real query secret", async () => {
    capturedServer = null;
    const ext = await installMcpExtension({
      name: "rehydrate-url",
      server: {
        transport: "http",
        name: "rehydrate-url",
        url: "https://mcp.vendor.com/mcp?api_key=REAL-URL-SECRET",
      },
      cachedTools: [],
    });
    // The manifest the registry loads is value-blanked; if rehydration were
    // wired AFTER the connect (or not at all) the client would dial
    // `?api_key=` and the server would answer 401.
    expect(JSON.stringify(ext.manifest)).not.toContain("REAL-URL-SECRET");

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeClient: any = {
      isConnected: false,
      connect: async function () { this.isConnected = true; },
      close: async () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (registry as any).mcpClients.set(ext.id, fakeClient);
    await registry.getMcpClient(ext.id);

    expect(capturedServer!.url).toBe("https://mcp.vendor.com/mcp?api_key=REAL-URL-SECRET");
  });

  test("issue #205 — the ARGV it SPAWNS carries the real flag value", async () => {
    capturedServer = null;
    const ext = await installMcpExtension({
      name: "rehydrate-argv",
      server: {
        transport: "stdio",
        name: "rehydrate-argv",
        command: "npx",
        args: ["-y", "srv", "--token=REAL-ARGV-SECRET"],
      },
      cachedTools: [],
    });
    expect(JSON.stringify(ext.manifest)).not.toContain("REAL-ARGV-SECRET");

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeClient: any = {
      isConnected: false,
      connect: async function () { this.isConnected = true; },
      close: async () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (registry as any).mcpClients.set(ext.id, fakeClient);
    await registry.getMcpClient(ext.id);

    expect(capturedServer!.args).toEqual(["-y", "srv", "--token=REAL-ARGV-SECRET"]);
    expect(capturedServer!.command).toBe("npx");
  });
});
