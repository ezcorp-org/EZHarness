import { describe, expect, mock, test } from "bun:test";
import { createExtensionFiles, ExtensionControl, extensionControlTools, requestedReleaseGrants } from "../extension-control";
import type { ExtensionLifecycle } from "../v4";
import type { InstallationState, LifecycleActor } from "../v4/types";
import { createExtensionControlTools, getExtensionControlMetadata } from "../../runtime/tools/extensions";

const actor: LifecycleActor = { principalId: "owner", scope: "global", kind: "agent" };
const installation = { id: "installation", ownerId: "owner", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled" as const, grants: [], acknowledgedGeneration: 0 };
const workspace = { id: "workspace", installationId: installation.id, revision: 1, sourceDigest: "source", createdAt: "now" };

function fixture() {
  const state: InstallationState = { installation, workspaces: { workspace }, revisions: {}, operations: {}, releases: {}, approvals: {} };
  const lifecycle = {
    createWorkspace: mock(async () => ({ installation, workspace })),
    list: mock(async () => [installation]),
    readWorkspace: mock(async () => ({ workspace, files: createExtensionFiles() })),
    editWorkspace: mock(async () => ({ ...workspace, revision: 2 })),
    build: mock(async () => ({ id: "operation", state: "queued" })),
    runBuild: mock(async () => ({ id: "operation", state: "verified" })),
    inspect: mock(async () => state),
    requestApproval: mock(async () => ({ id: "approval" })),
    activate: mock(async () => ({ state: "active" })),
    rollback: mock(async () => ({ state: "active" })),
    disable: mock(async () => undefined),
    uninstall: mock(async () => undefined),
  };
  return { lifecycle, state, control: new ExtensionControl(lifecycle as unknown as ExtensionLifecycle) };
}

describe("extension control", () => {
  test("describes one SDK contract with nested tested source and no approval tool", async () => {
    const { control } = fixture();
    expect(await control.execute(actor, "extensions_describe", {})).toMatchObject({ schemaVersion: 4, sdk: "@ezcorp/sdk/v4" });
    const files = createExtensionFiles("safe-name", "test");
    expect(files["extension.ts"]).toContain("defineExtension");
    expect(files["src/echo.test.ts"]).toContain("expect");
    expect(() => createExtensionFiles("../escape")).toThrow("lowercase");
    expect(extensionControlTools.map((tool) => tool.name)).not.toContain("extensions_approve");
  });

  test("creates and forks isolated workspaces without calling runner or activation", async () => {
    const { control, lifecycle } = fixture();
    expect(await control.execute(actor, "extensions_workspace", { action: "create" })).toMatchObject({ workspace, openUrl: "/extensions/author?installation=installation&workspace=workspace" });
    await control.execute(actor, "extensions_workspace", { action: "create", name: "custom", description: "custom", writes: { "nested/source.ts": "text" } });
    await control.execute(actor, "extensions_workspace", { action: "fork", installationId: "installation", releaseId: "release" });
    expect(lifecycle.createWorkspace.mock.calls).toHaveLength(3);
    expect(lifecycle.activate).not.toHaveBeenCalled();
    expect(lifecycle.runBuild).not.toHaveBeenCalled();
  });

  test("lists, reads and revision-checks edits", async () => {
    const { control, lifecycle } = fixture();
    expect(await control.execute(actor, "extensions_workspace", { action: "list" })).toEqual([installation]);
    await control.execute(actor, "extensions_workspace", { action: "read", installationId: "installation", workspaceId: "workspace" });
    await control.execute(actor, "extensions_workspace", { action: "edit", installationId: "installation", workspaceId: "workspace", expectedRevision: 1, writes: { "nested/file.ts": "text" }, deletes: ["old.ts"] });
    expect(lifecycle.editWorkspace).toHaveBeenCalledWith(actor, { installationId: "installation", workspaceId: "workspace", expectedRevision: 1, writes: { "nested/file.ts": "text" }, deletes: ["old.ts"] });
  });

  test("queues an exact revision and returns before durable worker finishes", async () => {
    const { control, lifecycle } = fixture();
    expect(await control.execute(actor, "extensions_build", { installationId: "installation", workspaceId: "workspace", expectedRevision: 1, idempotencyKey: "retry-key", entrypoint: "nested/start.ts" })).toMatchObject({ id: "operation" });
    expect(lifecycle.runBuild).toHaveBeenCalledWith(actor, "installation", "operation");
    expect(lifecycle.build).toHaveBeenCalledWith(actor, { installationId: "installation", workspaceId: "workspace", expectedRevision: 1, idempotencyKey: "retry-key", entrypoint: "nested/start.ts" });
  });

  test("rejects extra input, invalid revisions, missing fields and approval attempts", async () => {
    const { control, lifecycle } = fixture();
    for (const input of [{ action: "approve", installationId: "installation" }, { action: "activate", installationId: "installation" }, { action: "disable", installationId: "installation", approved: true }]) {
      await expect(control.execute(actor, "extensions_release", input)).rejects.toHaveProperty("code", "invalid_input");
    }
    for (const expectedRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await expect(control.execute(actor, "extensions_build", { installationId: "installation", workspaceId: "workspace", expectedRevision, idempotencyKey: "key" })).rejects.toHaveProperty("code", "invalid_input");
    await expect(control.execute(actor, "extensions_workspace", { action: "edit", installationId: "installation", workspaceId: "workspace", writes: { "file.ts": 1 } })).rejects.toHaveProperty("code", "invalid_input");
    expect(lifecycle.activate).not.toHaveBeenCalled();
  });

  test("approval requests bind all authority declarations, never caller-supplied grants", async () => {
    const { control, lifecycle, state } = fixture();
    const manifest = { schemaVersion: 4 as const, name: "test", version: "1", description: "test", author: { name: "test" }, permissions: { storage: true }, acceptsCallerCaps: true, escalateChildCaps: true };
    state.releases.release = { id: "release", installationId: "installation", workspaceId: "workspace", workspaceRevision: 1, sourceDigest: "source", artifactDigest: "artifact", imageDigest: "image", manifest, evidence: { protocolVersion: 4, validatorVersion: "4", tests: [], discoveryDigest: "discovery" }, runnerProfile: "podman", releaseDigest: "release-digest", policyDigest: "policy", createdAt: "now" };
    const grants = requestedReleaseGrants(manifest);
    expect(grants).toEqual(['["acceptsCallerCaps",true]', '["escalateChildCaps",true]', '["storage",true]']);
    await expect(control.execute(actor, "extensions_release", { action: "requestApproval", installationId: "installation", releaseId: "missing", expectedActiveReleaseId: null })).rejects.toHaveProperty("code", "not_found");
    await expect(control.execute(actor, "extensions_release", { action: "requestApproval", installationId: "installation", releaseId: "release" })).rejects.toHaveProperty("code", "invalid_input");
    await control.execute(actor, "extensions_release", { action: "requestApproval", installationId: "installation", releaseId: "release", expectedActiveReleaseId: null });
    expect(lifecycle.requestApproval).toHaveBeenCalledWith(actor, { installationId: "installation", releaseId: "release", grants, expectedActiveReleaseId: null });
  });

  test("activation, rollback, disable and uninstall all use the same lifecycle", async () => {
    const { control, lifecycle } = fixture();
    for (const action of ["activate", "rollback"]) await control.execute(actor, "extensions_release", { action, installationId: "installation", approvalId: "approval", idempotencyKey: "key" });
    for (const action of ["disable", "uninstall"]) await control.execute(actor, "extensions_release", { action, installationId: "installation" });
    expect(lifecycle.activate).toHaveBeenCalledWith(actor, { installationId: "installation", approvalId: "approval", idempotencyKey: "key" });
    expect(lifecycle.rollback).toHaveBeenCalledTimes(1);
    expect(lifecycle.disable).toHaveBeenCalledWith(actor, "installation");
    expect(lifecycle.uninstall).toHaveBeenCalledWith(actor, "installation");
  });

  test("inspect is owner-scoped, bounded, and abortable", async () => {
    const { control, state } = fixture();
    expect(await control.execute(actor, "extensions_inspect", { installationId: "installation" })).toEqual(state);
    await expect(control.execute(actor, "extensions_inspect", { installationId: "installation", operationId: "missing" })).rejects.toHaveProperty("code", "not_found");
    await expect(control.execute(actor, "extensions_inspect", { installationId: "installation", waitMs: 300001 })).rejects.toHaveProperty("code", "invalid_input");
    const controller = new AbortController();
    controller.abort();
    await expect(control.execute(actor, "extensions_inspect", { installationId: "installation" }, controller.signal)).rejects.toBeDefined();
  });

  test("builtins preserve structured errors and force agent identity", async () => {
    const { control } = fixture();
    const execute = mock(control.execute.bind(control));
    control.execute = execute;
    const tools = createExtensionControlTools({ ...actor, kind: "human" }, async () => control);
    expect(getExtensionControlMetadata()).toHaveLength(5);
    const describe = tools.find((tool) => tool.name === "extensions_describe")!;
    const result = await describe.execute("call", {}, undefined);
    expect(result.content[0]).toHaveProperty("type", "text");
    expect(execute.mock.calls[0]![0].kind).toBe("agent");
    expect((await describe.execute("call", null, undefined)).details).toHaveProperty("isError", true);
    expect((await describe.execute("call", { invalid: true }, undefined)).details).toMatchObject({ isError: true, code: "invalid_input" });
  });
});
