/**
 * Admin drift re-approval for bundled extensions
 * (`src/extensions/bundled-drift-reapprove.ts`).
 *
 * The bug this pins: the S6/S9 boot gate disables a NON-critical
 * bundled extension whose manifest permissions changed in a release
 * ("pending re-approval"), but no sanctioned re-approval path existed —
 * the stored-manifest reapprove route and the ceiling-clamped PUT both
 * dead-end on the stale stored manifest. Found blocking the web-search
 * zero-setup rollout on every deploy.
 *
 * Drives the REAL `ensureBundledExtensions` + `reapproveBundledDrift`
 * through the same mock-store infrastructure as
 * bundled-critical-s9.test.ts / web-search-bundled-install.test.ts,
 * with the REAL on-disk web-search manifest + the REAL
 * manifest.lock.json verification (the lockfile-mismatch case swaps in
 * a tampered lockfile via the `setLockfilePathOverride` test seam).
 *
 * Coverage:
 *   1. The bug + happy path + boot convergence: stale row → S9
 *      disables → reapproveBundledDrift heals (ceiling-clamped disk
 *      grant, manifest/version refreshed, enabled, audit row, diffs)
 *      → next `ensureBundledExtensions` does NOT re-disable.
 *   2. Ceiling clamp: a disk manifest declaring a host beyond the
 *      bundled ceiling → granted set excludes it (ceiling wins), no error.
 *   3. Lockfile mismatch → refused, row untouched, still disabled.
 *   4. Idempotent: second call succeeds with empty diffs, no grant change.
 *   5. Non-bundled name → `not-bundled` refusal.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";

// ── Capture the REAL loader before the passthrough mock below ──────
// (module body runs after hoisted imports, so this grabs the real fn).
import { loadManifest as realLoadManifest, loadManifestFresh as realLoadManifestFresh } from "../extensions/loader";
const realFresh = realLoadManifestFresh;
const realLoad = realLoadManifest;

/**
 * Per-test manifest doctoring seam. When set, the web-search disk
 * manifest is passed through this mutator — used by the ceiling-clamp
 * case to declare a host beyond the bundled ceiling without touching
 * the real example dir. Every other extension (and every test with the
 * seam unset) gets the genuine on-disk manifest.
 */
let manifestMutator: ((m: ExtensionManifestV2) => ExtensionManifestV2) | null = null;

mock.module("../extensions/loader", () => ({
  loadManifest: realLoad,
  loadManifestFresh: async (dir: string) => {
    const m = await realFresh(dir);
    return manifestMutator && dir.endsWith("web-search") ? manifestMutator(m) : m;
  },
}));

// ── Audit spy ───────────────────────────────────────────────────────
interface CapturedAudit {
  userId: string | null;
  action: string;
  target: string | undefined;
  metadata: Record<string, unknown> | undefined;
}
const auditEntries: CapturedAudit[] = [];
/** Throw seam for the audit-write-failure swallow branch. */
let auditShouldThrow = false;

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    userId: string | null,
    action: string,
    target?: string,
    metadata?: Record<string, unknown>,
  ) => {
    if (auditShouldThrow) throw new Error("audit table unavailable");
    auditEntries.push({ userId, action, target, metadata });
    return `audit-${auditEntries.length}`;
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

// ── In-memory extension store (mirrors bundled-critical-s9.test.ts) ─
import { createMockExtensionsStore, type MockExtensionRow } from "./helpers/mock-extensions-store";

const extStore = createMockExtensionsStore({ keyBy: "name" });
const store = extStore.store;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: extStore.getExtensionByName,
  createExtension: extStore.createExtension,
  listExtensions: extStore.listExtensions,
  updateExtension: extStore.updateExtension,
  deleteExtension: async () => undefined,
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  extStore.reset();
  auditEntries.length = 0;
  auditShouldThrow = false;
  manifestMutator = null;
});

/**
 * Seed a web-search DB row from an OLD release: keyed providers only
 * (pre-zero-setup — missing the keyless DDG/SearXNG hosts), old
 * version, no tools snapshot. Both the version+perm trigger AND the
 * tool-list-signature trigger of `detectVersionBumpRequiringReapproval`
 * fire against the current on-disk manifest, so the next boot disables
 * the row "pending re-approval" — the exact rollout bug.
 */
