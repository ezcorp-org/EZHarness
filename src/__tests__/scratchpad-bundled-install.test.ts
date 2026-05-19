/**
 * Tests the bundled install path for the `scratchpad` extension — the
 * conversion of the former built-in scratchpad tool (src/runtime/tools/
 * scratchpad.ts, deleted in the same Phase 1 work). Scratchpad is ON FOR
 * EVERY EZCorp INSTALLATION with no opt-out — unlike ai-kit, it has no
 * disable env flag because the conversation-scoped KV store has zero
 * network surface and zero filesystem impact.
 *
 * The code-review-is-approval model (invariant S5 in the plan) means
 * changes to `BUNDLED_EXTENSIONS[scratchpad]` require a PR; runtime
 * enforcement of the grant still runs on every access via
 * `src/extensions/storage-handler.ts:117`.
 */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionManifestV2 } from "../extensions/types";

// insertAuditEntry is mocked to a no-op because this file uses
// store-level mocks of `../db/queries/extensions` (no real DB), so the
// audit-write calls inside bundled.ts would otherwise hit an
// unavailable `getDb()`. The `afterAll(restoreModuleMocks)` below
// undoes the mock via the snapshotted real exports in preload.ts so
// subsequent test files (e.g. extension-audit-actions.test.ts) see the
// real module — the path is listed in MODULE_PATHS inside
// `./helpers/mock-cleanup.ts` for this restoration to work.
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async () => {},
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
  grantedPermissions: {
    storage?: boolean;
    grantedAt: Record<string, number>;
  };
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

import {
  ensureBundledExtensions,
  resolveBundledExtensions,
  isBundledExtensionName,
} from "../extensions/bundled";

beforeEach(() => {
  store = new Map();
  nextId = 0;
});

describe("resolveBundledExtensions — scratchpad entry", () => {
  test("includes scratchpad by default with no opt-out flag", () => {
    const list = resolveBundledExtensions({});
    expect(list.some((e) => e.name === "scratchpad")).toBe(true);
  });

  test("scratchpad cannot be disabled via any env flag (security by default)", () => {
    // Simulate common opt-out attempts that affect other bundled exts.
    const attempts: Record<string, string>[] = [
      { EZCORP_DISABLE_AI_KIT: "1" },
      { EZCORP_DISABLE_SCRATCHPAD: "1" },
      { EZCORP_NO_BUNDLED: "1" },
    ];
    for (const env of attempts) {
      const list = resolveBundledExtensions(env);
      expect(list.some((e) => e.name === "scratchpad")).toBe(true);
    }
  });

  test("scratchpad entry declares only the storage permission — no network/fs/shell/env", () => {
    const list = resolveBundledExtensions({});
    const entry = list.find((e) => e.name === "scratchpad")!;
    expect(entry.path).toBe("docs/extensions/examples/scratchpad");
    expect(entry.permissions.storage).toBe(true);
    // S1-S4: nothing else should be granted.
    expect(entry.permissions.network).toBeUndefined();
    expect(entry.permissions.filesystem).toBeUndefined();
    expect(entry.permissions.shell).toBeUndefined();
    expect(entry.permissions.env).toBeUndefined();
    // Must record a grant timestamp so the audit path can write oldValue/newValue.
    expect(entry.permissions.grantedAt["storage"]).toBeGreaterThan(0);
  });
});

describe("isBundledExtensionName — scratchpad is recognized", () => {
  test("returns true for 'scratchpad' so the integrity check is skipped on spawn", () => {
    // Dev edits to docs/extensions/examples/scratchpad/* must not brick the
    // subprocess — see bundled.ts:141-157 for the rationale.
    expect(isBundledExtensionName("scratchpad")).toBe(true);
  });

  test("returns false for unrelated names", () => {
    expect(isBundledExtensionName("user-installed-ext")).toBe(false);
  });
});

