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
interface StoredExtension {
  id: string;
  name: string;
  description?: string;
  manifest: unknown;
  installPath: string;
  enabled: boolean;
  isBundled?: boolean;
  grantedPermissions: ExtensionPermissions;
  version?: string;
}

let store: Map<string, StoredExtension>;
let nextId = 0;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => store.get(name) ?? null,
  createExtension: async (data: Omit<StoredExtension, "id">) => {
    const id = `ext-${++nextId}`;
    const row = { id, ...data } as StoredExtension;
    store.set(data.name, row);
    return row;
  },
  listExtensions: async () => Array.from(store.values()),
  updateExtension: async (id: string, patch: Partial<StoredExtension>) => {
    for (const row of store.values()) {
      if (row.id === id) {
        Object.assign(row, patch);
        return row;
      }
    }
    return null;
  },
  deleteExtension: async () => undefined,
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  store = new Map();
  nextId = 0;
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
function seedStaleWebSearch(): StoredExtension {
  const row: StoredExtension = {
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

const NEW_KEYLESS_HOSTS = [
  "lite.duckduckgo.com",
  "html.duckduckgo.com",
  "duckduckgo.com",
  "searxng",
  "localhost",
  "127.0.0.1",
];

describe("bundled drift re-approval", () => {
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

    // Grant == ceiling-clamped DISK set (old hosts survive, new
    // keyless hosts granted).
    const granted = row.grantedPermissions as ExtensionPermissions;
    for (const host of [...OLD_NETWORK, ...NEW_KEYLESS_HOSTS]) {
      expect(granted.network).toContain(host);
    }
    expect(granted.env).toContain("SEARXNG_BASE_URL");
    expect(granted.filesystem).toEqual(["$CWD"]);
    // Fresh grantedAt stamps for every surviving field.
    expect(typeof granted.grantedAt?.network).toBe("number");
    expect(granted.grantedAt?.network).toBeGreaterThan(1111);

    // Manifest + version refreshed from disk; row re-enabled.
    const manifest = row.manifest as ExtensionManifestV2;
    expect(row.version).toBe("1.0.0");
    expect(manifest.version).toBe("1.0.0");
    // D3 — the denormalized `description` column syncs from the disk
    // manifest (the UI reads the column, not the jsonb). The stale
    // "Keyless by default (Jina AI)"-era text is gone; the SearXNG
    // description is in place.
    expect(row.description).not.toBe("stale pre-zero-setup release");
    expect(row.description).toBe(manifest.description);
    expect(row.description).toContain("SearXNG sidecar");
    expect(manifest.permissions?.network).toContain("searxng");
    expect(Array.isArray(manifest.tools)).toBe(true); // tool snapshot present
    expect(row.enabled).toBe(true);

    // Audit row written with the admin as actor.
    const audits = auditEntries.filter((a) => a.action === "ext:bundled:drift-reapproved");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId).toBe("admin-1");
    expect(audits[0]?.target).toBe("seed-web-search");
    expect(audits[0]?.metadata?.actor).toBe("admin-1");

    // Response diffs mirror the boot gate's {field, oldValue, newValue}
    // shape and capture what was granted.
    const networkDiff = result.diffs.find((d) => d.field === "network");
    expect(networkDiff).toBeDefined();
    expect(networkDiff?.oldValue).toEqual(OLD_NETWORK);
    expect(networkDiff?.newValue).toContain("searxng");
    expect(result.diffs.find((d) => d.field === "env")).toBeDefined();
    // filesystem unchanged → not in the diff summary.
    expect(result.diffs.find((d) => d.field === "filesystem")).toBeUndefined();

    // ── Boot convergence pin (the actual bug): next boot's drift gate
    // passes and the row is NOT re-disabled. ─────────────────────────
    await ensureBundledExtensions();
    const afterBoot = store.get("web-search")!;
    expect(afterBoot.enabled).toBe(true);
    expect(afterBoot.version).toBe("1.0.0");
    // Grant survives the boot reconcile (no oscillation).
    const grantAfterBoot = afterBoot.grantedPermissions as ExtensionPermissions;
    for (const host of NEW_KEYLESS_HOSTS) {
      expect(grantAfterBoot.network).toContain(host);
    }
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
    // The excess host is dropped by the bundled ceiling…
    expect(granted.network).not.toContain("evil.example.com");
    // …while the legitimate within-ceiling widening still lands.
    expect(granted.network).toContain("lite.duckduckgo.com");
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
    expect((row.grantedPermissions as ExtensionPermissions).network).toContain("searxng");
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
