/**
 * Config-gated auto-`modifiable` for user-authored extensions.
 *
 * Gate (in `installFromLocal`, src/extensions/installer.ts):
 *   modifiable = creatorUserId != null
 *             && getSetting("extensions:authorAutoModifiable") === true
 *
 * Truth table verified end-to-end against the REAL `installFromLocal`
 * (in-memory `createExtension` capture mirrors `installer-deputy-flag`):
 *   - authored (creatorUserId set) + setting true            → true
 *   - authored + setting false / unset / non-boolean string  → false
 *   - NON-authored (creatorUserId null) + setting true       → false
 *   - same-name reinstall (refreshed branch) never downgrades an
 *     already-`modifiable` row (going-forward-only invariant).
 *
 * Security note: this flag only relaxes the per-extension admin gate.
 * The reopen owner-scope + the never-persisted always-prompt on
 * `ezcorp:extension:modify` are unaffected, so the assistant still
 * cannot silently modify anything — see docs/extensions/security.md.
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

// Controllable `extensions:authorAutoModifiable` setting. Other keys
// fall through to `undefined` (installer reads only this one here).
let settingValue: unknown;
mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) =>
    key === "extensions:authorAutoModifiable" ? settingValue : undefined,
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload: async () => {} }),
  },
}));

afterAll(() => restoreModuleMocks());

const { installFromLocal } = await import("../extensions/installer");

const emptyPerms: ExtensionPermissions = { grantedAt: {} };
const AUTHOR = "user-author-1";

// `InstalledExtension` (the static return type) doesn't surface the DB
// columns this gate writes; the mocked `createExtension` echoes them
// back verbatim, so widen the view. One helper also DRYs the fixed
// (perms, enabled) install args across every case.
type InstalledRow = Awaited<ReturnType<typeof installFromLocal>> & {
  creatorUserId?: string | null;
  modifiable?: boolean;
};
function install(
  path: string,
  opts?: Parameters<typeof installFromLocal>[3],
): Promise<InstalledRow> {
  return installFromLocal(path, emptyPerms, false, opts) as Promise<InstalledRow>;
}

beforeEach(() => {
  mockExtensions.clear();
  settingValue = undefined;
});

// ── Authored install: setting drives the default ────────────────────

describe("authored install (creatorUserId set)", () => {
  test("setting === true → modifiable = true", async () => {
    settingValue = true;
    const fx = makeLocalPackage({ name: "auth-on" });
    try {
      const ext = await install(fx.path, { creatorUserId: AUTHOR });
      expect(ext.creatorUserId).toBe(AUTHOR);
      expect(ext.modifiable).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  test("setting === false → modifiable = false", async () => {
    settingValue = false;
    const fx = makeLocalPackage({ name: "auth-off" });
    try {
      const ext = await install(fx.path, { creatorUserId: AUTHOR });
      expect(ext.modifiable).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("setting unset (undefined) → modifiable = false (secure default)", async () => {
    const fx = makeLocalPackage({ name: "auth-unset" });
    try {
      const ext = await install(fx.path, { creatorUserId: AUTHOR });
      expect(ext.modifiable).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("non-boolean truthy setting (\"true\" string) → modifiable = false (strict ===)", async () => {
    settingValue = "true";
    const fx = makeLocalPackage({ name: "auth-string" });
    try {
      const ext = await install(fx.path, { creatorUserId: AUTHOR });
      expect(ext.modifiable).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});

// ── Non-authored install: never auto-modifiable ─────────────────────

describe("non-authored install (creatorUserId null/omitted)", () => {
  test("setting === true but no creatorUserId → modifiable = false", async () => {
    settingValue = true;
    const fx = makeLocalPackage({ name: "noauthor-on" });
    try {
      const ext = await install(fx.path);
      expect(ext.creatorUserId).toBeNull();
      expect(ext.modifiable).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("explicit creatorUserId: null + setting true → modifiable = false", async () => {
    settingValue = true;
    const fx = makeLocalPackage({ name: "noauthor-explicit-null" });
    try {
      const ext = await install(fx.path, { creatorUserId: null });
      expect(ext.modifiable).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});

// ── Going-forward only: reinstall never downgrades ──────────────────

describe("same-name reinstall preserves an already-modifiable row", () => {
  test("refreshed branch does not flip modifiable back to false", async () => {
    // First authored install with the setting ON → modifiable=true.
    settingValue = true;
    const fx = makeLocalPackage({ name: "reinstall-keep" });
    try {
      const first = await install(fx.path, { creatorUserId: AUTHOR });
      expect(first.modifiable).toBe(true);

      // Operator later turns the setting OFF, then the SAME extension
      // is reinstalled from the same source (the "already installed —
      // refreshed" branch). modifiable must NOT be downgraded — the
      // default only ever applies on the FIRST authored install.
      settingValue = false;
      const again = await install(fx.path, { creatorUserId: AUTHOR });
      expect(again.id).toBe(first.id);
      expect(again.modifiable).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});
