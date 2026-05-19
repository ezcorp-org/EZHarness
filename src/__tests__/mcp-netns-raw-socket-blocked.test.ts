/**
 * Phase 58 / MCP-05 — RC#1 load-bearing proof. Inside a Stage 2 netns
 * (veth pair + nftables drop-egress), a raw-socket connect to host
 * loopback (127.0.0.1) must reject with `ENETUNREACH` — NOT
 * `ECONNREFUSED`. The distinction is load-bearing:
 *
 *   - `ECONNREFUSED` means the route exists but the destination port is
 *     closed → the raw-socket bypass would have *worked* if a listener
 *     were up.
 *   - `ENETUNREACH` means the route doesn't exist at all → the kernel
 *     has structurally severed loopback from the namespace.
 *
 * Plan 02 Task 1 ships the scaffold + the fixture script. The actual
 * assertion is gated on Task 2 landing the launcher veth-setup block
 * AND Plan 03 landing the bridge boot. Until those are wired, the case
 * is marked `test.todo`.
 *
 * SKIP gates (any failure → suite skips with a console.warn): same as
 * mcp-veth-bridge-integration.test.ts.
 */

import { test, describe } from "bun:test";

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
  console.warn(`[mcp-netns-raw-socket-blocked] SKIPPING — ${SKIP_REASON}`);
}

describe.skipIf(SKIP_REASON !== null)("RC#1: raw-socket bypass closed at kernel level", () => {
  // Full end-to-end proof requires a Stage 2 netns up (Task 2 launcher
  // veth setup + Plan 03 bridge boot). Until both land, mark as todo
  // so the file compiles cleanly on Linux+CAP_NET_ADMIN dev hosts.
  test.todo(
    "[Task 2 + Plan 03] Bun.connect({hostname: '127.0.0.1', port: 22}) inside Stage 2 netns rejects with ENETUNREACH (NOT ECONNREFUSED)",
    () => {
      // Will spawn `bun tests/fixtures/raw-socket-probe/index.ts` inside
      // a Stage 2 netns and assert stdout contains "ENETUNREACH".
      // Gated on Task 2 launcher work + Plan 03 bridge boot.
    },
  );
});