describe("ensureBundledExtensions — first-boot install", () => {
  test("creates a scratchpad row with enabled=true and storage granted", async () => {
    await ensureBundledExtensions();
    const row = store.get("scratchpad");
    expect(row).toBeDefined();
    expect(row!.name).toBe("scratchpad");
    expect(row!.enabled).toBe(true);
    expect(row!.grantedPermissions.storage).toBe(true);
  });

  test("manifest declares the two scratchpad tools with the right names", async () => {
    await ensureBundledExtensions();
    const row = store.get("scratchpad")!;
    const manifest = row.manifest as { tools?: Array<{ name: string }> };
    const names = (manifest.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["scratchpad_read", "scratchpad_write"]);
  });

  test("re-running is idempotent — no duplicate row, still enabled", async () => {
    await ensureBundledExtensions();
    const rowId1 = store.get("scratchpad")!.id;
    await ensureBundledExtensions();
    const rowId2 = store.get("scratchpad")!.id;
    expect(rowId2).toBe(rowId1);
    expect(store.get("scratchpad")!.enabled).toBe(true);
  });

  test("if an operator manually disables scratchpad in DB, next boot re-enables it", async () => {
    await ensureBundledExtensions();
    // Simulate admin-disable via direct DB edit.
    const row = store.get("scratchpad")!;
    row.enabled = false;
    await ensureBundledExtensions();
    // The bundled-mode "source of truth" reactivates it (bundled.ts:177-182).
    expect(store.get("scratchpad")!.enabled).toBe(true);
  });
});

describe("manifest-drift detection (S6)", () => {
  // The drift check compares the ON-DISK manifest (loaded fresh) with
  // the DB-STORED manifest (written at install). If they diverge on any
  // permission field, it emits a WARN and does NOT mutate the grant —
  // fail-closed. Runtime enforcement keeps using the DB grant, so a
  // tampered on-disk file cannot sneak in widened permissions without
  // being flagged.

  // Helper: capture stderr lines (where warn/error are written per
  // src/logger.ts:35) without conflating with the rest of the test
  // output. Spy-based because `logger.child()` creates a fresh
  // instance each call, so spying on the child's methods directly
  // misses the instance bundled.ts captured at module-load time.
  function captureWarns(run: () => Promise<void>): Promise<string[]> {
    const captured: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(
      (chunk: unknown) => {
        try {
          const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
          for (const line of s.split("\n")) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line) as { level?: string; msg?: string };
              if (parsed.level === "warn") captured.push(parsed.msg ?? "");
            } catch { /* non-JSON lines: ignore */ }
          }
        } catch { /* decoding error: ignore */ }
        return true;
      },
    );
    return run().then(() => { spy.mockRestore(); return captured; });
  }

  test("no drift → no warning, no mutation", async () => {
    const warns = await captureWarns(async () => {
      await ensureBundledExtensions();
      // Second run reuses the existing row and re-reads disk. Disk matches DB.
      await ensureBundledExtensions();
    });
    expect(warns.filter((m) => m.toLowerCase().includes("drift"))).toHaveLength(0);
  });

  test("permissions differ on disk vs DB → WARN fires; DB grant untouched", async () => {
    await ensureBundledExtensions();
    const row = store.get("scratchpad")!;
    const originalGrant = { ...row.grantedPermissions };

    // Simulate drift by mutating the DB manifest's permissions. On next
    // `ensureBundledExtensions()`, the on-disk manifest (which still has
    // `storage: true`) will diverge from the DB manifest (which we've
    // just cleared).
    const manifest = row.manifest as ExtensionManifestV2;
    (manifest as { permissions?: unknown }).permissions = {};
    row.manifest = manifest;

    const warns = await captureWarns(async () => {
      await ensureBundledExtensions();
    });
    expect(warns.some((m) => m.toLowerCase().includes("drift"))).toBe(true);

    // S5/S6: the drift check is advisory — it must NOT mutate the stored
    // grant. Runtime enforcement continues to use whatever was in the DB.
    expect(row.grantedPermissions).toEqual(originalGrant);
  });

  test("manifest-drift failure to read disk is non-fatal", async () => {
    await ensureBundledExtensions();
    const row = store.get("scratchpad")!;

    // Corrupt the DB manifest's installPath — loadManifestFresh will
    // throw inside the drift check, but the outer try/catch must
    // swallow it and the install-loop must continue without re-raising.
    row.installPath = "/tmp/does-not-exist-scratchpad-drift-test";

    // Must not throw even though drift-read fails. No assertion on warn
    // count — the contract tested here is "doesn't throw".
    await expect(ensureBundledExtensions()).resolves.toBeUndefined();
  });
});

