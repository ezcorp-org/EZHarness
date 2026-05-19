/**
 * Phase 5 — production-path integration coverage.
 *
 * The unit-level tests in `bundled-ceiling.test.ts` and
 * `manifest-tamper.test.ts` exercise the helper functions in isolation.
 * This file closes the auditor's two CRITICAL gaps:
 *
 *   1. Drive `ensureBundledExtensions` with a TAMPERED `manifest.lock.json`
 *      and assert the wired path through `bundled.ts:441-460` actually
 *      writes a `BUNDLED_MANIFEST_TAMPER` audit row AND flips
 *      `enabled=false` on the extension row.
 *
 *   2. Drive `ensureBundledExtensions` against a NARROWED ceiling
 *      (mock.module overrides `getCeiling` to return an empty grant
 *      for scratchpad) and assert the install path emits a
 *      `BUNDLED_CEILING_CLAMP` audit row with metadata fields populated
 *      AND that the persisted grant is the clamped (empty) shape.
 *
 * Plus two nice-to-haves:
 *
 *   3. Lockfile idempotency — `buildLockfile(repo)` twice yields no
 *      diff (other than `generatedAt`).
 *   4. ai-kit on-disk manifest regression guard — load the actual
 *      manifest at `packages/@ezcorp/ai-kit/ezcorp.config.ts`, clamp
 *      against the real ceiling, assert no clamp.
 *
 * NOTE: this file uses two SEPARATE describes wired through the same
 * mock infrastructure but with `mock.module("../extensions/bundled-ceiling")`
 * scoped to the M2 block via Bun's per-call module replacement. The
 * helper imports under test are dynamically loaded after each `mock.module`
 * setup so the production code (`bundled.ts`) sees the right ceiling.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionPermissions } from "../extensions/types";

// ── mocks (must be set up before module-under-test is imported) ─────

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

interface StoredExtension {
  id: string;
  name: string;
  manifest: unknown;
  installPath: string;
  enabled: boolean;
  consecutiveFailures?: number;
  isBundled?: boolean;
  grantedPermissions: ExtensionPermissions;
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
  deleteExtension: async (id: string) => {
    for (const [k, v] of store) if (v.id === id) store.delete(k);
  },
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  store = new Map();
  nextId = 0;
  auditEntries.length = 0;
});

// ──────────────────────────────────────────────────────────────────
// M1. Manifest-tamper INTEGRATION through ensureBundledExtensions
// ──────────────────────────────────────────────────────────────────

describe("M1 — tampered lockfile drives the production disable + audit path", () => {
  test("a wrong toolsHash for scratchpad disables the extension AND writes BUNDLED_MANIFEST_TAMPER", async () => {
    // Lazy import the lockfile module + bundled wiring AFTER the
    // shared `mock.module` registrations above. This guarantees
    // `bundled.ts` resolves through the mocked db/audit modules.
    const { setLockfilePathOverride, clearLockfileCache } = await import(
      "../extensions/bundled-lock"
    );
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    const { EXT_AUDIT_ACTIONS } = await import("../extensions/audit-actions");

    // Step 1: install all bundled extensions normally. The committed
    // `manifest.lock.json` at the repo root is consulted (no override
    // active yet). Confirm scratchpad lands enabled.
    setLockfilePathOverride(undefined);
    clearLockfileCache();
    await ensureBundledExtensions();
    const scratchpad = store.get("scratchpad");
    expect(scratchpad).toBeDefined();
    expect(scratchpad?.enabled).toBe(true);

    // Step 2: write a TAMPERED lockfile to a temp dir and point the
    // verifier at it. The toolsHash for scratchpad is replaced with
    // a known-bad value so the next refresh cycle trips the
    // tamper detector.
    const tempDir = await mkdtemp(join(tmpdir(), "tamper-integration-"));
    try {
      const tamperedLockPath = join(tempDir, "manifest.lock.json");
      const tamperedLockfile = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        extensions: {
          scratchpad: {
            version: "1.0.0",
            entrypoint: "./index.ts",
            toolsHash: "sha256-tampered-by-test-not-the-real-hash=",
          },
        },
      };
      await Bun.write(tamperedLockPath, JSON.stringify(tamperedLockfile, null, 2));
      setLockfilePathOverride(tamperedLockPath);
      clearLockfileCache();

      // Clear the audit capture so we measure exactly the next cycle.
      auditEntries.length = 0;

      // Step 3: re-run ensureBundledExtensions. The refresh path for
      // scratchpad MUST now hit `verifyManifestAgainstLock` → mismatch
      // → `writeBundledManifestTamperAudit` + disable.
      await ensureBundledExtensions();

      // The scratchpad row must be disabled.
      expect(store.get("scratchpad")?.enabled).toBe(false);

      // Audit row must exist with the right action + metadata.
      const tamperRows = auditEntries.filter(
        (r) => r.action === EXT_AUDIT_ACTIONS.BUNDLED_MANIFEST_TAMPER,
      );
      expect(tamperRows.length).toBeGreaterThanOrEqual(1);
      const row = tamperRows[0]!;
      expect(row.target).toBe(scratchpad!.id);
      expect(row.metadata).toBeDefined();
      const meta = row.metadata!;
      expect(meta.permission).toBe("manifest-tamper");
      expect(meta.actor).toBe("system");
      expect(meta.extensionName).toBe("scratchpad");
      expect(typeof meta.reason).toBe("string");
      expect((meta.reason as string).length).toBeGreaterThan(0);
      // Mismatch reason should reference tool-list drift since we
      // tampered the toolsHash specifically.
      expect((meta.reason as string).toLowerCase()).toContain("tool-list");
      // Metadata must capture both the expected (lockfile) and
      // actual (computed) hashes for forensic analysis.
      expect(meta.expected).toBe("sha256-tampered-by-test-not-the-real-hash=");
      expect(typeof meta.actual).toBe("string");
      expect((meta.actual as string).startsWith("sha256-")).toBe(true);
    } finally {
      setLockfilePathOverride(undefined);
      clearLockfileCache();
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("LOCKFILE MISSING fails refresh with the right reason and disables", async () => {
    const { setLockfilePathOverride, clearLockfileCache } = await import(
      "../extensions/bundled-lock"
    );
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    const { EXT_AUDIT_ACTIONS } = await import("../extensions/audit-actions");

    // Initial install with the real lockfile.
    setLockfilePathOverride(undefined);
    clearLockfileCache();
    await ensureBundledExtensions();
    expect(store.get("scratchpad")?.enabled).toBe(true);

    // Now point at a non-existent path and re-run.
    const tempDir = await mkdtemp(join(tmpdir(), "tamper-missing-"));
    try {
      setLockfilePathOverride(join(tempDir, "no-such-file.json"));
      clearLockfileCache();
      auditEntries.length = 0;

      await ensureBundledExtensions();

      // EVERY bundled refresh path tripped — fail-closed. We focus on
      // scratchpad as a representative sample; the assertion is that
      // it ended up disabled and a BUNDLED_MANIFEST_TAMPER audit row
      // was written for it.
      expect(store.get("scratchpad")?.enabled).toBe(false);

      const scratchpadId = store.get("scratchpad")!.id;
      const tamperRows = auditEntries.filter(
        (r) =>
          r.action === EXT_AUDIT_ACTIONS.BUNDLED_MANIFEST_TAMPER &&
          r.target === scratchpadId,
      );
      expect(tamperRows.length).toBeGreaterThanOrEqual(1);
      const meta = tamperRows[0]!.metadata!;
      expect((meta.reason as string).toLowerCase()).toContain("missing");
    } finally {
      setLockfilePathOverride(undefined);
      clearLockfileCache();
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// M2. Ceiling-clamp POSITIVE integration — split into a dedicated
// `bundled-phase5-clamp.test.ts` file because Bun's `mock.module`
// must register at module top level (before the imports it overrides
// are first resolved). Mid-test `mock.module` calls don't propagate
// reliably to already-loaded ESM bindings, leading to hangs on the
// downstream install path. See the sibling file for the M2 covered
// path.
// ──────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────
// N1. Lockfile idempotency
// ──────────────────────────────────────────────────────────────────

describe("N1 — buildLockfile is idempotent", () => {
  test("running buildLockfile twice on the same repo yields no diff (mod generatedAt)", async () => {
    const { buildLockfile, diffLockfiles } = await import(
      "../../scripts/regenerate-manifest-lock"
    );
    // Use the real worktree as the repo. The committed lockfile is
    // generated FROM this state, so successive `buildLockfile` calls
    // must be byte-identical (apart from `generatedAt`).
    const repoRoot = join(import.meta.dir, "..", "..");
    const a = await buildLockfile(repoRoot);
    const b = await buildLockfile(repoRoot);

    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);

    // diffLockfiles ignores `generatedAt` by design (it only diffs
    // the per-extension entries). All three categories must be empty.
    const diff = diffLockfiles(a.lockfile, b.lockfile);
    expect(diff).toEqual({ added: [], removed: [], changed: [] });
  });
});

// ──────────────────────────────────────────────────────────────────
// N2. ai-kit on-disk manifest regression guard
// ──────────────────────────────────────────────────────────────────

describe("N2 — ai-kit's on-disk manifest is a subset of the bundled ceiling", () => {
  test("loadManifestFresh(packages/@ezcorp/ai-kit) clamps cleanly", async () => {
    const { loadManifestFresh } = await import("../extensions/loader");
    const { clampToBundledCeiling } = await import("../extensions/bundled-ceiling");

    const aiKitDir = join(
      import.meta.dir,
      "..",
      "..",
      "packages",
      "@ezcorp",
      "ai-kit",
    );
    const manifest = await loadManifestFresh(aiKitDir);
    expect(manifest.name).toBe("ai-kit");

    // Translate the manifest's declared permissions into the
    // ExtensionPermissions grant shape expected by clampToBundledCeiling.
    // (Manifest `permissions` block ≈ grant shape, modulo grantedAt.)
    const declared = {
      ...(manifest.permissions ?? {}),
      grantedAt: {},
    } as ExtensionPermissions;
    // Strip Phase-4 flags that only live on grant shapes, never the
    // manifest's permissions block, so the comparison is apples-to-apples.
    delete (declared as { acceptsCallerCaps?: boolean }).acceptsCallerCaps;
    delete (declared as { escalateChildCaps?: boolean }).escalateChildCaps;

    const { effective, clamped } = clampToBundledCeiling("ai-kit", declared);
    expect(clamped).toBe(false);
    // The effective grant must contain (at least) the manifest's
    // declared network/filesystem/env values.
    expect(new Set(effective.network ?? [])).toEqual(
      new Set(declared.network ?? []),
    );
    expect(new Set(effective.filesystem ?? [])).toEqual(
      new Set(declared.filesystem ?? []),
    );
    expect(new Set(effective.env ?? [])).toEqual(
      new Set(declared.env ?? []),
    );
  });
});
