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
  grantsToCapabilitySet,
  intersect,
  intersectPermissions,
  isSubset,
  type Capability,
  type CapabilitySet,
} from "../extensions/capability-types";
import type { CapabilityDeclaration, ExtensionPermissions } from "../extensions/types";

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

// ── intersectPermissions ────────────────────────────────────────────
//
// Phase 4 helper. Operates at the `ExtensionPermissions` shape level
// so callers can persist the result back into
// `conversation_extensions.effective_granted_permissions` without
// flattening to/from `CapabilitySet`.

describe("intersectPermissions — network", () => {
  test("disjoint network arrays → no network in result", () => {
    const a: ExtensionPermissions = { network: ["foo.com"], grantedAt: {} };
    const b: ExtensionPermissions = { network: ["bar.com"], grantedAt: {} };
    const r = intersectPermissions(a, b);
    expect(r.network).toBeUndefined();
  });

  test("full overlap → returns the shared host list (deduped, lowercased)", () => {
    const a: ExtensionPermissions = { network: ["FOO.com", "bar.com"], grantedAt: {} };
    const b: ExtensionPermissions = { network: ["foo.com", "bar.com"], grantedAt: {} };
    const r = intersectPermissions(a, b);
    expect(r.network).toEqual(["foo.com", "bar.com"]);
  });

  test("partial overlap → only the shared host(s)", () => {
    const a: ExtensionPermissions = { network: ["foo.com", "evil.com"], grantedAt: {} };
    const b: ExtensionPermissions = { network: ["foo.com", "bar.com"], grantedAt: {} };
    expect(intersectPermissions(a, b).network).toEqual(["foo.com"]);
  });

  test("one side missing network → result has no network field", () => {
    const a: ExtensionPermissions = { grantedAt: {} };
    const b: ExtensionPermissions = { network: ["foo.com"], grantedAt: {} };
    expect(intersectPermissions(a, b).network).toBeUndefined();
  });
});

describe("intersectPermissions — filesystem", () => {
  test("identical paths → preserved", () => {
    const a: ExtensionPermissions = { filesystem: ["/data"], grantedAt: {} };
    const b: ExtensionPermissions = { filesystem: ["/data"], grantedAt: {} };
    expect(intersectPermissions(a, b).filesystem).toEqual(["/data"]);
  });

  test("path-prefix intersection: /foo (a) + /foo/bar (b) → /foo/bar wins", () => {
    const a: ExtensionPermissions = { filesystem: ["/foo"], grantedAt: {} };
    const b: ExtensionPermissions = { filesystem: ["/foo/bar"], grantedAt: {} };
    expect(intersectPermissions(a, b).filesystem).toEqual(["/foo/bar"]);
  });

  test("disjoint paths → no filesystem field", () => {
    const a: ExtensionPermissions = { filesystem: ["/foo"], grantedAt: {} };
    const b: ExtensionPermissions = { filesystem: ["/bar"], grantedAt: {} };
    expect(intersectPermissions(a, b).filesystem).toBeUndefined();
  });

  test("non-prefix textual overlap (/foo vs /foobar) → no overlap", () => {
    const a: ExtensionPermissions = { filesystem: ["/foo"], grantedAt: {} };
    const b: ExtensionPermissions = { filesystem: ["/foobar"], grantedAt: {} };
    expect(intersectPermissions(a, b).filesystem).toBeUndefined();
  });

  test("mode-array intersection at the CapabilityDeclaration → CapabilitySet layer: read+write ∩ read = read (no fs.write)", () => {
    // Spec phase-4-cross-ext-attribution.md:247 — read+write ∩ read =
    // read at the cap-set layer (the place mode actually lives).
    // `ExtensionPermissions.filesystem` is path-only (no mode field),
    // so we exercise the round-trip through
    // capabilityDeclarationToSet → intersect. This pins that the
    // narrower mode side wins.
    const wide = capabilityDeclarationToSet(
      { filesystem: { paths: ["/data"], mode: ["read", "write"] } },
      {},
    );
    const narrow = capabilityDeclarationToSet(
      { filesystem: { paths: ["/data"], mode: ["read"] } },
      {},
    );
    const result = intersect(wide, narrow);
    const kinds = result.map((c) => c.kind).sort();
    // wide emits: fs.read+fs.list+fs.stat+fs.write
    // narrow emits: fs.read+fs.list+fs.stat (NO fs.write)
    // intersection drops fs.write since narrow doesn't have it.
    expect(kinds).toEqual(["fs.list", "fs.read", "fs.stat"]);
    expect(kinds).not.toContain("fs.write");
  });

  test("mode-array intersection: write-only ∩ read-only = empty", () => {
    const writeOnly = capabilityDeclarationToSet(
      { filesystem: { paths: ["/data"], mode: ["write"] } },
      {},
    );
    const readOnly = capabilityDeclarationToSet(
      { filesystem: { paths: ["/data"], mode: ["read"] } },
      {},
    );
    expect(intersect(writeOnly, readOnly)).toEqual([]);
  });
});

