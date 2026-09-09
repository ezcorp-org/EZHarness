/** Source staging has no caller-deputy path: only an active human administrator can create a candidate. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import {
  resetInstallerV4SourceFixture,
  restoreInstallerV4SourceFixture,
  setSourceUser,
  sourceActor,
  stagingCalls,
} from "./helpers/installer-v4-source-fixtures";

const { stageExtensionSourceFiles } = await import("../extensions/source-import");

afterAll(() => restoreInstallerV4SourceFixture());
beforeEach(resetInstallerV4SourceFixture);

test("source metadata cannot carry a secret, target identity, or delegated authority", async () => {
  const inputs = [
    { kind: "github", repository: "owner/repo", token: "secret" },
    { kind: "github", repository: "owner/repo", targetInstallationId: "unexpected" },
    { kind: "skill", name: "fixture", headers: { authorization: "secret" } },
  ];
  for (const input of inputs) {
    await expect(stageExtensionSourceFiles(sourceActor, { "extension.ts": "export {};" }, input as Parameters<typeof stageExtensionSourceFiles>[2])).rejects.toThrow();
  }
  expect(stagingCalls().workspace).not.toHaveBeenCalled();
});

test("inactive, member, and non-human callers cannot stage a v4 source candidate", async () => {
  for (const account of [undefined, { id: "admin", role: "admin", status: "inactive" }, { id: "admin", role: "member", status: "active" }]) {
    setSourceUser(account);
    await expect(stageExtensionSourceFiles(sourceActor, { "extension.ts": "export {};" }, { kind: "skill", name: "fixture" })).rejects.toThrow();
  }
  await expect(stageExtensionSourceFiles({ ...sourceActor, kind: "agent" }, { "extension.ts": "export {};" }, { kind: "skill", name: "fixture" })).rejects.toThrow("human administrator");
  expect(stagingCalls().workspace).not.toHaveBeenCalled();
});

test("an authorized source stages a disabled candidate without persisting caller authority", async () => {
  const result = await stageExtensionSourceFiles(sourceActor, { "extension.ts": "export {};" }, { kind: "skill", name: "fixture" });
  expect(result.installation.enabled).toBe(false);
  expect(result.installation.activeReleaseId).toBeNull();
  expect(stagingCalls().build).toHaveBeenCalledTimes(1);
});
