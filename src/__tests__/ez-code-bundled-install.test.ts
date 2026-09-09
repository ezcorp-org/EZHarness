import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async () => {},
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

import { createMockExtensionsStore } from "./helpers/mock-extensions-store";

const extStore = createMockExtensionsStore({ keyBy: "name" });

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: extStore.getExtensionByName,
  createExtension: extStore.createExtension,
  listExtensions: extStore.listExtensions,
  updateExtension: extStore.updateExtension,
  deleteExtension: extStore.deleteExtension,
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

afterAll(() => restoreModuleMocks());

// Import AFTER the mocks so the installer resolves to the stubbed queries.
const { resolveBundledExtensions, isBundledExtensionName } =
  await import("../extensions/bundled");
const { clampToBundledCeiling, getCeiling } = await import(
  "../extensions/bundled-ceiling"
);

beforeEach(() => {
  extStore.reset();
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