describe("intersectPermissions — shell, env, storage", () => {
  test("shell AND truth table — full 9-cell coverage", () => {
    const tt = (sa: boolean | undefined, sb: boolean | undefined) =>
      intersectPermissions(
        { shell: sa, grantedAt: {} } as ExtensionPermissions,
        { shell: sb, grantedAt: {} } as ExtensionPermissions,
      ).shell;
    // (true, *) — only true∧true emits
    expect(tt(true, true)).toBe(true);
    expect(tt(true, false)).toBeUndefined();
    expect(tt(true, undefined)).toBeUndefined();
    // (false, *) — never emits
    expect(tt(false, true)).toBeUndefined();
    expect(tt(false, false)).toBeUndefined();
    expect(tt(false, undefined)).toBeUndefined();
    // (undefined, *) — never emits
    expect(tt(undefined, true)).toBeUndefined();
    expect(tt(undefined, false)).toBeUndefined();
    expect(tt(undefined, undefined)).toBeUndefined();
  });

  test("env array intersection", () => {
    const a: ExtensionPermissions = { env: ["FOO", "BAR"], grantedAt: {} };
    const b: ExtensionPermissions = { env: ["BAR", "BAZ"], grantedAt: {} };
    expect(intersectPermissions(a, b).env).toEqual(["BAR"]);
  });

  test("storage AND truth table", () => {
    expect(
      intersectPermissions(
        { storage: true, grantedAt: {} },
        { storage: true, grantedAt: {} },
      ).storage,
    ).toBe(true);
    expect(
      intersectPermissions(
        { storage: true, grantedAt: {} },
        { storage: false, grantedAt: {} } as ExtensionPermissions,
      ).storage,
    ).toBeUndefined();
  });
});

