import { afterAll, expect, mock, test } from "bun:test";
import * as projects from "../db/queries/projects";
import * as projectTargets from "../runtime/workspaces/project-target";
import { sandboxWorkspaceTarget } from "../runtime/workspaces/target";

const originalProjects = { ...projects };
const originalProjectTargets = { ...projectTargets };
const binding = {
  projectId: "project-1", workspaceId: "workspace-1", connectionId: "connection-1",
  providerId: "incus", generation: 1, presetId: "preset-1",
  releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64),
  effectiveSettingsDigest: "c".repeat(64),
};
const calls: string[] = [];
const target = sandboxWorkspaceTarget(binding, {
  async execute(request) {
    calls.push(request.toolName);
    return { content: [{ type: "text" as const, text: "sandbox result" }], details: {} };
  },
});
let currentTarget = target;
mock.module("../db/queries/projects", () => ({
  ...originalProjects,
  getProject: async (id: string) => ({ id, path: "/host/canary" }),
}));
mock.module("../runtime/workspaces/project-target", () => ({
  ...originalProjectTargets,
  resolveProjectWorkspaceTarget: async () => currentTarget,
}));
const { resolveProviderProjectBuiltinTools } = await import("../runtime/stream-chat/provider-project-tools");
const { setupTools } = await import("../runtime/stream-chat/setup-tools");

afterAll(() => {
  mock.module("../db/queries/projects", () => originalProjects);
  mock.module("../runtime/workspaces/project-target", () => originalProjectTargets);
});

test("provider tools stop when the resolved binding changes after construction", async () => {
  const tools = await resolveProviderProjectBuiltinTools(binding.projectId, target);
  const readFile = tools.find(tool => tool.name === "readFile")!;
  expect((await readFile.execute("call-1", { path: "canary.txt" })).content[0])
    .toEqual({ type: "text", text: "sandbox result" });
  expect(calls).toEqual(["readFile"]);

  currentTarget = sandboxWorkspaceTarget({ ...binding, generation: 2 }, target.backend);
  const denied = await readFile.execute("call-2", { path: "canary.txt" });
  expect(denied.details).toMatchObject({ isError: true });
  expect(denied.content[0]).toEqual({
    type: "text", text: "Error: Workspace binding changed; start a new run before retrying.",
  });
  expect(calls).toEqual(["readFile"]);
});

test("attachment handles require a host-selected workspace target", async () => {
  const attachment = { id: "attachment-1", filename: "canary.txt", mimeType: "text/plain", storagePath: "opaque" };
  await expect(setupTools(
    { run: { id: "run-1" } } as Parameters<typeof setupTools>[0],
    { bus: { emit() {} } } as unknown as Parameters<typeof setupTools>[1],
    "conversation-1", "hello", { attachments: [attachment] }, [], null, "conversation-1",
  )).rejects.toThrow("Attachment resolution requires an explicit workspace target");
});
