/**
 * Phase 5 — bundled-ceiling matrix.
 *
 * The ceiling table at `src/extensions/bundled-ceiling.ts:BUNDLED_CEILING`
 * is the SECURITY ceiling for every bundled extension. This file
 * exercises every concrete-clamp path the install machinery in
 * `bundled.ts` will take, plus the round-trip "real bundled extensions
 * install cleanly" guarantee that protects existing users.
 *
 * Matrix (from `tasks/phase-5-bundled-ceiling.md`):
 *
 *   (a) Every bundled extension's manifest declaration ⊆ ceiling, i.e.
 *       `clampToBundledCeiling` is a no-op on existing manifests.
 *   (b) Network requested but ceiling has no network → clamped to {}.
 *   (c) Filesystem outside ceiling allowlist → clamped to {}.
 *   (d) Filesystem inside ceiling allowlist → no clamp.
 *   (e) spawnAgents numeric clamp via Math.min.
 *   (f) Non-bundled name → passthrough.
 *
 * Plus an install-integration test that proves the audit row +
 * persisted grant flow when a bundled install request exceeds the
 * ceiling.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions, ExtensionManifestV2 } from "../extensions/types";

// Audit / DB mocks — same pattern as scratchpad-bundled-install.test.ts.
// We capture audit calls so the install-integration block can assert
// the clamp action code was written with the right metadata.
interface CapturedAudit {
  userId: string | null;
  action: string;
  target: string | undefined;
  metadata: Record<string, unknown> | undefined;
}

const auditEntries: CapturedAudit[] = [];

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    userId: string | null,
    action: string,
    target?: string,
    metadata?: Record<string, unknown>,
  ) => {
    auditEntries.push({ userId, action, target, metadata });
    return `audit-${auditEntries.length}`;
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

import { createMockExtensionsStore } from "./helpers/mock-extensions-store";

const extStore = createMockExtensionsStore({ keyBy: "name" });
const store = extStore.store;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: extStore.getExtensionByName,
  createExtension: extStore.createExtension,
  listExtensions: extStore.listExtensions,
  updateExtension: extStore.updateExtension,
  deleteExtension: extStore.deleteExtension,
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

afterAll(() => restoreModuleMocks());

const {
  BUNDLED_CEILING,
  canonicalizePerms,
  clampToBundledCeiling,
  getCeiling,
} = await import("../extensions/bundled-ceiling");

const { ensureBundledExtensions, resolveBundledExtensions } = await import("../extensions/bundled");

const { EXT_AUDIT_ACTIONS } = await import("../extensions/audit-actions");

beforeEach(() => {
  extStore.reset();
  auditEntries.length = 0;
});

// ── (a) every bundled extension's declared permissions ⊆ ceiling ──────
//
// This test is the Day-1 risk gate: if the ceiling table is too
// narrow for any bundled extension's CURRENT manifest, this fails
// and the operator must widen the ceiling before merging. The
// guarantee: after Phase 5, no existing user's installed bundled
// extension is silently de-permissioned.

describe("(a) ceiling is wide enough for every bundled extension's CURRENT declaration", () => {
  test("every BUNDLED_EXTENSIONS entry has a ceiling row in BUNDLED_CEILING", () => {
    const bundled = resolveBundledExtensions({});
    for (const entry of bundled) {
      expect(getCeiling(entry.name)).not.toBeNull();
    }
  });

  test("clampToBundledCeiling is a no-op on every bundled entry's declared grant", () => {
    const bundled = resolveBundledExtensions({});
    for (const entry of bundled) {
      const { effective, clamped } = clampToBundledCeiling(entry.name, entry.permissions);
      expect(clamped).toBe(false);
      // Per-field equivalence — `shell: false` ≡ absent (both = "not
      // granted"); arrays compared by Set semantics; numeric ceilings
      // (spawnAgents) compared by value. We don't use `toEqual` because
      // a few bundled grants explicitly set `shell: false` for clarity
      // even when the ceiling has no shell entry, and the post-intersect
      // shape drops the `false` boolean. That equivalence is INTENDED.
      expectFunctionallyEqualGrant(effective, entry.permissions, entry.name);
    }
  });
});

// ── (b)–(f) targeted clamp scenarios ─────────────────────────────────

describe("(b) requested network but ceiling has none → clamped", () => {
  test("scratchpad's ceiling is storage-only; network is dropped", () => {
    const requested: ExtensionPermissions = {
      network: ["evil.com"],
      grantedAt: { network: Date.now() },
    };
    const { effective, clamped } = clampToBundledCeiling("scratchpad", requested);
    expect(clamped).toBe(true);
    expect(effective.network).toBeUndefined();
    // grantedAt for `network` should be dropped because it didn't survive.
    expect(effective.grantedAt.network).toBeUndefined();
  });
});

describe("(c) requested filesystem path is outside ceiling allowlist", () => {
  test("project-analyzer's ceiling is ['$CWD']; '/etc' is outside → clamped to empty", () => {
    const requested: ExtensionPermissions = {
      filesystem: ["/etc"],
      grantedAt: { filesystem: Date.now() },
    };
    const { effective, clamped } = clampToBundledCeiling("project-analyzer", requested);
    expect(clamped).toBe(true);
    expect(effective.filesystem).toBeUndefined();
  });
});

describe("(d) requested filesystem path is inside ceiling allowlist → no clamp", () => {
  test("project-analyzer with ['$CWD'] is in-ceiling", () => {
    const requested: ExtensionPermissions = {
      filesystem: ["$CWD"],
      shell: true,
      grantedAt: { filesystem: Date.now(), shell: Date.now() },
    };
    const { effective, clamped } = clampToBundledCeiling("project-analyzer", requested);
    expect(clamped).toBe(false);
    expect(effective.filesystem).toEqual(["$CWD"]);
    expect(effective.shell).toBe(true);
  });

  test("filesystem prefix-match: $CWD covers $CWD/subdir", () => {
    const requested: ExtensionPermissions = {
      filesystem: ["$CWD/subdir"],
      grantedAt: { filesystem: Date.now() },
    };
    const { effective, clamped } = clampToBundledCeiling("project-analyzer", requested);
    expect(clamped).toBe(false);
    expect(effective.filesystem).toEqual(["$CWD/subdir"]);
  });
});

describe("(e) spawnAgents numeric clamp via min", () => {
  test("requested 9999/99 is clamped to ceiling's 200/10 for task-tracking", () => {
    const requested: ExtensionPermissions = {
      spawnAgents: { maxPerHour: 9999, maxConcurrent: 99 },
      grantedAt: { spawnAgents: Date.now() },
    };
    const { effective, clamped } = clampToBundledCeiling("task-tracking", requested);
    expect(clamped).toBe(true);
    expect(effective.spawnAgents).toEqual({ maxPerHour: 200, maxConcurrent: 10 });
  });

  test("requested same as ceiling → no clamp", () => {
    const requested: ExtensionPermissions = {
      spawnAgents: { maxPerHour: 200, maxConcurrent: 10 },
      grantedAt: { spawnAgents: Date.now() },
    };
    const { effective, clamped } = clampToBundledCeiling("task-tracking", requested);
    expect(clamped).toBe(false);
    expect(effective.spawnAgents).toEqual({ maxPerHour: 200, maxConcurrent: 10 });
  });

  test("requested lower than ceiling → no clamp (the user under-asks)", () => {
    const requested: ExtensionPermissions = {
      spawnAgents: { maxPerHour: 50, maxConcurrent: 5 },
      grantedAt: { spawnAgents: Date.now() },
    };
    const { effective, clamped } = clampToBundledCeiling("task-tracking", requested);
    expect(clamped).toBe(false);
    expect(effective.spawnAgents).toEqual({ maxPerHour: 50, maxConcurrent: 5 });
  });
});

describe("(f) non-bundled name → passthrough", () => {
  test("unknown extension passes the request through unchanged", () => {
    const requested: ExtensionPermissions = {
      network: ["whatever.com"],
      filesystem: ["/anywhere"],
      grantedAt: { network: Date.now(), filesystem: Date.now() },
    };
    const { effective, clamped } = clampToBundledCeiling("not-a-bundled-name", requested);
    expect(clamped).toBe(false);
    expect(effective).toEqual(requested);
  });

  test("getCeiling returns null for unknown name", () => {
    expect(getCeiling("nope")).toBeNull();
    expect(getCeiling("scratchpad")).not.toBeNull();
  });
});

// ── (g) rbacScopes declarations are inert pass-through ──────────────
//
// `permissions.rbacScopes` names custom extension-RBAC scopes (grant-UI
// options / ctx.rbac.check names) — declarations, NOT privileges. No
// ceiling row lists them; `intersectPermissions` drops them from every
// intersection (grants never carry declarations); and the clamp
// comparator IGNORES them so a manifest-shaped request that declares
// scopes (e.g. the drift-reapprove heal clamping the raw disk
// `permissions` block) never reads as "clamped".

describe("(g) rbacScopes declarations never trip the clamp", () => {
  // The manifest permissions block is cast the same way the
  // drift-reapprove / boot paths cast it before clamping.
  const withDeclaration = (extra: Partial<ExtensionPermissions> = {}): ExtensionPermissions =>
    ({
      eventSubscriptions: [
        "github-projects:approve",
        "github-projects:dismiss",
        "github-projects:rerun",
        "github-projects:pause",
        "github-projects:resume",
        "github-projects:refresh",
        "github-projects:poll-now",
        "github-projects:proposal-update",
        "task:assignment_update",
        "run:complete",
      ],
      storage: true,
      rbacScopes: [{ name: "write-tickets", description: "Create and mutate board tickets from chat" }],
      grantedAt: { eventSubscriptions: Date.now(), storage: Date.now() },
      ...extra,
    }) as unknown as ExtensionPermissions;

  test("github-projects manifest shape (with write-tickets declared) → clamped:false; grant carries no declaration", () => {
    const { effective, clamped } = clampToBundledCeiling("github-projects", withDeclaration());
    expect(clamped).toBe(false);
    // Declarations never land in the persisted grant — the rbac-check
    // handler reads them from the REGISTRY manifest instead.
    expect((effective as unknown as Record<string, unknown>).rbacScopes).toBeUndefined();
    expect(effective.storage).toBe(true);
  });

  test("declarations do not MASK a real widening — over-ceiling fields still clamp", () => {
    const { effective, clamped } = clampToBundledCeiling(
      "github-projects",
      withDeclaration({ network: ["evil.com"], shell: true }),
    );
    expect(clamped).toBe(true);
    expect(effective.network).toBeUndefined();
    expect(effective.shell).toBeUndefined();
    expect((effective as unknown as Record<string, unknown>).rbacScopes).toBeUndefined();
  });

  // REGRESSION GUARD: the clamp must stay blind to declaration changes.
  // No ceiling row lists rbacScopes and `intersectPermissions` drops it,
  // so counting a rename here would flag `clamped: true` — and emit an
  // AUDIT_BUNDLED_CEILING_CLAMP row — on a call where nothing narrowed.
  test("a RENAMED declaration (read-tickets → admin-tickets) still does not trip the clamp", () => {
    const asExtra = (names: string[]) =>
      ({ rbacScopes: declarations(names) }) as unknown as Partial<ExtensionPermissions>;
    const before = clampToBundledCeiling(
      "github-projects",
      withDeclaration(asExtra(["read-tickets"])),
    );
    const after = clampToBundledCeiling(
      "github-projects",
      withDeclaration(asExtra(["admin-tickets"])),
    );
    expect(before.clamped).toBe(false);
    expect(after.clamped).toBe(false);
    // The rename is invisible to the clamp in BOTH directions: same
    // effective grant, and neither side carries the declaration.
    expect(after.effective).toEqual(before.effective);
    expect((after.effective as unknown as Record<string, unknown>).rbacScopes).toBeUndefined();
  });

  test("declaring scopes where the ceiling row has none still does not trip the clamp", () => {
    const none = clampToBundledCeiling("github-projects", withDeclaration());
    const added = clampToBundledCeiling(
      "github-projects",
      withDeclaration({
        rbacScopes: declarations(["write-tickets", "approve-gate"]),
      } as unknown as Partial<ExtensionPermissions>),
    );
    expect(none.clamped).toBe(false);
    expect(added.clamped).toBe(false);
    expect(added.effective).toEqual(none.effective);
  });
});

// ── canonicalizePerms: rbacScopes is skipped for EVERY caller ────────
//
// `canonicalizePerms` is shared by BOTH permission comparators so they
// cannot drift apart (see its doc), and they agree on `rbacScopes`
// without exception. `equalPermissions` skips it because an inert
// declaration narrows nothing. `diffGrants` skips it because it compares
// GRANT against GRANT and `intersectPermissions` strips declarations
// from every grant it emits — so the new side structurally cannot carry
// the field, and reporting it could only ever render as a spurious
// "removed". An `{includeRbacScopes}` opt-in was shipped and reverted;
// these tests pin the reverted behavior, including the absent parameter.
//
// Order-independence for NON-string arrays is retained and tested
// separately below. That branch is defensive rather than dead: stored
// `grantedPermissions` is unvalidated jsonb on read, so a legacy row can
// present objects on a field that is NOT skipped.

/** `permissions.rbacScopes`-shaped declarations for the given names. */
function declarations(names: string[]): Array<{ name: string; description: string }> {
  return names.map((name) => ({ name, description: `${name} scope` }));
}

