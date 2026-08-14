/**
 * MCP defect 1, at the layer that actually serves the LLM.
 *
 * `getMcpClient` returns early on `isConnected`, and `isConnected` was cleared
 * only by an explicit `close()` — so once an MCP server restarted, the cached
 * client was a corpse the registry handed back on every call until the harness
 * itself restarted. There was no auto-reconnect.
 *
 * The registry now drops the cache entry when the transport closes. That is
 * what makes the recovery COMPLETE rather than partial: the next call rebuilds
 * the whole sandbox envelope (fresh spec, fresh proxy) instead of reconnecting
 * against a spec that was built for the dead child.
 *
 * Real spawned MCP servers, real JSON-RPC, real DB rows. `buildSandboxedMcpSpec`
 * is stubbed to a pass-through (the precedent is
 * `mcp-secrets-rehydrate-connect.test.ts`) so the child is the fixture itself
 * rather than a prlimit/unshare wrapper.
 *
 * No timers, no wall-clock budgets: the SDK fires `Protocol.onclose` BEFORE it
 * rejects the in-flight request, so the caller's own `rejects` await is the
 * synchronisation point.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

mock.module("../extensions/mcp-sandbox", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildSandboxedMcpSpec: async (server: any) => ({ spec: { ...server }, proxyHandle: null }),
  runMcpSeccompSoakReader: () => {},
}));

const { ExtensionRegistry } = await import("../extensions/registry");
const { installMcpExtension, deleteExtension } = await import("../db/queries/extensions");
const { makeStdioMcpServer, MCP_FIXTURE_DIE_TOOL } = await import(
  "./helpers/stdio-mcp-fixture"
);
const { McpClient } = await import("../mcp/client");

type RegistryInternals = { mcpClients: Map<string, unknown> };

/** Install a real MCP row whose server is the controllable stdio fixture. */
async function installFixtureRow(name: string) {
  const srv = makeStdioMcpServer({ toolName: "echo", controls: true });
  const ext = await installMcpExtension({
    name,
    server: { transport: "stdio", name, command: srv.command, args: srv.args },
    cachedTools: [{ name: "echo", description: "Echo tool", inputSchema: { type: "object" } }],
  });
  const registry = ExtensionRegistry.getInstance();
  await registry.loadFromDb();
  return { ext, registry };
}

beforeEach(async () => {
  await setupTestDb();
  ExtensionRegistry.resetInstance();
});

afterAll(async () => {
  await closeTestDb();
  mock.restore();
});

describe("getMcpClient recovers from an MCP server restart", () => {
  test("the dead client is evicted and the next call gets a live one", async () => {
    const { ext, registry } = await installFixtureRow("lifecycle-restart");
    const internals = registry as unknown as RegistryInternals;

    const first = await registry.getMcpClient(ext.id);
    expect(first).toBeInstanceOf(McpClient);
    expect(first.isConnected).toBe(true);
    expect(internals.mcpClients.get(ext.id)).toBe(first);

    // The server exits mid-request — a restart as the harness sees it.
    await expect(first.callTool(MCP_FIXTURE_DIE_TOOL, {})).rejects.toThrow();

    // Pre-fix the map still held `first` and `isConnected` was still true, so
    // `getMcpClient` short-circuited and returned the corpse.
    expect(first.isConnected).toBe(false);
    expect(internals.mcpClients.has(ext.id)).toBe(false);

    const second = await registry.getMcpClient(ext.id);
    expect(second).not.toBe(first);
    expect(second.isConnected).toBe(true);
    expect((await second.listTools()).map((t) => t.name)).toEqual(["echo"]);

    registry.killAll();
    await deleteExtension(ext.id);
  });

  test("a late close event never evicts the client that replaced it", async () => {
    const { ext, registry } = await installFixtureRow("lifecycle-late-close");
    const internals = registry as unknown as RegistryInternals;

    const first = await registry.getMcpClient(ext.id);
    await expect(first.callTool(MCP_FIXTURE_DIE_TOOL, {})).rejects.toThrow();
    const second = await registry.getMcpClient(ext.id);
    expect(internals.mcpClients.get(ext.id)).toBe(second);

    // The old client closing again (shutdown of the already-dead child) must
    // not take the live entry down with it.
    await first.close();
    expect(internals.mcpClients.get(ext.id)).toBe(second);

    registry.killAll();
    await deleteExtension(ext.id);
  });
});
