/**
 * Phase 58 / MCP-05 — Linux+CAP_NET_ADMIN+nft-gated integration test for
 * the bridge + veth pair setup. Plan 02 Task 1 lands the scaffold; the
 * cases marked `test.todo` flip to real assertions once:
 *
 *   - Task 2 lands the launcher veth-setup block (Case 3)
 *   - Plan 03 lands `ensureBridge` in `mcp-bridge.ts` (Case 1)
 *
 * SKIP gates (any failure → suite skips with a console.warn):
 *   - `process.platform === "linux"`
 *   - `ip` binary on PATH
 *   - `nft` binary on PATH
 *   - A live `ip link add probe-veth-test type veth peer name probe-veth-test-p`
 *     succeeds AND a `ip link delete probe-veth-test` cleans up (proxies
 *     for CAP_NET_ADMIN — dev hosts without it fail the create with
 *     `Operation not permitted`).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";

const HAS_LINUX = process.platform === "linux";
const HAS_IP = HAS_LINUX && Bun.which("ip") !== null;
const HAS_NFT = HAS_LINUX && Bun.which("nft") !== null;

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
    : !HAS_NFT
      ? "missing binary: nft"
      : !canProbeVeth()
        ? "veth probe failed (CAP_NET_ADMIN required)"
        : null;

if (SKIP_REASON !== null) {
  console.warn(`[mcp-veth-bridge-integration] SKIPPING — ${SKIP_REASON}`);
}

describe.skipIf(SKIP_REASON !== null)("Stage 2 bridge + veth pair integration", () => {
  // Case 1: idempotent bridge create — gated on Plan 03's ensureBridge.
  test.todo(
    "[Plan 03] idempotent bridge create — calling ensureBridge twice produces a single br-ezcorp-mcp interface",
    () => {
      // Plan 03 will land `ensureBridge()` in mcp-bridge.ts. Until then,
      // this case is a placeholder so `--todo` flag picks it up cleanly.
    },
  );

  // Case 2: veth pair create + move into a fork()'d sleep fixture's netns.
  // This case uses raw `ip` invocations; it does NOT require the launcher
  // (Task 2). Task 1 flips this from todo to a real assertion.
  test("veth pair create + move into PID-target netns succeeds", () => {
    const id = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    const hostSide = `mcp-${id}`;
    const nsSide = `mcp-${id}-ns`;

    // Fork a sleeping fixture child whose pid we'll target.
    const sleeper = Bun.spawn({
      cmd: ["sleep", "30"],
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const sleepPid = sleeper.pid;
      expect(typeof sleepPid).toBe("number");

      // Create the veth pair.
      const add = Bun.spawnSync({
        cmd: ["ip", "link", "add", hostSide, "type", "veth", "peer", "name", nsSide],
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(add.success).toBe(true);

      try {
        // Move the namespace-side peer into the sleeper's netns.
        const move = Bun.spawnSync({
          cmd: ["ip", "link", "set", nsSide, "netns", String(sleepPid)],
          stdout: "ignore",
          stderr: "ignore",
        });
        expect(move.success).toBe(true);

        // After the move, `ip link show <nsSide>` on the host must return
        // non-zero exit (interface no longer in host ns).
        const show = Bun.spawnSync({
          cmd: ["ip", "link", "show", nsSide],
          stdout: "ignore",
          stderr: "ignore",
        });
        expect(show.success).toBe(false);
      } finally {
        // Host-side delete auto-cleans the namespace-side peer (or it's
        // already in the sleeper's netns and dies with the sleeper).
        Bun.spawnSync({
          cmd: ["ip", "link", "delete", hostSide],
          stdout: "ignore",
          stderr: "ignore",
        });
      }
    } finally {
      sleeper.kill();
    }
  });

  // Case 3: nftables egress rule presence — requires Task 2's launcher
  // work + an in-namespace shell that has run the heredoc. Gated until
  // Task 2 + Plan 03 land the end-to-end spawn path.
  test.todo(
    "[Task 2 + Plan 03] nft list table inet mcp-egress shows single allow-exception rule",
    () => {
      // Task 2 lands the launcher heredoc; Plan 03 lands bridge boot. The
      // assertion checks `nft list table inet mcp-egress` output inside a
      // Stage 2 child for the `tcp dport <port> accept` rule.
    },
  );

  // Case 4: cleanup invariant — covered by Case 2's `finally` block; the
  // `ip link show` post-delete assertion verifies the both-sides teardown.
  test("cleanup: ip link delete <host-side> tears down both ends", () => {
    const id = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
    const hostSide = `mcp-${id}`;
    const nsSide = `mcp-${id}-ns`;

    const add = Bun.spawnSync({
      cmd: ["ip", "link", "add", hostSide, "type", "veth", "peer", "name", nsSide],
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(add.success).toBe(true);

    const del = Bun.spawnSync({
      cmd: ["ip", "link", "delete", hostSide],
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(del.success).toBe(true);

    // Both sides should be gone.
    const showHost = Bun.spawnSync({
      cmd: ["ip", "link", "show", hostSide],
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(showHost.success).toBe(false);
    const showNs = Bun.spawnSync({
      cmd: ["ip", "link", "show", nsSide],
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(showNs.success).toBe(false);
  });
});