describe("intersectPermissions — capability tier", () => {
  test("taskEvents AND truth table — full 9-cell coverage", () => {
    const tt = (a: boolean | undefined, b: boolean | undefined) =>
      intersectPermissions(
        { taskEvents: a, grantedAt: {} } as ExtensionPermissions,
        { taskEvents: b, grantedAt: {} } as ExtensionPermissions,
      ).taskEvents;
    // (true, *) — only true∧true emits
    expect(tt(true, true)).toBe(true);
    expect(tt(true, false)).toBeUndefined();
    expect(tt(true, undefined)).toBeUndefined();
    // (false, *) — never emits
    expect(tt(false, true)).toBeUndefined();
    expect(tt(false, false)).toBeUndefined();
    expect(tt(false, undefined)).toBeUndefined();
    // (undefined, *) — never emits
    expect(tt(undefined, true)).toBeUndefined();
    expect(tt(undefined, false)).toBeUndefined();
    expect(tt(undefined, undefined)).toBeUndefined();
  });

  test("agentConfig: both 'read' → 'read'; only one 'read' → absent", () => {
    expect(
      intersectPermissions(
        { agentConfig: "read", grantedAt: {} },
        { agentConfig: "read", grantedAt: {} },
      ).agentConfig,
    ).toBe("read");
    expect(
      intersectPermissions(
        { agentConfig: "read", grantedAt: {} },
        { grantedAt: {} },
      ).agentConfig,
    ).toBeUndefined();
  });

  test("spawnAgents: takes min of maxPerHour and maxConcurrent", () => {
    const r = intersectPermissions(
      { spawnAgents: { maxPerHour: 10, maxConcurrent: 5 }, grantedAt: {} },
      { spawnAgents: { maxPerHour: 20, maxConcurrent: 2 }, grantedAt: {} },
    );
    expect(r.spawnAgents).toEqual({ maxPerHour: 10, maxConcurrent: 2 });
  });

  test("spawnAgents: missing on one side → result has no spawnAgents", () => {
    const r = intersectPermissions(
      { spawnAgents: { maxPerHour: 10 }, grantedAt: {} },
      { grantedAt: {} },
    );
    expect(r.spawnAgents).toBeUndefined();
  });

  test("eventSubscriptions: array intersection", () => {
    const r = intersectPermissions(
      { eventSubscriptions: ["x:y", "a:b"], grantedAt: {} },
      { eventSubscriptions: ["a:b", "c:d"], grantedAt: {} },
    );
    expect(r.eventSubscriptions).toEqual(["a:b"]);
  });

  test("appendMessages: OR on excludedDefault (force-exclude wins, both sides)", () => {
    // Phase 4 §M5 — clip semantics. If EITHER side says
    // "excludedDefault: true", the intersection forces excluded.
    // AND would have let `false ∩ true → false` accidentally
    // publish turns the restrictive side wanted hidden.
    const r1 = intersectPermissions(
      { appendMessages: { excludedDefault: true }, grantedAt: {} },
      { appendMessages: { excludedDefault: true }, grantedAt: {} },
    );
    expect(r1.appendMessages).toEqual({ excludedDefault: true });

    // Restrictive side wins: (true, false) → true.
    const r2 = intersectPermissions(
      { appendMessages: { excludedDefault: true }, grantedAt: {} },
      { appendMessages: { excludedDefault: false }, grantedAt: {} },
    );
    expect(r2.appendMessages).toEqual({ excludedDefault: true });

    // Symmetric: (false, true) → true.
    const r3 = intersectPermissions(
      { appendMessages: { excludedDefault: false }, grantedAt: {} },
      { appendMessages: { excludedDefault: true }, grantedAt: {} },
    );
    expect(r3.appendMessages).toEqual({ excludedDefault: true });

    // Neither side restrictive: (false, false) → false.
    const r4 = intersectPermissions(
      { appendMessages: { excludedDefault: false }, grantedAt: {} },
      { appendMessages: { excludedDefault: false }, grantedAt: {} },
    );
    expect(r4.appendMessages).toEqual({ excludedDefault: false });

    // Missing on EITHER side → no appendMessages in result (both
    // sides must declare for the field to survive intersection).
    const r5 = intersectPermissions(
      { appendMessages: { excludedDefault: true }, grantedAt: {} },
      { grantedAt: {} },
    );
    expect(r5.appendMessages).toBeUndefined();
    const r6 = intersectPermissions(
      { grantedAt: {} },
      { appendMessages: { excludedDefault: false }, grantedAt: {} },
    );
    expect(r6.appendMessages).toBeUndefined();
  });
});

