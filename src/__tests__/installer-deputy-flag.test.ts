/**
 * Phase 4 — installer surface for `acceptsCallerCaps` /
 * `escalateChildCaps` flags.
 *
 * Coverage matrix (spec items h-k):
 *   (h) Manifest declares acceptsCallerCaps: true → after install, the
 *       persisted DB row's manifest carries it. UI consumes this to
 *       render the elevated-trust consent checkbox.
 *   (i) Manifest declares escalateChildCaps: true → independent
 *       persistence path; UI renders a separate orchestration consent.
 *   (j) Both flags declared → both persist; UI lets user accept
 *       independently.
 *   (k) installFromLocal does NOT auto-grant the flags (consent must
 *       come via a separate POST /:id/activate or PUT /permissions
 *       call) — initial grantedPermissions is empty/{} after install.
 *       This is the "user declined" path: even if the manifest
 *       declares the flag, the runtime check (=== true on the GRANT)
 *       sees `undefined` until the user explicitly opts in.
 *
 * The clamping behavior on subsequent grant updates is covered in
 * `web/src/__tests__/installer-deputy-flag.server.test.ts`.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { makeLocalPackage } from "./helpers/installer-fixtures";
import type { ExtensionPermissions } from "../extensions/types";

import { createMockExtensionsStore } from "./helpers/mock-extensions-store";

const extStore = createMockExtensionsStore({ keyBy: "id", timestamps: true, generateId: () => crypto.randomUUID() });
const mockExtensions = extStore.store;

mock.module("../db/queries/extensions", () => ({
  createExtension: extStore.createExtension,
  getExtensionByName: extStore.getExtensionByName,
  updateExtension: extStore.updateExtension,
  deleteExtension: extStore.deleteExtension,
  listExtensions: extStore.listExtensions,
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload: async () => {} }),
  },
}));

afterAll(() => restoreModuleMocks());

const { installFromLocal } = await import("../extensions/installer");

const emptyPerms: ExtensionPermissions = { grantedAt: {} };

beforeEach(() => {
  mockExtensions.clear();
});

// ── (h) Manifest declares acceptsCallerCaps ─────────────────────────

describe("(h) Manifest acceptsCallerCaps: true persists through install", () => {
  test("installFromLocal preserves acceptsCallerCaps on the persisted manifest", async () => {
    const fx = makeLocalPackage({
      name: "deputy-ext",
      acceptsCallerCaps: true,
    });
    try {
      const ext = await installFromLocal(fx.path, emptyPerms, false);
      expect(ext.manifest.acceptsCallerCaps).toBe(true);
      expect(ext.manifest.escalateChildCaps).toBeUndefined();
      // Initial grant is empty until user explicitly consents (k).
      expect(ext.grantedPermissions.acceptsCallerCaps).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });
});

// ── (i) Manifest declares escalateChildCaps ─────────────────────────

describe("(i) Manifest escalateChildCaps: true persists through install", () => {
  test("installFromLocal preserves escalateChildCaps on the persisted manifest", async () => {
    const fx = makeLocalPackage({
      name: "orchestrator-ext",
      escalateChildCaps: true,
    });
    try {
      const ext = await installFromLocal(fx.path, emptyPerms, false);
      expect(ext.manifest.escalateChildCaps).toBe(true);
      expect(ext.manifest.acceptsCallerCaps).toBeUndefined();
      expect(ext.grantedPermissions.escalateChildCaps).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });
});

// ── (j) Both flags declared ─────────────────────────────────────────

describe("(j) Manifest with both flags persists both", () => {
  test("acceptsCallerCaps + escalateChildCaps both survive the install path", async () => {
    const fx = makeLocalPackage({
      name: "double-deputy-ext",
      acceptsCallerCaps: true,
      escalateChildCaps: true,
    });
    try {
      const ext = await installFromLocal(fx.path, emptyPerms, false);
      expect(ext.manifest.acceptsCallerCaps).toBe(true);
      expect(ext.manifest.escalateChildCaps).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});

// ── (k) Initial grant does NOT auto-promote the flags ───────────────

describe("(k) Install does NOT auto-grant — consent required via separate API", () => {
  test("manifest declares acceptsCallerCaps but caller passed emptyPerms → grant has no flag", async () => {
    const fx = makeLocalPackage({
      name: "k-deputy-ext",
      acceptsCallerCaps: true,
    });
    try {
      const ext = await installFromLocal(fx.path, emptyPerms, false);
      // The grant blob is what the runtime consults — declaration on
      // the manifest is meaningless without consent.
      expect(ext.grantedPermissions.acceptsCallerCaps).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  test("manifest declares both flags + caller passed emptyPerms → neither granted", async () => {
    const fx = makeLocalPackage({
      name: "k-double-decline",
      acceptsCallerCaps: true,
      escalateChildCaps: true,
    });
    try {
      const ext = await installFromLocal(fx.path, emptyPerms, false);
      expect(ext.grantedPermissions.acceptsCallerCaps).toBeUndefined();
      expect(ext.grantedPermissions.escalateChildCaps).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  test("caller passes pre-approved grants → install honors them as-is (admin-trust path)", async () => {
    // The installer doesn't clamp here — it trusts what the caller
    // passes (the admin-only POST /api/extensions endpoint always
    // passes empty perms; programmatic admin paths can pre-approve).
    // This is sec-C3's invariant: the SvelteKit POST handler ALWAYS
    // passes emptyPerms here; consent goes through a separate
    // /activate endpoint that DOES clamp.
    const preApproved: ExtensionPermissions = {
      acceptsCallerCaps: true,
      grantedAt: { acceptsCallerCaps: Date.now() },
    };
    const fx = makeLocalPackage({
      name: "k-preapproved",
      acceptsCallerCaps: true,
    });
    try {
      const ext = await installFromLocal(fx.path, preApproved, false);
      expect(ext.grantedPermissions.acceptsCallerCaps).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});
