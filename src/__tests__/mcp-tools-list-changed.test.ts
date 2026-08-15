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

type RefreshEntry = { promise: Promise<void>; queued: boolean };
type RegistryInternals = {
  mcpClients: Map<string, unknown>;
  mcpToolRefreshes: Map<string, RefreshEntry>;
};

/** Await this extension's in-flight refresh AND its coalesced re-run. */
async function settleRefresh(internals: RegistryInternals, extId: string): Promise<void> {
  await internals.mcpToolRefreshes.get(extId)?.promise;
}

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
    await settleRefresh(internals, ext.id);

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

  test("overlapping notifications are serialized, and the slot clears itself", async () => {
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
    const entry = internals.mcpToolRefreshes.get(ext.id)!;
    expect(entry.queued).toBe(false);
    fire(ext.id);
    // COALESCED: the second notification flags the SAME entry rather than
    // appending a link to a chain the map holds no reference to.
    expect(internals.mcpToolRefreshes.get(ext.id)).toBe(entry);
    expect(entry.queued).toBe(true);

    releaseFirst!();
    await entry.promise;

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
    await settleRefresh(internals, ext.id);
    // The failure did not surface as an unhandled rejection and left the old
    // catalog in place.
    expect(registry.getToolExtension("listchanged-refresh-fails__echo")).toBe(ext.id);

    // A later notification still refreshes — one bad refresh cannot wedge it.
    fire(ext.id);
    await settleRefresh(internals, ext.id);
    expect(registry.getToolExtension("listchanged-refresh-fails__recovered")).toBe(ext.id);

    registry.killAll();
    await deleteExtension(ext.id);
  });
});

// ── The burst is BOUNDED, and shutdown cancels what is queued ──────────────
//
// Serializing bounds interleaving, not work: the previous shape appended one
// `prior.then(...)` link per notification, so N notifications bought N
// `getMcpClient` + `tools/list` + read-every-extension-row + jsonb-write
// cycles and N retained closures. Nothing debounced them and nothing dropped
// them on shutdown.

/** A hand-driven MCP client whose first `listTools` is held open. */
function heldClient(): {
  stub: Record<string, unknown>;
  started: Promise<void>;
  release: () => void;
  calls: () => number;
} {
  const startedGate = Promise.withResolvers<void>();
  let release: (() => void) | null = null;
  let calls = 0;
  return {
    started: startedGate.promise,
    release: () => release?.(),
    calls: () => calls,
    stub: {
      isConnected: true,
      connect: async () => {},
      close: async () => {},
      callTool: async () => ({ content: [], isError: false }),
      listTools: async () => {
        calls += 1;
        const which = calls;
        if (which === 1) {
          startedGate.resolve();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return [{ name: `tool-${which}`, description: "", inputSchema: { type: "object" } }];
      },
    },
  };
}

/** Count `getMcpClient` entries — a reconnect after shutdown shows up here
 *  even when the respawned client never reaches the stub's `listTools`. */
function countConnects(registry: unknown): () => number {
  const reg = registry as { getMcpClient: (id: string) => Promise<unknown> };
  const real = reg.getMcpClient.bind(reg);
  let calls = 0;
  reg.getMcpClient = async (id: string) => {
    calls += 1;
    return real(id);
  };
  return () => calls;
}

describe("tools/list_changed refreshes are coalesced and cancellable", () => {
  test("a burst of 25 notifications costs TWO refreshes, and the last one still wins", async () => {
    const { ext, registry } = await installFixtureRow("listchanged-burst");
    const internals = registry as unknown as RegistryInternals;
    const held = heldClient();
    internals.mcpClients.set(ext.id, held.stub);

    const fire = notifier(registry);
    fire(ext.id);
    await held.started;
    for (let i = 0; i < 24; i += 1) fire(ext.id);

    // One entry, whatever the server does — the queue is a flag, not a chain.
    expect(internals.mcpToolRefreshes.size).toBe(1);
    expect(internals.mcpToolRefreshes.get(ext.id)!.queued).toBe(true);

    held.release();
    await settleRefresh(internals, ext.id);

    // 25 notifications, exactly 2 refreshes: the in-flight one plus the ONE
    // re-run the other 24 collapsed onto. An equality, not a budget — nothing
    // here reads a clock.
    expect(held.calls()).toBe(2);
    // Coalescing did not cost correctness: the row describes the LAST list.
    expect(registry.getToolExtension("listchanged-burst__tool-2")).toBe(ext.id);
    expect(registry.getToolExtension("listchanged-burst__tool-1")).toBeNull();
    expect(internals.mcpToolRefreshes.has(ext.id)).toBe(false);

    registry.killAll();
    await deleteExtension(ext.id);
  });

  test("killAll() cancels the queued refresh — no respawn after a deliberate close", async () => {
    const { ext, registry } = await installFixtureRow("listchanged-shutdown");
    const internals = registry as unknown as RegistryInternals;
    const held = heldClient();
    internals.mcpClients.set(ext.id, held.stub);
    const connects = countConnects(registry);

    const fire = notifier(registry);
    fire(ext.id);
    await held.started;
    fire(ext.id);
    const entry = internals.mcpToolRefreshes.get(ext.id)!;
    expect(entry.queued).toBe(true);

    // Deliberate shutdown while a refresh is queued.
    registry.killAll();
    expect(internals.mcpClients.size).toBe(0);
    expect(internals.mcpToolRefreshes.size).toBe(0);

    held.release();
    await entry.promise;

    // The queued refresh did NOT run. Had it run, `getMcpClient` would have
    // missed the cache killAll just cleared, rebuilt the sandbox envelope and
    // respawned the stdio child of a server the host just closed — leaving a
    // live client behind after shutdown.
    expect(held.calls()).toBe(1);
    expect(connects()).toBe(1);
    expect(internals.mcpClients.size).toBe(0);

    await deleteExtension(ext.id);
  });

  test("reload() cancels a queued refresh for an extension it just dropped", async () => {
    const { ext, registry } = await installFixtureRow("listchanged-reload");
    const internals = registry as unknown as RegistryInternals;
    const held = heldClient();
    internals.mcpClients.set(ext.id, held.stub);
    const connects = countConnects(registry);

    const fire = notifier(registry);
    fire(ext.id);
    await held.started;
    fire(ext.id);
    const entry = internals.mcpToolRefreshes.get(ext.id)!;
    expect(entry.queued).toBe(true);

    // Uninstalled underneath the queued refresh.
    await deleteExtension(ext.id);
    await registry.reload();
    expect(internals.mcpClients.has(ext.id)).toBe(false);
    expect(internals.mcpToolRefreshes.has(ext.id)).toBe(false);

    held.release();
    await entry.promise;

    // Same interlock as killAll: a queued refresh for an extension the
    // registry no longer runs must not reconnect it.
    expect(held.calls()).toBe(1);
    expect(connects()).toBe(1);
    expect(internals.mcpClients.has(ext.id)).toBe(false);

    registry.killAll();
  });
});