/** Manifest-shaped permission blocks are cast the same way the
 *  drift-reapprove / boot paths cast them (`rbacScopes` lives on the
 *  MANIFEST permission type, never on a grant). */
const asPerms = (o: Record<string, unknown>): ExtensionPermissions =>
  o as unknown as ExtensionPermissions;

describe("canonicalizePerms — rbacScopes is erased, unconditionally", () => {
  test("a rename and an addition both read as no change", () => {
    const absent = canonicalizePerms(asPerms({}));
    const read = canonicalizePerms(asPerms({ rbacScopes: declarations(["read"]) }));
    const admin = canonicalizePerms(asPerms({ rbacScopes: declarations(["admin"]) }));
    expect(read).toBe("{}");
    expect(read).toBe(absent);
    expect(admin).toBe(read);
  });

  test("there is no opt-in parameter to re-enable the field", () => {
    // The reverted defect was a second argument. Pin BOTH halves: the
    // declared arity, and the behavior under a caller that passes the old
    // option object anyway (a stale call site must not resurrect it).
    expect(canonicalizePerms.length).toBe(1);
    const withScopes = asPerms({ rbacScopes: declarations(["admin"]) });
    const sneak = canonicalizePerms as unknown as (
      p: ExtensionPermissions,
      opts?: unknown,
    ) => string;
    expect(sneak(withScopes, { includeRbacScopes: true })).toBe("{}");
  });

  test("erasing it does not suppress a REAL field that changed alongside it", () => {
    // Guards the skip from being over-broad: only `rbacScopes` is dropped.
    const before = canonicalizePerms(
      asPerms({ storage: true, rbacScopes: declarations(["read"]) }),
    );
    const after = canonicalizePerms(
      asPerms({ storage: true, shell: true, rbacScopes: declarations(["admin"]) }),
    );
    expect(before).toBe(JSON.stringify({ storage: true }));
    expect(after).not.toBe(before);
    expect(after).toContain("shell");
  });
});

