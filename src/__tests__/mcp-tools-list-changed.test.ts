/**
 * MCP defect 3 — nothing anywhere handled `notifications/tools/list_changed`.
 *
 * An MCP server that added, renamed or dropped a tool stayed misdescribed in
 * the manifest at rest and in the registry's `toolMap` until an admin clicked
 * "Refresh tools". The registry now routes the notification through
 * `refreshMcpTools` — the SAME entry point `POST /api/mcp-servers/[id]/refresh`
 * drives — so a server-initiated change invalidates exactly what an admin
 * refresh invalidates rather than a parallel subset that would drift from it.
 *
 * Real spawned MCP server, real JSON-RPC, real DB rows. `buildSandboxedMcpSpec`
 * is stubbed to a pass-through (the precedent is
 * `mcp-secrets-rehydrate-connect.test.ts`) so the child is the fixture itself.
 *
 * No timers, no wall-clock budgets: the fixture pushes the notification BEFORE
 * the reply it is answering, so a client that has processed the reply has
 * necessarily already processed the notification.
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
const { installMcpExtension, getExtension, deleteExtension } = await import(
  "../db/queries/extensions"
);
const {
  makeStdioMcpServer,
  MCP_FIXTURE_LIST_CHANGED_TOOL,
  MCP_FIXTURE_TOOL_AFTER_CHANGE,
} = await import("./helpers/stdio-mcp-fixture");
import type { ExtensionManifestV2 } from "../extensions/types";

type RegistryInternals = {
  mcpClients: Map<string, unknown>;
  mcpToolRefreshes: Map<string, Promise<void>>;
};

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

/**
 * Drain the microtask queue until `done()` holds, bounded so an unfixed build
 * fails on the assertion instead of hanging. This is NOT a timing budget — the
 * bytes are already off the pipe by the time it runs; all that is outstanding
 * is the SDK's own notification dispatch, which is microtasks.
 */
async function drainMicrotasks(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i += 1) await Promise.resolve();
}

/** The registry's private notification entry point, bound for direct firing. */
function notifier(registry: unknown): (id: string) => void {
  const reg = registry as { onMcpToolListChanged: (id: string) => void };
  return reg.onMcpToolListChanged.bind(reg);
}

beforeEach(async () => {
  await setupTestDb();
  ExtensionRegistry.resetInstance();
});

afterAll(async () => {
  await closeTestDb();
  mock.restore();
});

describe("notifications/tools/list_changed refreshes the catalog", () => {
  test("a server-initiated change lands in the registry AND at rest", async () => {
    const { ext, registry } = await installFixtureRow("listchanged-wire");
    const internals = registry as unknown as RegistryInternals;

    const client = await registry.getMcpClient(ext.id);
    expect(registry.getToolExtension("listchanged-wire__echo")).toBe(ext.id);

    await client.callTool(MCP_FIXTURE_LIST_CHANGED_TOOL, {});
    await drainMicrotasks(() => internals.mcpToolRefreshes.has(ext.id));
    await internals.mcpToolRefreshes.get(ext.id);

    const fresh = `listchanged-wire__${MCP_FIXTURE_TOOL_AFTER_CHANGE}`;
    expect(registry.getToolExtension(fresh)).toBe(ext.id);
    expect(registry.getToolExtension("listchanged-wire__echo")).toBeNull();

    // Persisted, exactly as the admin refresh persists it — a reboot must not
    // resurrect the stale catalog.
    const row = await getExtension(ext.id);
    expect(row).not.toBeNull();
    const tools = (row!.manifest as ExtensionManifestV2).tools ?? [];
    expect(tools.map((t) => t.name)).toEqual([MCP_FIXTURE_TOOL_AFTER_CHANGE]);
    // The slot clears itself once the chain tail settles.
    expect(internals.mcpToolRefreshes.has(ext.id)).toBe(false);

    registry.killAll();
    await deleteExtension(ext.id);
  });

  test("overlapping notifications are serialized, and the tail owns the slot", async () => {
    const { ext, registry } = await installFixtureRow("listchanged-serialize");
    const internals = registry as unknown as RegistryInternals;

    // Hand-drive the refresh so two notifications provably overlap: the first
    // `listTools` is held open while the second notification is delivered.
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const firstListStarted = Promise.withResolvers<void>();
    let listCalls = 0;
    internals.mcpClients.set(ext.id, {
      isConnected: true,
      connect: async () => {},
      close: async () => {},
      callTool: async () => ({ content: [], isError: false }),
      listTools: async () => {
        listCalls += 1;
        const which = listCalls;
        order.push(`start-${which}`);
        if (which === 1) {
          firstListStarted.resolve();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        order.push(`end-${which}`);
        return [{ name: `tool-${which}`, description: "", inputSchema: { type: "object" } }];
      },
    });

    const fire = notifier(registry);
    fire(ext.id);
    await firstListStarted.promise;
    const firstChain = internals.mcpToolRefreshes.get(ext.id);
    fire(ext.id);
    const secondChain = internals.mcpToolRefreshes.get(ext.id);
    expect(secondChain).not.toBe(firstChain);

    releaseFirst!();
    await secondChain;

    // Strictly serial: the second refresh never started before the first ended.
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
    // The last notification is the last writer.
    expect(registry.getToolExtension("listchanged-serialize__tool-2")).toBe(ext.id);
    expect(registry.getToolExtension("listchanged-serialize__tool-1")).toBeNull();
    expect(internals.mcpToolRefreshes.has(ext.id)).toBe(false);

    registry.killAll();
    await deleteExtension(ext.id);
  });

  test("a failing refresh is logged, not thrown, and does not break the chain", async () => {
    const { ext, registry } = await installFixtureRow("listchanged-refresh-fails");
    const internals = registry as unknown as RegistryInternals;

    let listCalls = 0;
    internals.mcpClients.set(ext.id, {
      isConnected: true,
      connect: async () => {},
      close: async () => {},
      callTool: async () => ({ content: [], isError: false }),
      listTools: async () => {
        listCalls += 1;
        if (listCalls === 1) throw new Error("server hung up mid-list");
        return [{ name: "recovered", description: "", inputSchema: { type: "object" } }];
      },
    });

    const fire = notifier(registry);
    fire(ext.id);
    await internals.mcpToolRefreshes.get(ext.id);
    // The failure did not surface as an unhandled rejection and left the old
    // catalog in place.
    expect(registry.getToolExtension("listchanged-refresh-fails__echo")).toBe(ext.id);

    // A later notification still refreshes — one bad link cannot wedge it.
    fire(ext.id);
    await internals.mcpToolRefreshes.get(ext.id);
    expect(registry.getToolExtension("listchanged-refresh-fails__recovered")).toBe(ext.id);

    registry.killAll();
    await deleteExtension(ext.id);
  });
});
