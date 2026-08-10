import { afterEach, describe, expect, test } from "bun:test";
import { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";
import type { ExtensionProcess } from "../extensions/subprocess";
import type { McpClient } from "../mcp/client";
import type { McpProxyHandle } from "../extensions/mcp-proxy";

interface RegistryInternals {
  processes: Map<string, ExtensionProcess>;
  manifests: Map<string, ExtensionManifestV2>;
  installPaths: Map<string, string>;
  grantedPerms: Map<string, ExtensionPermissions>;
  bundledFlags: Map<string, boolean>;
  mcpClients: Map<string, McpClient>;
  mcpProxies: Map<string, McpProxyHandle>;
}

const manifest = (version: string, checksum: string): ExtensionManifestV2 => ({
  schemaVersion: 2,
  name: "reload-test",
  version,
  description: "reload test",
  author: { name: "test" },
  entrypoint: "./index.ts",
  tools: [{ name: "run", description: "run", inputSchema: { type: "object" } }],
  permissions: {},
  checksum,
});

const grants = { grantedAt: {} } as ExtensionPermissions;

/** Seed one extension's registry maps. */
function seed(state: RegistryInternals, id: string, m: ExtensionManifestV2): void {
  state.manifests.set(id, m);
  state.installPaths.set(id, `/tmp/${id}`);
  state.grantedPerms.set(id, grants);
  state.bundledFlags.set(id, false);
}

function clearAll(state: RegistryInternals): void {
  state.manifests.clear();
  state.installPaths.clear();
  state.grantedPerms.clear();
  state.bundledFlags.clear();
}

describe("ExtensionRegistry.reload process invalidation", () => {
  afterEach(() => ExtensionRegistry.resetInstance());

  test("kills only subprocesses whose runtime inputs changed", async () => {
    const registry = ExtensionRegistry.getInstance();
    const state = registry as unknown as RegistryInternals;
    const killed: string[] = [];
    const fakeProcess = (id: string) =>
      ({
        isRunning: true,
        kill: () => killed.push(id),
      }) as unknown as ExtensionProcess;

    state.processes.set("changed", fakeProcess("changed"));
    state.processes.set("unchanged", fakeProcess("unchanged"));
    seed(state, "changed", manifest("1.0.0", "old"));
    seed(state, "unchanged", manifest("1.0.0", "same"));

    registry.loadFromDb = async () => {
      clearAll(state);
      seed(state, "changed", manifest("1.1.0", "new"));
      seed(state, "unchanged", manifest("1.0.0", "same"));
    };

    await registry.reload();

    expect(killed).toEqual(["changed"]);
    expect(state.processes.has("changed")).toBe(false);
    expect(state.processes.has("unchanged")).toBe(true);
  });

  test("a code-only change (checksum) invalidates the subprocess", async () => {
    const registry = ExtensionRegistry.getInstance();
    const state = registry as unknown as RegistryInternals;
    let killedCount = 0;

    state.processes.set("ext", {
      isRunning: true,
      inFlightCallCount: 0,
      kill: () => {
        killedCount++;
      },
    } as unknown as ExtensionProcess);
    seed(state, "ext", manifest("1.0.0", "hash-before-edit"));

    // Same version, same tools, same grants — only the entrypoint hash
    // moved. This is what a bundled `index.ts` edit looks like.
    registry.loadFromDb = async () => {
      clearAll(state);
      seed(state, "ext", manifest("1.0.0", "hash-after-edit"));
    };

    await registry.reload();

    expect(killedCount).toBe(1);
    expect(state.processes.has("ext")).toBe(false);
  });
});

describe("ExtensionRegistry.reload MCP invalidation", () => {
  afterEach(() => ExtensionRegistry.resetInstance());

  const fakeProxy = (log: string[], id: string) =>
    ({
      stop: async () => {
        log.push(`stop:${id}`);
      },
    }) as unknown as McpProxyHandle;
  const fakeClient = (log: string[], id: string) =>
    ({
      isConnected: true,
      close: async () => {
        log.push(`close:${id}`);
      },
    }) as unknown as McpClient;

  test("an UPGRADED mcp extension drops its stale proxy and client", async () => {
    const registry = ExtensionRegistry.getInstance();
    const state = registry as unknown as RegistryInternals;
    const log: string[] = [];

    state.mcpProxies.set("upgraded", fakeProxy(log, "upgraded"));
    state.mcpClients.set("upgraded", fakeClient(log, "upgraded"));
    state.mcpProxies.set("untouched", fakeProxy(log, "untouched"));
    state.mcpClients.set("untouched", fakeClient(log, "untouched"));
    seed(state, "upgraded", manifest("1.0.0", "old"));
    seed(state, "untouched", manifest("1.0.0", "same"));

    registry.loadFromDb = async () => {
      clearAll(state);
      seed(state, "upgraded", manifest("2.0.0", "new"));
      seed(state, "untouched", manifest("1.0.0", "same"));
    };

    await registry.reload();
    // `stop()`/`close()` are fire-and-forget inside reload.
    await Bun.sleep(1);

    expect(log.sort()).toEqual(["close:upgraded", "stop:upgraded"]);
    expect(state.mcpProxies.has("upgraded")).toBe(false);
    expect(state.mcpClients.has("upgraded")).toBe(false);
    expect(state.mcpProxies.has("untouched")).toBe(true);
    expect(state.mcpClients.has("untouched")).toBe(true);
  });

  test("a REMOVED mcp extension still drops its proxy and client", async () => {
    const registry = ExtensionRegistry.getInstance();
    const state = registry as unknown as RegistryInternals;
    const log: string[] = [];

    state.mcpProxies.set("gone", fakeProxy(log, "gone"));
    state.mcpClients.set("gone", fakeClient(log, "gone"));
    seed(state, "gone", manifest("1.0.0", "old"));

    registry.loadFromDb = async () => clearAll(state);

    await registry.reload();
    await Bun.sleep(1);

    expect(log.sort()).toEqual(["close:gone", "stop:gone"]);
    expect(state.mcpProxies.size).toBe(0);
    expect(state.mcpClients.size).toBe(0);
  });
});

describe("ExtensionRegistry.reload does not interrupt an in-flight call", () => {
  afterEach(() => ExtensionRegistry.resetInstance());

  /** Stand-in for a subprocess that is blocked serving a host call. */
  function busyProcess(onKill: () => void) {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let inFlight = 1;
    const proc = {
      isRunning: true,
      get inFlightCallCount() {
        return inFlight;
      },
      whenCallsSettled: () => settled,
      kill: onKill,
    };
    return {
      proc: proc as unknown as ExtensionProcess,
      finishCall: () => {
        inFlight = 0;
        settle();
      },
    };
  }

  test("the kill is deferred until the call settles, then still happens", async () => {
    const registry = ExtensionRegistry.getInstance();
    const state = registry as unknown as RegistryInternals;
    const killedAt: string[] = [];
    let callFinished = false;
    const { proc, finishCall } = busyProcess(() => {
      killedAt.push(callFinished ? "after-call" : "during-call");
    });

    state.processes.set("self", proc);
    seed(state, "self", manifest("1.0.0", "old"));

    // The grant self-heal rewriting `grantedPermissions` is enough to move
    // the signature — this is the extension-author self-install shape.
    registry.loadFromDb = async () => {
      clearAll(state);
      seed(state, "self", manifest("1.0.0", "old"));
      state.grantedPerms.set("self", {
        grantedAt: { custom: 1 },
        custom: { "drafts.kinds": ["extension"] },
      } as unknown as ExtensionPermissions);
    };

    await registry.reload();

    // Detached immediately: the next getProcess() spawns fresh code…
    expect(state.processes.has("self")).toBe(false);
    // …but the still-blocked caller was NOT killed out from under itself.
    expect(killedAt).toEqual([]);

    // The in-flight call returns, and only then is the stale process reaped.
    callFinished = true;
    finishCall();
    await Bun.sleep(1);
    expect(killedAt).toEqual(["after-call"]);
  });

  test("an idle process is killed immediately", async () => {
    const registry = ExtensionRegistry.getInstance();
    const state = registry as unknown as RegistryInternals;
    let killed = false;

    state.processes.set("idle", {
      isRunning: true,
      inFlightCallCount: 0,
      whenCallsSettled: () => Promise.resolve(),
      kill: () => {
        killed = true;
      },
    } as unknown as ExtensionProcess);
    seed(state, "idle", manifest("1.0.0", "old"));

    registry.loadFromDb = async () => {
      clearAll(state);
      seed(state, "idle", manifest("1.0.1", "new"));
    };

    await registry.reload();

    expect(killed).toBe(true);
    expect(state.processes.has("idle")).toBe(false);
  });
});