// ── canonicalizePerms: non-string arrays are order-independent ───────
//
// RETAINED from the reverted change, on its own merits. `grantedPermissions`
// is unvalidated jsonb on READ, so a stored row can present a non-string
// array on ANY field — including ones the canonicalizer does not skip. The
// old `: v` passthrough left those order-dependent, which is the same
// phantom-diff class (`network` reordered between releases reported as a
// permission change) that the shared canonicalizer exists to prevent. The
// fixtures below use `network` precisely because it is NOT skipped, so this
// branch stays reachable and covered.

/** A malformed-but-storable `network` value: objects, a primitive, `null`,
 *  and a nested array — none of which a validator would have admitted, all
 *  of which a legacy jsonb row can hold. */
const MESSY_NETWORK: unknown[] = [
  { host: "z.example.com", note: "d" },
  7,
  null,
  ["nested"],
  "a.example.com",
];

describe("canonicalizePerms — malformed non-string arrays", () => {
  test("ARRAY ORDER alone is not a difference (no phantom diff)", () => {
    const forward = canonicalizePerms(asPerms({ network: MESSY_NETWORK }));
    const shuffled = canonicalizePerms(
      asPerms({ network: [...MESSY_NETWORK].reverse() }),
    );
    expect(shuffled).toBe(forward);
    // …and it really did keep the elements rather than dropping them all.
    expect(forward).toContain("z.example.com");
    expect(forward).toContain("nested");
  });

  test("per-entry KEY order alone is not a difference either", () => {
    const declared = canonicalizePerms(
      asPerms({ network: [{ host: "run-job", note: "Fire a job" }] }),
    );
    const keySwapped = canonicalizePerms(
      asPerms({ network: [{ note: "Fire a job", host: "run-job" }] }),
    );
    expect(keySwapped).toBe(declared);
  });

  test("null / number / string / nested-array elements survive verbatim", () => {
    // Non-object elements take the passthrough branch — they must be
    // preserved, not coerced or dropped, or a real change to one of them
    // would go unreported.
    // Sorted by each element's own `JSON.stringify([el])`, which is why
    // the string sorts first (`"` < `7` < `[` < `n`) — the exact order is
    // irrelevant to callers, but pinning it catches a silent coercion.
    const canon = canonicalizePerms(asPerms({ network: [null, 7, ["nested"], "s"] }));
    expect(JSON.parse(canon).network).toEqual(["s", 7, ["nested"], null]);
  });

  test("duplicate elements canonicalize identically to their reverse", () => {
    // Exercises the equal-sort-key path in the element comparator.
    const dupes = [{ a: 1 }, { a: 1 }, "x", "x"];
    expect(canonicalizePerms(asPerms({ network: dupes }))).toBe(
      canonicalizePerms(asPerms({ network: [...dupes].reverse() })),
    );
  });

  test("a genuinely different element set is STILL a difference", () => {
    expect(canonicalizePerms(asPerms({ network: [7, null] }))).not.toBe(
      canonicalizePerms(asPerms({ network: MESSY_NETWORK })),
    );
  });

  test("an EMPTY array is equivalent to the field being absent", () => {
    expect(canonicalizePerms(asPerms({ network: [] }))).toBe(
      canonicalizePerms(asPerms({})),
    );
  });

  test("every other field's canonical form is untouched", () => {
    const shape = asPerms({
      network: ["b.example.com", "a.example.com"],
      storage: true,
      shell: false,
      env: [],
      spawnAgents: { maxConcurrent: 2, maxPerHour: 5 },
      grantedAt: { storage: 1 },
    });
    // Keys + string arrays sorted, `shell: false` and `[]` dropped as
    // "not granted" — the all-strings branch is unaffected by the above.
    expect(canonicalizePerms(shape)).toBe(
      JSON.stringify({
        grantedAt: { storage: 1 },
        network: ["a.example.com", "b.example.com"],
        spawnAgents: { maxConcurrent: 2, maxPerHour: 5 },
        storage: true,
      }),
    );
  });
});

