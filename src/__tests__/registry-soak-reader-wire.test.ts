/**
 * Registry → soak reader wire-up tests — Phase 58 / MCP-04 follow-up to Plan 55-03.
 *
 * Phase 55 exported `runMcpSeccompSoakReader` from mcp-sandbox.ts but never
 * wired it into production. The export was dead code in the v1.4-shipping
 * image (verified at mcp-sandbox.ts:404 in Phase 55 SUMMARY line 72). Plan
 * 58-01 wires it.
 *
 * Three contract assertions:
 *   1. getMcpClient schedules runMcpSeccompSoakReader on the underlying
 *      McpClient child's `exited` promise (fire-and-forget).
 *   2. The soak reader receives a ctx object carrying the right
 *      extensionId + extensionName (manifest.name).
 *   3. Scheduling does NOT block getMcpClient's resolution — the soak
 *      reader fires AFTER the child exits, which is potentially hours
 *      later; awaiting it would deadlock the registry.
 *
 * Test strategy:
 *   - mock.module() on "../extensions/mcp-sandbox" to intercept both
 *     buildSandboxedMcpSpec (returns a benign spec) and
 *     runMcpSeccompSoakReader (captures call args).
 *   - mock.module() on "../mcp/client" to inject a fake McpClient whose
 *     getChildProcess() returns a stable { pid, exited } shape.
 *
 * RED state on creation: McpClient does not have a `getChildProcess()`
 * method (Task 2 adds it), and registry.ts does not import or schedule
 * runMcpSeccompSoakReader (Task 2 wires it). Both assertions fail until
 * Task 2 lands.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Module mocks set up at top-level so dynamic import of the SUT
// resolves against them. Mirrors mcp-stage1-soak-reader.test.ts.

const SOAK_CALLS: Array<{
  pid: number;
  spawnAt: Date;
  ctx: { userId: string | null; extensionId: string; extensionName: string };
}> = [];

let CHILD_EXITED_RESOLVE: (() => void) | null = null;

mock.module("../extensions/mcp-sandbox", () => ({
  buildSandboxedMcpSpec: async (
    server: unknown,
    _manifest: unknown,
    _granted: unknown,
    _extensionId: string,
  ) => ({
    spec: server,
    proxyHandle: null,
  }),
  runMcpSeccompSoakReader: async (
    pid: number,
    spawnAt: Date,
    ctx: { userId: string | null; extensionId: string; extensionName: string },
  ): Promise<void> => {
    SOAK_CALLS.push({ pid, spawnAt, ctx });
  },
}));

// Fake McpClient that exposes getChildProcess(). Task 2 lands this
// public method on src/mcp/client.ts; the production code path will
// then route through it.
mock.module("../mcp/client", () => ({
  McpClient: class {
    public readonly isConnected = true;
    constructor(_spec: unknown) {}
    async connect(): Promise<void> {
      /* immediate resolve */
    }
    async listTools(): Promise<unknown[]> {
      return [];
    }
    async callTool(): Promise<unknown> {
      return { content: [], isError: false };
    }
    async close(): Promise<void> {
      /* noop */
    }
    getChildProcess(): { pid: number; exited: Promise<unknown> } | null {
      return {
        pid: 12345,
        exited: new Promise<void>((resolve) => {
          CHILD_EXITED_RESOLVE = resolve;
        }),
      };
    }
  },
}));

// Permission engine is read inside getMcpClient; stub it out so we
// don't pull the whole singleton bootstrap into the test.
mock.module("../extensions/permission-engine", () => ({
  getPermissionEngine: () => {
    throw new Error("not initialized — test path falls through to no-ctx wrap");
  },
}));

// Import SUT after mocks are registered.
import { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionManifestV2 } from "../extensions/types";

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  SOAK_CALLS.length = 0;
  CHILD_EXITED_RESOLVE = null;
  // Wipe the singleton between cases so each test seeds its own
  // manifest map cleanly (mirrors mcp-registry.test.ts discipline).
  ExtensionRegistry.resetInstance();
});

function makeRegistryWithMcp(extensionId: string, name: string): ExtensionRegistry {
  // ExtensionRegistry's constructor is private — use the public
  // getInstance() factory (mirrors mcp-registry.test.ts pattern).
  const registry = ExtensionRegistry.getInstance();
  const manifest: ExtensionManifestV2 = {
    schemaVersion: 2,
    name,
    version: "1.0.0",
    description: "fixture manifest for Phase 58 soak-reader wire-up test",
    author: { name: "test" },
    kind: "mcp",
    tools: [],
    mcpServers: [
      {
        name,
        transport: "stdio",
        command: "/bin/true",
        args: [],
      },
    ],
    permissions: {},
  };
  // Public test-only setters — no private-map pokes.
  registry.setManifestForTest(extensionId, manifest);
  registry.setGrantedPermsForTest(extensionId, { grantedAt: {} });
  return registry;
}

describe("Phase 58 registry → runMcpSeccompSoakReader wire-up", () => {
  test("getMcpClient schedules runMcpSeccompSoakReader on child exited", async () => {
    const registry = makeRegistryWithMcp("ext-foo", "foo-mcp");
    await registry.getMcpClient("ext-foo");
    // The soak reader runs AFTER child.exited resolves. Trigger it now.
    expect(CHILD_EXITED_RESOLVE).not.toBeNull();
    CHILD_EXITED_RESOLVE?.();
    // Flush microtasks so the .then(...) hook fires.
    await new Promise((r) => setTimeout(r, 10));
    expect(SOAK_CALLS.length).toBe(1);
    expect(SOAK_CALLS[0]?.pid).toBe(12345);
  });

  test("soak reader receives correct ctx (extensionId, extensionName from manifest)", async () => {
    const registry = makeRegistryWithMcp("ext-bar", "bar-mcp");
    await registry.getMcpClient("ext-bar");
    CHILD_EXITED_RESOLVE?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(SOAK_CALLS.length).toBe(1);
    expect(SOAK_CALLS[0]?.ctx.extensionId).toBe("ext-bar");
    expect(SOAK_CALLS[0]?.ctx.extensionName).toBe("bar-mcp");
    expect(SOAK_CALLS[0]?.spawnAt).toBeInstanceOf(Date);
  });

  test("soak reader scheduling is fire-and-forget (does not block getMcpClient resolution)", async () => {
    const registry = makeRegistryWithMcp("ext-baz", "baz-mcp");
    // child.exited is NEVER resolved by the test. getMcpClient must
    // still resolve — otherwise registry initialization would block
    // for the lifetime of the child (potentially hours).
    const start = Date.now();
    await registry.getMcpClient("ext-baz");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    // Soak reader has NOT fired yet (child still alive).
    expect(SOAK_CALLS.length).toBe(0);
  });
});
