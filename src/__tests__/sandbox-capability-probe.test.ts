/**
 * Phase A1 — capability-probe tier-selection unit coverage.
 *
 * The GO/NO-GO gate hinges on the probe resolving the correct tier from
 * each combination of primitive availability. `selectTier` is PURE, so we
 * exhaustively cover every branch (bwrap / landlock / advisory) by feeding
 * synthetic ProbeOutcomes — no syscalls, no spawns. The live FFI probes
 * are exercised by the in-repo evidence scripts under
 * src/extensions/sandbox/__spikes__/.
 *
 * The thin impure probes (probeUserns / probeCgroupV2Delegation /
 * probeKvm / probeLandlockAbi) are exercised live (they must never throw —
 * they fail-closed to false/null) plus the cache accessor + reset.
 */
import { test, expect, describe } from "bun:test";
import {
  selectTier,
  probeUserns,
  probeCgroupV2Delegation,
  probeKvm,
  probeLandlockAbi,
  probeSandboxCapabilities,
  getSandboxCapabilities,
  getSandboxTier,
  __resetSandboxCapabilitiesCache,
  type ProbeOutcomes,
} from "../extensions/sandbox/capability-probe";

function outcomes(over: Partial<ProbeOutcomes>): ProbeOutcomes {
  return {
    landlockAbi: null,
    userns: false,
    cgroupV2Delegation: false,
    kvm: false,
    arch: "x64",
    ...over,
  };
}

describe("selectTier — pure tier selection", () => {
  test("bwrap: usable Landlock + userns", () => {
    const r = selectTier(outcomes({ landlockAbi: 5, userns: true }));
    expect(r).toEqual({ tier: "bwrap", landlockUsable: true });
  });

  test("landlock: usable Landlock, no userns", () => {
    const r = selectTier(outcomes({ landlockAbi: 1, userns: false }));
    expect(r).toEqual({ tier: "landlock", landlockUsable: true });
  });

  test("advisory: Landlock ABI null (unsupported)", () => {
    const r = selectTier(outcomes({ landlockAbi: null, userns: true }));
    expect(r).toEqual({ tier: "advisory", landlockUsable: false });
  });

  test("advisory: Landlock ABI 0 (no support) even with userns", () => {
    const r = selectTier(outcomes({ landlockAbi: 0, userns: true }));
    expect(r).toEqual({ tier: "advisory", landlockUsable: false });
  });

  test("advisory: non-x86_64 arch disables Landlock even if ABI>0", () => {
    const r = selectTier(outcomes({ landlockAbi: 4, userns: true, arch: "arm64" }));
    expect(r).toEqual({ tier: "advisory", landlockUsable: false });
  });

  test("landlock tier ignores cgroup/kvm (informational only)", () => {
    const r = selectTier(
      outcomes({ landlockAbi: 2, userns: false, cgroupV2Delegation: true, kvm: true }),
    );
    expect(r).toEqual({ tier: "landlock", landlockUsable: true });
  });

  test("boundary: ABI exactly 1 on x64 is usable", () => {
    const r = selectTier(outcomes({ landlockAbi: 1, userns: false, arch: "x64" }));
    expect(r.landlockUsable).toBe(true);
    expect(r.tier).toBe("landlock");
  });
});

describe("impure probes — never throw, fail-closed", () => {
  test("probeUserns returns a boolean", () => {
    expect(typeof probeUserns()).toBe("boolean");
  });

  test("probeCgroupV2Delegation returns a boolean", () => {
    expect(typeof probeCgroupV2Delegation()).toBe("boolean");
  });

  test("probeKvm returns a boolean", () => {
    expect(typeof probeKvm()).toBe("boolean");
  });

  test("probeLandlockAbi returns number|null", () => {
    const v = probeLandlockAbi();
    expect(v === null || typeof v === "number").toBe(true);
    if (typeof v === "number") expect(v).toBeGreaterThan(0);
  });
});

describe("probeSandboxCapabilities + cache", () => {
  test("resolves a complete, self-consistent capability set", () => {
    const caps = probeSandboxCapabilities();
    expect(["bwrap", "landlock", "advisory"]).toContain(caps.tier);
    expect(typeof caps.landlockUsable).toBe("boolean");
    // tier must agree with the pure selector given the same outcomes
    const { tier, landlockUsable } = selectTier(caps);
    expect(caps.tier).toBe(tier);
    expect(caps.landlockUsable).toBe(landlockUsable);
  });

  test("getSandboxCapabilities memoizes (same object across calls)", () => {
    __resetSandboxCapabilitiesCache();
    const a = getSandboxCapabilities();
    const b = getSandboxCapabilities();
    expect(a).toBe(b);
  });

  test("getSandboxTier returns the cached tier", () => {
    __resetSandboxCapabilitiesCache();
    const t = getSandboxTier();
    expect(t).toBe(getSandboxCapabilities().tier);
  });

  test("__resetSandboxCapabilitiesCache forces a re-probe", () => {
    const a = getSandboxCapabilities();
    __resetSandboxCapabilitiesCache();
    const b = getSandboxCapabilities();
    expect(a).not.toBe(b); // different object identity after reset
    expect(a.tier).toBe(b.tier); // but same resolved tier on this host
  });
});
