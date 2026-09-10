import { controlActor, controlFixture, controlWorkspace as workspace } from "./helpers/extension-control-fixture";
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

async function assertLegacyAuthoredInstallRefusal(setting: unknown, creatorUserId: string | null | undefined): Promise<boolean> {
  settingValue = setting;
  const fixture = makeLocalPackage({ name: "cutover-authored" });
  try {
    await expect(installFromLocal(fixture.path, { grantedAt: {} }, false, { creatorUserId })).rejects.toThrow("EXTENSION_V4_REQUIRED");
    expect(store.store.size).toBe(0);
    return false;
  } finally { fixture.cleanup(); }
}

test("authored enabled setting cannot bypass isolated release approval", async () => { expect(await assertLegacyAuthoredInstallRefusal(true, "owner")).toBe(false); });
test("missing creator cannot bypass isolated release approval", async () => { expect(await assertLegacyAuthoredInstallRefusal(true, undefined)).toBe(false); });
test("null creator cannot bypass isolated release approval", async () => { expect(await assertLegacyAuthoredInstallRefusal(true, null)).toBe(false); });

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

  test("creates and forks isolated workspaces without calling runner or activation", async () => {
    const { control, lifecycle } = controlFixture();
    expect(await control.execute(controlActor, "extensions_workspace", { action: "create" })).toMatchObject({ workspace, openUrl: "/extensions/author?installation=installation&workspace=workspace" });
    await control.execute(controlActor, "extensions_workspace", { action: "create", name: "custom", description: "custom", writes: { "nested/source.ts": "text" } });
    await control.execute(controlActor, "extensions_workspace", { action: "fork", installationId: "installation", releaseId: "release" });
    expect(lifecycle.createWorkspace.mock.calls).toHaveLength(3);
    expect(lifecycle.activate).not.toHaveBeenCalled();
    expect(lifecycle.runBuild).not.toHaveBeenCalled();
  });
