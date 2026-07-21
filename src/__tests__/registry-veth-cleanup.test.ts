/**
 * Registry → veth cleanup on normal child exit — Phase 58 / MCP-05.
 *
 * getMcpClient() schedules a host-side veth teardown on the MCP child's
 * `exited` promise when Stage 2 networking allocated a veth pair
 * (`sandboxedSpec._internal_vethSetup`). On normal exit it runs
 * `ip link delete <hostSideName>` then releases the veth slot. The
 * connect-FAILURE path (a synchronous teardown before `throw`) is covered
 * by the mcp-sandbox require-sandbox suite; this covers the SUCCESS path —
 * the fire-and-forget `.then` on `childProc.exited`.
 *
 * Strategy mirrors registry-soak-reader-wire.test.ts: mock buildSandboxedMcpSpec
 * to return a stdio spec carrying `_internal_vethSetup`, inject a fake McpClient
 * whose getChildProcess() exposes a controllable `exited`, and mock mcp-netns so
 * the slot release is observable.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const RELEASED_SLOTS: number[] = [];
let CHILD_EXITED_RESOLVE: (() => void) | null = null;

const VETH = { hostSideName: "veth-cleanup-test", slot: 1 };

mock.module("../extensions/mcp-sandbox", () => ({
  // Pass the server spec (which carries `_internal_vethSetup`) straight
  // through as the sandboxed spec, so getMcpClient reads the veth carrier.
  buildSandboxedMcpSpec: async (server: unknown) => ({ spec: server, proxyHandle: null }),
  runMcpSeccompSoakReader: async (): Promise<void> => {},
}));

mock.module("../mcp/client", () => ({
  McpClient: class {
    public readonly isConnected = true;
    async connect(): Promise<void> {}
    async listTools(): Promise<unknown[]> {
      return [];
    }
    async callTool(): Promise<unknown> {
      return { content: [], isError: false };
    }
    async close(): Promise<void> {}
    getChildProcess(): { pid: number; exited: Promise<unknown> } | null {
      return {
        pid: 24680,
        exited: new Promise<void>((resolve) => {
          CHILD_EXITED_RESOLVE = resolve;
        }),
      };
    }
  },
}));

// Observe slot release; stub the boot-time initStage2 + allocator so the
// registry constructor and any Stage 2 probes are inert under test.
mock.module("../extensions/mcp-netns", () => ({
  releaseVethSlot: (slot: number): void => {
    RELEASED_SLOTS.push(slot);
  },
  initStage2: async (): Promise<void> => {},
  allocVethSlot: (): number | null => null,
}));

mock.module("../extensions/permission-engine", () => ({
  getPermissionEngine: () => {
    throw new Error("not initialized — test path falls through to no-ctx wrap");
  },
}));

import { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionManifestV2 } from "../extensions/types";

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  RELEASED_SLOTS.length = 0;
  CHILD_EXITED_RESOLVE = null;
  ExtensionRegistry.resetInstance();
});

describe("Phase 58 registry → veth cleanup on normal child exit", () => {
  test("releases the veth slot after the MCP child exits", async () => {
    const registry = ExtensionRegistry.getInstance();
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "veth-mcp",
      version: "1.0.0",
      description: "fixture manifest for Phase 58 veth-cleanup test",
      author: { name: "test" },
      kind: "mcp",
      tools: [],
      mcpServers: [
        {
          name: "veth-mcp",
          transport: "stdio",
          command: "/bin/true",
          args: [],
          // Stage 2 carrier — read by getMcpClient's vethSetup narrowing.
          _internal_vethSetup: VETH,
        },
      ],
      permissions: {},
    } as unknown as ExtensionManifestV2;
    registry.setManifestForTest("ext-veth", manifest);
    registry.setGrantedPermsForTest("ext-veth", { grantedAt: {} });

    await registry.getMcpClient("ext-veth");

    // Nothing released while the child is still alive.
    expect(RELEASED_SLOTS).toEqual([]);

    // Child exits → the fire-and-forget `.then` deletes the host-side veth
    // and releases the slot. Flush microtasks so the hook runs.
    expect(CHILD_EXITED_RESOLVE).not.toBeNull();
    CHILD_EXITED_RESOLVE?.();
    await new Promise((r) => setTimeout(r, 10));

    expect(RELEASED_SLOTS).toEqual([VETH.slot]);
  });
});