describe("version-bump re-approval gate (S9)", () => {
  // A bundled extension whose on-disk version changes AND whose
  // permissions change must have `enabled=false` set on next startup,
  // pending admin re-approval. Pure version bumps (no permission
  // change) pass through — they're normal upgrades. Pure permission
  // changes (no version bump) are already caught by drift detection.

  test("version unchanged → no block, enabled stays true", async () => {
    await ensureBundledExtensions();
    const row = store.get("scratchpad")!;
    expect(row.enabled).toBe(true);
    await ensureBundledExtensions();
    expect(store.get("scratchpad")!.enabled).toBe(true);
  });

  test("version bump WITH permission change → disabled pending re-approval", async () => {
    await ensureBundledExtensions();
    const row = store.get("scratchpad")!;
    expect(row.enabled).toBe(true);

    // Simulate the DB state *after* a prior install: older version,
    // DIFFERENT permissions than what's currently on disk. When
    // `ensureBundledExtensions()` runs again, the on-disk manifest's
    // newer version AND wider permissions will trip the gate.
    const manifest = row.manifest as ExtensionManifestV2;
    (manifest as { version: string }).version = "0.0.1";  // older than disk 1.0.0
    (manifest as { permissions?: unknown }).permissions = {};  // no storage originally
    row.manifest = manifest;

    await ensureBundledExtensions();

    // Fail-closed: the extension is now disabled. Admin must re-approve.
    expect(store.get("scratchpad")!.enabled).toBe(false);
  });

  test("version bump WITHOUT permission change → NOT blocked; stays enabled", async () => {
    await ensureBundledExtensions();
    const row = store.get("scratchpad")!;
    const manifest = row.manifest as ExtensionManifestV2;
    // Change version only. Permissions are identical (storage: true)
    // between DB and disk.
    (manifest as { version: string }).version = "0.0.1";
    row.manifest = manifest;

    await ensureBundledExtensions();

    // A pure version bump is a normal upgrade — no re-approval needed.
    expect(store.get("scratchpad")!.enabled).toBe(true);
  });
});

describe("mention-picker surface path (Task 10)", () => {
  // web/src/routes/api/mentions/search/+server.ts:279-294 sources mention-picker
  // results from `extensions WHERE enabled=true`. For scratchpad to appear as a
  // `@scratchpad` option, the bundled install must produce a row with that
  // shape. This test exercises the contract end-to-end (DB shape only — the
  // actual HTTP route is covered in e2e tests).
  test("post-install, the DB row shape satisfies the mention-search query", async () => {
    await ensureBundledExtensions();
    // Emulate the exact mention-search query (extensions WHERE enabled=true).
    const listed = Array.from(store.values()).filter((row) => row.enabled);
    const scratchpad = listed.find((row) => row.name === "scratchpad");
    expect(scratchpad).toBeDefined();
    expect(scratchpad!.name).toBe("scratchpad");
    // The mention-picker returns `(name, description)` — both must be set so
    // the UI renders a non-empty item.
    const manifest = scratchpad!.manifest as { description?: string };
    expect(typeof manifest?.description === "string" && manifest.description.length > 0).toBe(true);
  });
});
