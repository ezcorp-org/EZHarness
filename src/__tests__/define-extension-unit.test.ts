import { describe, expect, mock, test } from "bun:test";
import { createExtensionFiles, ExtensionControl, extensionControlTools, requestedReleaseGrants } from "../extensions/extension-control";
import { scaffoldWorkspace } from "@ezcorp/sdk/scaffold";
import type { ExtensionLifecycle } from "../extensions/v4";
import type { InstallationState, LifecycleActor } from "../extensions/v4/types";
import { createExtensionControlTools, getExtensionControlMetadata } from "../runtime/tools/extensions";

import { controlActor as actor, controlFixture as fixture, controlInstallation as installation, controlWorkspace as workspace } from "./helpers/extension-control-fixture";

describe("extension control", () => {
  test("workspace control accepts bounded binary assets above the invocation frame limit", async () => {
    const { control, lifecycle } = fixture();
    const file = { encoding: "base64", data: "AAAA".repeat(400_000), executable: false };
    await control.execute(actor, "extensions_workspace", { action: "edit", installationId: "installation", workspaceId: "workspace", expectedRevision: 1, writes: { "assets/large.bin": file } });
    expect(lifecycle.editWorkspace).toHaveBeenCalledWith(actor, { installationId: "installation", workspaceId: "workspace", expectedRevision: 1, writes: { "assets/large.bin": file }, deletes: undefined });
    await expect(control.execute(actor, "extensions_workspace", { action: "create", writes: { "asset.bin": { ...file, data: "AB==" } } })).rejects.toThrow("canonical");
    await expect(control.execute(actor, "extensions_workspace", { action: "create", writes: { "extension.ts": file } })).rejects.toThrow("must be text");
    expect(lifecycle.createWorkspace).not.toHaveBeenCalled();
  });



  test("lists, reads and revision-checks edits", async () => {
    const { control, lifecycle } = fixture();
    expect(await control.execute(actor, "extensions_workspace", { action: "list" })).toEqual([installation]);
    await control.execute(actor, "extensions_workspace", { action: "read", installationId: "installation", workspaceId: "workspace" });
    await control.execute(actor, "extensions_workspace", { action: "edit", installationId: "installation", workspaceId: "workspace", expectedRevision: 1, writes: { "nested/file.ts": "text" }, deletes: ["old.ts"] });
    expect(lifecycle.editWorkspace).toHaveBeenCalledWith(actor, { installationId: "installation", workspaceId: "workspace", expectedRevision: 1, writes: { "nested/file.ts": "text" }, deletes: ["old.ts"] });
  });



  test("resolves dependencies through revision-checked workspace action without building", async () => {
    const { control, lifecycle } = fixture();
    const input = { action: "resolveDependencies", installationId: "installation", workspaceId: "workspace", expectedRevision: 1 };
    expect(await control.execute(actor, "extensions_workspace", input)).toMatchObject({ revision: 2 });
    expect(lifecycle.resolveWorkspaceDependencies).toHaveBeenCalledWith(actor, { installationId: "installation", workspaceId: "workspace", expectedRevision: 1 });
    expect(lifecycle.build).not.toHaveBeenCalled();
    await expect(control.execute(actor, "extensions_workspace", { action: input.action, installationId: input.installationId, workspaceId: input.workspaceId })).rejects.toThrow("expectedRevision");
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


  test("rejects unsupported tools and malformed workspace revisions before lifecycle calls", async () => {
    const { control, lifecycle } = fixture();
    await expect(control.execute(actor, "extensions_unknown" as never, {})).rejects.toMatchObject({ code: "unknown_tool" });
    await expect(control.execute(actor, "extensions_workspace", null as never)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(control.execute(actor, "extensions_workspace", { action: "read", installationId: "installation" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(control.execute(actor, "extensions_workspace", { action: "edit", installationId: "installation", workspaceId: "workspace", expectedRevision: 1.5 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(control.execute(actor, "extensions_workspace", { action: "resolveDependencies", installationId: "installation", workspaceId: "workspace", expectedRevision: "stale" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(control.execute(actor, "extensions_workspace", { action: "stale-action", installationId: "installation", workspaceId: "workspace" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(lifecycle.readWorkspace).not.toHaveBeenCalled();
    expect(lifecycle.editWorkspace).not.toHaveBeenCalled();
    expect(lifecycle.resolveWorkspaceDependencies).not.toHaveBeenCalled();
  });


});