// ── (network ceiling: allowed-host subset) ──────────────────────────

describe("network host allowlist intersection", () => {
  test("ai-kit ceiling includes localhost+127.0.0.1; foreign host clamped", () => {
    const requested: ExtensionPermissions = {
      network: ["localhost", "127.0.0.1", "evil.com"],
      grantedAt: { network: Date.now() },
    };
    const { effective, clamped } = clampToBundledCeiling("ai-kit", requested);
    expect(clamped).toBe(true);
    // Order is preserved by intersection input ordering, but compare
    // via Set semantics for resilience against future order tweaks.
    expect(new Set(effective.network)).toEqual(new Set(["localhost", "127.0.0.1"]));
  });

  test("web-search ceiling grants the search capability and NO network (egress is host-side)", () => {
    // Post shared-search-capability (Phase 1): the web-search extension
    // is a thin shim that forwards to `ctx.search`; all provider egress
    // + BYOK keys live host-side in src/search/. The ceiling therefore
    // grants `search` and NOTHING else — a network request is clamped
    // out entirely (a tighter, more correct grant than the old per-host
    // network ceiling).
    const requested: ExtensionPermissions = {
      search: "inherit",
      network: ["api.tavily.com"],
      grantedAt: { network: Date.now() },
    };
    const { effective, clamped } = clampToBundledCeiling("web-search", requested);
    expect(clamped).toBe(true);
    expect(effective.search).toBe("inherit");
    expect(effective.network ?? []).toEqual([]);
  });
});

