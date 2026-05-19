/**
 * Phase 58 / MCP-05 — Plan 58-03 — Pre-spawn conntrack guard tests.
 *
 * The pre-spawn pressure check at the top of `buildSandboxedMcpSpec` reads
 * /proc/sys/net/netfilter/nf_conntrack_count + _max via a test seam
 * (`_setConntrackOverridesForTests`). When count > 0.7 * max (strict >),
 * the spawn is refused with a descriptive error AND an
 * MCP_CONNTRACK_HIGH audit row is emitted with metadata
 * {extensionName, conntrackCount, conntrackMax, ratio}.
 *
 * Cases:
 *   - count < 0.5 * max → spawn proceeds, no audit row
 *   - count exactly 0.7 * max → spawn proceeds (strict `>` not `>=`)
 *   - count > 0.7 * max → spawn refused + MCP_CONNTRACK_HIGH row
 *   - /proc unavailable (non-Linux) → spawn proceeds, no check, no audit
 *   - audit row metadata shape conforms to CONTEXT shape
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Audit mock — captures rows written by the guard ─────────────────
const auditCalls: Array<{
  action: string;
  metadata: Record<string, unknown> | null;
}> = [];
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    _userId: string | null,
    action: string,
    _target?: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> => {
    auditCalls.push({ action, metadata: metadata ?? null });
    return `audit-${auditCalls.length}`;
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

import {
  buildSandboxedMcpSpec,
  _setConntrackOverridesForTests,
  _resetTmpfsKillSwitchBootFlagForTests,
  _resetSeccompKillSwitchBootFlagForTests,
  _resetStage2KillSwitchBootFlagForTests,
} from "../extensions/mcp-sandbox";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  McpServerStdio,
} from "../extensions/types";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import { EXT_AUDIT_ACTIONS } from "../extensions/audit-actions";

function makeManifest(): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-mcp-ext",
    description: "Test MCP extension",
    author: "test",
    version: "1.0.0",
    kind: "mcp",
    permissions: { grantedAt: {} },
    mcpServers: [
      {
        transport: "stdio",
        name: "test-mcp-server",
        description: "Test stdio MCP",
        command: "echo",
        args: ["hello"],
      },
    ],
    tools: [],
  } as unknown as ExtensionManifestV2;
}

function makeSpec(): McpServerStdio {
  return {
    transport: "stdio",
    name: "test-mcp-server",
    description: "Test stdio MCP",
    command: "echo",
    args: ["hello"],
  };
}

function makeGranted(): ExtensionPermissions {
  return { grantedAt: {} } as ExtensionPermissions;
}

function makeCtx() {
  return {
    engine: createStubPermissionEngine(),
    conversationId: null,
    userId: null,
  };
}

beforeEach(() => {
  auditCalls.length = 0;
  _setConntrackOverridesForTests(null);
  _resetTmpfsKillSwitchBootFlagForTests();
  _resetSeccompKillSwitchBootFlagForTests();
  _resetStage2KillSwitchBootFlagForTests();
});

afterAll(() => {
  _setConntrackOverridesForTests(null);
  restoreModuleMocks();
});

describe("pre-spawn conntrack guard", () => {
  test("count < 0.5 * max → spawn proceeds, no MCP_CONNTRACK_HIGH row", async () => {
    _setConntrackOverridesForTests({
      exists: (_p: string) => true,
      readFile: (p: string) => {
        if (p.endsWith("nf_conntrack_max")) return "262144";
        if (p.endsWith("nf_conntrack_count")) return "10000"; // ~3.8%
        return "0";
      },
    });

    // Should not throw.
    const result = await buildSandboxedMcpSpec(
      makeSpec(),
      makeManifest(),
      makeGranted(),
      "ext-1",
      makeCtx(),
    );
    expect(result.spec).toBeDefined();
    // Tear down the proxy started by buildSandboxedMcpSpec.
    if (result.proxyHandle) await result.proxyHandle.stop();

    expect(
      auditCalls.some((c) => c.action === EXT_AUDIT_ACTIONS.MCP_CONNTRACK_HIGH),
    ).toBe(false);
  });

  test("count exactly 0.7 * max → spawn proceeds (strict `>` not `>=`)", async () => {
    _setConntrackOverridesForTests({
      exists: (_p: string) => true,
      readFile: (p: string) => {
        if (p.endsWith("nf_conntrack_max")) return "100000";
        if (p.endsWith("nf_conntrack_count")) return "70000"; // exactly 70%
        return "0";
      },
    });

    // Should not throw — strict > threshold.
    const result = await buildSandboxedMcpSpec(
      makeSpec(),
      makeManifest(),
      makeGranted(),
      "ext-1",
      makeCtx(),
    );
    expect(result.spec).toBeDefined();
    if (result.proxyHandle) await result.proxyHandle.stop();

    expect(
      auditCalls.some((c) => c.action === EXT_AUDIT_ACTIONS.MCP_CONNTRACK_HIGH),
    ).toBe(false);
  });

  test("count > 0.7 * max → spawn refused + MCP_CONNTRACK_HIGH row with metadata", async () => {
    _setConntrackOverridesForTests({
      exists: (_p: string) => true,
      readFile: (p: string) => {
        if (p.endsWith("nf_conntrack_max")) return "100000";
        if (p.endsWith("nf_conntrack_count")) return "80000"; // 80%
        return "0";
      },
    });

    let thrown: Error | null = null;
    try {
      await buildSandboxedMcpSpec(
        makeSpec(),
        makeManifest(),
        makeGranted(),
        "ext-1",
        makeCtx(),
      );
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toMatch(/conntrack/i);
    expect(thrown!.message).toMatch(/70%|0\.7/);

    const row = auditCalls.find(
      (c) => c.action === EXT_AUDIT_ACTIONS.MCP_CONNTRACK_HIGH,
    );
    expect(row).toBeDefined();
    expect(row?.metadata?.extensionName).toBe("test-mcp-ext");
    expect(row?.metadata?.conntrackCount).toBe(80000);
    expect(row?.metadata?.conntrackMax).toBe(100000);
    expect(row?.metadata?.ratio).toBeCloseTo(0.8, 2);
  });

  test("/proc unavailable (non-Linux dev) → spawn proceeds, no check, no audit", async () => {
    _setConntrackOverridesForTests({
      exists: (_p: string) => false,
      readFile: () => {
        throw new Error("should not be called");
      },
    });

    const result = await buildSandboxedMcpSpec(
      makeSpec(),
      makeManifest(),
      makeGranted(),
      "ext-1",
      makeCtx(),
    );
    expect(result.spec).toBeDefined();
    if (result.proxyHandle) await result.proxyHandle.stop();

    expect(
      auditCalls.some((c) => c.action === EXT_AUDIT_ACTIONS.MCP_CONNTRACK_HIGH),
    ).toBe(false);
  });

  test("audit row metadata shape conforms to CONTEXT (permission, oldValue, newValue, actor)", async () => {
    _setConntrackOverridesForTests({
      exists: (_p: string) => true,
      readFile: (p: string) => {
        if (p.endsWith("nf_conntrack_max")) return "1000";
        if (p.endsWith("nf_conntrack_count")) return "900"; // 90%
        return "0";
      },
    });

    try {
      await buildSandboxedMcpSpec(
        makeSpec(),
        makeManifest(),
        makeGranted(),
        "ext-1",
        makeCtx(),
      );
    } catch {
      /* expected refusal */
    }

    const row = auditCalls.find(
      (c) => c.action === EXT_AUDIT_ACTIONS.MCP_CONNTRACK_HIGH,
    );
    expect(row).toBeDefined();
    expect(row?.metadata?.permission).toBe("network");
    expect(row?.metadata?.oldValue).toBe(null);
    expect(row?.metadata?.newValue).toBe(null);
    expect(row?.metadata?.actor).toBe("system");
    expect(row?.metadata?.extensionName).toBe("test-mcp-ext");
    expect(typeof row?.metadata?.conntrackCount).toBe("number");
    expect(typeof row?.metadata?.conntrackMax).toBe("number");
    expect(typeof row?.metadata?.ratio).toBe("number");
  });
});
