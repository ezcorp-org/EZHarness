import { afterAll, expect, mock, test } from "bun:test";
import * as nativeTools from "./native-tools";
import { sandboxWorkspaceTarget } from "../workspaces/target";

const originalNativeTools = { ...nativeTools };
mock.module("./native-tools", () => ({
  ...originalNativeTools,
  getNativeToolDefs: (...args: Parameters<typeof nativeTools.getNativeToolDefs>) => [
    ...originalNativeTools.getNativeToolDefs(...args),
    { name: "runWorkflow", description: "Non-workspace tool", execute: async () => ({ content: [], details: {} }) },
  ],
}));
const { getBuiltinToolDefs } = await import("./index");

afterAll(() => mock.module("./native-tools", () => originalNativeTools));

test("sandbox metadata rejects a built-in without a workspace route", () => {
  const target = sandboxWorkspaceTarget({
    projectId: "project-1", workspaceId: "workspace-1", connectionId: "connection-1",
    providerId: "incus", generation: 1, presetId: "preset-1",
    releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64),
    effectiveSettingsDigest: "c".repeat(64),
  }, null);
  expect(() => getBuiltinToolDefs(target)).toThrow("Built-in tool runWorkflow has no sandbox workspace route");
});
