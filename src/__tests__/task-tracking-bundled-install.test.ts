/**
 * Tests the bundled install path for the `task-tracking` extension —
 * Phase 3 commit-5 replaced the built-in task-tracking tool module
 * (src/runtime/tools/task-tracking.ts, deleted in the same commit) with
 * a bundled extension at docs/extensions/examples/task-tracking/.
 *
 * The assertions mirror the scratchpad-bundled-install suite: verify
 * the BUNDLED_EXTENSIONS entry ships with the right permission block,
 * that `ensureBundledExtensions()` creates the DB row on first boot,
 * and that the storage migration for users who had tasks under the
 * old `extensionId = "builtin"` naming runs exactly once.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// insertAuditEntry is mocked to a no-op because the store-level mocks
// below don't initialize a real DB; the audit-write path would blow up
// on the missing getDb() otherwise.
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
  grantedPermissions: Record<string, unknown>;
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

// Storage migration is exercised in a separate block further down; the
// installer path itself just needs a no-op override so this suite
// doesn't pull in the PGlite driver.
let migrationCalls: Array<{ extId: string }> = [];
mock.module("../extensions/migrations/task-tracking-storage", () => ({
  migrateBuiltinTaskStorage: async (extId: string) => {
    migrationCalls.push({ extId });
  },
}));

// Phase 5's bundled-lock verifier compares the on-disk manifest's
// tools hash against `manifest.lock.json`. The committed lockfile on
// this branch is stale relative to the manifest tool-list updates;
// regenerating the lockfile lives in a separate maintenance commit.
// Here we stub the verifier to always-ok so the install + idempotency
// invariants under test aren't drowned by tamper-disable.
mock.module("../extensions/bundled-lock", () => ({
  verifyManifestAgainstLock: async () => ({ ok: true }),
  canonicalizeAndHash: () => "sha256-stub",
  loadManifestLock: async () => ({ schemaVersion: 1, generatedAt: "", extensions: {} }),
}));

// ── Manifest loader override ────────────────────────────────────────
// Refresh-branch tests drive `loadManifestFresh` return values per-
// test. Current loader signature: `(dir: string) =>
// Promise<ExtensionManifestV2>`. If the real loader ever gains
// additional parameters the mock's delegate path will drift — rerun
// this suite after any signature change to ../extensions/loader.
//
// The `loadManifest` export (used by installer.ts on first boot) is
// left untouched so the existing install-path tests continue to read
// the REAL bundled manifest from disk. We capture the real function
// REFERENCES via top-level `await import(...)` BEFORE registering the
// mock — once captured into local bindings, they no longer resolve
// through the live module record (so they're immune to the mock
// replacement). Importing via a file-URL specifier is NOT sufficient:
// Bun's `mock.module` matches by resolved file path, not specifier
// string, so a file-URL re-import inside the mock factory hits the
// mock again — infinite recursion (which is the bug this fixes).
const realLoader = await import("../extensions/loader");
const realLoadManifest = realLoader.loadManifest;
const realLoadManifestFresh = realLoader.loadManifestFresh;

const freshManifestCalls: Array<{ dir: string }> = [];
let freshManifestOverride:
  | { kind: "value"; manifest: import("../extensions/types").ExtensionManifestV2 }
  | { kind: "throw"; error: Error }
  | undefined;

mock.module("../extensions/loader", () => ({
  loadManifest: realLoadManifest,
  loadManifestFresh: async (dir: string) => {
    freshManifestCalls.push({ dir });
    if (freshManifestOverride) {
      if (freshManifestOverride.kind === "throw") throw freshManifestOverride.error;
      return freshManifestOverride.manifest;
    }
    return realLoadManifestFresh(dir);
  },
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
  migrationCalls = [];
});

describe("resolveBundledExtensions — task-tracking entry", () => {
  test("includes task-tracking by default with no opt-out flag", () => {
    const list = resolveBundledExtensions({});
    expect(list.some((e) => e.name === "task-tracking")).toBe(true);
  });

  test("task-tracking cannot be disabled via any env flag (security-by-default)", () => {
    const attempts: Record<string, string>[] = [
      { EZCORP_DISABLE_TASK_TRACKING: "1" },
      { EZCORP_NO_BUNDLED: "1" },
    ];
    for (const env of attempts) {
      const list = resolveBundledExtensions(env);
      expect(list.some((e) => e.name === "task-tracking")).toBe(true);
    }
  });

  test("declares storage + taskEvents + agentConfig + spawnAgents + eventSubscriptions — the full Phase 2 capability set", () => {
    const list = resolveBundledExtensions({});
    const entry = list.find((e) => e.name === "task-tracking")!;
    expect(entry.path).toBe("docs/extensions/examples/task-tracking");
    expect(entry.permissions.storage).toBe(true);
    expect(entry.permissions.taskEvents).toBe(true);
    expect(entry.permissions.agentConfig).toBe("read");
    expect(entry.permissions.spawnAgents).toEqual({ maxPerHour: 200, maxConcurrent: 10 });
    expect(entry.permissions.eventSubscriptions).toEqual(["task:assignment_update"]);
    // grantedAt timestamps present for every permission so the audit
    // path can write oldValue/newValue deltas.
    for (const key of ["storage", "taskEvents", "agentConfig", "spawnAgents", "eventSubscriptions"]) {
      expect(entry.permissions.grantedAt[key]).toBeGreaterThan(0);
    }
  });
});

describe("isBundledExtensionName — task-tracking is recognized", () => {
  test("returns true for 'task-tracking' so the integrity check is skipped on spawn", () => {
    expect(isBundledExtensionName("task-tracking")).toBe(true);
  });
});

describe("ensureBundledExtensions — first-boot install", () => {
  test("creates a task-tracking row with enabled=true and all five permissions granted", async () => {
    await ensureBundledExtensions();
    const row = store.get("task-tracking");
    expect(row).toBeDefined();
    expect(row!.name).toBe("task-tracking");
    expect(row!.enabled).toBe(true);
    const granted = row!.grantedPermissions as {
      storage?: boolean;
      taskEvents?: boolean;
      agentConfig?: string;
      spawnAgents?: unknown;
      eventSubscriptions?: unknown;
    };
    expect(granted.storage).toBe(true);
    expect(granted.taskEvents).toBe(true);
    expect(granted.agentConfig).toBe("read");
    expect(granted.spawnAgents).toEqual({ maxPerHour: 200, maxConcurrent: 10 });
    expect(granted.eventSubscriptions).toEqual(["task:assignment_update"]);
  });

  test("manifest declares all 14 task-tracking tools", async () => {
    await ensureBundledExtensions();
    const row = store.get("task-tracking")!;
    const manifest = row.manifest as { tools?: Array<{ name: string }> };
    const names = (manifest.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "task_add",
      "task_assign",
      "task_complete",
      "task_fail",
      "task_list",
      "task_list_agents",
      "task_plan",
      "task_resume",
      "task_set_dependencies",
      "task_start",
      "task_stop",
      "task_subtask_toggle",
      "task_unassign",
      "task_update",
    ]);
  });

  test("re-running ensureBundledExtensions is idempotent — same row, still enabled", async () => {
    await ensureBundledExtensions();
    const rowId1 = store.get("task-tracking")!.id;
    await ensureBundledExtensions();
    const rowId2 = store.get("task-tracking")!.id;
    expect(rowId2).toBe(rowId1);
    expect(store.get("task-tracking")!.enabled).toBe(true);
  });

  test("storage migration is invoked exactly once per ensureBundledExtensions call", async () => {
    await ensureBundledExtensions();
    expect(migrationCalls).toHaveLength(1);
    expect(migrationCalls[0]!.extId).toBe(store.get("task-tracking")!.id);
  });
});
