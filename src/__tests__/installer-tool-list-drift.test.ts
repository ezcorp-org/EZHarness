/** New source creates a candidate build only. It cannot activate or approve a changed tool surface. */
import { afterAll, beforeEach, expect, test } from "bun:test";
import {
  resetInstallerV4SourceFixture,
  restoreInstallerV4SourceFixture,
  sourceActor,
  stagingCalls,
} from "./helpers/installer-v4-source-fixtures";

const { stageExtensionSourceFiles } = await import("../extensions/source-import");

afterAll(() => restoreInstallerV4SourceFixture());
beforeEach(resetInstallerV4SourceFixture);

test("a changed v4 tool source remains disabled and queues a separate candidate build", async () => {
  const first = await stageExtensionSourceFiles(sourceActor, { "extension.ts": "export const tools = ['read'];" }, { kind: "skill", name: "tool-fixture" });
  const changed = await stageExtensionSourceFiles(sourceActor, { "extension.ts": "export const tools = ['read', 'write'];" }, { kind: "skill", name: "tool-fixture" });

  expect(first.installation).toMatchObject({ enabled: false, activeReleaseId: null });
  expect(changed.installation).toMatchObject({ enabled: false, activeReleaseId: null });
  expect(changed.operation.id).not.toBe(first.operation.id);
  expect(stagingCalls().runBuild).toHaveBeenCalledTimes(2);
});

test("a runner failure leaves the staged source disabled instead of treating the build as activation", async () => {
  stagingCalls().runBuild.mockRejectedValueOnce(new Error("runner unavailable"));
  const result = await stageExtensionSourceFiles(sourceActor, { "extension.ts": "export const tools = ['read'];" }, { kind: "skill", name: "tool-fixture" });
  await Promise.resolve();
  expect(result.operation.state).toBe("queued");
  expect(result.installation.enabled).toBe(false);
  expect(result.installation.activeReleaseId).toBeNull();
  expect(stagingCalls().runBuild).toHaveBeenCalledWith(sourceActor, "installation", result.operation.id);
});
