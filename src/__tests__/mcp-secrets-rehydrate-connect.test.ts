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
let capturedServer: { headers?: Record<string, string>; env?: Record<string, string> } | null = null;
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
});