const OLD_NETWORK = ["api.tavily.com", "api.search.brave.com"];
const OLD_ENV = ["TAVILY_API_KEY", "BRAVE_API_KEY"];
function seedStaleWebSearch(): MockExtensionRow {
  const row: MockExtensionRow = {
    id: "seed-web-search",
    name: "web-search",
    // Denormalized column carries the STALE description — the live
    // repro was the UI showing "Keyless by default (Jina AI)" while the
    // disk manifest had moved on to SearXNG. Reapprove must sync it.
    description: "stale pre-zero-setup release",
    enabled: true,
    isBundled: true,
    installPath: "docs/extensions/examples/web-search",
    version: "0.9.0",
    manifest: {
      schemaVersion: 2,
      name: "web-search",
      version: "0.9.0",
      description: "stale pre-zero-setup release",
      author: { name: "EZCorp" },
      permissions: { network: OLD_NETWORK, env: OLD_ENV, filesystem: ["$CWD"] },
    },
    grantedPermissions: {
      network: [...OLD_NETWORK],
      env: [...OLD_ENV],
      filesystem: ["$CWD"],
      grantedAt: { network: 1111, env: 1111, filesystem: 1111 },
    } as ExtensionPermissions,
  };
  store.set("web-search", row);
  return row;
}

