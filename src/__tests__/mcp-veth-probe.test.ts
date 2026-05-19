/**
 * Phase 58 / MCP-05 — Unit tests for `probeVethCapability` in mcp-netns.ts.
 *
 * Mirrors the probe-once-cache-result shape used by `probeBwrapAvailability`
 * (Plan 55-02). Test seam (`_setVethProbeOverridesForTests`) avoids any
 * Bun-global mocking — same pattern as `_setBwrapProbeOverridesForTests`
 * at mcp-netns.ts:276.
 *
 * Coverage:
 *   - non-Linux short-circuits with `reason: "not linux"`
 *   - missing `ip` or `nft` binary surfaces the exact `missing binary: <name>`
 *   - probe-runner success: false propagates exitCode
 *   - cache hit on second call (probe runner invoked exactly once)
 *   - clearing the seam resets the cache (overrides off ⇒ re-probe)
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  probeVethCapability,
  _setVethProbeOverridesForTests,
  _resetInitStage2ForTests,
} from "../extensions/mcp-netns";

describe("probeVethCapability", () => {
  beforeEach(() => {
    _setVethProbeOverridesForTests(null);
    // Plan 58-03: probeVethCapability short-circuits when initStage2 has set
    // the stage2-degraded-at-boot flag. Other tests in this suite (e.g.
    // any that construct ExtensionRegistry) trigger initStage2 which on a
    // non-Linux dev host sets the flag. Reset between tests so the probe
    // exercises its own gates, not the boot cascade.
    _resetInitStage2ForTests();
  });
  afterEach(() => {
    _setVethProbeOverridesForTests(null);
    _resetInitStage2ForTests();
  });

  test("non-Linux returns available: false with reason 'not linux'", () => {
    _setVethProbeOverridesForTests({
      platform: () => "darwin",
    });
    const result = probeVethCapability();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/not linux/);
  });

  test("missing ip binary returns reason 'missing binary: ip'", () => {
    _setVethProbeOverridesForTests({
      platform: () => "linux",
      whichIp: () => null,
      whichNft: () => "/usr/sbin/nft",
      probeRunner: () => ({ success: true, exitCode: 0 }),
    });
    const result = probeVethCapability();
    expect(result.available).toBe(false);
    expect(result.reason).toBe("missing binary: ip");
  });

  test("missing nft binary returns reason 'missing binary: nft'", () => {
    _setVethProbeOverridesForTests({
      platform: () => "linux",
      whichIp: () => "/usr/sbin/ip",
      whichNft: () => null,
      probeRunner: () => ({ success: true, exitCode: 0 }),
    });
    const result = probeVethCapability();
    expect(result.available).toBe(false);
    expect(result.reason).toBe("missing binary: nft");
  });

  test("probe runner failure propagates exitCode in reason", () => {
    _setVethProbeOverridesForTests({
      platform: () => "linux",
      whichIp: () => "/usr/sbin/ip",
      whichNft: () => "/usr/sbin/nft",
      probeRunner: () => ({ success: false, exitCode: 1 }),
    });
    const result = probeVethCapability();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/1/);
    expect(result.reason).toMatch(/veth probe/);
  });

  test("cache hit on second call: probe runner invoked exactly once", () => {
    let invocations = 0;
    _setVethProbeOverridesForTests({
      platform: () => "linux",
      whichIp: () => "/usr/sbin/ip",
      whichNft: () => "/usr/sbin/nft",
      probeRunner: () => {
        invocations++;
        return { success: true, exitCode: 0 };
      },
    });
    const first = probeVethCapability();
    const second = probeVethCapability();
    expect(first.available).toBe(true);
    expect(second.available).toBe(true);
    expect(invocations).toBe(1);
  });

  test("_setVethProbeOverridesForTests(null) resets cache", () => {
    let invocations = 0;
    _setVethProbeOverridesForTests({
      platform: () => "linux",
      whichIp: () => "/usr/sbin/ip",
      whichNft: () => "/usr/sbin/nft",
      probeRunner: () => {
        invocations++;
        return { success: true, exitCode: 0 };
      },
    });
    probeVethCapability();
    expect(invocations).toBe(1);

    // Clear overrides — also clears cache.
    _setVethProbeOverridesForTests(null);

    // Re-install overrides with a fresh counter so we can detect re-probe.
    let secondInvocations = 0;
    _setVethProbeOverridesForTests({
      platform: () => "linux",
      whichIp: () => "/usr/sbin/ip",
      whichNft: () => "/usr/sbin/nft",
      probeRunner: () => {
        secondInvocations++;
        return { success: true, exitCode: 0 };
      },
    });
    probeVethCapability();
    expect(secondInvocations).toBe(1);
  });
});
