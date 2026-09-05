import { expect, test } from "bun:test";
import { AUTO_ENABLE_ON_INSTALL, installFromLocal, installFromGit, installFromGitHub, shouldAutoEnableOnInstall } from "../installer";
import { updateExtension, uninstallExtension, removeExtension, checkForUpdates, installWithDependencies } from "../installer";
import { validateManifest } from "@ezcorp/extension-contract";

test("legacy installers cannot bypass lifecycle builds or grant approval", async () => {
  expect(AUTO_ENABLE_ON_INSTALL.size).toBe(0);
  expect(shouldAutoEnableOnInstall("task-stack")).toBe(false);
  const grants = { grantedAt: {} };
  await expect(installFromLocal("/tmp/untrusted", grants, true)).rejects.toThrow("EXTENSION_V4_REQUIRED");
  await expect(installFromGit("https://attacker.invalid/repository", grants)).rejects.toThrow("EXTENSION_V4_REQUIRED");
  await expect(installFromGitHub("attacker/repository", grants)).rejects.toThrow("EXTENSION_V4_REQUIRED");
});

for (const [name, invoke] of [
  ["update", () => updateExtension("fixture")],
  ["uninstall", () => uninstallExtension({ id: "fixture", name: "fixture", installPath: "/etc" }, { purgeData: true })],
  ["remove", () => removeExtension("../escape", { purgeData: true })],
  ["remote update check", () => checkForUpdates({ source: "git:https://attacker.invalid/repo", version: "1.0.0" })],
  ["dependency installer", () => installWithDependencies("https://attacker.invalid/repo", { grantedAt: {} }, { enabled: true, onConfirm: async () => { throw new Error("must not invoke approval callback"); } })],
] as const) test(`retired ${name} cannot touch host sources or skip release control`, async () => {
  await expect(invoke()).rejects.toThrow("EXTENSION_V4_REQUIRED");
});

test("preloaded handlers, creator attribution, bundled flags and caller grants cannot revive legacy installation", async () => {
  let evaluated = false;
  const options = { isBundled: true, envEscapeHatch: true, creatorUserId: "admin", userId: "admin", get preloadedManifest(): never { evaluated = true; throw new Error("untrusted metadata evaluated"); } };
  await expect(installFromLocal("/tmp/source", { shell: true, env: ["EZCORP_API_KEY"], grantedAt: {} }, true, options)).rejects.toThrow("EXTENSION_V4_REQUIRED");
  expect(evaluated).toBe(false);
});

const manifest = { schemaVersion: 4, name: "safe-extension", version: "1.0.0", description: "Fixture", author: { name: "Fixture" }, permissions: {} };
for (const name of ["", "..", "../escape", "/absolute", "slash/name", "back\\slash", "name\0nul", "UPPERCASE", "a".repeat(65)]) test(`canonical release validator rejects unsafe name ${JSON.stringify(name)}`, () => {
  expect(() => validateManifest({ ...manifest, name })).toThrow();
});
for (const patch of [{ schemaVersion: 2 }, { version: "not-semver" }, { description: undefined }, { author: {} }, { tools: [{ name: "tool", description: "Tool", inputSchema: {} }] }, { handler: () => null }]) test(`canonical release validator rejects invalid metadata ${JSON.stringify(patch)}`, () => {
  expect(() => validateManifest({ ...manifest, ...patch })).toThrow();
});

test("canonical metadata preserves author and explicit deputy declarations without generating grants", () => {
  const validated = validateManifest({ ...manifest, name: "a".repeat(64), acceptsCallerCaps: true, escalateChildCaps: true });
  expect(validated.author).toEqual(manifest.author);
  expect(validated.acceptsCallerCaps).toBe(true);
  expect(validated.escalateChildCaps).toBe(true);
  expect(validated.permissions).toEqual({});
  expect(Object.hasOwn(validated, "grantedPermissions")).toBe(false);
});
