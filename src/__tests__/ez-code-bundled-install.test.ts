/**
 * Integration test for the bundled-install path of the `ez-code`
 * extension. ez-code is a Warren-style control plane for ephemeral
 * coding-agent runs (dispatch/steer/cancel/list/open_pr + an Extension
 * Pages Hub dashboard + cron triggers). It was a valid, tested example
 * extension that was NOT in the bundled registry; this suite locks in
 * its registration so it auto-installs and shows up in the extensions
 * list.
 *
 * What this test locks in:
 *   - The `ez-code` BUNDLED_EXTENSIONS entry declares the full
 *     capability set its manifest grants (spawnAgents + schedule + shell
 *     + network + appendMessages + eventSubscriptions + storage +
 *     filesystem) with a `grantedAt` timestamp per capability.
 *   - `ensureBundledExtensions()` creates an enabled `ez-code` DB row on
 *     first boot.
 *   - The POST-CEILING grant (after `clampToBundledCeiling`) retains
 *     EVERY capability — i.e. the bundled ceiling in
 *     `bundled-ceiling.ts` is a superset-or-equal of the install grant.
 *     The load-bearing piece is the SCHEDULE: `intersectPermissions`
 *     does `Math.min` on `maxRunDurationMs`/`maxRetries` and reads
 *     `missedRunPolicy`, so a mismatched/omitted schedule field on
 *     either side would silently produce `NaN`/undefined and drop the
 *     cron grant. We assert the crons + `maxRunsPerDay: 48` survive.
 *   - ez-code appears in the bundled (`isBundled=true`) list.
 *   - Install is idempotent.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions } from "../extensions/types";

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async () => {},
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

interface StoredExtension {
  id: string;
  name: string;
  version: string;
  description: string;
  manifest: unknown;
  source: string;
  installPath: string;
  enabled: boolean;
  isBundled?: boolean;
  grantedPermissions: ExtensionPermissions;
  checksumVerified: boolean;
  consecutiveFailures: number;
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

// Import AFTER the mocks so the installer resolves to the stubbed queries.
const { ensureBundledExtensions, resolveBundledExtensions, isBundledExtensionName } =
  await import("../extensions/bundled");
const { clampToBundledCeiling, getCeiling } = await import(
  "../extensions/bundled-ceiling"
);

beforeEach(() => {
  store = new Map();
  nextId = 0;
});

describe("bundled registry — ez-code entry", () => {
  test("ez-code is in the resolved bundled list and recognized as bundled", () => {
    const list = resolveBundledExtensions({});
    const entry = list.find((e) => e.name === "ez-code");
    expect(entry).toBeDefined();
    expect(entry!.path).toBe("docs/extensions/examples/ez-code");
    expect(isBundledExtensionName("ez-code")).toBe(true);
  });

  test("declares the full Warren capability set with a grantedAt per capability", () => {
    const entry = resolveBundledExtensions({}).find((e) => e.name === "ez-code")!;
    const p = entry.permissions;
    expect(p.spawnAgents).toEqual({ maxPerHour: 30, maxConcurrent: 6 });
    expect(p.eventSubscriptions).toEqual([
      "task:assignment_update",
      "ez-code:steer",
      "ez-code:cancel",
      "ez-code:open-pr",
    ]);
    expect(p.appendMessages).toEqual({ excludedDefault: true });
    expect(p.storage).toBe(true);
    expect(p.filesystem).toEqual(["$CWD"]);
    expect(p.shell).toBe(true);
    expect(p.network).toEqual(["api.github.com"]);
    // Full five-field schedule shape — see the SCHEDULE TRAP comment in
    // bundled.ts / bundled-ceiling.ts.
    expect(p.schedule).toEqual({
      crons: ["0 * * * *", "0 9 * * *"],
      maxRunsPerDay: 48,
      maxRunDurationMs: 300_000,
      missedRunPolicy: "fire-once",
      maxRetries: 0,
    });
    for (const key of [
      "spawnAgents",
      "eventSubscriptions",
      "appendMessages",
      "storage",
      "filesystem",
      "shell",
      "network",
      "schedule",
    ]) {
      expect(p.grantedAt[key]).toBeGreaterThan(0);
    }
  });
});

describe("bundled ceiling — ez-code intersection is lossless", () => {
  test("ez-code has a ceiling row", () => {
    expect(getCeiling("ez-code")).not.toBeNull();
  });

  test("clampToBundledCeiling(ez-code) does NOT clamp the install grant", () => {
    const entry = resolveBundledExtensions({}).find((e) => e.name === "ez-code")!;
    const { effective, clamped } = clampToBundledCeiling("ez-code", entry.permissions);
    expect(clamped).toBe(false);

    // Every capability survives the intersection.
    expect(effective.spawnAgents).toEqual({ maxPerHour: 30, maxConcurrent: 6 });
    expect(new Set(effective.eventSubscriptions)).toEqual(
      new Set([
        "task:assignment_update",
        "ez-code:steer",
        "ez-code:cancel",
        "ez-code:open-pr",
      ]),
    );
    expect(effective.appendMessages?.excludedDefault).toBe(true);
    expect(effective.storage).toBe(true);
    expect(effective.filesystem).toEqual(["$CWD"]);
    expect(effective.shell).toBe(true);
    expect(effective.network).toEqual(["api.github.com"]);

    // SCHEDULE TRAP guard: the intersection must keep a coherent
    // schedule — NO NaN on the numeric fields, crons + maxRunsPerDay
    // intact.
    expect(effective.schedule).toBeDefined();
    expect(effective.schedule!.crons).toEqual(["0 * * * *", "0 9 * * *"]);
    expect(effective.schedule!.maxRunsPerDay).toBe(48);
    expect(effective.schedule!.maxRunDurationMs).toBe(300_000);
    expect(Number.isNaN(effective.schedule!.maxRunDurationMs)).toBe(false);
    expect(effective.schedule!.missedRunPolicy).toBe("fire-once");
    expect(effective.schedule!.maxRetries).toBe(0);
    expect(Number.isNaN(effective.schedule!.maxRetries)).toBe(false);
  });
});

describe("ensureBundledExtensions — ez-code first-boot install", () => {
  test("creates an enabled, bundled-flagged ez-code row", async () => {
    await ensureBundledExtensions();
    const row = store.get("ez-code");
    expect(row).toBeDefined();
    expect(row!.name).toBe("ez-code");
    expect(row!.enabled).toBe(true);
    expect(row!.isBundled).toBe(true);
  });

  test("persisted grant retains every capability post-ceiling (schedule lossless)", async () => {
    await ensureBundledExtensions();
    const granted = store.get("ez-code")!.grantedPermissions;
    expect(granted.spawnAgents).toEqual({ maxPerHour: 30, maxConcurrent: 6 });
    expect(new Set(granted.eventSubscriptions)).toEqual(
      new Set([
        "task:assignment_update",
        "ez-code:steer",
        "ez-code:cancel",
        "ez-code:open-pr",
      ]),
    );
    expect(granted.appendMessages?.excludedDefault).toBe(true);
    expect(granted.storage).toBe(true);
    expect(granted.filesystem).toEqual(["$CWD"]);
    expect(granted.shell).toBe(true);
    expect(granted.network).toEqual(["api.github.com"]);
    expect(granted.schedule?.crons).toEqual(["0 * * * *", "0 9 * * *"]);
    expect(granted.schedule?.maxRunsPerDay).toBe(48);
    expect(Number.isNaN(granted.schedule?.maxRunDurationMs ?? NaN)).toBe(false);
    expect(Number.isNaN(granted.schedule?.maxRetries ?? NaN)).toBe(false);
  });

  test("manifest declares the five ez-code tools", async () => {
    await ensureBundledExtensions();
    const row = store.get("ez-code")!;
    const manifest = row.manifest as { tools?: Array<{ name: string }> };
    const names = (manifest.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "cancel_run",
      "dispatch_run",
      "list_runs",
      "open_pr",
      "steer_run",
    ]);
  });

  test("appears in the bundled (isBundled=true) list", async () => {
    await ensureBundledExtensions();
    const { listExtensions } = await import("../db/queries/extensions");
    const bundled = (await listExtensions()).filter((r) => r.isBundled === true);
    expect(bundled.some((r) => r.name === "ez-code")).toBe(true);
  });

  test("second run is a no-op (already installed)", async () => {
    await ensureBundledExtensions();
    const firstId = store.get("ez-code")!.id;
    await ensureBundledExtensions();
    expect(store.get("ez-code")!.id).toBe(firstId);
    expect(store.get("ez-code")!.enabled).toBe(true);
  });
});