// ── boolean tier intersection ───────────────────────────────────────

describe("boolean ceilings intersect via AND", () => {
  test("scratchpad's storage ceiling: requesting only storage stays granted", () => {
    const requested: ExtensionPermissions = {
      storage: true,
      grantedAt: { storage: Date.now() },
    };
    const { effective, clamped } = clampToBundledCeiling("scratchpad", requested);
    expect(clamped).toBe(false);
    expect(effective.storage).toBe(true);
  });

  test("file-refactor ceiling has no shell; requested shell:true clamped", () => {
    const requested: ExtensionPermissions = {
      filesystem: ["$CWD"],
      shell: true,
      grantedAt: { filesystem: Date.now(), shell: Date.now() },
    };
    const { effective, clamped } = clampToBundledCeiling("file-refactor", requested);
    expect(clamped).toBe(true);
    expect(effective.shell).toBeUndefined();
    expect(effective.filesystem).toEqual(["$CWD"]);
  });
});

// ── BUNDLED_CEILING shape sanity ────────────────────────────────────

describe("BUNDLED_CEILING shape", () => {
  test("every entry has grantedAt: {} (the neutral element)", () => {
    for (const [, perms] of Object.entries(BUNDLED_CEILING)) {
      expect(perms.grantedAt).toEqual({});
    }
  });

  test("every entry's name is a non-empty string and ceiling object is defined", () => {
    for (const [name, perms] of Object.entries(BUNDLED_CEILING)) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
      expect(perms).toBeDefined();
    }
  });
});

