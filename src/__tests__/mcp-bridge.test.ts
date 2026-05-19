/**
 * Phase 58 / MCP-05 — Plan 58-03 — Unit tests for mcp-bridge.ts exports.
 *
 * Covers:
 *   - ensureBridge: idempotent create, success, CAP_NET_ADMIN-missing failure,
 *     subnetOverride threading to `ip addr add`
 *   - ensureConntrackCeiling: idempotent (only-write-if-lower), default floor
 *     262144, sysctl write failure preserves observable state, /proc missing
 *   - sweepOrphanVeths: zero orphans → row with count=0; two matching orphans
 *     deleted + row with count=2; non-matching names (14 chars, bridge, eth0,
 *     docker0) NOT swept; `ip link show` failure returns error
 *
 * All branches use `_setBridgeOverridesForTests` seam to inject fake
 * Bun.spawnSync + readFileSync/existsSync — mirrors `_setBwrapProbeOverridesForTests`
 * pattern (Plan 55-02) so production code stays clean.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Audit mock — captures rows written by sweepOrphanVeths ───────────
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
  ensureBridge,
  ensureConntrackCeiling,
  sweepOrphanVeths,
  _setBridgeOverridesForTests,
  BRIDGE_NAME,
  BRIDGE_CIDR_DEFAULT,
  VETH_HOST_NAME_PATTERN,
} from "../extensions/mcp-bridge";
import { EXT_AUDIT_ACTIONS } from "../extensions/audit-actions";

interface FakeSpawnCall {
  cmd: readonly string[];
}

interface FakeSpawnResult {
  success: boolean;
  exitCode: number | null;
  stdout?: Uint8Array;
  stderr?: Uint8Array;
}

function makeFakeSpawn(
  matcher: (cmd: readonly string[]) => FakeSpawnResult,
  calls: FakeSpawnCall[],
) {
  return (input: { cmd: readonly string[]; [k: string]: unknown }) => {
    calls.push({ cmd: [...input.cmd] });
    return matcher(input.cmd);
  };
}

const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  auditCalls.length = 0;
  _setBridgeOverridesForTests(null);
});

afterAll(() => {
  _setBridgeOverridesForTests(null);
  restoreModuleMocks();
});

describe("mcp-bridge constants", () => {
  test("BRIDGE_NAME is 'br-ezcorp-mcp'", () => {
    expect(BRIDGE_NAME).toBe("br-ezcorp-mcp");
  });

  test("BRIDGE_CIDR_DEFAULT is '10.42.0.1/24'", () => {
    expect(BRIDGE_CIDR_DEFAULT).toBe("10.42.0.1/24");
  });

  test("VETH_HOST_NAME_PATTERN matches 'mcp-<8hex>' and rejects suffixed/short variants", () => {
    expect(VETH_HOST_NAME_PATTERN.test("mcp-deadbeef")).toBe(true);
    expect(VETH_HOST_NAME_PATTERN.test("mcp-00000001")).toBe(true);
    // 14 chars (8hex + 'XX' suffix) — rejected
    expect(VETH_HOST_NAME_PATTERN.test("mcp-deadbeefXX")).toBe(false);
    // 17 chars — pre-correction CONTEXT shape — rejected (Pitfall 1)
    expect(VETH_HOST_NAME_PATTERN.test("mcp-deadbeef-host")).toBe(false);
    expect(VETH_HOST_NAME_PATTERN.test("eth0")).toBe(false);
    expect(VETH_HOST_NAME_PATTERN.test("br-ezcorp-mcp")).toBe(false);
  });
});

describe("ensureBridge", () => {
  test("bridge already exists (ip link show returns success) → ok:true + no `ip link add` call", () => {
    const calls: FakeSpawnCall[] = [];
    _setBridgeOverridesForTests({
      spawnSync: makeFakeSpawn((cmd) => {
        if (cmd[1] === "link" && cmd[2] === "show") {
          return { success: true, exitCode: 0 };
        }
        return { success: true, exitCode: 0 };
      }, calls) as unknown as typeof Bun.spawnSync,
    });

    const result = ensureBridge();
    expect(result.ok).toBe(true);
    expect(result.subnet).toBe(BRIDGE_CIDR_DEFAULT);
    // No `ip link add` call should appear.
    expect(calls.some((c) => c.cmd[1] === "link" && c.cmd[2] === "add")).toBe(false);
  });

  test("bridge create succeeds → ok:true + add/addr/up/sysctl IPv6 disable all called", () => {
    const calls: FakeSpawnCall[] = [];
    _setBridgeOverridesForTests({
      spawnSync: makeFakeSpawn((cmd) => {
        if (cmd[1] === "link" && cmd[2] === "show") {
          return { success: false, exitCode: 1 }; // bridge doesn't exist
        }
        return { success: true, exitCode: 0 };
      }, calls) as unknown as typeof Bun.spawnSync,
    });

    const result = ensureBridge();
    expect(result.ok).toBe(true);
    expect(result.subnet).toBe(BRIDGE_CIDR_DEFAULT);

    // ip link add ... type bridge
    expect(
      calls.some(
        (c) =>
          c.cmd.includes("add") && c.cmd.includes("bridge") && c.cmd.includes(BRIDGE_NAME),
      ),
    ).toBe(true);
    // ip addr add 10.42.0.1/24 dev br-ezcorp-mcp
    expect(
      calls.some(
        (c) =>
          c.cmd.includes("addr") && c.cmd.includes("add") && c.cmd.includes(BRIDGE_CIDR_DEFAULT),
      ),
    ).toBe(true);
    // ip link set br-ezcorp-mcp up
    expect(
      calls.some(
        (c) =>
          c.cmd.includes("link") && c.cmd.includes("set") && c.cmd.includes("up") && c.cmd.includes(BRIDGE_NAME),
      ),
    ).toBe(true);
    // sysctl -w net.ipv6.conf.br-ezcorp-mcp.disable_ipv6=1
    expect(
      calls.some(
        (c) =>
          c.cmd[0] === "sysctl" && c.cmd.some((s) => s.includes("disable_ipv6=1") && s.includes(BRIDGE_NAME)),
      ),
    ).toBe(true);
  });

  test("bridge create fails (CAP_NET_ADMIN missing) → ok:false + reason captures stderr", () => {
    const calls: FakeSpawnCall[] = [];
    _setBridgeOverridesForTests({
      spawnSync: makeFakeSpawn((cmd) => {
        if (cmd[1] === "link" && cmd[2] === "show") {
          return { success: false, exitCode: 1 };
        }
        if (cmd[1] === "link" && cmd[2] === "add") {
          return {
            success: false,
            exitCode: 1,
            stderr: enc("RTNETLINK answers: Operation not permitted\n"),
          };
        }
        return { success: true, exitCode: 0 };
      }, calls) as unknown as typeof Bun.spawnSync,
    });

    const result = ensureBridge();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Operation not permitted/);
  });

  test("subnetOverride '10.99.0.0/24' is threaded to `ip addr add` as '10.99.0.0/24'", () => {
    const calls: FakeSpawnCall[] = [];
    _setBridgeOverridesForTests({
      spawnSync: makeFakeSpawn((cmd) => {
        if (cmd[1] === "link" && cmd[2] === "show") {
          return { success: false, exitCode: 1 };
        }
        return { success: true, exitCode: 0 };
      }, calls) as unknown as typeof Bun.spawnSync,
    });

    const result = ensureBridge({ subnetOverride: "10.99.0.0/24" });
    expect(result.ok).toBe(true);
    expect(result.subnet).toBe("10.99.0.0/24");
    expect(
      calls.some((c) => c.cmd.includes("addr") && c.cmd.includes("add") && c.cmd.includes("10.99.0.0/24")),
    ).toBe(true);
    // NOT the default
    expect(
      calls.some((c) => c.cmd.includes("addr") && c.cmd.includes("add") && c.cmd.includes(BRIDGE_CIDR_DEFAULT)),
    ).toBe(false);
  });
});

describe("ensureConntrackCeiling", () => {
  test("current >= 262144 → no sysctl write (idempotent)", () => {
    const calls: FakeSpawnCall[] = [];
    _setBridgeOverridesForTests({
      spawnSync: makeFakeSpawn(
        () => ({ success: true, exitCode: 0 }),
        calls,
      ) as unknown as typeof Bun.spawnSync,
      readFileSync: (_p: string) => "262144\n",
      existsSync: (_p: string) => true,
    });

    const result = ensureConntrackCeiling();
    expect(result.ok).toBe(true);
    expect(result.before).toBe(262144);
    expect(result.after).toBe(262144);
    // No sysctl write call.
    expect(calls.some((c) => c.cmd[0] === "sysctl" && c.cmd.includes("-w"))).toBe(false);
  });

  test("current 65536 → sysctl -w called → after = 262144", () => {
    const calls: FakeSpawnCall[] = [];
    let readN = 0;
    _setBridgeOverridesForTests({
      spawnSync: makeFakeSpawn(
        () => ({ success: true, exitCode: 0 }),
        calls,
      ) as unknown as typeof Bun.spawnSync,
      readFileSync: (_p: string) => {
        readN++;
        // Both pre-write and post-write reads return 65536 in the mock; the
        // implementation's `after` value is the effective new floor when the
        // sysctl write succeeds.
        return readN === 1 ? "65536\n" : "262144\n";
      },
      existsSync: (_p: string) => true,
    });

    const result = ensureConntrackCeiling();
    expect(result.ok).toBe(true);
    expect(result.before).toBe(65536);
    expect(result.after).toBe(262144);
    expect(
      calls.some(
        (c) =>
          c.cmd[0] === "sysctl" &&
          c.cmd.includes("-w") &&
          c.cmd.some((s) => s.includes("net.netfilter.nf_conntrack_max=262144")),
      ),
    ).toBe(true);
  });

  test("sysctl write fails → after = before (preserves observable state)", () => {
    const calls: FakeSpawnCall[] = [];
    _setBridgeOverridesForTests({
      spawnSync: makeFakeSpawn((cmd) => {
        if (cmd[0] === "sysctl") {
          return {
            success: false,
            exitCode: 1,
            stderr: enc("sysctl: permission denied\n"),
          };
        }
        return { success: true, exitCode: 0 };
      }, calls) as unknown as typeof Bun.spawnSync,
      readFileSync: (_p: string) => "65536\n",
      existsSync: (_p: string) => true,
    });

    const result = ensureConntrackCeiling();
    expect(result.ok).toBe(false);
    expect(result.before).toBe(65536);
    expect(result.after).toBe(65536);
  });

  test("/proc path missing (non-Linux) → ok:false, before=0, after=0", () => {
    _setBridgeOverridesForTests({
      spawnSync: makeFakeSpawn(
        () => ({ success: true, exitCode: 0 }),
        [],
      ) as unknown as typeof Bun.spawnSync,
      readFileSync: () => {
        throw new Error("ENOENT");
      },
      existsSync: () => false,
    });

    const result = ensureConntrackCeiling();
    expect(result.ok).toBe(false);
    expect(result.before).toBe(0);
    expect(result.after).toBe(0);
  });
});

describe("sweepOrphanVeths", () => {
  // Helper: build an `ip -o link show` style output string.
  function ipOutput(names: string[]): string {
    return names
      .map(
        (n, i) =>
          `${i + 1}: ${n}@if${i + 99}: <BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000\\    link/ether ...`,
      )
      .join("\n");
  }

  test("zero orphans → audit row count=0, names=[]", async () => {
    _setBridgeOverridesForTests({
      spawnSync: makeFakeSpawn((cmd) => {
        if (cmd[1] === "-o" && cmd[2] === "link") {
          // No mcp-<8hex> interfaces, just system ones.
          return {
            success: true,
            exitCode: 0,
            stdout: enc(ipOutput(["lo", "eth0", "docker0", "br-ezcorp-mcp"])),
          };
        }
        return { success: true, exitCode: 0 };
      }, []) as unknown as typeof Bun.spawnSync,
    });

    const result = await sweepOrphanVeths(null);
    expect(result.count).toBe(0);
    expect(result.names).toEqual([]);
    expect(result.error).toBeUndefined();

    // Audit row STILL fires (count=0 operator-visibility contract).
    const row = auditCalls.find(
      (c) => c.action === EXT_AUDIT_ACTIONS.MCP_VETH_ORPHAN_SWEPT,
    );
    expect(row).toBeDefined();
    expect(row?.metadata?.count).toBe(0);
    expect(row?.metadata?.names).toEqual([]);
  });

  test("two matching orphans → both deleted + audit row count=2 + names array", async () => {
    const deleteCalls: string[] = [];
    _setBridgeOverridesForTests({
      spawnSync: makeFakeSpawn((cmd) => {
        if (cmd[1] === "-o" && cmd[2] === "link") {
          return {
            success: true,
            exitCode: 0,
            stdout: enc(
              ipOutput([
                "lo",
                "eth0",
                "mcp-deadbeef",
                "docker0",
                "mcp-cafef00d",
              ]),
            ),
          };
        }
        if (cmd[1] === "link" && cmd[2] === "delete") {
          deleteCalls.push(cmd[3] as string);
          return { success: true, exitCode: 0 };
        }
        return { success: true, exitCode: 0 };
      }, []) as unknown as typeof Bun.spawnSync,
    });

    const result = await sweepOrphanVeths(null);
    expect(result.count).toBe(2);
    expect(result.names.sort()).toEqual(["mcp-cafef00d", "mcp-deadbeef"]);
    expect(deleteCalls.sort()).toEqual(["mcp-cafef00d", "mcp-deadbeef"]);

    const row = auditCalls.find(
      (c) => c.action === EXT_AUDIT_ACTIONS.MCP_VETH_ORPHAN_SWEPT,
    );
    expect(row?.metadata?.count).toBe(2);
    expect((row?.metadata?.names as string[]).sort()).toEqual([
      "mcp-cafef00d",
      "mcp-deadbeef",
    ]);
  });

  test("interleaved non-matching names (mcp-deadbeefXX is 14 chars → NOT swept)", async () => {
    const deleteCalls: string[] = [];
    _setBridgeOverridesForTests({
      spawnSync: makeFakeSpawn((cmd) => {
        if (cmd[1] === "-o" && cmd[2] === "link") {
          return {
            success: true,
            exitCode: 0,
            stdout: enc(
              ipOutput([
                "lo",
                "eth0",
                "br-ezcorp-mcp",
                "mcp-deadbeefXX", // 14 chars — does NOT match /^mcp-[a-f0-9]{8}$/
                "mcp-deadbeef-ns", // ns-side, not host-side
                "docker0",
                "mcp-12345678", // 12 chars, matches
              ]),
            ),
          };
        }
        if (cmd[1] === "link" && cmd[2] === "delete") {
          deleteCalls.push(cmd[3] as string);
          return { success: true, exitCode: 0 };
        }
        return { success: true, exitCode: 0 };
      }, []) as unknown as typeof Bun.spawnSync,
    });

    const result = await sweepOrphanVeths(null);
    expect(result.count).toBe(1);
    expect(result.names).toEqual(["mcp-12345678"]);
    expect(deleteCalls).toEqual(["mcp-12345678"]);

    // Defensive: the non-matchers were NOT deleted.
    expect(deleteCalls).not.toContain("mcp-deadbeefXX");
    expect(deleteCalls).not.toContain("mcp-deadbeef-ns");
    expect(deleteCalls).not.toContain("br-ezcorp-mcp");
  });

  test("ip link show fails (CAP_NET_ADMIN missing) → return error string + count=0", async () => {
    _setBridgeOverridesForTests({
      spawnSync: makeFakeSpawn((cmd) => {
        if (cmd[1] === "-o" && cmd[2] === "link") {
          return {
            success: false,
            exitCode: 1,
            stderr: enc("Cannot bind netlink socket: Operation not permitted\n"),
          };
        }
        return { success: true, exitCode: 0 };
      }, []) as unknown as typeof Bun.spawnSync,
    });

    const result = await sweepOrphanVeths(null);
    expect(result.count).toBe(0);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/Operation not permitted|ip link show failed/);
  });
});