describe("intersectPermissions — grantedAt audit trail", () => {
  test("preserves the OLDER timestamp when both sides have it", () => {
    const r = intersectPermissions(
      { network: ["foo.com"], grantedAt: { network: 100 } },
      { network: ["foo.com"], grantedAt: { network: 50 } },
    );
    expect(r.grantedAt.network).toBe(50);
  });

  test("drops grantedAt entries for fields that didn't survive", () => {
    const r = intersectPermissions(
      { shell: true, grantedAt: { shell: 100 } },
      { grantedAt: { shell: 50 } } as ExtensionPermissions,
    );
    expect(r.grantedAt.shell).toBeUndefined();
  });

  test("uses the surviving side's grantedAt when only one side has a timestamp", () => {
    const r = intersectPermissions(
      { network: ["foo.com"], grantedAt: { network: 100 } },
      { network: ["foo.com"], grantedAt: {} },
    );
    expect(r.grantedAt.network).toBe(100);
  });
});

describe("intersectPermissions — empty / disjoint", () => {
  test("two empty permission objects → empty result", () => {
    const r = intersectPermissions({ grantedAt: {} }, { grantedAt: {} });
    expect(r).toEqual({ grantedAt: {} });
  });

  test("one fully populated, the other empty → mostly empty result", () => {
    const a: ExtensionPermissions = {
      network: ["foo.com"],
      filesystem: ["/data"],
      shell: true,
      storage: true,
      env: ["FOO"],
      taskEvents: true,
      agentConfig: "read",
      spawnAgents: { maxPerHour: 5 },
      eventSubscriptions: ["x:y"],
      appendMessages: { excludedDefault: true },
      grantedAt: { shell: 1 },
    };
    const r = intersectPermissions(a, { grantedAt: {} });
    expect(r.network).toBeUndefined();
    expect(r.filesystem).toBeUndefined();
    expect(r.shell).toBeUndefined();
    expect(r.storage).toBeUndefined();
    expect(r.env).toBeUndefined();
    expect(r.taskEvents).toBeUndefined();
    expect(r.agentConfig).toBeUndefined();
    expect(r.spawnAgents).toBeUndefined();
    expect(r.eventSubscriptions).toBeUndefined();
    expect(r.appendMessages).toBeUndefined();
    expect(r.grantedAt).toEqual({});
  });
});

// ── grantsToCapabilitySet — $CWD expansion ──────────────────────────
//
// Regression for the PDP-side `$CWD` gap: pre-fix, `grantsToCapabilitySet`
// pushed the literal string "$CWD" as the cap value. The fs-handler
// authorizes against a realpath-resolved ABSOLUTE path, so the
// PDP's prefix-match (`g.value === n.value || n.value.startsWith(g.value + "/")`)
// could never match an absolute needed path against a "$CWD"-shaped
// grant — the engine wrongly denied writes that the fs-handler's own
// pre-PDP check had already approved (it expands `$CWD` via
// `expandGrantPrefix` at `permissions.ts:97`). Fixed by expanding at
// grant→cap translation time so both sides see the same resolved root.

describe("grantsToCapabilitySet — $CWD expansion", () => {
  test("filesystem grant `$CWD` expands to process.cwd() in every fs.* cap", () => {
    const grants: ExtensionPermissions = {
      grantedAt: {},
      filesystem: ["$CWD"],
    };
    const caps = grantsToCapabilitySet(grants);
    const cwd = process.cwd();
    const fsKinds = ["fs.read", "fs.list", "fs.stat", "fs.write"] as const;
    for (const kind of fsKinds) {
      const cap = caps.find((c) => c.kind === kind);
      expect(cap).toBeDefined();
      expect(cap!.value).toBe(cwd);
      // The literal string must NOT survive — that was the bug.
      expect(cap!.value).not.toBe("$CWD");
    }
  });

  test("filesystem grant `$CWD/<sub>` expands to <cwd>/<sub>", () => {
    const grants: ExtensionPermissions = {
      grantedAt: {},
      filesystem: ["$CWD/.ezcorp/extension-data"],
    };
    const caps = grantsToCapabilitySet(grants);
    const writeCap = caps.find((c) => c.kind === "fs.write");
    expect(writeCap).toBeDefined();
    expect(writeCap!.value).toBe(`${process.cwd()}/.ezcorp/extension-data`);
  });

  test("filesystem grant `/etc/passwd` (absolute) passes through unchanged", () => {
    const grants: ExtensionPermissions = {
      grantedAt: {},
      filesystem: ["/etc/passwd"],
    };
    const caps = grantsToCapabilitySet(grants);
    const writeCap = caps.find((c) => c.kind === "fs.write");
    expect(writeCap!.value).toBe("/etc/passwd");
  });

  test("PDP cover-check: `$CWD` grant now matches a realpath-absolute needed cap (regression)", () => {
    // This is the production failure mode: the fs-handler emits a cap
    // whose value is the realpath'd absolute path (`/<cwd>/foo/bar`).
    // Pre-fix, the literal `$CWD` grant could not cover it. Post-fix,
    // the grant expands to `<cwd>` and the prefix-match succeeds.
    const grants: ExtensionPermissions = {
      grantedAt: {},
      filesystem: ["$CWD"],
    };
    const granted = grantsToCapabilitySet(grants);
    const needed: CapabilitySet = [
      { kind: "fs.write", value: `${process.cwd()}/.ezcorp/extension-data/openai-image-gen-2/generated` },
    ];
    expect(isSubset(needed, granted)).toBe(true);
    expect(firstMissingCapability(needed, granted)).toBeNull();
  });
});

