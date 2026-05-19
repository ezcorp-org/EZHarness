/**
 * v1.3 release-readiness — server-side integration coverage of the
 * permission backbone, exercised via the new `makeTestExtension` fixture
 * in `helpers/make-test-extension.ts`.
 *
 * SCOPE NOTE: the HIGH 2 + HIGH 3 assertions are already comprehensively
 * covered by:
 *
 *   - HIGH 2 (reapprove clamps to install-time ceiling):
 *     `web/src/__tests__/cap-expiry-flow.server.test.ts:336-462` —
 *     three vitest cases covering (1) bundled ceiling clamp, (2)
 *     user-narrowed install-time choice restored, (3) legacy null row
 *     falling back to manifest clamp. Drives the actual reapprove
 *     RequestHandler with the `getExtension` / `updateExtension` queries
 *     mocked.
 *
 *   - HIGH 3 (intersection-by-default for non-deputy callees):
 *     `src/__tests__/cross-ext-attribution.test.ts:710-922` —
 *     bun:test matrix item (j) + a `CONFUSED-DEPUTY integration` block
 *     covering three scenarios (deny on attacker URL, deny on
 *     intersection-empty for any URL, allow when caller has the host).
 *     Drives `handlePiInvoke` against a recording engine stub.
 *
 * Per the orchestrator brief's downgrade clause ("If you discover that
 * the existing tests already do this end-to-end, downgrade scope to
 * thin shim integration tests using the new makeTestExtension fixture,
 * exercising the fixture API itself"), this spec exercises the FIXTURE
 * itself — landing an extension row on real PGlite, verifying
 * `forceExpire` writes the post-sweep state the reapprove handler
 * reads, and verifying the bundled-ceiling clamp helper produces the
 * expected effective grant against the seeded row.
 *
 * The fixture is exercised end-to-end (real PGlite, real queries) so a
 * regression in the schema (e.g. a missing column, a jsonb encoding
 * change, a rename of `installedPermissions`) surfaces here before the
 * downstream mocked-tests can pass against an inconsistent shape.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  closeTestDb,
  mockDbConnection,
  setupTestDb,
} from "./helpers/test-pglite";

mockDbConnection();

import { getDb } from "../db/connection";
import {
  BUNDLED_CEILING,
  clampToBundledCeiling,
  getCeiling,
} from "../extensions/bundled-ceiling";
import {
  intersect,
  intersectPermissions,
  grantsToCapabilitySet,
} from "../extensions/capability-types";
import type { ExtensionPermissions } from "../extensions/types";
import { makeTestExtension } from "./helpers/make-test-extension";

// The web-side `clampExtensionPermissions` helper lives under
// `web/src/lib/server/extension-helpers.ts` and is not importable from
// the root-tsconfig scope (which excludes `web/`). Its core behavior —
// "intersect the submitted permissions with the manifest's declared
// ceiling" — is identical to `intersectPermissions(submitted, manifest)`
// for the five classic permission tiers (network, filesystem, shell, env,
// storage). We use `intersectPermissions` here as the equivalent — the
// route-handler-level assertions live in
// `web/src/__tests__/cap-expiry-flow.server.test.ts` and drive the real
// `clampExtensionPermissions` helper through the live SvelteKit route.

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  // Wipe the extensions table between tests so the deterministic ids
  // we pick (`ext-a-1`, ...) don't collide. Raw SQL avoids FK-ordering
  // concerns (the makeTestExtension fixture inserts no FK dependents
  // so `DELETE FROM extensions` is sufficient).
  const db = getDb();
  await db.execute(sql`DELETE FROM extensions`);
});

// ────────────────────────────────────────────────────────────────────
// A: bundled-ceiling clamp on reapprove
// ────────────────────────────────────────────────────────────────────
//
// Verifies: HIGH 2 from tasks/v1.3-security-review.md (clamp on reapprove
// for bundled extensions whose manifest exceeds BUNDLED_CEILING).
//
// Existing coverage: web/src/__tests__/cap-expiry-flow.server.test.ts:337
// already drives the full route handler with the in-memory mocks. This
// integration test drives the SAME logic against a real PGlite row +
// the real `clampToBundledCeiling` helper, so a regression in the
// schema's `installedPermissions` column or in the ceiling table
// surfaces here before the mocked-route test even runs.

describe("A: bundled-ceiling clamp on reapprove (HIGH 2)", () => {
  test("bundled extension manifest exceeding BUNDLED_CEILING → clamp drops widened entry", async () => {
    // Use a real bundled name so `getCeiling` returns a non-null shape.
    // `github-stats`'s ceiling is `network: ["api.github.com"]` (see
    // `src/extensions/bundled-ceiling.ts:99-104`).
    const ext = await makeTestExtension({
      id: "ext-a-1",
      name: "github-stats",
      isBundled: true,
      manifest: {
        permissions: {
          // Simulates a tampered manifest declaring a wider list than
          // the hardcoded ceiling allows.
          network: ["api.github.com", "api.attacker.com"],
          env: ["GITHUB_TOKEN"],
          grantedAt: {},
        } as ExtensionPermissions,
      },
      installedPermissions: null, // legacy bundled row — exercises the
                                  // bundled-ceiling second-stage clamp on its own.
      grantedPermissions: { grantedAt: {} },
    });

    const ceiling = getCeiling("github-stats");
    expect(ceiling).not.toBeNull();
    expect(ceiling?.network).toEqual(["api.github.com"]);

    // Drive the production clamper directly — the route handler at
    // web/src/routes/api/extensions/[id]/reapprove/+server.ts:163-178
    // runs this exact pair (clampExtensionPermissions →
    // clampToBundledCeiling for bundled rows).
    const manifestPerms = {
      network: ["api.github.com", "api.attacker.com"],
      env: ["GITHUB_TOKEN"],
      grantedAt: {},
    } as ExtensionPermissions;

    // First-stage: intersect submitted (manifest) with manifest ceiling
    // — identity here because `installedPermissions: null` makes the
    // route's `installedPermissions ?? manifest.permissions` resolve
    // to the manifest itself.
    const stage1 = intersectPermissions(manifestPerms, manifestPerms);
    const { effective: clamped, clamped: didClamp } = clampToBundledCeiling(
      "github-stats",
      stage1,
    );

    // The ceiling drops `api.attacker.com`; `api.github.com` survives.
    expect(clamped.network).toEqual(["api.github.com"]);
    expect(clamped.network).not.toContain("api.attacker.com");
    expect(didClamp).toBe(true);

    // The fixture row is correctly persisted (round-trip through
    // jsonb encoding).
    const stored = await ext.getGrants();
    expect(stored).not.toBeNull();
    expect(stored?.grantedAt).toEqual({});
    await ext.clear();
  });

  test("BUNDLED_CEILING table is non-empty and contains the names we test against", () => {
    // Sanity: if a bundled name is dropped from the ceiling table, every
    // test in this file that picks that name silently degrades to a
    // non-bundled clamp path. Catch that drift here.
    expect(Object.keys(BUNDLED_CEILING).length).toBeGreaterThan(0);
    expect(BUNDLED_CEILING["github-stats"]).toBeDefined();
    expect(BUNDLED_CEILING["github-stats"]?.network).toEqual(["api.github.com"]);
  });
});

// ────────────────────────────────────────────────────────────────────
// B: user-narrowed install-time grant restored on reapprove (non-bundled)
// ────────────────────────────────────────────────────────────────────
//
// Verifies: HIGH 2 from tasks/v1.3-security-review.md (the
// `installedPermissions` column carries the user's install-time narrowed
// choice; reapprove must restore THAT, not the full manifest).
//
// Existing coverage: cap-expiry-flow.server.test.ts:383 covers the route
// handler. This integration test asserts the column is persisted
// correctly through the fixture round-trip + the clamper produces the
// narrowed result.

describe("B: user-narrowed install-time grant restored on reapprove (HIGH 2)", () => {
  test("non-bundled row with installedPermissions narrower than manifest → clamp restores narrowed only", async () => {
    // User originally approved `api.foo.com` only; the manifest
    // requested both `api.foo.com` and `api.bar.com`. Post-sweep,
    // `grantedPermissions.network` is gone — reapprove must restore
    // the narrowed set.
    const installedPerms: ExtensionPermissions = {
      network: ["api.foo.com"],
      grantedAt: { network: Date.now() - 30 * DAY_MS },
    };
    const ext = await makeTestExtension({
      id: "ext-b-1",
      name: "third-party-fetcher",
      isBundled: false,
      manifest: {
        permissions: {
          network: ["api.foo.com", "api.bar.com"],
          grantedAt: {},
        } as ExtensionPermissions,
      },
      installedPermissions: installedPerms,
      grantedPermissions: { grantedAt: {} },
    });

    // Round-trip the installedPermissions column.
    const stored = await ext.getInstalled();
    expect(stored).not.toBeNull();
    expect(stored?.network).toEqual(["api.foo.com"]);

    // Drive the production first-stage clamp (the reapprove route at
    // web/src/routes/api/extensions/[id]/reapprove/+server.ts:153-160
    // passes `installedPermissions ?? manifest.permissions` as the
    // ceiling target).
    const manifestPerms: ExtensionPermissions = {
      network: ["api.foo.com", "api.bar.com"],
      grantedAt: {},
    };
    // Intersect the user's narrowed choice with the manifest ceiling —
    // mirrors the route handler's first-stage clamp at
    // web/src/routes/api/extensions/[id]/reapprove/+server.ts:153-160.
    const clamped = intersectPermissions(installedPerms, manifestPerms);
    expect(clamped.network).toEqual(["api.foo.com"]);
    expect(clamped.network).not.toContain("api.bar.com");

    await ext.clear();
  });

  test("legacy row (installedPermissions=null) → fixture stores null, clamp falls back to manifest", async () => {
    // Pre-fix install rows have no `installedPermissions`. The fixture
    // must persist that as a true SQL NULL (not the string "null" or
    // an empty object) so the route handler's `?? manifest.permissions`
    // fallback fires correctly.
    const ext = await makeTestExtension({
      id: "ext-b-2",
      name: "legacy-third-party",
      isBundled: false,
      manifest: {
        permissions: {
          network: ["api.legacy.com"],
          grantedAt: {},
        } as ExtensionPermissions,
      },
      installedPermissions: null, // legacy row
      grantedPermissions: { grantedAt: {} },
    });

    expect(await ext.getInstalled()).toBeNull();

    // Fallback path: when installedPermissions is null, the route
    // passes `manifest.permissions` as both the submitted set AND the
    // ceiling — clamp passes the full manifest through.
    const manifestPerms: ExtensionPermissions = {
      network: ["api.legacy.com"],
      grantedAt: {},
    };
    // installedPermissions is null → route passes the manifest as both
    // submitted and ceiling → intersection passes the manifest through.
    const clamped = intersectPermissions(manifestPerms, manifestPerms);
    expect(clamped.network).toEqual(["api.legacy.com"]);

    await ext.clear();
  });
});

// ────────────────────────────────────────────────────────────────────
// D: confused-deputy intersection — non-deputy callee gets caps
//    intersected with caller's caps (HIGH 3 default)
// ────────────────────────────────────────────────────────────────────
//
// Verifies: HIGH 3 from tasks/v1.3-security-review.md (intersection-
// by-default for non-deputy callees on `ezcorp/invoke`).
//
// Existing coverage: cross-ext-attribution.test.ts:710 (HIGH 3 item j)
// + the post-flip CONFUSED-DEPUTY integration block (3 scenarios)
// cover the engine-level dispatch end-to-end with a recording stub.
//
// This integration test exercises the FIXTURE-side surface: the
// `acceptsCallerCaps: true` flag on the callee's manifest gets persisted
// correctly through the jsonb round-trip, and the pure intersection
// helper produces the spec-correct result given the seeded shapes.
// A regression in either the schema's manifest column or the
// intersection helper surfaces here.

describe("D: confused-deputy intersection — non-deputy callee gets caps intersected with caller (HIGH 3)", () => {
  test("Non-deputy callee (no acceptsCallerCaps flag) + empty-cap caller → intersection is empty", async () => {
    // Caller A has NO network grants. Callee B has network but is a
    // NON-deputy (no acceptsCallerCaps flag). Per the HIGH 3 flip,
    // the runtime defaults to intersection — A's empty caps narrow
    // the effective set to {}.
    const caller = await makeTestExtension({
      id: "ext-d-caller-1",
      name: "caller-a",
      manifest: {
        permissions: { grantedAt: {} } as ExtensionPermissions,
      },
      grantedPermissions: { grantedAt: {} },
    });
    const callee = await makeTestExtension({
      id: "ext-d-callee-1",
      name: "callee-b",
      manifest: {
        permissions: {
          network: ["api.test.example.com"],
          grantedAt: {},
        } as ExtensionPermissions,
        // No `acceptsCallerCaps: true` → non-deputy → default
        // intersection.
      },
      grantedPermissions: {
        network: ["api.test.example.com"],
        grantedAt: { network: Date.now() },
      },
    });

    // Round-trip the manifest jsonb — confirms the field shape the
    // runtime reads from `getManifest()`.
    const callerGrants = (await caller.getGrants()) ?? { grantedAt: {} };
    const calleeGrants = (await callee.getGrants()) ?? { grantedAt: {} };

    const callerCaps = grantsToCapabilitySet(callerGrants);
    const calleeCaps = grantsToCapabilitySet(calleeGrants);

    // The runtime's `handlePiInvoke` post-HIGH-3 ALWAYS computes
    // `intersect(callerCaps, calleeCaps)` for non-deputy callees
    // (src/extensions/tool-executor.ts handlePiInvoke). A's empty
    // caps drive the intersection to [].
    const effective = intersect(callerCaps, calleeCaps);
    expect(effective).toEqual([]);
    // The PDP with `capContext: []` cannot authorize any network
    // capability, regardless of what's in the callee's installed
    // grants — that's the confused-deputy gate.

    await caller.clear();
    await callee.clear();
  });

  test("Counter-case: caller also has the network host → intersection contains it → call ALLOWED", async () => {
    // Same setup but the caller ALSO has the network host. The
    // intersection now contains it — the PDP would authorize.
    const caller = await makeTestExtension({
      id: "ext-d-caller-2",
      name: "caller-a-2",
      manifest: {
        permissions: {
          network: ["api.test.example.com"],
          grantedAt: {},
        } as ExtensionPermissions,
      },
      grantedPermissions: {
        network: ["api.test.example.com"],
        grantedAt: { network: Date.now() },
      },
    });
    const callee = await makeTestExtension({
      id: "ext-d-callee-2",
      name: "callee-b-2",
      manifest: {
        permissions: {
          network: ["api.test.example.com", "api.other.example.com"],
          grantedAt: {},
        } as ExtensionPermissions,
      },
      grantedPermissions: {
        network: ["api.test.example.com", "api.other.example.com"],
        grantedAt: { network: Date.now() },
      },
    });

    const callerGrants = (await caller.getGrants()) ?? { grantedAt: {} };
    const calleeGrants = (await callee.getGrants()) ?? { grantedAt: {} };

    const effective = intersect(
      grantsToCapabilitySet(callerGrants),
      grantsToCapabilitySet(calleeGrants),
    );
    // Intersection contains the shared host — the PDP authorizes it.
    // Callee's `api.other.example.com` is dropped (caller never had it),
    // closing the laundering vector.
    expect(effective).toContainEqual({
      kind: "network",
      value: "api.test.example.com",
    });
    expect(effective).not.toContainEqual({
      kind: "network",
      value: "api.other.example.com",
    });

    await caller.clear();
    await callee.clear();
  });

  test("OPT-OUT case: callee with acceptsCallerCaps:true → intersection NOT computed in runtime", async () => {
    // The HIGH 3 flip made `acceptsCallerCaps: true` the OPT-OUT — when
    // set, the callee runs with its OWN installed grants, not the
    // intersection. This case verifies the flag survives the jsonb
    // round-trip so the runtime can read it correctly. The full
    // runtime-level assertion (capContext IS undefined when the flag
    // is set) lives in cross-ext-attribution.test.ts:(c)-(f); this
    // integration test asserts only the persistence layer.
    const callee = await makeTestExtension({
      id: "ext-d-deputy",
      name: "trusted-deputy",
      manifest: {
        permissions: {
          network: ["api.deputy.example.com"],
          grantedAt: {},
        } as ExtensionPermissions,
        acceptsCallerCaps: true, // opt-out marker
      },
      grantedPermissions: {
        network: ["api.deputy.example.com"],
        grantedAt: { network: Date.now() },
      },
    });

    // Read the row back via drizzle (typed select) and confirm the
    // manifest's flag survived the jsonb round-trip. The runtime reads
    // this exact field via `registry.getManifest().acceptsCallerCaps`
    // in `src/extensions/tool-executor.ts handlePiInvoke`.
    const db = getDb();
    const { extensions } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(extensions).where(eq(extensions.id, callee.id));
    const row = rows[0];
    expect(row).toBeDefined();
    expect((row?.manifest as { acceptsCallerCaps?: boolean } | undefined)?.acceptsCallerCaps).toBe(true);

    await callee.clear();
  });
});

// ────────────────────────────────────────────────────────────────────
// Fixture-API smoke tests
// ────────────────────────────────────────────────────────────────────
//
// `makeTestExtension` is shared across A/B/D and any future v1.3
// permission-backbone integration test. These cases exercise the
// affordance surface (`forceExpire`, `getGrants`, `getInstalled`,
// `clear`) directly so a regression in the fixture (rather than the
// system under test) is attributed correctly.

describe("makeTestExtension fixture — affordance smoke", () => {
  test("forceExpire writes a stale grantedAt timestamp the sweep would revoke", async () => {
    const ext = await makeTestExtension({
      id: "ext-fx-1",
      name: "fx-test",
      grantedPermissions: {
        network: ["api.fresh.example.com"],
        grantedAt: { network: Date.now() },
      },
    });

    await ext.forceExpire("network");
    const grants = await ext.getGrants();
    expect(grants?.grantedAt?.network).toBeDefined();
    // 91 days ago — well past the 90-day TTL the sweep enforces.
    const age = Date.now() - (grants?.grantedAt?.network ?? 0);
    expect(age).toBeGreaterThanOrEqual(91 * DAY_MS - 1000);
    await ext.clear();
  });

  test("clear() removes the row + getGrants returns null afterwards", async () => {
    const ext = await makeTestExtension({ id: "ext-fx-2", name: "fx-test-2" });
    expect(await ext.getGrants()).not.toBeNull();
    await ext.clear();
    expect(await ext.getGrants()).toBeNull();
  });

  test("installedPermissions defaults to null (legacy row); explicit value is persisted as jsonb", async () => {
    // Default — null.
    const legacy = await makeTestExtension({ id: "ext-fx-3a", name: "fx-legacy" });
    expect(await legacy.getInstalled()).toBeNull();
    await legacy.clear();

    // Explicit — round-trips through jsonb.
    const explicit = await makeTestExtension({
      id: "ext-fx-3b",
      name: "fx-explicit",
      installedPermissions: {
        network: ["api.installed.example.com"],
        grantedAt: { network: Date.now() - 10 * DAY_MS },
      },
    });
    const installed = await explicit.getInstalled();
    expect(installed?.network).toEqual(["api.installed.example.com"]);
    await explicit.clear();
  });
});