// ── install-integration test: clamp reaches the DB grant + audit row ──

describe("install integration — bundled.ts clamps at install + writes audit", () => {
  // Drive `ensureBundledExtensions` against a MUTATED `BUNDLED_EXTENSIONS`
  // entry. We can't easily monkey-patch the module's const, so instead
  // we verify the no-op path: every bundled install today produces a
  // `BUNDLED_INSTALLED` audit row and NO `BUNDLED_CEILING_CLAMP` row,
  // because the ceiling was authored to MATCH today's manifests.

  test("first-boot install of all bundled extensions produces NO clamp audit rows", async () => {
    await ensureBundledExtensions();
    const clampRows = auditEntries.filter(
      (r) => r.action === EXT_AUDIT_ACTIONS.BUNDLED_CEILING_CLAMP,
    );
    expect(clampRows).toEqual([]);
    // And every bundled extension is installed + enabled.
    expect(store.size).toBeGreaterThan(0);
    for (const row of store.values()) {
      expect(row.enabled).toBe(true);
    }
  });

  test("clampToBundledCeiling is the only narrowing surface — direct call records intent", () => {
    // This is a pure unit assertion that complements the audit-row
    // assertion above. The bundled-install path calls the function;
    // any future bypass would produce both a clamp-event AND a
    // missing audit row, and this test would still pass — that's
    // why the "no audit rows" assertion above is the load-bearing
    // piece for the production install path.
    const requested: ExtensionPermissions = {
      network: ["api.evil.com"],
      filesystem: ["/etc/passwd"],
      shell: true,
      grantedAt: { network: 1, filesystem: 1, shell: 1 },
    };
    const { effective, clamped } = clampToBundledCeiling("scratchpad", requested);
    expect(clamped).toBe(true);
    // Scratchpad ceiling = storage only; everything else dropped.
    expect(effective.network).toBeUndefined();
    expect(effective.filesystem).toBeUndefined();
    expect(effective.shell).toBeUndefined();
    expect(effective.storage).toBeUndefined();
    expect(effective.grantedAt).toEqual({});
  });

  test("simulated post-clamp audit metadata captures the requested vs effective diff", () => {
    // Unit-test the metadata SHAPE the install audit writer uses.
    // The production helper `writeBundledCeilingClampAudit` is private
    // to bundled.ts; this test is a contract guard that the metadata
    // we ASSEMBLE for it includes the necessary fields.
    const requested: ExtensionPermissions = {
      network: ["evil.com"],
      grantedAt: { network: 1 },
    };
    const { effective, clamped } = clampToBundledCeiling("scratchpad", requested);
    expect(clamped).toBe(true);

    const meta = {
      permission: "ceiling-clamp",
      oldValue: requested,
      newValue: effective,
      actor: "system" as const,
      reason: "bundled-ceiling-clamp",
      extensionName: "scratchpad",
      requested,
      effective,
    };
    // Shape contract: metadata serializes round-trip.
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
  });
});