// ── capabilityDeclarationToSet — $CWD expansion ─────────────────────

describe("capabilityDeclarationToSet — $CWD expansion in declared paths", () => {
  test("tool-level filesystem.paths `$CWD` expands the same way as grants", () => {
    const decl: CapabilityDeclaration = {
      filesystem: { paths: ["$CWD"], mode: ["write"] },
    };
    const caps = capabilityDeclarationToSet(decl, {});
    const writeCap = caps.find((c) => c.kind === "fs.write");
    expect(writeCap).toBeDefined();
    expect(writeCap!.value).toBe(process.cwd());
    expect(writeCap!.value).not.toBe("$CWD");
  });
});

// ── grantsToCapabilitySet — derived install cap ─────────────────────
//
// `extension-author`'s existing `custom.drafts.kinds:["extension"]`
// grant implies the sensitive `ezcorp:extension:install` cap so the
// PDP subset check passes and the agent-driven install reaches the
// mandatory user-approval prompt (instead of being denied as an
// ungranted cap). It is a BOOLEAN cap (no value) — must match a
// valueless needed cap via `capabilityCovers`.

describe("grantsToCapabilitySet — ezcorp:extension:install derivation", () => {
  const installCap = { kind: "ezcorp:extension:install" as const };

  test("custom.drafts.kinds:['extension'] derives a valueless install cap", () => {
    const caps = grantsToCapabilitySet({
      grantedAt: {},
      custom: { drafts: { kinds: ["extension"] } },
    });
    const found = caps.find((c) => c.kind === "ezcorp:extension:install");
    expect(found).toEqual(installCap);
    expect(found!.value).toBeUndefined();
  });

  test("the derived cap COVERS a valueless needed install cap (subset passes)", () => {
    const granted = grantsToCapabilitySet({
      grantedAt: {},
      custom: { drafts: { kinds: ["extension"] } },
    });
    expect(isSubset([installCap], granted)).toBe(true);
  });

  test("NOT derived when drafts.kinds lacks 'extension'", () => {
    const caps = grantsToCapabilitySet({
      grantedAt: {},
      custom: { drafts: { kinds: ["project", "agent"] } },
    });
    expect(caps.some((c) => c.kind === "ezcorp:extension:install")).toBe(false);
  });

  test("NOT derived when custom/drafts absent", () => {
    expect(
      grantsToCapabilitySet({ grantedAt: {}, shell: true }).some(
        (c) => c.kind === "ezcorp:extension:install",
      ),
    ).toBe(false);
    expect(
      grantsToCapabilitySet(null).some(
        (c) => c.kind === "ezcorp:extension:install",
      ),
    ).toBe(false);
  });
});
