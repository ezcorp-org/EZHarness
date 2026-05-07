/**
 * Direct unit coverage for the capability-comparison helpers in
 * `src/extensions/capability-types.ts`. Spec section B mandates that
 * `intersect`, `isSubset`, `capabilityCovers`,
 * `firstMissingCapability`, and `capabilityDeclarationToSet` each
 * have explicit test cases — the broader engine + migration suites
 * exercise them transitively, but a refactor to the comparison
 * primitives needs a focused regression net.
 */

import { describe, expect, test } from "bun:test";
import {
  capabilityCovers,
  capabilityDeclarationToSet,
  firstMissingCapability,
  intersect,
  isSubset,
  type Capability,
  type CapabilitySet,
} from "../extensions/capability-types";
import type { CapabilityDeclaration } from "../extensions/types";

// ── intersect ────────────────────────────────────────────────────────

describe("intersect", () => {
  test("disjoint sets → empty", () => {
    const a: CapabilitySet = [{ kind: "shell" }];
    const b: CapabilitySet = [{ kind: "storage" }];
    expect(intersect(a, b)).toEqual([]);
  });

  test("full overlap → returns the shared caps (deduped)", () => {
    const both: CapabilitySet = [
      { kind: "network", value: "a.com" },
      { kind: "shell" },
    ];
    expect(intersect(both, both)).toEqual([
      { kind: "network", value: "a.com" },
      { kind: "shell" },
    ]);
  });

  test("partial overlap → only the matching cap survives", () => {
    const a: CapabilitySet = [
      { kind: "network", value: "a.com" },
      { kind: "shell" },
    ];
    const b: CapabilitySet = [{ kind: "shell" }, { kind: "storage" }];
    expect(intersect(a, b)).toEqual([{ kind: "shell" }]);
  });

  test("value-distinguished caps with different hostnames don't intersect", () => {
    const a: CapabilitySet = [{ kind: "network", value: "a.com" }];
    const b: CapabilitySet = [{ kind: "network", value: "b.com" }];
    expect(intersect(a, b)).toEqual([]);
  });

  test("dedups when `a` contains the same cap twice", () => {
    const a: CapabilitySet = [
      { kind: "network", value: "a.com" },
      { kind: "network", value: "a.com" },
    ];
    const b: CapabilitySet = [{ kind: "network", value: "a.com" }];
    expect(intersect(a, b)).toEqual([{ kind: "network", value: "a.com" }]);
  });
});

// ── isSubset ─────────────────────────────────────────────────────────

describe("isSubset", () => {
  test("empty needed → always a subset", () => {
    expect(isSubset([], [{ kind: "shell" }])).toBe(true);
    expect(isSubset([], [])).toBe(true);
  });

  test("equal sets → true", () => {
    const set: CapabilitySet = [{ kind: "shell" }, { kind: "storage" }];
    expect(isSubset(set, set)).toBe(true);
  });

  test("strict subset → true", () => {
    const needed: CapabilitySet = [{ kind: "shell" }];
    const granted: CapabilitySet = [
      { kind: "shell" },
      { kind: "storage" },
      { kind: "network", value: "a.com" },
    ];
    expect(isSubset(needed, granted)).toBe(true);
  });

  test("single missing cap → false", () => {
    const needed: CapabilitySet = [
      { kind: "shell" },
      { kind: "network", value: "a.com" },
    ];
    const granted: CapabilitySet = [{ kind: "shell" }];
    expect(isSubset(needed, granted)).toBe(false);
  });

  test("filesystem prefix-match: /foo covers /foo/bar", () => {
    expect(
      isSubset(
        [{ kind: "fs.read", value: "/foo/bar" }],
        [{ kind: "fs.read", value: "/foo" }],
      ),
    ).toBe(true);
  });
});

// ── capabilityCovers ─────────────────────────────────────────────────

describe("capabilityCovers", () => {
  test("kind mismatch → false even with identical value", () => {
    expect(
      capabilityCovers(
        { kind: "fs.read", value: "/x" },
        { kind: "fs.write", value: "/x" },
      ),
    ).toBe(false);
  });

  test("boolean caps: kind match alone covers", () => {
    expect(capabilityCovers({ kind: "shell" }, { kind: "shell" })).toBe(true);
    expect(capabilityCovers({ kind: "storage" }, { kind: "storage" })).toBe(true);
  });

  test("boolean granted vs valued needed → false (mismatched shapes)", () => {
    expect(
      capabilityCovers({ kind: "network" }, { kind: "network", value: "a.com" }),
    ).toBe(false);
  });

  test("filesystem prefix-match: /foo covers /foo and /foo/bar but NOT /foobar", () => {
    const granted: Capability = { kind: "fs.read", value: "/foo" };
    expect(capabilityCovers(granted, { kind: "fs.read", value: "/foo" })).toBe(true);
    expect(capabilityCovers(granted, { kind: "fs.read", value: "/foo/bar" })).toBe(true);
    expect(capabilityCovers(granted, { kind: "fs.read", value: "/foobar" })).toBe(false);
  });

  test("network/env: exact value match", () => {
    expect(
      capabilityCovers(
        { kind: "network", value: "a.com" },
        { kind: "network", value: "a.com" },
      ),
    ).toBe(true);
    expect(
      capabilityCovers(
        { kind: "network", value: "a.com" },
        { kind: "network", value: "subdomain.a.com" },
      ),
    ).toBe(false);
    expect(
      capabilityCovers(
        { kind: "env", value: "FOO" },
        { kind: "env", value: "FOO" },
      ),
    ).toBe(true);
  });

  test("namespaced ezcorp:* boolean caps: kind match covers", () => {
    expect(
      capabilityCovers({ kind: "ezcorp:tasks:emit" }, { kind: "ezcorp:tasks:emit" }),
    ).toBe(true);
  });
});

