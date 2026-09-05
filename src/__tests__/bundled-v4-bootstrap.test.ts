import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { InstallationState, LifecycleActor } from "../extensions/v4/types";
import { digestObject } from "../extensions/v4/blobs";

const states = new Map<string, InstallationState>();
const legacy = new Map<string, { id: string; creatorUserId?: string; enabled: boolean; disabledByUser?: boolean }>();
let users: Array<{ id: string; role: string; status: string }> = [];
let files: Record<string, string> = {};
let sourceDirectory = "extensions/candidate";
let sourceFailure = false;
const create = mock(async (state: InstallationState) => { states.set(state.installation.id, state); });
const update = mock(async (id: string, patch: Record<string, unknown>) => {
  const row = [...legacy.values()].find((candidate) => candidate.id === id);
  if (row) Object.assign(row, patch);
});
const workspace = mock(async (_actor: LifecycleActor, input: { installationId: string; files: Record<string, string> }) => {
  const state = states.get(input.installationId)!;
  const workspace = { id: `workspace-${Object.keys(state.workspaces).length}`, installationId: input.installationId, revision: 1, sourceDigest: digestObject(input.files), createdAt: new Date().toISOString() };
  state.workspaces[workspace.id] = workspace;
  return { workspace };
});
const build = mock(async (_actor: LifecycleActor, input: { installationId: string; workspaceId: string; expectedRevision: number; entrypoint: string; idempotencyKey: string }) => ({ id: `operation-${input.workspaceId}`, state: "queued" }));
const runBuild = mock(async (_actor: LifecycleActor, _installationId: string, _operationId: string) => {});
const snapshot = mock(async () => {
  if (sourceFailure) throw new Error("Source is unreadable");
  return { source: { directory: sourceDirectory, entrypoint: "extension.ts" }, files };
});
mock.module("../db/connection", () => ({ getDb: () => ({}) }));
mock.module("../db/queries/extension-releases", () => ({ DatabaseLifecycleRepository: class {
  read(id: string) { return Promise.resolve(states.get(id) ?? null); }
  create = create;
} }));
mock.module("../db/queries/extensions", () => ({ getExtensionByName: async (name: string) => legacy.get(name) ?? null, updateExtension: update }));
mock.module("../db/queries/users", () => ({ listUsers: async () => users }));
mock.module("../extensions/project-root", () => ({ getProjectRoot: () => "/reviewed" }));
mock.module("../../scripts/migrate-extension-v4", () => ({ snapshotFirstPartyExtension: snapshot }));
mock.module("../extensions/extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => ({ createWorkspace: workspace, build, runBuild }) }));

const { stageBundledExtensionSources, bundledInstallationId } = await import("../extensions/bundled-bootstrap");
const entries = [{ name: "candidate", path: "extensions/candidate" }];
afterAll(() => mock.restore());
beforeEach(() => {
  states.clear(); legacy.clear();
  users = [{ id: "admin", role: "admin", status: "active" }];
  files = { "extension.ts": "throw new Error('must never execute on the host')" };
  sourceDirectory = entries[0]!.path;
  sourceFailure = false;
  for (const callback of [create, update, workspace, build, runBuild, snapshot]) callback.mockClear();
  build.mockImplementation(async (_actor, input) => ({ id: `operation-${input.workspaceId}`, state: "queued" }));
  runBuild.mockImplementation(async () => {});
});

async function stage(): Promise<InstallationState> {
  await stageBundledExtensionSources(entries);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return [...states.values()][0]!;
}

describe("host-owned bundled source staging", () => {
  test("binds an active human owner but starts disabled without grants or approvals", async () => {
    const state = await stage();
    expect(state.installation).toMatchObject({ ownerId: "admin", enabled: false, activeReleaseId: null, grants: [], generation: 0 });
    expect(state.approvals).toEqual({});
    expect(state.releases).toEqual({});
    expect(workspace).toHaveBeenCalledWith({ principalId: "admin", scope: "global", kind: "service" }, { installationId: state.installation.id, files });
    expect(runBuild).toHaveBeenCalledTimes(1);
  });

  test("uses deterministic installation identifiers and selects administrators deterministically", async () => {
    users = [{ id: "z", role: "admin", status: "active" }, { id: "a", role: "admin", status: "active" }];
    const state = await stage();
    expect(state.installation.ownerId).toBe("a");
    expect(state.installation.id).toBe(bundledInstallationId("candidate"));
    expect(bundledInstallationId("candidate")).not.toBe(bundledInstallationId("another"));
    expect(state.installation.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-a[\da-f]{3}-[\da-f]{12}$/);
  });

  for (const population of [[], [{ id: "member", role: "member", status: "active" }], [{ id: "admin", role: "admin", status: "disabled" }]]) {
    test(`does not stage without an active administrator: ${JSON.stringify(population)}`, async () => {
      users = population;
      await stage();
      expect(create).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
    });
  }

  test("preserves the original installation and creator instead of transferring ownership", async () => {
    users.push({ id: "creator", role: "member", status: "active" });
    legacy.set("candidate", { id: "legacy-id", creatorUserId: "creator", enabled: true });
    const state = await stage();
    expect(state.installation.id).toBe("legacy-id");
    expect(state.installation.ownerId).toBe("creator");
    expect(update).toHaveBeenCalledWith("legacy-id", { enabled: false, grantedPermissions: { grantedAt: {} } });
  });

  test("does not seize an inactive or missing creator's source", async () => {
    legacy.set("candidate", { id: "legacy-id", creatorUserId: "departed", enabled: false });
    await stage();
    expect(create).not.toHaveBeenCalled();
    expect(workspace).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  for (const disabledByUser of [true, false]) {
    test(`does not re-enable legacy code, user disable flag ${disabledByUser}`, async () => {
      legacy.set("candidate", { id: "legacy-id", enabled: false, disabledByUser });
      const state = await stage();
      expect(legacy.get("candidate")).toMatchObject({ enabled: false, disabledByUser });
      expect(state.installation.enabled).toBe(false);
      expect(state.installation.grants).toEqual([]);
      expect(state.approvals).toEqual({});
    });
  }

  test("does not reinstall a removed installation on the next boot", async () => {
    const state = await stage();
    state.installation.uninstalled = true;
    snapshot.mockClear(); build.mockClear();
    await stage();
    expect(snapshot).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  test("keeps a verified active release unchanged while a source update waits for approval", async () => {
    legacy.set("candidate", { id: "legacy-id", enabled: true });
    const state = await stage();
    state.installation.activeReleaseId = "approved-release";
    state.installation.enabled = true;
    legacy.get("candidate")!.enabled = true;
    files = { ...files, "new-tool.ts": "export const newTool = true" };
    update.mockClear();
    await stage();
    expect(state.installation.activeReleaseId).toBe("approved-release");
    expect(state.installation.enabled).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(Object.keys(state.workspaces)).toHaveLength(2);
    expect(state.approvals).toEqual({});
  });

  test("reuses exact snapshots and durable build keys across repeated boots", async () => {
    await stage();
    await stage();
    expect(create).toHaveBeenCalledTimes(1);
    expect(workspace).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]![1]).toEqual(build.mock.calls[1]![1]);
    expect(build.mock.calls[0]![1]).toMatchObject({ expectedRevision: 1, entrypoint: "extension.ts", idempotencyKey: `bundled-bootstrap:${digestObject(files)}` });
  });

  test("any source change creates a new workspace without changing active grants", async () => {
    const state = await stage();
    files = { ...files, "presentation.json": "{\"title\":\"Updated\"}" };
    await stage();
    expect(workspace).toHaveBeenCalledTimes(2);
    expect(build.mock.calls[0]![1].idempotencyKey).not.toBe(build.mock.calls[1]![1].idempotencyKey);
    expect(state.installation.grants).toEqual([]);
    expect(state.installation.enabled).toBe(false);
  });

  test("unreadable source cannot build or revive a legacy extension", async () => {
    legacy.set("candidate", { id: "legacy-id", enabled: true });
    sourceFailure = true;
    await stage();
    expect(legacy.get("candidate")!.enabled).toBe(false);
    expect(workspace).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  test("checks the exact reviewed source path before creating a workspace", async () => {
    sourceDirectory = "extensions/attacker";
    await stage();
    expect(workspace).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  test("completed operations are not executed again", async () => {
    build.mockImplementation(async () => ({ id: "complete", state: "succeeded" }));
    await stage();
    expect(runBuild).not.toHaveBeenCalled();
  });

  test("one failed build cannot block the next queued build or activate either", async () => {
    runBuild.mockRejectedValueOnce(new Error("runner unavailable"));
    const state = await stage();
    files = { ...files, "changed.ts": "export const changed = true" };
    await stage();
    expect(runBuild).toHaveBeenCalledTimes(2);
    expect(state.installation.activeReleaseId).toBeNull();
    expect(state.installation.enabled).toBe(false);
  });
});
