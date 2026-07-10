/**
 * Phase A — `installFromLocal` idempotency.
 *
 * Regression coverage for the loop-incident root cause #1: re-running
 * `ext install <path>` did a bare INSERT and threw a raw
 * `Failed query: insert into "extensions"` unique error; the in-app
 * agent rationalized it as "expected" and looped.
 *
 * Post-fix contract:
 *   - same path re-install ⇒ ok + refresh; `enabled` & grants preserved;
 *     registry reloaded; entity install hooks NOT re-run (no double-seed).
 *   - different source, same name ⇒ clean error string (not raw SQL).
 *   - fresh name ⇒ create unchanged (regression).
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions } from "../extensions/types";
import { makeLocalPackage } from "./helpers/installer-fixtures";

const mockExtensions = new Map<string, any>();
let createCalls = 0;
let updateCalls = 0;
let reloadCalls = 0;
let entitySeedCalls = 0;

mock.module("../db/queries/extensions", () => ({
  createExtension: async (data: any) => {
    createCalls++;
    const ext = {
      id: crypto.randomUUID(),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockExtensions.set(ext.id, ext);
    return ext;
  },
  getExtensionByName: async (name: string) => {
    for (const ext of mockExtensions.values()) {
      if (ext.name === name) return ext;
    }
    return null;
  },
  updateExtension: async (id: string, data: any) => {
    updateCalls++;
    const ext = mockExtensions.get(id);
    if (!ext) return null;
    Object.assign(ext, data, { updatedAt: new Date() });
    return ext;
  },
  deleteExtension: async (id: string) => mockExtensions.delete(id),
  listExtensions: async () => Array.from(mockExtensions.values()),
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {
        reloadCalls++;
      },
    }),
  },
}));

// Spy the post-create entity hooks so we can prove the refresh path
// returns BEFORE `runEntityInstallHooks` (no double-seed / double-migrate).
// `runEntityNamespaceMigration` fires whenever `legacyEntityMappings` is
// passed, independent of `manifest.entities`, so it's the cleanest probe
// for "did the post-create hook block execute".
mock.module("../extensions/entities/migrate", () => ({
  runEntityNamespaceMigration: async () => {
    entitySeedCalls++;
  },
}));

afterAll(() => restoreModuleMocks());

const { installFromLocal } = await import("../extensions/installer");

const defaultPerms: ExtensionPermissions = {
  network: ["api.example.com"],
  grantedAt: { network: Date.now() },
};

beforeEach(() => {
  mockExtensions.clear();
  createCalls = 0;
  updateCalls = 0;
  reloadCalls = 0;
  entitySeedCalls = 0;
});

describe("installFromLocal — idempotent same-source re-install", () => {
  test("second install of same path refreshes in place (no dup INSERT)", async () => {
    const pkg = makeLocalPackage({ name: "idem-ext", version: "1.0.0" });
    try {
      const first = await installFromLocal(pkg.path, defaultPerms, true);
      expect(createCalls).toBe(1);
      expect(mockExtensions.size).toBe(1);

      const second = await installFromLocal(pkg.path, defaultPerms, true);

      // No second INSERT — the existing row was UPDATEd instead.
      expect(createCalls).toBe(1);
      expect(updateCalls).toBe(1);
      expect(mockExtensions.size).toBe(1);
      expect(second.id).toBe(first.id);
    } finally {
      pkg.cleanup();
    }
  });

  test("refresh preserves `enabled` and granted permissions", async () => {
    // The manifest DECLARES the granted network host: since fix-wave B
    // Phase 2 the refresh path re-clamps stored grants against the
    // refreshed manifest (grant ∩ manifest), so preservation is asserted
    // for a manifest-covered grant — the "unchanged manifest = no-op"
    // arm. Out-of-manifest grants are now DROPPED by design (see the
    // re-clamp describe below).
    const pkg = makeLocalPackage({
      name: "preserve-ext",
      version: "1.0.0",
      permissions: { network: ["api.example.com"] },
    });
    try {
      // First install: enabled=true with a real grant.
      const first = await installFromLocal(pkg.path, defaultPerms, true);
      expect(first.enabled).toBe(true);

      // Caller asks for enabled=false + empty grants on the re-install —
      // refresh must IGNORE those and keep the original consent state.
      const second = await installFromLocal(
        pkg.path,
        { grantedAt: {} },
        false,
      );

      expect(second.enabled).toBe(true);
      expect(second.grantedPermissions).toEqual(defaultPerms);
    } finally {
      pkg.cleanup();
    }
  });

  test("refresh updates version + description + manifest checksum", async () => {
    // The author-endpoint path passes a `preloadedManifest` (it already
    // loaded the config for pre-install validation). Use that here so the
    // bumped version is observed deterministically — Bun caches
    // `ezcorp.config.ts` by path, and `loadManifest` is intentionally
    // non-cache-busting, so an in-place file rewrite at the same path
    // would yield the stale cached module (a test artifact, not a
    // product bug — the real refresh callers pass the fresh manifest).
    const pkg = makeLocalPackage({ name: "ver-ext", version: "1.0.0" });
    try {
      const first = await installFromLocal(pkg.path, defaultPerms, true);
      expect(first.version).toBe("1.0.0");

      const bumped = {
        schemaVersion: 2 as const,
        name: "ver-ext",
        version: "2.5.0",
        description: "Bumped description",
        author: { name: "test" },
        entrypoint: "./index.ts",
        tools: [
          {
            name: "noop",
            description: "noop tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        permissions: {},
      };

      const refreshed = await installFromLocal(
        pkg.path,
        defaultPerms,
        true,
        { preloadedManifest: bumped as any },
      );
      expect(refreshed.version).toBe("2.5.0");
      expect(refreshed.description).toBe("Bumped description");
      expect((refreshed.manifest as any).checksum).toBeDefined();
      expect((refreshed.manifest as any).version).toBe("2.5.0");
    } finally {
      pkg.cleanup();
    }
  });

  test("refresh reloads the registry", async () => {
    const pkg = makeLocalPackage({ name: "reload-ext" });
    try {
      await installFromLocal(pkg.path, defaultPerms, true);
      const reloadsAfterFirst = reloadCalls;
      await installFromLocal(pkg.path, defaultPerms, true);
      expect(reloadCalls).toBeGreaterThan(reloadsAfterFirst);
    } finally {
      pkg.cleanup();
    }
  });

  test("refresh does NOT re-run entity install hooks (no double-seed)", async () => {
    const pkg = makeLocalPackage({ name: "seed-ext" });
    const legacyEntityMappings = [
      { entityType: "note", from: "old:note", to: "new:note" } as any,
    ];
    try {
      // First install runs the post-create hook (migration spy fires once).
      await installFromLocal(pkg.path, defaultPerms, true, {
        legacyEntityMappings,
      });
      expect(entitySeedCalls).toBe(1);

      // Re-install at the same path → refresh branch returns BEFORE
      // `runEntityInstallHooks`, so the migration spy must NOT fire again.
      await installFromLocal(pkg.path, defaultPerms, true, {
        legacyEntityMappings,
      });
      expect(entitySeedCalls).toBe(1);
    } finally {
      pkg.cleanup();
    }
  });
});

describe("installFromLocal — different source, same name", () => {
  test("throws a clean error string, not raw SQL", async () => {
    const pkgA = makeLocalPackage({ name: "collide-ext" });
    const pkgB = makeLocalPackage({ name: "collide-ext" });
    try {
      await installFromLocal(pkgA.path, defaultPerms, true);
      // Different localPath ⇒ different `source` ⇒ collision.
      await expect(
        installFromLocal(pkgB.path, defaultPerms, true),
      ).rejects.toThrow(
        /Extension "collide-ext" is already installed \(source: local:/,
      );
      // The error must NOT be a raw drizzle/SQL failure.
      await expect(
        installFromLocal(pkgB.path, defaultPerms, true),
      ).rejects.not.toThrow(/Failed query|insert into|duplicate key/i);
      // No second row created.
      expect(mockExtensions.size).toBe(1);
    } finally {
      pkgA.cleanup();
      pkgB.cleanup();
    }
  });
});

describe("installFromLocal — fresh name regression", () => {
  test("brand-new name creates a row unchanged", async () => {
    const pkg = makeLocalPackage({ name: "fresh-ext", version: "3.1.4" });
    try {
      const ext = await installFromLocal(pkg.path, defaultPerms, false);
      expect(createCalls).toBe(1);
      expect(updateCalls).toBe(0);
      expect(ext.name).toBe("fresh-ext");
      expect(ext.version).toBe("3.1.4");
      expect(ext.enabled).toBe(false);
    } finally {
      pkg.cleanup();
    }
  });
});

// ── fix-wave B Phase 2: same-source refresh re-clamps grants ──────────
//
// A refreshed manifest that DROPS a permission must drop the matching
// stored grant, or the registry spawn options (`networkAllowed` /
// `shellAllowed`) keep the stale looser sandbox forever. Bundled boot
// refreshes are exempt (S6/S9 clamp those with their own ceiling rules).
// The `preloadedManifest` option stands in for the refreshed config —
// Bun caches `ezcorp.config.ts` by path, so an in-place rewrite would
// yield the stale cached module (same test artifact documented on the
// version-bump test above).

describe("installFromLocal — same-source refresh re-clamp", () => {
  const manifestBase = {
    schemaVersion: 2 as const,
    name: "reclamp-ext",
    description: "Fixture extension for installer tests",
    author: { name: "test" },
    entrypoint: "./index.ts",
    tools: [
      { name: "noop", description: "noop tool", inputSchema: { type: "object", properties: {} } },
    ],
  };
  const widePerms = { network: ["api.example.com", "cdn.example.com"], shell: true };
  const wideGrant = {
    network: ["api.example.com", "cdn.example.com"],
    shell: true,
    grantedAt: { network: 111, shell: 222 },
  };

  test("narrowing manifest drops granted shell + removed network host", async () => {
    const pkg = makeLocalPackage({
      name: "reclamp-ext",
      version: "1.0.0",
      permissions: widePerms,
    });
    try {
      await installFromLocal(pkg.path, wideGrant, true);

      const refreshed = await installFromLocal(pkg.path, wideGrant, true, {
        preloadedManifest: {
          ...manifestBase,
          version: "1.1.0",
          // shell dropped; cdn host removed.
          permissions: { network: ["api.example.com"] },
        } as any,
      });

      expect(refreshed.grantedPermissions.shell).toBeUndefined();
      expect(refreshed.grantedPermissions.network).toEqual(["api.example.com"]);
      // grantedAt timestamps survive; enabled untouched.
      expect(refreshed.grantedPermissions.grantedAt.network).toBe(111);
      expect(refreshed.enabled).toBe(true);
    } finally {
      pkg.cleanup();
    }
  });

  test("unchanged manifest = no-op on stored grants", async () => {
    const pkg = makeLocalPackage({
      name: "reclamp-ext",
      version: "1.0.0",
      permissions: widePerms,
    });
    try {
      await installFromLocal(pkg.path, wideGrant, true);

      const refreshed = await installFromLocal(pkg.path, wideGrant, true, {
        preloadedManifest: {
          ...manifestBase,
          version: "1.1.0",
          permissions: widePerms,
        } as any,
      });

      expect(refreshed.grantedPermissions.network).toEqual([
        "api.example.com",
        "cdn.example.com",
      ]);
      expect(refreshed.grantedPermissions.shell).toBe(true);
      expect(refreshed.grantedPermissions.grantedAt).toEqual({ network: 111, shell: 222 });
      expect(refreshed.enabled).toBe(true);
    } finally {
      pkg.cleanup();
    }
  });

  test("bundled refresh (isBundled: true) leaves grants completely untouched", async () => {
    const pkg = makeLocalPackage({
      name: "reclamp-ext",
      version: "1.0.0",
      permissions: widePerms,
    });
    try {
      await installFromLocal(pkg.path, wideGrant, true, { isBundled: true });

      const refreshed = await installFromLocal(pkg.path, wideGrant, true, {
        isBundled: true,
        preloadedManifest: {
          ...manifestBase,
          version: "1.1.0",
          // Narrowed manifest — but bundled refreshes must NOT re-clamp
          // here: S6/S9 own the bundled clamp with their ceiling rules.
          permissions: { network: ["api.example.com"] },
        } as any,
      });

      // Grants verbatim from install — the refresh wrote no
      // grantedPermissions field at all for the bundled path.
      expect(refreshed.grantedPermissions).toEqual(wideGrant);
    } finally {
      pkg.cleanup();
    }
  });
});
