/**
 * Phase A1 — capability-probe tier-selection unit coverage.
 *
 * The GO/NO-GO gate hinges on the probe resolving the correct tier from
 * each combination of primitive availability. `selectTier` is PURE, so we
 * exhaustively cover every branch (bwrap / landlock / advisory) by feeding
 * synthetic ProbeOutcomes — no syscalls, no spawns. The live FFI probes
 * are exercised by the in-repo evidence scripts under
 * scripts/spikes/.
 *
 * The thin impure probes (probeUserns / probeCgroupV2Delegation /
 * probeKvm / probeLandlockAbi) are exercised live (they must never throw —
 * they fail-closed to false/null) plus the cache accessor + reset.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import {
  findBwrap,
  selectTier,
  probeUserns,
  probeCgroupV2Delegation,
  probeKvm,
  probeLandlockAbi,
  probeSandboxCapabilities,
  getSandboxCapabilities,
  getSandboxTier,
  bwrapIsSetuid,
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
    bwrapSetuid: false,
    // Default to a bwrap being installed: these cases are about the OTHER
    // primitives, and the absent-bwrap case gets its own explicit test.
    bwrapPresent: true,
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

  test("landlock (not bwrap): userns works but bwrap is setuid-root", () => {
    // The setuid bwrap can't run our jail (rejects --size; runtime lives
    // behind /run symlinks the bind-set misses), so we drop to landlock
    // even though userns is available — real fs confinement is preserved.
    const r = selectTier(outcomes({ landlockAbi: 5, userns: true, bwrapSetuid: true }));
    expect(r).toEqual({ tier: "landlock", landlockUsable: true });
  });

  test("landlock (not bwrap): userns works but NO bwrap is installed", () => {
    // The regression this guards: `bwrapSetuid` is false both for a plain
    // bwrap and for no bwrap at all, so selecting on `!bwrapSetuid` alone
    // picked the bwrap tier on images without bubblewrap and produced an
    // argv (`["bwrap", ...]`) that dies with "Executable not found in
    // $PATH". Docker masked it by blocking userns; rootless Podman allows
    // userns, so the dev stack hit it the moment it moved runtimes.
    const r = selectTier(outcomes({ landlockAbi: 5, userns: true, bwrapPresent: false }));
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

describe("bwrapIsSetuid — detects setuid-root bwrap on PATH", () => {
  const ORIG_PATH = process.env.PATH;
  let dir: string | null = null;

  afterEach(() => {
    process.env.PATH = ORIG_PATH;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test("returns true when the first bwrap on PATH carries the setuid bit", () => {
    dir = mkdtempSync(join(tmpdir(), "bwrap-setuid-"));
    const fake = join(dir, "bwrap");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    // Bun's chmodSync masks off the setuid bit (it only honors the low
    // permission bits), so set it via the system `chmod`, which preserves
    // it — exactly the mode NixOS' /run/wrappers/bin/bwrap carries.
    const r = spawnSync("chmod", ["4755", fake]);
    if (r.status !== 0) throw new Error("chmod 4755 failed in test setup");
    process.env.PATH = dir;
    expect(bwrapIsSetuid()).toBe(true);
  });

  test("returns false for a plain (non-setuid) bwrap", () => {
    dir = mkdtempSync(join(tmpdir(), "bwrap-plain-"));
    const fake = join(dir, "bwrap");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n"); // default 0644 — no setuid
    process.env.PATH = dir;
    expect(bwrapIsSetuid()).toBe(false);
  });

  test("returns false when no bwrap exists on PATH", () => {
    dir = mkdtempSync(join(tmpdir(), "bwrap-none-"));
    process.env.PATH = dir;
    expect(bwrapIsSetuid()).toBe(false);
  });
});

describe("findBwrap — presence and setuid-ness from ONE lookup", () => {
  const ORIG_PATH = process.env.PATH;
  let dir: string | null = null;

  afterEach(() => {
    process.env.PATH = ORIG_PATH;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test("null when PATH holds no bwrap — the case that used to read as 'plain'", () => {
    dir = mkdtempSync(join(tmpdir(), "findbwrap-none-"));
    process.env.PATH = dir;
    expect(findBwrap()).toBeNull();
  });

  test("reports the resolved path and setuid=false for a plain bwrap", () => {
    dir = mkdtempSync(join(tmpdir(), "findbwrap-plain-"));
    const fake = join(dir, "bwrap");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    process.env.PATH = dir;
    expect(findBwrap()).toEqual({ path: fake, setuid: false });
  });

  test("reports setuid=true for a setuid-root bwrap", () => {
    dir = mkdtempSync(join(tmpdir(), "findbwrap-setuid-"));
    const fake = join(dir, "bwrap");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    const r = spawnSync("chmod", ["4755", fake]);
    if (r.status !== 0) throw new Error("chmod 4755 failed in test setup");
    process.env.PATH = dir;
    expect(findBwrap()).toEqual({ path: fake, setuid: true });
  });

  test("skips PATH entries that do not contain bwrap and takes the first hit", () => {
    dir = mkdtempSync(join(tmpdir(), "findbwrap-order-"));
    const empty = join(dir, "empty");
    const holding = join(dir, "holding");
    mkdirSync(empty);
    mkdirSync(holding);
    const fake = join(holding, "bwrap");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    // Empty dir first, plus a stray "" entry — exec() would skip both.
    process.env.PATH = `${empty}${delimiter}${delimiter}${holding}`;
    expect(findBwrap()).toEqual({ path: fake, setuid: false });
  });
});

describe("the probe never selects a tier it cannot execute", () => {
  /**
   * Live host check, and the coupling the unit cases can't give: it holds
   * the RESOLVED tier against the actual filesystem rather than against
   * synthetic outcomes. If `probeSandboxCapabilities` ever reports the
   * bwrap tier on a machine with no bwrap, extension spawning is broken on
   * that machine and this fails there — regardless of which container
   * runtime or distro CI happens to run on.
   */
  test("bwrapPresent mirrors the filesystem, and bwrap tier implies a binary", () => {
    __resetSandboxCapabilitiesCache();
    const caps = probeSandboxCapabilities();
    expect(caps.bwrapPresent).toBe(findBwrap() !== null);
    expect(caps.tier === "bwrap" && !caps.bwrapPresent).toBe(false);
  });
});