describe("bundled drift re-approval", () => {
  test("preview exposes every newly added capability before approval", async () => {
    const { previewBundledDrift } = await import("../extensions/bundled-drift-reapprove");
    const row: MockExtensionRow = {
      id: "seed-city-conditions",
      name: "city-conditions",
      enabled: true,
      isBundled: true,
      installPath: "docs/extensions/examples/city-conditions",
      version: "0.1.0",
      manifest: {
        name: "city-conditions",
        version: "0.1.0",
        permissions: {
          network: [
            "geocoding-api.open-meteo.com",
            "api.open-meteo.com",
            "air-quality-api.open-meteo.com",
          ],
        },
      },
      grantedPermissions: {
        network: [
          "geocoding-api.open-meteo.com",
          "api.open-meteo.com",
          "air-quality-api.open-meteo.com",
        ],
        grantedAt: { network: 1 },
      } as ExtensionPermissions,
    };

    const result = await previewBundledDrift(row);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.grant.network).toContain("www.atlantaallergy.com");
    expect(result.grant.network).toContain("pollen.googleapis.com");

    // The point of the preview is that NOTHING new is granted silently:
    // every tier the row is about to gain must appear as its own diff, with
    // the pre-approval value on the left. The three hosts already granted
    // stay put; the v0.2 station host, the v0.3 Google host, and the v0.3
    // Storage tier (which holds the user's Google key) are all new.
    const network = result.diffs.find((d) => d.field === "network");
    expect(network?.oldValue).toEqual([
      "geocoding-api.open-meteo.com",
      "api.open-meteo.com",
      "air-quality-api.open-meteo.com",
    ]);
    expect(network?.newValue).toEqual([
      "geocoding-api.open-meteo.com",
      "api.open-meteo.com",
      "air-quality-api.open-meteo.com",
      "pollen.googleapis.com",
      "www.atlantaallergy.com",
    ]);
    expect(result.diffs).toContainEqual({
      field: "storage",
      oldValue: undefined,
      newValue: true,
    });
    expect(result.diffs).toContainEqual({
      field: "workflows",
      oldValue: undefined,
      newValue: { names: ["conditions"], maxRunsPerHour: 12 },
    });

    // Still fail-closed on the tiers this extension must never hold, so a
    // widened preview can't quietly become a blanket approval.
    for (const field of ["shell", "filesystem", "env"]) {
      expect(result.diffs.some((d) => d.field === field)).toBe(false);
    }
  }, 30_000);

  test("diffGrants canonicalizes like equalPermissions — a network reorder with the same host set is not a phantom diff", async () => {
    const { previewBundledDrift } = await import("../extensions/bundled-drift-reapprove");
    // Same city-conditions manifest as the "preview exposes every newly
    // added capability" case above, but the STORED prior grant already
    // holds the full current host set — just in a different array order
    // than the on-disk manifest declares (as would happen if a past
    // release listed `permissions.network` in a different order with the
    // same hosts). `intersectPermissions` preserves the REQUESTED side's
    // (disk manifest's) array order rather than sorting, so the freshly
    // computed grant and the stored prior grant differ in order only —
    // `equalPermissions`/`canonicalizePerms` in bundled-ceiling.ts already
    // treats that as equal (it sorts string arrays). `diffGrants` must not
    // diverge from that and report a changed field for order alone.
    const row: MockExtensionRow = {
      id: "seed-city-conditions-reorder",
      name: "city-conditions",
      enabled: true,
      isBundled: true,
      installPath: "docs/extensions/examples/city-conditions",
      version: "0.1.0",
      manifest: {
        name: "city-conditions",
        version: "0.1.0",
        permissions: {
          storage: true,
          network: [
            "geocoding-api.open-meteo.com",
            "api.open-meteo.com",
            "air-quality-api.open-meteo.com",
            "pollen.googleapis.com",
            "www.atlantaallergy.com",
          ],
          workflows: { names: ["conditions"], maxRunsPerHour: 12 },
        },
      },
      grantedPermissions: {
        storage: true,
        // Same five hosts as the disk manifest/ceiling, reverse order.
        network: [
          "www.atlantaallergy.com",
          "pollen.googleapis.com",
          "air-quality-api.open-meteo.com",
          "api.open-meteo.com",
          "geocoding-api.open-meteo.com",
        ],
        workflows: { names: ["conditions"], maxRunsPerHour: 12 },
        grantedAt: { storage: 1, network: 1, workflows: 1 },
      } as ExtensionPermissions,
    };

    const result = await previewBundledDrift(row);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // The freshly computed grant does carry the disk manifest's array
    // order (not sorted) — that's `intersectPermissions`'s documented
    // behavior, not the bug.
    expect(result.grant.network).toEqual([
      "geocoding-api.open-meteo.com",
      "api.open-meteo.com",
      "air-quality-api.open-meteo.com",
      "pollen.googleapis.com",
      "www.atlantaallergy.com",
    ]);
    // But it must NOT show up as a diff: same hosts, order-only churn.
    expect(result.diffs.some((d) => d.field === "network")).toBe(false);
    expect(result.diffs.some((d) => d.field === "storage")).toBe(false);
    expect(result.diffs.some((d) => d.field === "workflows")).toBe(false);
    expect(result.diffs).toEqual([]);
  }, 30_000);

  test("a stored rbacScopes declaration produces NO diff entry — a grant-vs-grant diff cannot express a declaration change", async () => {
    const { previewBundledDrift } = await import("../extensions/bundled-drift-reapprove");
    // REGRESSION GUARD against reintroducing `canonicalizePerms({
    // includeRbacScopes: true})` in `diffGrants` (shipped in 4dc382ab,
    // reverted). The premise of that change — "an admin should see a
    // scope renamed read → admin" — cannot be served by THIS comparison:
    // `diffGrants` receives the output of `clampToBundledCeiling`, and
    // `intersectPermissions` never emits `rbacScopes` (it drops the
    // declaration even when BOTH sides declare it). The new side is
    // therefore always `undefined`, so the only entry the opt-in can
    // produce is `{oldValue:<stale blob>, newValue:undefined}` — which a
    // UI renders as REMOVED, wrongly, on every preview until the row is
    // healed. Silence is correct; surfacing declaration changes would
    // need the MANIFEST as input, not the grant.
    //
    // github-projects is the fixture because its REAL on-disk manifest
    // declares one scope (`write-tickets`). The stored row below carries
    // a DIFFERENT declaration, the shape a row written by an older
    // release leaves behind — `grantedPermissions` is unvalidated jsonb
    // on read, and nothing rewrites it until a heal lands.
    const EVENTS = [
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
    ];
    const STALE_SCOPES = [{ name: "read-tickets", description: "Read board tickets" }];
    const row: MockExtensionRow = {
      id: "seed-github-projects-rbac",
      name: "github-projects",
      enabled: true,
      isBundled: true,
      installPath: "docs/extensions/examples/github-projects",
      version: "0.1.0",
      manifest: { name: "github-projects", version: "0.1.0" },
      grantedPermissions: {
        eventSubscriptions: EVENTS,
        storage: true,
        rbacScopes: STALE_SCOPES,
        grantedAt: { eventSubscriptions: 1, storage: 1 },
      } as unknown as ExtensionPermissions,
    };

    const result = await previewBundledDrift(row);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // The premise, asserted rather than assumed: the freshly clamped
    // grant carries no declaration, so there is no "new value" any diff
    // entry could report against.
    expect((result.grant as unknown as Record<string, unknown>).rbacScopes).toBeUndefined();

    // THE GUARD: no rbacScopes row, despite the stored side carrying one.
    expect(result.diffs.some((d) => d.field === "rbacScopes")).toBe(false);

    // Non-vacuous: the fixture really did reach the comparator with the
    // stale declaration on the old side (it is still on the row), and
    // nothing else about this row drifted either — so the screen is
    // silent because the field is excluded, not because the diff is
    // empty for some unrelated reason.
    expect(
      (row.grantedPermissions as unknown as Record<string, unknown>).rbacScopes,
    ).toEqual(STALE_SCOPES);
    expect(result.diffs.some((d) => d.field === "eventSubscriptions")).toBe(false);
    expect(result.diffs.some((d) => d.field === "storage")).toBe(false);
    expect(result.diffs).toEqual([]);
  }, 30_000);

  test("the bug + happy path + boot convergence: S9 disables, reapprove heals from disk, next boot stays enabled", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    const { reapproveBundledDrift } = await import("../extensions/bundled-drift-reapprove");
    seedStaleWebSearch();

    // ── The bug: boot drift gate disables the non-critical row ──────
    await ensureBundledExtensions();
    const row = store.get("web-search")!;
    expect(row.enabled).toBe(false); // "pending re-approval", no exit pre-fix

    // ── The heal ────────────────────────────────────────────────────
    const result = await reapproveBundledDrift(row, "admin-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // Grant == ceiling-clamped DISK set. Shared-search Phase 1 turned
    // web-search into a thin shim: the on-disk manifest no longer
    // declares network/env/filesystem (the provider chain moved
    // host-side), so the heal DROPS the stale network/env grant and
    // grants the new `search` capability ("inherit", per the ceiling).
    const granted = row.grantedPermissions as ExtensionPermissions;
    expect(granted.search).toBe("inherit");
    expect(granted.network ?? []).toEqual([]);
    expect(granted.env ?? []).toEqual([]);
    expect(granted.filesystem ?? []).toEqual([]);
    // The approved snapshot is also the future expiry-reapproval ceiling.
    expect(row.installedPermissions).toEqual(granted);
    // Fresh grantedAt stamp for the surviving `search` field.
    expect(typeof granted.grantedAt?.search).toBe("number");

    // Manifest + version refreshed from disk; row re-enabled.
    const manifest = row.manifest as ExtensionManifestV2;
    expect(row.version).toBe("1.0.0");
    expect(manifest.version).toBe("1.0.0");
    // D3 — the denormalized `description` column syncs from the disk
    // manifest (the UI reads the column, not the jsonb). The stale
    // pre-shim text is gone; the new ctx.search description is in place.
    expect(row.description).not.toBe("stale pre-zero-setup release");
    expect(row.description).toBe(manifest.description);
    expect(row.description).toContain("ctx.search");
    expect(manifest.permissions?.search).toBe("inherit");
    expect(Array.isArray(manifest.tools)).toBe(true); // tool snapshot present
    expect(row.enabled).toBe(true);
    // An admin re-approving is an EXPLICIT enable, so it also withdraws any
    // earlier user opt-out. Leaving the flag set would put the row in the
    // contradictory state `enabled=true, disabledByUser=true`, which the next
    // boot's reconcilers read as conflicting intent.
    expect(row.disabledByUser).toBe(false);

    // Audit row written with the admin as actor.
    const audits = auditEntries.filter((a) => a.action === "ext:bundled:drift-reapproved");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId).toBe("admin-1");
    expect(audits[0]?.target).toBe("seed-web-search");
    expect(audits[0]?.metadata?.actor).toBe("admin-1");

    // Phase B — a TYPED capability-policy-write row accompanies the
    // summary row (additive). The stale grant had no `search` field; the
    // heal grants `search: "inherit"`, so the policy field changed.
    const policyRows = auditEntries.filter(
      (a) => a.action === "ext:capability-policy-write",
    );
    const searchPolicyRow = policyRows.find((a) => a.metadata?.capability === "search");
    expect(searchPolicyRow).toBeDefined();
    expect(searchPolicyRow?.userId).toBe("admin-1");
    expect(searchPolicyRow?.target).toBe("seed-web-search");
    expect(searchPolicyRow?.metadata).toMatchObject({
      capability: "search",
      oldValue: undefined,
      newValue: "inherit",
      actor: "admin-1",
      reason: "drift-reapprove",
      route: "reapprove-drift",
    });

    // Response diffs mirror the boot gate's {field, oldValue, newValue}
    // shape. The stale network is removed; `search` is added.
    const networkDiff = result.diffs.find((d) => d.field === "network");
    expect(networkDiff).toBeDefined();
    expect(networkDiff?.oldValue).toEqual(OLD_NETWORK);
    const searchDiff = result.diffs.find((d) => d.field === "search");
    expect(searchDiff).toBeDefined();
    expect(searchDiff?.newValue).toBe("inherit");

    // ── Boot convergence pin (the actual bug): next boot's drift gate
    // passes and the row is NOT re-disabled. ─────────────────────────
    await ensureBundledExtensions();
    const afterBoot = store.get("web-search")!;
    expect(afterBoot.enabled).toBe(true);
    expect(afterBoot.version).toBe("1.0.0");
    // Grant survives the boot reconcile (no oscillation).
    const grantAfterBoot = afterBoot.grantedPermissions as ExtensionPermissions;
    expect(grantAfterBoot.search).toBe("inherit");
  }, 30_000);

  test("ceiling clamp: a disk manifest declaring a host beyond the ceiling is silently narrowed (ceiling wins, no error)", async () => {
    const { reapproveBundledDrift } = await import("../extensions/bundled-drift-reapprove");
    const row = seedStaleWebSearch();
    row.enabled = false;

    manifestMutator = (m) => ({
      ...m,
      permissions: {
        ...(m.permissions ?? {}),
        network: [...((m.permissions?.network as string[]) ?? []), "evil.example.com"],
      },
    });

    const result = await reapproveBundledDrift(row, "admin-1");
    expect(result.ok).toBe(true);

    const granted = row.grantedPermissions as ExtensionPermissions;
    // The web-search bundled ceiling is now `search: "inherit"` ONLY (the
    // shim owns no network). A disk manifest that tries to smuggle in ANY
    // network host is fully dropped by the ceiling — including the
    // excess `evil.example.com`. The legitimate `search` grant survives.
    expect(granted.network ?? []).toEqual([]);
    expect(granted.network ?? []).not.toContain("evil.example.com");
    expect(granted.search).toBe("inherit");
    expect(row.enabled).toBe(true);
    // The clamp is recorded on the audit row for forensics.
    const audit = auditEntries.find((a) => a.action === "ext:bundled:drift-reapproved");
    expect(audit?.metadata?.ceilingClamped).toBe(true);
  }, 30_000);

  test("lockfile mismatch: refused, row untouched, still disabled, no audit row", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    const { reapproveBundledDrift } = await import("../extensions/bundled-drift-reapprove");
    const { resolveLockfilePath, setLockfilePathOverride, clearLockfileCache } = await import(
      "../extensions/bundled-lock"
    );
    seedStaleWebSearch();
    await ensureBundledExtensions(); // real lockfile → gate disables the stale row
    const row = store.get("web-search")!;
    expect(row.enabled).toBe(false);

    // Tamper a COPY of the real lockfile (web-search toolsHash) and
    // point the verifier at it via the test seam.
    const realLock = JSON.parse(await Bun.file(resolveLockfilePath()).text());
    realLock.extensions["web-search"].toolsHash = "sha256-TAMPERED";
    const badLockPath = join(tmpdir(), `ezcorp-bad-lock-${Date.now()}.json`);
    await Bun.write(badLockPath, JSON.stringify(realLock));
    setLockfilePathOverride(badLockPath);

    try {
      const result = await reapproveBundledDrift(row, "admin-1");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("lockfile-mismatch");

      // Row untouched: still disabled, stale grant + version intact.
      expect(row.enabled).toBe(false);
      expect(row.version).toBe("0.9.0");
      expect((row.grantedPermissions as ExtensionPermissions).network).toEqual(OLD_NETWORK);
      expect(
        auditEntries.some((a) => a.action === "ext:bundled:drift-reapproved"),
      ).toBe(false);
    } finally {
      setLockfilePathOverride(undefined);
      clearLockfileCache();
    }
  }, 30_000);

  test("idempotent: a second call succeeds with empty diffs and no grant change", async () => {
    const { reapproveBundledDrift } = await import("../extensions/bundled-drift-reapprove");
    const row = seedStaleWebSearch();
    row.enabled = false;

    const first = await reapproveBundledDrift(row, "admin-1");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.diffs.length).toBeGreaterThan(0);
    const grantAfterFirst = JSON.parse(JSON.stringify(row.grantedPermissions));

    // Phase B — clear audit trail before the no-drift second call so we
    // can assert NO typed capability-policy row is emitted when the
    // search policy is unchanged.
    auditEntries.length = 0;
    const second = await reapproveBundledDrift(row, "admin-1");
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    // No drift left → empty diff summary; refresh/enable is a no-op-safe heal.
    expect(second.diffs).toEqual([]);
    expect(row.enabled).toBe(true);

    // Grant unchanged modulo the refreshed grantedAt stamps.
    const grantAfterSecond = row.grantedPermissions as ExtensionPermissions;
    const stripStamps = (g: Record<string, unknown>) => {
      const { grantedAt: _ignored, ...rest } = g;
      return rest;
    };
    expect(stripStamps(grantAfterSecond as unknown as Record<string, unknown>)).toEqual(
      stripStamps(grantAfterFirst),
    );
    // No-drift heal → no typed capability-policy-write row.
    expect(
      auditEntries.some((a) => a.action === "ext:capability-policy-write"),
    ).toBe(false);
  }, 30_000);

  test("unreadable on-disk manifest → manifest-unreadable refusal, row untouched", async () => {
    const { reapproveBundledDrift } = await import("../extensions/bundled-drift-reapprove");
    const row = seedStaleWebSearch();
    row.enabled = false;

    manifestMutator = () => {
      throw new Error("ezcorp.config.ts parse failure");
    };

    const result = await reapproveBundledDrift(row, "admin-1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("manifest-unreadable");
    expect(result.message).toMatch(/parse failure/);
    expect(row.enabled).toBe(false);
    expect(row.version).toBe("0.9.0");
    expect(auditEntries).toHaveLength(0);
  }, 30_000);

  test("row deleted between fetch and update (race) → not-found refusal", async () => {
    const { reapproveBundledDrift } = await import("../extensions/bundled-drift-reapprove");
    // A web-search-shaped row whose id is NOT in the store — the
    // mocked updateExtension returns null, mirroring a concurrent
    // delete between the route's getExtension and the heal's write.
    const ghost = {
      ...seedStaleWebSearch(),
      id: "ghost-row",
    };
    store.delete("web-search");

    const result = await reapproveBundledDrift(ghost, "admin-1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("not-found");
    expect(auditEntries).toHaveLength(0);
  }, 30_000);

  test("audit-write failure is swallowed — the heal itself still lands", async () => {
    const { reapproveBundledDrift } = await import("../extensions/bundled-drift-reapprove");
    const row = seedStaleWebSearch();
    row.enabled = false;
    auditShouldThrow = true;

    const result = await reapproveBundledDrift(row, "admin-1");
    expect(result.ok).toBe(true);
    expect(row.enabled).toBe(true);
    expect(row.version).toBe("1.0.0");
    expect((row.grantedPermissions as ExtensionPermissions).search).toBe("inherit");
    expect(auditEntries).toHaveLength(0);
  }, 30_000);

  test("non-bundled extension name → not-bundled refusal, nothing written", async () => {
    const { reapproveBundledDrift } = await import("../extensions/bundled-drift-reapprove");
    const result = await reapproveBundledDrift(
      { id: "ext-user-1", name: "definitely-not-bundled" },
      "admin-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("not-bundled");
    expect(auditEntries).toHaveLength(0);
  }, 30_000);
});
