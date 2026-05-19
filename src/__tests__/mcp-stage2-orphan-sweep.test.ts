/**
 * Phase 58 / MCP-05 — Plan 58-03 — Linux+CAP_NET_ADMIN-gated integration
 * test for the boot-time orphan veth sweep (ROADMAP Success Criterion #5).
 *
 * SKIP gates (any failure → suite skips with console.warn):
 *   - process.platform === "linux"
 *   - `ip` binary on PATH
 *   - A live `ip link add probe-veth-test type veth peer name
 *     probe-veth-test-p && ip link delete probe-veth-test` succeeds
 *     (proxies for CAP_NET_ADMIN — dev hosts without it fail with
 *     `Operation not permitted`).
 *
 * Cases:
 *   1. Pre-seeded orphan `mcp-deadbeef` is swept; MCP_VETH_ORPHAN_SWEPT
 *      audit row fires with count=1, names=['mcp-deadbeef']
 *   2. Zero orphans on clean host → row STILL fires with count=0
 *      (operator-visibility contract)
 *   3. Non-matching name `mcp-deadbeefXX` (14 chars) is NOT swept
 */

import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  afterAll,
  mock,
} from "bun:test";
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

import { sweepOrphanVeths } from "../extensions/mcp-bridge";
import { EXT_AUDIT_ACTIONS } from "../extensions/audit-actions";

const HAS_LINUX = process.platform === "linux";
const HAS_IP = HAS_LINUX && Bun.which("ip") !== null;

function canProbeVeth(): boolean {
  if (!HAS_IP) return false;
  const probeName = `probe-veth-${Math.floor(Math.random() * 1e6).toString(16)}`;
  const peerName = `${probeName}-p`;
  const add = Bun.spawnSync({
    cmd: ["ip", "link", "add", probeName, "type", "veth", "peer", "name", peerName],
    stdout: "ignore",
    stderr: "ignore",
  });
  if (!add.success) return false;
  Bun.spawnSync({
    cmd: ["ip", "link", "delete", probeName],
    stdout: "ignore",
    stderr: "ignore",
  });
  return true;
}

const SKIP_REASON = !HAS_LINUX
  ? "not linux"
  : !HAS_IP
    ? "missing binary: ip"
    : !canProbeVeth()
      ? "veth probe failed (CAP_NET_ADMIN required)"
      : null;

if (SKIP_REASON !== null) {
  console.warn(`[mcp-stage2-orphan-sweep] SKIPPING — ${SKIP_REASON}`);
}

function deleteIfExists(name: string): void {
  Bun.spawnSync({
    cmd: ["ip", "link", "delete", name],
    stdout: "ignore",
    stderr: "ignore",
  });
}

describe.skipIf(SKIP_REASON !== null)(
  "Stage 2 boot orphan veth sweep (RC#5)",
  () => {
    // Defensive cleanup names we touch across cases.
    const CLEANUP_NAMES = [
      "mcp-deadbeef",
      "mcp-deadbeefXX",
      "mcp-12345678",
    ];

    beforeEach(() => {
      auditCalls.length = 0;
      for (const n of CLEANUP_NAMES) deleteIfExists(n);
    });

    afterEach(() => {
      for (const n of CLEANUP_NAMES) deleteIfExists(n);
    });

    afterAll(() => {
      restoreModuleMocks();
    });

    test("pre-seeded mcp-deadbeef is swept + MCP_VETH_ORPHAN_SWEPT row fires count=1", async () => {
      // Seed a dangling host-side veth `mcp-deadbeef`.
      const seed = Bun.spawnSync({
        cmd: [
          "ip",
          "link",
          "add",
          "mcp-deadbeef",
          "type",
          "veth",
          "peer",
          "name",
          "mcp-deadbeef-ns",
        ],
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(seed.success).toBe(true);

      const result = await sweepOrphanVeths(null);
      expect(result.count).toBe(1);
      expect(result.names).toContain("mcp-deadbeef");
      expect(result.error).toBeUndefined();

      // Verify deletion.
      const post = Bun.spawnSync({
        cmd: ["ip", "link", "show", "mcp-deadbeef"],
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(post.success).toBe(false);

      const row = auditCalls.find(
        (c) => c.action === EXT_AUDIT_ACTIONS.MCP_VETH_ORPHAN_SWEPT,
      );
      expect(row).toBeDefined();
      expect(row?.metadata?.count).toBe(1);
      expect((row?.metadata?.names as string[])[0]).toBe("mcp-deadbeef");
    }, 30_000);

    test("zero orphans → row STILL fires with count=0 (operator-visibility contract)", async () => {
      // beforeEach removed any mcp-* leftovers. Sweep should fire row count=0.
      const result = await sweepOrphanVeths(null);
      expect(result.count).toBe(0);
      expect(result.names).toEqual([]);
      expect(result.error).toBeUndefined();

      const row = auditCalls.find(
        (c) => c.action === EXT_AUDIT_ACTIONS.MCP_VETH_ORPHAN_SWEPT,
      );
      expect(row).toBeDefined();
      expect(row?.metadata?.count).toBe(0);
      expect(row?.metadata?.names).toEqual([]);
    }, 30_000);

    test("non-matching name `mcp-deadbeefXX` (14 chars) is NOT swept", async () => {
      // Seed a non-matching veth that should NOT be swept (14 chars total).
      const seed = Bun.spawnSync({
        cmd: [
          "ip",
          "link",
          "add",
          "mcp-deadbeefXX",
          "type",
          "veth",
          "peer",
          "name",
          "mcp-deadbeefXX-p",
        ],
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(seed.success).toBe(true);

      const result = await sweepOrphanVeths(null);
      expect(result.names).not.toContain("mcp-deadbeefXX");

      // Verify `mcp-deadbeefXX` still exists.
      const post = Bun.spawnSync({
        cmd: ["ip", "link", "show", "mcp-deadbeefXX"],
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(post.success).toBe(true);
    }, 30_000);
  },
);