// ── firstMissingCapability ───────────────────────────────────────────

describe("firstMissingCapability", () => {
  test("returns null when granted ⊇ needed", () => {
    expect(
      firstMissingCapability(
        [{ kind: "shell" }],
        [{ kind: "shell" }, { kind: "storage" }],
      ),
    ).toBeNull();
  });

  test("returns null on empty needed", () => {
    expect(firstMissingCapability([], [{ kind: "shell" }])).toBeNull();
  });

  test("returns the FIRST missing cap (order-deterministic, not last)", () => {
    const needed: CapabilitySet = [
      { kind: "shell" }, // granted
      { kind: "network", value: "a.com" }, // MISSING (first)
      { kind: "storage" }, // also missing — must NOT be returned
    ];
    const granted: CapabilitySet = [{ kind: "shell" }];
    expect(firstMissingCapability(needed, granted)).toEqual({
      kind: "network",
      value: "a.com",
    });
  });

  test("identifies single missing cap correctly", () => {
    expect(
      firstMissingCapability(
        [{ kind: "fs.write", value: "/etc" }],
        [{ kind: "fs.write", value: "/home" }],
      ),
    ).toEqual({ kind: "fs.write", value: "/etc" });
  });
});

// ── capabilityDeclarationToSet ───────────────────────────────────────

describe("capabilityDeclarationToSet", () => {
  test("undefined declaration → empty set", () => {
    expect(capabilityDeclarationToSet(undefined, {})).toEqual([]);
  });

  test("empty declaration → empty set", () => {
    expect(capabilityDeclarationToSet({}, {})).toEqual([]);
  });

  test("network.hosts → one Capability per host (lowercased)", () => {
    const decl: CapabilityDeclaration = {
      network: { hosts: ["api.foo.com", "B.COM"] },
    };
    const result = capabilityDeclarationToSet(decl, {});
    expect(result).toEqual([
      { kind: "network", value: "api.foo.com" },
      { kind: "network", value: "b.com" },
    ]);
  });

  test("filesystem with mode=['read'] → fs.read + fs.list + fs.stat (no fs.write)", () => {
    const decl: CapabilityDeclaration = {
      filesystem: { paths: ["/data"], mode: ["read"] },
    };
    const caps = capabilityDeclarationToSet(decl, {});
    const kinds = caps.map((c) => c.kind);
    expect(kinds).toContain("fs.read");
    expect(kinds).toContain("fs.list");
    expect(kinds).toContain("fs.stat");
    expect(kinds).not.toContain("fs.write");
  });

  test("filesystem with mode=['write'] → fs.write only (no read/list/stat)", () => {
    const decl: CapabilityDeclaration = {
      filesystem: { paths: ["/data"], mode: ["write"] },
    };
    const caps = capabilityDeclarationToSet(decl, {});
    expect(caps).toEqual([{ kind: "fs.write", value: "/data" }]);
  });

  test("filesystem with mode=['read','write'] → all four kinds emitted", () => {
    const decl: CapabilityDeclaration = {
      filesystem: { paths: ["/data"], mode: ["read", "write"] },
    };
    const caps = capabilityDeclarationToSet(decl, {});
    const kinds = caps.map((c) => c.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["fs.read", "fs.list", "fs.stat", "fs.write"]),
    );
  });

  test("filesystem with mode=[] (empty) → defaults to read-only triad (read+list+stat)", () => {
    // The Phase 1 default for unspecified mode mirrors v2 fs flat
    // allowlist semantics — though the migration emits ["read","write"]
    // explicitly; an empty mode array falls through to the most-
    // permissive read-only defaults, NOT no caps at all.
    const decl: CapabilityDeclaration = {
      filesystem: { paths: ["/x"], mode: [] },
    };
    const caps = capabilityDeclarationToSet(decl, {});
    const kinds = caps.map((c) => c.kind);
    expect(kinds).toContain("fs.read");
    expect(kinds).toContain("fs.list");
    expect(kinds).toContain("fs.stat");
    expect(kinds).not.toContain("fs.write");
  });

  test("shell: true → single shell cap", () => {
    expect(capabilityDeclarationToSet({ shell: true }, {})).toEqual([
      { kind: "shell" },
    ]);
  });

  test("shell: false → no shell cap emitted", () => {
    const caps = capabilityDeclarationToSet({ shell: false }, {});
    expect(caps.find((c) => c.kind === "shell")).toBeUndefined();
  });

  test("env: ['VAR'] → one env cap per name", () => {
    expect(capabilityDeclarationToSet({ env: ["FOO", "BAR"] }, {})).toEqual([
      { kind: "env", value: "FOO" },
      { kind: "env", value: "BAR" },
    ]);
  });

  test("storage: true → single storage cap", () => {
    expect(capabilityDeclarationToSet({ storage: true }, {})).toEqual([
      { kind: "storage" },
    ]);
  });

  test("custom: { taskEvents: true } → ezcorp:tasks:emit cap", () => {
    expect(
      capabilityDeclarationToSet({ custom: { taskEvents: true } }, {}),
    ).toEqual([{ kind: "ezcorp:tasks:emit" }]);
  });

  test("custom: { eventSubscriptions: ['x:y'] } → namespaced cap with value", () => {
    expect(
      capabilityDeclarationToSet({ custom: { eventSubscriptions: ["x:y"] } }, {}),
    ).toEqual([{ kind: "ezcorp:events:subscribe", value: "x:y" }]);
  });

  test("custom: unknown key is dropped (forward-compat ignore)", () => {
    expect(
      capabilityDeclarationToSet(
        { custom: { unknownKey: ["x"] } },
        {},
      ),
    ).toEqual([]);
  });
});
