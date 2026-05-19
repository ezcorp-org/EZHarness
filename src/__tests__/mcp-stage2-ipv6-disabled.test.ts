/**
 * Phase 58 / MCP-05 — Plan 58-03 — Integration test for RC#3:
 * IPv6 is STRUCTURALLY absent inside the Stage 2 netns.
 *
 * Contract: when an MCP attempts `curl -6 https://example.com` from
 * inside its Stage 2 netns, the curl exits non-zero AND stderr matches
 * `/Network (is )?unreachable/i`. Stderr MUST NOT contain:
 *   - "Could not resolve host" — DNS-only failure; IPv6 stack still wired
 *   - "Connection refused"     — proxy returned 502; proxy reachable on IPv6
 *
 * SKIP gates:
 *   - process.platform === "linux"
 *   - `curl`, `ip`, `nft` binaries on PATH
 *   - Live veth probe succeeds (proxies for CAP_NET_ADMIN)
 *   - End-to-end Stage 2 stack is operational (bridge `br-ezcorp-mcp` is
 *     up on the host — Plan 03's initStage2 must have succeeded)
 *
 * On dev hosts the full Stage 2 stack is rarely operational (no
 * NET_ADMIN, no bridge boot). Cases are marked `test.todo` so the
 * scaffold lands now and the test infrastructure for the manual
 * verification fallback in docs/deployment.md is wired. The real
 * GREEN assertions activate on a Linux + CAP_NET_ADMIN CI runner once
 * Stage 2 end-to-end is operational.
 *
 * Manual verification: see docs/deployment.md § "Stage 2 readiness
 * checklist" — operator runs `curl -6` inside the netns and validates
 * by hand on the deployed image.
 */

import { test, describe } from "bun:test";

const HAS_LINUX = process.platform === "linux";
const HAS_CURL = HAS_LINUX && Bun.which("curl") !== null;
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
  : !HAS_CURL
    ? "missing binary: curl"
    : !HAS_IP
      ? "missing binary: ip"
      : !HAS_NFT
        ? "missing binary: nft"
        : !canProbeVeth()
          ? "veth probe failed (CAP_NET_ADMIN required)"
          : null;

if (SKIP_REASON !== null) {
  console.warn(`[mcp-stage2-ipv6-disabled] SKIPPING — ${SKIP_REASON}`);
}

describe.skipIf(SKIP_REASON !== null)("Stage 2 IPv6 leak guard (RC#3)", () => {
  // Both cases require an end-to-end Stage 2 stack: bridge br-ezcorp-mcp up
  // on the host (Plan 03 initStage2), launcher-driven veth-pair attachment,
  // and the launcher's per-iface IPv6 disable sysctl writes succeeding.
  //
  // On dev hosts that lack the full operational stack, these are todo'd.
  // Manual verification path documented in docs/deployment.md.

  test.todo(
    "curl -6 https://example.com inside Stage 2 netns returns 'Network is unreachable'",
    () => {
      // PSEUDOCODE for the GREEN implementation on a Linux+NET_ADMIN+CI runner:
      //   1. Construct a Stage 2 netns via buildSandboxedMcpSpec(...,ctx)
      //      using a curl-probe fixture MCP (a 'sleep 30' suffices).
      //   2. Wait for the child's netns to be populated via the launcher.
      //   3. `nsenter -t <child.pid> -n curl -6 https://example.com --max-time 5 -v`
      //      capturing stderr.
      //   4. Assert exit code != 0 AND stderr matches /Network (is )?unreachable/i
      //   5. Assert stderr does NOT match /Could not resolve/
      //   6. Assert stderr does NOT match /Connection refused/
    },
  );

  test.todo(
    "negative control: curl -4 https://example.com via proxy SUCCEEDS in the same netns",
    () => {
      // Positive control — proves the netns IS functional for IPv4 through
      // the proxy; only the IPv6 stack is structurally absent.
      //
      //   `nsenter -t <child.pid> -n curl -4 https://example.com --max-time 5
      //    -x ${EZCORP_MCP_PROXY_HOST_GATEWAY}`
      //   → assert exit code === 0
    },
  );
});