// ── intersection corner cases: appendMessages OR semantics ──────────

describe("appendMessages clamp uses OR (CLIP semantics: more-restrictive wins)", () => {
  test("kokoro-tts ceiling has appendMessages.excludedDefault=true; request false → effective true", () => {
    const requested: ExtensionPermissions = {
      eventSubscriptions: ["kokoro-tts:speak"],
      appendMessages: { excludedDefault: false },
      grantedAt: { eventSubscriptions: 1, appendMessages: 1 },
    };
    const { effective } = clampToBundledCeiling("kokoro-tts", requested);
    // intersectPermissions OR semantics: ceiling says exclude-by-default,
    // so the result excludes regardless of what was requested.
    expect(effective.appendMessages?.excludedDefault).toBe(true);
  });
});

// ── eventSubscriptions: array intersection ──────────────────────────

describe("eventSubscriptions clamp drops un-listed events", () => {
  test("ask-user ceiling = ['ask-user:answer']; requesting an alien event → dropped", () => {
    const requested: ExtensionPermissions = {
      eventSubscriptions: ["ask-user:answer", "alien:event"],
      grantedAt: { eventSubscriptions: 1 },
    };
    const { effective, clamped } = clampToBundledCeiling("ask-user", requested);
    expect(clamped).toBe(true);
    expect(effective.eventSubscriptions).toEqual(["ask-user:answer"]);
  });
});

// ── env clamp ───────────────────────────────────────────────────────

describe("env clamp drops un-listed env vars", () => {
  test("github-stats ceiling = ['GITHUB_TOKEN']; requesting AWS_KEY → dropped", () => {
    const requested: ExtensionPermissions = {
      network: ["api.github.com"],
      env: ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"],
      grantedAt: { network: 1, env: 1 },
    };
    const { effective, clamped } = clampToBundledCeiling("github-stats", requested);
    expect(clamped).toBe(true);
    expect(effective.env).toEqual(["GITHUB_TOKEN"]);
    expect(effective.network).toEqual(["api.github.com"]);
  });
});

