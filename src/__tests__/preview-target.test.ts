import { expect, mock, spyOn, test } from "bun:test";
import * as conversationQueries from "../db/queries/conversations";
import * as projectQueries from "../db/queries/projects";
import type { PreviewRegistryRow } from "../runtime/preview/preview-proxy";
import {
  registerQualificationPreviewTarget,
  resolveCurrentPreviewSandboxTarget,
  resolveQualificationPreviewTarget,
} from "../runtime/preview/preview-target";
import { sandboxWorkspaceTarget, workspaceTargetReference } from "../runtime/workspaces/target";

function fixture() {
  const binding = { projectId: "project", workspaceId: "fixture", connectionId: "connection",
    providerId: "incus", generation: 1, presetId: "incus-compose-v1",
    releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64), effectiveSettingsDigest: "c".repeat(64) };
  const key = { previewId: "qualification-preview", userId: "owner", conversationId: "conversation",
    targetPort: 4173, binding };
  const target = sandboxWorkspaceTarget(binding, {
    execute: async () => { throw new Error("No workspace execution during preview resolution"); },
    previews: { open: async () => {}, serve: async () => new Response("guest"), close: async () => {} },
  });
  const row: PreviewRegistryRow = { id: key.previewId, userId: key.userId,
    conversationId: key.conversationId, kind: "dynamic", staticPath: null,
    targetPort: key.targetPort, expiresAt: new Date(2000), workspaceTarget: workspaceTargetReference(target) };
  return { key, target, row };
}

test("invalid qualification registrations cannot replace a lease or invoke its resolver", async () => {
  const { key, target, row } = fixture();
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  const resolve = mock(async () => target);
  const replacement = mock(async () => target);
  const dispose = registerQualificationPreviewTarget(key, resolve);
  let disposeReplacement: (() => void) | undefined;
  try {
    const invalid = [
      { ...key, previewId: "" }, { ...key, previewId: "invalid", userId: "" },
      { ...key, previewId: "invalid", conversationId: "" },
      ...[1023, 65536, 4173.5, Number.NaN, Number.POSITIVE_INFINITY]
        .map(targetPort => ({ ...key, previewId: "invalid", targetPort })),
      key,
    ];
    for (const candidate of invalid) {
      expect(() => registerQualificationPreviewTarget(candidate, replacement))
        .toThrow("Qualification preview route is unavailable");
    }
    expect(replacement).not.toHaveBeenCalled();
    expect(await resolveQualificationPreviewTarget(row)).toBe(target);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();

    dispose();
    expect(await resolveQualificationPreviewTarget(row)).toBeUndefined();
    disposeReplacement = registerQualificationPreviewTarget(key, replacement);
    dispose(); // A stale disposer cannot revoke the replacement lease.
    expect(await resolveQualificationPreviewTarget(row)).toBe(target);
    expect(replacement).toHaveBeenCalledTimes(1);
  } finally {
    disposeReplacement?.();
    dispose();
    clock.mockRestore();
  }
});

for (const failingLookup of ["conversation", "project"] as const) {
  test(`a ${failingLookup} lookup failure denies preview access without using a fixture lease`, async () => {
    const { key, target, row } = fixture();
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    const resolve = mock(async () => target);
    const dispose = registerQualificationPreviewTarget(key, resolve);
    const conversation = spyOn(conversationQueries, "getConversation").mockResolvedValue({
      id: key.conversationId, userId: key.userId, projectId: key.binding.projectId,
    } as Awaited<ReturnType<typeof conversationQueries.getConversation>>);
    const project = spyOn(projectQueries, "getProject").mockRejectedValue(new Error("database unavailable"));
    if (failingLookup === "conversation") conversation.mockRejectedValue(new Error("database unavailable"));
    try {
      expect(await resolveCurrentPreviewSandboxTarget(row)).toBeUndefined();
      expect(conversation).toHaveBeenCalledWith(key.conversationId);
      if (failingLookup === "conversation") expect(project).not.toHaveBeenCalled();
      else expect(project).toHaveBeenCalledWith(key.binding.projectId);
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      project.mockRestore();
      conversation.mockRestore();
      dispose();
      clock.mockRestore();
    }
  });
}
