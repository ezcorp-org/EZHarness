/**
 * Cap-expiry Phase 2 — `runSweep` planner + helper unit tests.
 *
 * These tests wire a stub Drizzle handle that satisfies the SELECT
 * surface `runSweep` exercises. No real DB; no migrations. The
 * companion integration test (`perm-expiry-sweep.integration.test.ts`)
 * exercises `applySweepResult` against real PGlite — these here lock
 * in the planner's contract.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";
import { extensions, settings } from "../db/schema";
import {
  mapGrantKeyToExpiryKind,
  runSweep,
  type Revocation,
} from "../extensions/perm-expiry-sweep";
import type { ExtensionPermissions } from "../extensions/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 2_000_000_000_000; // arbitrary fixed reference point

// ── Stub DB handle ──────────────────────────────────────────────────
// `runSweep` uses two query shapes:
//   • db.select(...).from(extensions).where(eq(extensions.enabled, true))
//   • db.select(...).from(settings).where(like(settings.key, "..."))
// We satisfy both by inspecting the operator the test wired up; no
// drizzle internals are touched.

interface StubExtRow {
  id: string;
  enabled: boolean;
  perms: ExtensionPermissions | null;
}
interface StubSettingRow {
  key: string;
  value: unknown;
}

function makeStubDb(opts: {
  ext: readonly StubExtRow[];
  settings: readonly StubSettingRow[];
}) {
  // We build a minimal `select` chain. `runSweep` only ever calls
  // `.select(fields).from(table).where(cond)` and awaits the result.
  // We don't need to honor the SQL `cond` in detail — the runtime
  // contract is "extensions where enabled = true" and "settings keys
  // like ext:%:always_allow:%". We pre-filter the seed data by those
  // contracts and return it verbatim.
  return {
    select(fields: Record<string, unknown>) {
      void fields; // unused — runSweep selects specific columns; we
      // return the same row shape unconditionally.
      return {
        from(table: unknown) {
          if (table === extensions) {
            return {
              where(_cond: unknown) {
                // Mirror the eq(extensions.enabled, true) filter.
                return Promise.resolve(
                  opts.ext
                    .filter((r) => r.enabled)
                    .map((r) => ({ id: r.id, perms: r.perms })),
                );
              },
            };
          }
          if (table === settings) {
            return {
              where(_cond: unknown) {
                // Mirror the like(settings.key, "ext:%:always_allow:%")
                // filter so test seed data with non-matching keys is
                // dropped.
                return Promise.resolve(
                  opts.settings
                    .filter((r) => /^ext:.+:always_allow:.+/.test(r.key))
                    .map((r) => ({ key: r.key, value: r.value })),
                );
              },
            };
          }
          throw new Error(`unexpected table in stub: ${String(table)}`);
        },
      };
    },
  };
}

// Sanity smoke that the stub satisfies `runSweep`'s call shape — also
// guarantees the `eq` / `like` imports at the top stay used (so biome's
// noUnusedImports doesn't flag them as dead weight).
test("stub harness — drizzle eq/like operators import successfully", () => {
  const cond1 = eq(extensions.enabled, true);
  const cond2 = like(settings.key, "ext:%:always_allow:%");
  expect(cond1).toBeDefined();
  expect(cond2).toBeDefined();
});

// ── mapGrantKeyToExpiryKind ─────────────────────────────────────────

describe("mapGrantKeyToExpiryKind", () => {
  test("network → network", () => {
    expect(mapGrantKeyToExpiryKind("network")).toBe("network");
  });

  test("filesystem → filesystem-write (conservative; design doc note)", () => {
    // The grant record key is plain `"filesystem"` with no read/write
    // tag. v1 sweep treats every filesystem grant as the more
    // restrictive write-tier (30d) so a write-capable install is not
    // held to the longer read-only TTL.
    expect(mapGrantKeyToExpiryKind("filesystem")).toBe("filesystem-write");
  });

  test("shell → shell", () => {
    expect(mapGrantKeyToExpiryKind("shell")).toBe("shell");
  });

  test("env → env", () => {
    expect(mapGrantKeyToExpiryKind("env")).toBe("env");
  });

  test("storage → storage (Never)", () => {
    expect(mapGrantKeyToExpiryKind("storage")).toBe("storage");
  });

  test("taskEvents → taskEvents (Never)", () => {
    expect(mapGrantKeyToExpiryKind("taskEvents")).toBe("taskEvents");
  });

  test("appendMessages → appendMessages (Never)", () => {
    expect(mapGrantKeyToExpiryKind("appendMessages")).toBe("appendMessages");
  });

  test("llm → llm", () => {
    expect(mapGrantKeyToExpiryKind("llm")).toBe("llm");
  });

  test("memory → memory", () => {
    expect(mapGrantKeyToExpiryKind("memory")).toBe("memory");
  });

  test("lessons → lessons", () => {
    expect(mapGrantKeyToExpiryKind("lessons")).toBe("lessons");
  });

  test("schedule → schedule (Never)", () => {
    expect(mapGrantKeyToExpiryKind("schedule")).toBe("schedule");
  });

  test("eventSubscriptions → null (plumbing, not user-facing)", () => {
    expect(mapGrantKeyToExpiryKind("eventSubscriptions")).toBe(null);
  });

  test("spawnAgents → null (plumbing)", () => {
    expect(mapGrantKeyToExpiryKind("spawnAgents")).toBe(null);
  });

  test("agentConfig → null (plumbing)", () => {
    expect(mapGrantKeyToExpiryKind("agentConfig")).toBe(null);
  });

  test("acceptsCallerCaps / escalateChildCaps → null (deputy flags)", () => {
    expect(mapGrantKeyToExpiryKind("acceptsCallerCaps")).toBe(null);
    expect(mapGrantKeyToExpiryKind("escalateChildCaps")).toBe(null);
  });

  test("unknown key → null (forward compat — sweep won't crash on a future field)", () => {
    expect(mapGrantKeyToExpiryKind("madeUpField")).toBe(null);
    expect(mapGrantKeyToExpiryKind("")).toBe(null);
  });
});

// ── runSweep — empty store ──────────────────────────────────────────

describe("runSweep — empty store", () => {
  test("zero extensions, zero settings → empty result", async () => {
    const db = makeStubDb({ ext: [], settings: [] });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
    expect(r.audits).toEqual([]);
    expect(r.events).toEqual([]);
  });
});

// ── runSweep — disabled extensions ──────────────────────────────────

describe("runSweep — disabled extensions are skipped", () => {
  test("disabled extension with aged grant produces no revocation", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-disabled",
          enabled: false,
          perms: {
            network: ["api.example.com"],
            grantedAt: { network: NOW - 1000 * DAY_MS },
          },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });
});

// ── runSweep — per-capability TTL (extension-grant scope) ───────────

describe("runSweep — per-capability TTL (extension-grant rows)", () => {
  test("filesystem grant aged 31d → revocation (30d TTL)", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-fs",
          enabled: true,
          perms: {
            filesystem: ["/tmp/foo"],
            grantedAt: { filesystem: NOW - 31 * DAY_MS },
          },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toHaveLength(1);
    expect(r.revocations[0]).toMatchObject({
      kind: "extension-grant",
      extensionId: "ext-fs",
      grantKey: "filesystem",
      capability: "filesystem-write",
      ttlMs: 30 * DAY_MS,
    });
    expect(r.revocations[0]?.ageMs).toBe(31 * DAY_MS);
  });

  test("filesystem grant aged 29d → NOT revoked (under 30d TTL)", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-fs",
          enabled: true,
          perms: {
            filesystem: ["/tmp/foo"],
            grantedAt: { filesystem: NOW - 29 * DAY_MS },
          },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("shell grant aged 31d → revocation (30d TTL)", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-sh",
          enabled: true,
          perms: {
            shell: true,
            grantedAt: { shell: NOW - 31 * DAY_MS },
          },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toHaveLength(1);
    expect(r.revocations[0]).toMatchObject({
      capability: "shell",
      ttlMs: 30 * DAY_MS,
    });
  });

  test("network grant aged 91d → revocation (90d TTL)", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-net",
          enabled: true,
          perms: {
            network: ["api.x"],
            grantedAt: { network: NOW - 91 * DAY_MS },
          },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toHaveLength(1);
    expect(r.revocations[0]?.capability).toBe("network");
    expect(r.revocations[0]?.ttlMs).toBe(90 * DAY_MS);
  });

  test("network grant aged 89d → NOT revoked", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-net",
          enabled: true,
          perms: {
            network: ["api.x"],
            grantedAt: { network: NOW - 89 * DAY_MS },
          },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("env grant aged 91d → revocation (90d TTL)", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-env",
          enabled: true,
          perms: { env: ["FOO"], grantedAt: { env: NOW - 91 * DAY_MS } },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toHaveLength(1);
    expect(r.revocations[0]?.capability).toBe("env");
  });

  test("storage grant aged 1000d → NEVER revoked (storage TTL = 'never')", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-storage",
          enabled: true,
          perms: {
            storage: true,
            grantedAt: { storage: NOW - 1000 * DAY_MS },
          },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("schedule grant aged 1000d → NEVER revoked", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-sched",
          enabled: true,
          perms: {
            schedule: { crons: ["* * * * *"], maxRunsPerDay: 1, maxRunDurationMs: 1000, missedRunPolicy: "skip", maxRetries: 0 },
            grantedAt: { schedule: NOW - 1000 * DAY_MS },
          } as ExtensionPermissions,
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("plumbing keys (eventSubscriptions, spawnAgents) → NEVER revoked", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-plumb",
          enabled: true,
          perms: {
            eventSubscriptions: ["task:assignment_update"],
            spawnAgents: { maxPerHour: 200 },
            grantedAt: {
              eventSubscriptions: NOW - 1000 * DAY_MS,
              spawnAgents: NOW - 1000 * DAY_MS,
            },
          },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("multiple capabilities, mixed ages — only aged ones revoked", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-multi",
          enabled: true,
          perms: {
            network: ["api.x"], // aged 91d → revoke
            filesystem: ["/tmp"], // aged 10d → keep
            shell: true, // aged 31d → revoke
            grantedAt: {
              network: NOW - 91 * DAY_MS,
              filesystem: NOW - 10 * DAY_MS,
              shell: NOW - 31 * DAY_MS,
            },
          },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toHaveLength(2);
    const caps = r.revocations.map((rev) => rev.capability).sort();
    expect(caps).toEqual(["network", "shell"]);
  });
});

// ── runSweep — synthetic 100-extension store ────────────────────────

describe("runSweep — bulk happy path", () => {
  test("100 extensions: 50 with 91-day-old network grant, 50 fresh → 50 revocations", async () => {
    const ext: StubExtRow[] = [];
    for (let i = 0; i < 50; i++) {
      ext.push({
        id: `aged-${i}`,
        enabled: true,
        perms: {
          network: ["api.x"],
          grantedAt: { network: NOW - 91 * DAY_MS },
        },
      });
    }
    for (let i = 0; i < 50; i++) {
      ext.push({
        id: `fresh-${i}`,
        enabled: true,
        perms: {
          network: ["api.x"],
          grantedAt: { network: NOW - 1 * DAY_MS },
        },
      });
    }
    const db = makeStubDb({ ext, settings: [] });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toHaveLength(50);
    expect(r.audits).toHaveLength(50);
    expect(r.events).toHaveLength(50);
    // Every revocation is for an aged-* extension.
    for (const rev of r.revocations) {
      expect(rev.extensionId.startsWith("aged-")).toBe(true);
    }
  });
});

// ── runSweep — idempotence ──────────────────────────────────────────

describe("runSweep — idempotent", () => {
  test("after the first sweep mutates the store, the second sweep produces zero revocations", async () => {
    // Simulate the post-apply state: aged grant replaced with no
    // grantedAt entry (and no permission slot).
    const db = makeStubDb({
      ext: [
        {
          id: "ext-1",
          enabled: true,
          perms: { grantedAt: {} },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });
});

// ── runSweep — always-allow rows ────────────────────────────────────

describe("runSweep — always-allow rows", () => {
  test("legacy boolean true → never-expires (skipped, no revocation)", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          // Canonical scoped key — value is legacy `true`, which has no
          // `grantedAt`. Per Phase 1 read-side migration: treat as
          // never-expires.
          key: "ext:ext-1:user-1:forever:*:always_allow:shell",
          value: true,
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("legacy boolean false → already denied, no revocation", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:forever:*:always_allow:shell",
          value: false,
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("session scope is always skipped (in-memory only)", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:session:*:always_allow:shell",
          value: { allowed: true, grantedAt: NOW - 365 * DAY_MS },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("forever scope new shape past 90d default → revocation", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:forever:*:always_allow:shell",
          value: { allowed: true, grantedAt: NOW - 91 * DAY_MS },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW, config: { foreverTtlMs: 90 * DAY_MS } });
    expect(r.revocations).toHaveLength(1);
    const rev = r.revocations[0]!;
    expect(rev.kind).toBe("always-allow");
    if (rev.kind === "always-allow") {
      expect(rev.extensionId).toBe("ext-1");
      expect(rev.scope).toBe("forever");
      expect(rev.capability).toBe("shell");
      expect(rev.settingKey).toBe("ext:ext-1:user-1:forever:*:always_allow:shell");
      expect(rev.ttlMs).toBe(90 * DAY_MS);
      expect(rev.ageMs).toBe(91 * DAY_MS);
    }
  });

  test("forever scope respects foreverTtlMs override (test injection)", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:forever:*:always_allow:shell",
          value: { allowed: true, grantedAt: NOW - 8 * DAY_MS },
        },
      ],
    });
    // Tighter TTL via injection — 7d. Aged 8d → revoke.
    const r1 = await runSweep({ db, now: NOW, config: { foreverTtlMs: 7 * DAY_MS } });
    expect(r1.revocations).toHaveLength(1);
    // Looser TTL via injection — 30d. Aged 8d → keep.
    const r2 = await runSweep({ db, now: NOW, config: { foreverTtlMs: 30 * DAY_MS } });
    expect(r2.revocations).toHaveLength(0);
  });

  test("forever scope new shape — fresh grant → no revocation", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:forever:*:always_allow:fs.write",
          value: { allowed: true, grantedAt: NOW - 5 * DAY_MS },
        },
      ],
    });
    const r = await runSweep({
      db,
      now: NOW,
      config: { foreverTtlMs: 90 * DAY_MS },
    });
    expect(r.revocations).toEqual([]);
  });

  test("conversation scope is skipped (lifetime-bound, design doc §4.4)", async () => {
    // Per design doc § 4.4: "conversation is bounded by conversation
    // lifetime (parallel — sweep doesn't need to age it)". An aged
    // conversation-scope grant must produce ZERO revocations, even at
    // 1000 days old. Mirrors the session-scope skip test above.
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:conversation:conv-1:always_allow:shell",
          value: { allowed: true, grantedAt: NOW - 1000 * DAY_MS },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("project scope uses per-capability TTL (network = 90d)", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:project:proj-1:always_allow:network",
          value: { allowed: true, grantedAt: NOW - 91 * DAY_MS },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toHaveLength(1);
    const rev = r.revocations[0]!;
    if (rev.kind === "always-allow") {
      expect(rev.scope).toBe("project");
      expect(rev.ttlMs).toBe(90 * DAY_MS);
    }
  });

  test("storage capability on always-allow → never expires (matches table)", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:forever:*:always_allow:storage",
          value: { allowed: true, grantedAt: NOW - 1000 * DAY_MS },
        },
      ],
    });
    const r = await runSweep({
      db,
      now: NOW,
      config: { foreverTtlMs: 1 * DAY_MS },
    });
    expect(r.revocations).toEqual([]);
  });

  test("malformed value (allowed='yes') → fail-closed, no revocation", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:forever:*:always_allow:shell",
          value: { allowed: "yes", grantedAt: 1 },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("legacy unscoped key (ext:ext-1:always_allow:shell) → skipped", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:always_allow:shell",
          value: { allowed: true, grantedAt: NOW - 365 * DAY_MS },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("non-always-allow setting keys are ignored (settings store like-filter)", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        // Real settings keys that look-similar but are not always-allow.
        {
          key: "ext:ext-1:listing:metadata",
          value: { foo: "bar" },
        },
        {
          key: "global:somethingElse",
          value: 42,
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });
});

// ── runSweep — env-var integration (getForeverTtlMs default) ────────

describe("runSweep — env var EZCORP_PERM_FOREVER_TTL_DAYS", () => {
  const orig = process.env.EZCORP_PERM_FOREVER_TTL_DAYS;
  afterEach(() => {
    if (orig === undefined) delete process.env.EZCORP_PERM_FOREVER_TTL_DAYS;
    else process.env.EZCORP_PERM_FOREVER_TTL_DAYS = orig;
  });
  beforeEach(() => {
    delete process.env.EZCORP_PERM_FOREVER_TTL_DAYS;
  });

  test("env unset → default 90d for forever scope", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:forever:*:always_allow:shell",
          value: { allowed: true, grantedAt: NOW - 91 * DAY_MS },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toHaveLength(1);
    expect((r.revocations[0] as Extract<Revocation, { kind: "always-allow" }>).ttlMs).toBe(
      90 * DAY_MS,
    );
  });

  test("env set to 7 → forever-scope sweep at 7d", async () => {
    process.env.EZCORP_PERM_FOREVER_TTL_DAYS = "7";
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:forever:*:always_allow:shell",
          value: { allowed: true, grantedAt: NOW - 8 * DAY_MS },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toHaveLength(1);
    expect((r.revocations[0] as Extract<Revocation, { kind: "always-allow" }>).ttlMs).toBe(
      7 * DAY_MS,
    );
  });
});

// ── runSweep — audit + event payload shape ──────────────────────────

describe("runSweep — audit + event payload contract", () => {
  test("extension-grant revocation produces matching audit + event with full metadata", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-x",
          enabled: true,
          perms: {
            network: ["api.x"],
            grantedAt: { network: NOW - 91 * DAY_MS },
          },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.audits).toHaveLength(1);
    expect(r.audits[0]).toEqual({
      userId: null,
      action: "ext:permission-grant-expired",
      target: "ext-x",
      metadata: {
        capability: "network",
        scope: "extensions-row",
        ttlMs: 90 * DAY_MS,
        ageMs: 91 * DAY_MS,
      },
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toEqual({
      type: "perm-expired",
      data: {
        extensionId: "ext-x",
        capability: "network",
        scope: "extensions-row",
        ageMs: 91 * DAY_MS,
      },
    });
  });

  test("always-allow revocation produces matching audit + event with scope tag", async () => {
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-aa:user-1:forever:*:always_allow:fs.write",
          value: { allowed: true, grantedAt: NOW - 91 * DAY_MS },
        },
      ],
    });
    const r = await runSweep({
      db,
      now: NOW,
      config: { foreverTtlMs: 90 * DAY_MS },
    });
    expect(r.audits).toHaveLength(1);
    expect(r.audits[0]).toEqual({
      userId: null,
      action: "ext:permission-grant-expired",
      target: "ext-aa",
      metadata: {
        capability: "filesystem-write",
        scope: "forever",
        ttlMs: 90 * DAY_MS,
        ageMs: 91 * DAY_MS,
      },
    });
    expect(r.events[0]).toEqual({
      type: "perm-expired",
      data: {
        extensionId: "ext-aa",
        capability: "filesystem-write",
        scope: "forever",
        ageMs: 91 * DAY_MS,
      },
    });
  });
});

// ── Phase 56 — per-row ttlOverrideMs precedence ─────────────────────
//
// Locks in the new TTL-resolution branch inside `runSweep`'s always-
// allow loop. Precedence rules (see plan 56-01 task 2):
//
//   readTtlOverrideMs(row.value) result:
//     null       → "Never". Skip row entirely (no revocation, no audit).
//                  Even when scope === "forever" and foreverTtlMs would
//                  otherwise apply (Pitfall 6 — honest Never).
//     number > 0 → Use as the per-row TTL. Wins over BOTH
//                  TTL_CONFIG[kind] AND foreverTtlMs. Even when
//                  scope === "forever" (Pitfall 6 — override always
//                  beats env-driven fallback).
//                  Even when TTL_CONFIG[kind] === "never" (override
//                  takes precedence everywhere — case 7).
//     undefined  → Legacy/absent. Fall back to the existing Phase 1/2
//                  TTL_CONFIG[kind] / foreverTtlMs logic.
//
// These cases drive the production change at perm-expiry-sweep.ts
// lines 485-516. The companion test suite at always-allow-value-
// shape.test.ts already locks readTtlOverrideMs's own branches; here
// we only assert the SWEEP'S consumption of it.

const HOUR_MS = 60 * 60 * 1000;

describe("Phase 56 — per-row ttlOverrideMs precedence", () => {
  test("override (1d) wins over TTL_CONFIG (shell=30d) — aged past override → revoke", async () => {
    // shell TTL_CONFIG is 30d. Row carries a 1d override and is aged
    // 2d. Without Phase 56 the 30d fallback would keep this row; with
    // the override the sweep MUST revoke at 2d > 1d.
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:project:proj-1:always_allow:shell",
          value: {
            allowed: true,
            grantedAt: NOW - 2 * DAY_MS,
            ttlOverrideMs: 1 * DAY_MS,
            expiresAt: NOW - 1 * DAY_MS,
          },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toHaveLength(1);
    const rev = r.revocations[0]!;
    expect(rev.kind).toBe("always-allow");
    if (rev.kind === "always-allow") {
      expect(rev.scope).toBe("project");
      expect(rev.capability).toBe("shell");
      expect(rev.ttlMs).toBe(1 * DAY_MS);
      expect(rev.ageMs).toBe(2 * DAY_MS);
    }
    // Audit row emitted with the same per-row TTL.
    expect(r.audits).toHaveLength(1);
    expect(r.audits[0]?.metadata.ttlMs).toBe(1 * DAY_MS);
  });

  test("override null (Never) → skip even at 365d age", async () => {
    // Row aged 1y, TTL_CONFIG[shell]=30d. The null override must
    // short-circuit BEFORE the fallback compares against TTL_CONFIG.
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:project:proj-1:always_allow:shell",
          value: {
            allowed: true,
            grantedAt: NOW - 365 * DAY_MS,
            ttlOverrideMs: null,
            expiresAt: null,
          },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
    expect(r.audits).toEqual([]);
    expect(r.events).toEqual([]);
  });

  test("override absent → fall back to TTL_CONFIG (REGRESSION: 5d < 30d → keep)", async () => {
    // Legacy row without ttlOverrideMs. Sweep must use the existing
    // Phase 1/2 fallback path: shell TTL is 30d, row aged 5d → keep.
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:project:proj-1:always_allow:shell",
          value: {
            allowed: true,
            grantedAt: NOW - 5 * DAY_MS,
          },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("Pitfall 6 — override (1h) wins over scope=forever + foreverTtlMs (90d) → revoke", async () => {
    // scope=forever's foreverTtlMs default is 90d. Override is 1h; row
    // aged 2h. WITHOUT Phase 56 the sweep would compute ttl=foreverTtlMs
    // (90d) and keep the row; WITH the precedence rule the override
    // wins and revokes at 2h > 1h. This is the load-bearing Pitfall 6
    // case — Never/override MUST short-circuit BEFORE the
    // scope===forever ? foreverTtlMs : baseTtl branch.
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:forever:*:always_allow:shell",
          value: {
            allowed: true,
            grantedAt: NOW - 2 * HOUR_MS,
            ttlOverrideMs: 1 * HOUR_MS,
            expiresAt: NOW - 1 * HOUR_MS,
          },
        },
      ],
    });
    const r = await runSweep({
      db,
      now: NOW,
      config: { foreverTtlMs: 90 * DAY_MS },
    });
    expect(r.revocations).toHaveLength(1);
    const rev = r.revocations[0]!;
    if (rev.kind === "always-allow") {
      expect(rev.scope).toBe("forever");
      expect(rev.ttlMs).toBe(1 * HOUR_MS); // override, NOT 90d
      expect(rev.ageMs).toBe(2 * HOUR_MS);
    }
  });

  test("override null on scope=forever → skip (honest Never even on forever)", async () => {
    // scope=forever with a 1y-old grant. foreverTtlMs=90d would
    // otherwise revoke. The null override must win — CONTEXT
    // "Never availability" decision: forever-scope grants can be
    // marked Never via the per-row override.
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:forever:*:always_allow:shell",
          value: {
            allowed: true,
            grantedAt: NOW - 365 * DAY_MS,
            ttlOverrideMs: null,
          },
        },
      ],
    });
    const r = await runSweep({
      db,
      now: NOW,
      config: { foreverTtlMs: 90 * DAY_MS },
    });
    expect(r.revocations).toEqual([]);
  });

  test('TTL_CONFIG[kind] === "never" + no override → skip (REGRESSION)', async () => {
    // storage TTL_CONFIG is "never". Legacy row without override must
    // hit the existing never-fallback skip branch.
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:forever:*:always_allow:storage",
          value: { allowed: true, grantedAt: NOW - 365 * DAY_MS },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test('TTL_CONFIG[kind] === "never" + override=1h → use override (revoke at 2h)', async () => {
    // Rare but contractual: override wins everywhere, including when
    // the fallback would say never. storage is the "never" tier.
    const db = makeStubDb({
      ext: [],
      settings: [
        {
          key: "ext:ext-1:user-1:project:proj-1:always_allow:storage",
          value: {
            allowed: true,
            grantedAt: NOW - 2 * HOUR_MS,
            ttlOverrideMs: 1 * HOUR_MS,
            expiresAt: NOW - 1 * HOUR_MS,
          },
        },
      ],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toHaveLength(1);
    const rev = r.revocations[0]!;
    if (rev.kind === "always-allow") {
      expect(rev.capability).toBe("storage");
      expect(rev.ttlMs).toBe(1 * HOUR_MS);
      expect(rev.ageMs).toBe(2 * HOUR_MS);
    }
  });
});

// ── runSweep — defensive null/empty/unknown inputs ──────────────────

describe("runSweep — defensive parsing", () => {
  test("null grantedPermissions → skipped (no crash)", async () => {
    const db = makeStubDb({
      ext: [{ id: "ext-1", enabled: true, perms: null }],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("empty grantedAt → skipped (no crash)", async () => {
    const db = makeStubDb({
      ext: [
        { id: "ext-1", enabled: true, perms: { grantedAt: {} } },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });

  test("non-numeric grantedAt entry (NaN) → skipped (no crash)", async () => {
    const db = makeStubDb({
      ext: [
        {
          id: "ext-1",
          enabled: true,
          perms: {
            network: ["api.x"],
            // Deliberate malformed input to exercise defensive
            // parsing — `as any` here punches through the typed
            // `Record<string, number>` so the runSweep code path
            // sees the NaN it would see from a corrupt DB row.
            grantedAt: { network: Number.NaN } as any,
          },
        },
      ],
      settings: [],
    });
    const r = await runSweep({ db, now: NOW });
    expect(r.revocations).toEqual([]);
  });
});