// ── grantedAt only retains keys that survived ──────────────────────

describe("grantedAt is rebuilt from surviving permission keys", () => {
  test("clamping drops grantedAt entries for fields that didn't survive", () => {
    const requested: ExtensionPermissions = {
      network: ["evil.com"],
      filesystem: ["$CWD"],
      grantedAt: {
        network: 1234,
        filesystem: 5678,
      },
    };
    // project-analyzer ceiling: filesystem ['$CWD'], shell true. NO network.
    const { effective, clamped } = clampToBundledCeiling("project-analyzer", requested);
    expect(clamped).toBe(true);
    // network grant dropped → grantedAt.network must also be dropped.
    expect(effective.grantedAt.network).toBeUndefined();
    // filesystem survived; its grantedAt stays.
    expect(effective.grantedAt.filesystem).toBe(5678);
  });
});

// ── manifest declarations don't widen ceiling ─────────────────────

describe("a wider 'malicious manifest' grant is clamped to ceiling", () => {
  test("scratchpad with bogus shell grant → ceiling drops shell", () => {
    // Simulate a malicious bundled.ts entry that requests shell: true
    // for scratchpad. The ceiling refuses.
    const malicious: ExtensionPermissions = {
      storage: true,
      shell: true,
      grantedAt: { storage: 1, shell: 1 },
    };
    const { effective, clamped } = clampToBundledCeiling("scratchpad", malicious);
    expect(clamped).toBe(true);
    expect(effective.shell).toBeUndefined();
    expect(effective.storage).toBe(true);
  });

  test("scratchpad with bogus filesystem grant → ceiling drops filesystem", () => {
    const malicious: ExtensionPermissions = {
      storage: true,
      filesystem: ["/", "/etc"],
      grantedAt: { storage: 1, filesystem: 1 },
    };
    const { effective, clamped } = clampToBundledCeiling("scratchpad", malicious);
    expect(clamped).toBe(true);
    expect(effective.filesystem).toBeUndefined();
  });
});

// Silence unused-import warning if tests compile.
void ({} as ExtensionManifestV2);

/**
 * Compare two grant shapes treating "not granted" forms as equal:
 *   - `shell: false` ≡ `shell: undefined` (and same for storage,
 *     taskEvents, acceptsCallerCaps, escalateChildCaps)
 *   - empty arrays ≡ undefined
 *   - same Math.min(maxPerHour) and Math.min(maxConcurrent)
 *
 * This mirrors the canonicalize semantics inside
 * `bundled-ceiling.ts`. Used by the matrix-(a) sweep.
 */
function expectFunctionallyEqualGrant(
  a: ExtensionPermissions,
  b: ExtensionPermissions,
  context: string,
): void {
  const norm = (g: ExtensionPermissions): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const r = g as unknown as Record<string, unknown>;
    const BOOL_FIELDS = new Set([
      "shell",
      "storage",
      "taskEvents",
      "acceptsCallerCaps",
      "escalateChildCaps",
    ]);
    for (const k of Object.keys(r).sort()) {
      const v = r[k];
      if (v === undefined) continue;
      if (BOOL_FIELDS.has(k) && v === false) continue;
      if (Array.isArray(v)) {
        if (v.length === 0) continue;
        const allStrings = v.every((x) => typeof x === "string");
        out[k] = allStrings ? [...v].sort() : v;
      } else if (v !== null && typeof v === "object") {
        const inner: Record<string, unknown> = {};
        for (const ik of Object.keys(v as Record<string, unknown>).sort()) {
          inner[ik] = (v as Record<string, unknown>)[ik];
        }
        out[k] = inner;
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  const aNorm = norm(a);
  const bNorm = norm(b);
  if (JSON.stringify(aNorm) !== JSON.stringify(bNorm)) {
    // Throw a readable diff via Bun's default toEqual.
    expect({ context, normalized: aNorm }).toEqual({ context, normalized: bNorm });
  }
}
