import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { makeLocalPackage } from "./helpers/installer-fixtures";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { createMockExtensionsStore } from "./helpers/mock-extensions-store";

const store = createMockExtensionsStore({ keyBy: "id", timestamps: true, generateId: () => crypto.randomUUID() });
let settingValue: unknown;
mock.module("../db/queries/extensions", () => ({ createExtension: store.createExtension, getExtensionByName: store.getExtensionByName, updateExtension: store.updateExtension, deleteExtension: store.deleteExtension, listExtensions: store.listExtensions }));
mock.module("../db/queries/settings", () => ({ getSetting: async () => settingValue }));
const { installFromLocal } = await import("../extensions/installer");
beforeEach(() => { store.store.clear(); settingValue = undefined; });
afterAll(restoreModuleMocks);

for (const [name, setting, creatorUserId] of [
  ["authored enabled setting", true, "owner"],
  ["authored disabled setting", false, "owner"],
  ["authored missing setting", undefined, "owner"],
  ["authored string setting", "true", "owner"],
  ["missing creator", true, undefined],
  ["null creator", true, null],
] as const) test(`${name} cannot bypass isolated release approval`, async () => {
  settingValue = setting;
  const fixture = makeLocalPackage({ name: "cutover-authored" });
  try {
    await expect(installFromLocal(fixture.path, { grantedAt: {} }, false, { creatorUserId })).rejects.toThrow("EXTENSION_V4_REQUIRED");
    expect(store.store.size).toBe(0);
  } finally { fixture.cleanup(); }
});

test("refused same-name reinstall preserves existing ownership and modifiable state", async () => {
  const existing = await store.createExtension({ id: "retained", name: "reinstall-keep", creatorUserId: "owner", modifiable: true, enabled: false } as never);
  const before = structuredClone(existing);
  const fixture = makeLocalPackage({ name: "reinstall-keep" });
  try {
    for (const setting of [true, false]) {
      settingValue = setting;
      await expect(installFromLocal(fixture.path, { grantedAt: {} }, false, { creatorUserId: "stranger" })).rejects.toThrow("EXTENSION_V4_REQUIRED");
      expect(await store.getExtensionByName("reinstall-keep")).toEqual(before);
      expect(store.store.size).toBe(1);
    }
  } finally { fixture.cleanup(); }
});
