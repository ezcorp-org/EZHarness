import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { InstallationState } from "../v4/types";

const states = new Map<string, InstallationState>();
const builds: unknown[] = [];
const approved: unknown[] = [];
let users = [{ id: "admin", role: "admin", status: "active" }];
let legacy: { id: string; creatorUserId: string | null; enabled: boolean } | undefined;
const updates: unknown[] = [];
const runs: unknown[] = [];
let buildState = "awaiting_approval";
mock.module("../../db/connection", () => ({ getDb: () => ({}) }));
mock.module("../../db/queries/users", () => ({ listUsers: async () => users }));
mock.module("../../db/queries/extensions", () => ({ getExtensionByName: async () => legacy, updateExtension: async (...args: unknown[]) => updates.push(args) }));
mock.module("../../db/queries/extension-releases", () => ({ DatabaseLifecycleRepository: class {
  async read(id: string) { return states.get(id) ?? null; }
  async create(state: InstallationState) { states.set(state.installation.id, state); }
} }));
mock.module("../../../scripts/migrate-extension-v4", () => ({ snapshotFirstPartyExtension: async () => ({ source: { directory: "extensions/test", entrypoint: "extension.ts" }, files: { "extension.ts": "throw new Error('Do not import on host')" } }) }));
mock.module("../extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => ({
  async createWorkspace(_actor: unknown, input: { installationId: string; files: unknown }) {
    const { digestObject } = await import("../v4/blobs");
    const workspace = { id: "workspace", installationId: input.installationId, revision: 1, sourceDigest: digestObject(input.files), createdAt: new Date(0).toISOString() };
    states.get(input.installationId)!.workspaces[workspace.id] = workspace;
    return { workspace };
  },
  async build(actor: unknown, input: unknown) { builds.push({ actor, input }); return { id: "operation", state: buildState }; },
  async runBuild(...args: unknown[]) { runs.push(args); throw new Error("Completed operation must not restart"); },
  policyDigest: () => "policy",
  async approve(...args: unknown[]) { approved.push(args); },
}) }));
const { stageBundledExtensionSources, bundledInstallationId, stageBuiltinRunnerSources, builtinRunnerInstallationId } = await import("../bundled-bootstrap");
beforeEach(() => { states.clear(); builds.length = 0; runs.length = 0; buildState = "awaiting_approval"; approved.length = 0; updates.length = 0; legacy = undefined; users = [{ id: "admin", role: "admin", status: "active" }]; });

test("stages immutable source once without executing config or approving releases", async () => {
  const entries = [{ name: "test", path: "extensions/test" }];
  await stageBundledExtensionSources(entries);
  await stageBundledExtensionSources(entries);
  const state = states.get(bundledInstallationId("test"))!;
  expect(state.installation.ownerId).toBe("admin");
  expect(state.installation.enabled).toBe(false);
  expect(Object.keys(state.workspaces)).toHaveLength(1);
  expect(approved).toHaveLength(0);
  expect(builds).toHaveLength(2);
  expect(builds[0]).toEqual(builds[1]);
});

test("preserves existing installation identity and creator and disables legacy projection", async () => {
  users.push({ id: "creator", role: "member", status: "active" });
  legacy = { id: "legacy", creatorUserId: "creator", enabled: true };
  await stageBundledExtensionSources([{ name: "test", path: "extensions/test" }]);
  expect(states.get("legacy")?.installation.ownerId).toBe("creator");
  expect(updates).toEqual([["legacy", { enabled: false, grantedPermissions: { grantedAt: {} } }]]);
  expect(approved).toHaveLength(0);
});

test("does not invent a system owner when no active administrator exists", async () => {
  users = [];
  await stageBundledExtensionSources([{ name: "test", path: "extensions/test" }]);
  expect(states.size).toBe(0);
  expect(builds).toHaveLength(0);
});

describe("built-in runner packages (C05 'Install built-in runner packages', W4H-26)", () => {
  const runner = (text: string) => [{ manifestName: "reference-code", files: { "extension.ts": text }, entrypoint: "extension.ts" }];

  test("stage once in their own namespace, owned by the administrator, disabled, never approved", async () => {
    await stageBuiltinRunnerSources(runner("export {}"));
    await stageBuiltinRunnerSources(runner("export {}"));
    const id = builtinRunnerInstallationId("reference-code");
    expect(id).not.toBe(bundledInstallationId("reference-code"));
    const state = states.get(id)!;
    expect(state.installation).toMatchObject({ ownerId: "admin", scope: "global", enabled: false, activeReleaseId: null });
    expect(Object.keys(state.workspaces)).toHaveLength(1);
    expect(builds).toHaveLength(2);
    expect(builds[0]).toEqual(builds[1]);
    expect(builds[0]).toMatchObject({ actor: { principalId: "admin", scope: "global", kind: "service" } });
    expect(approved).toHaveLength(0);
  });

  test("changed bytes stage a second workspace and build; nothing is approved or activated", async () => {
    await stageBuiltinRunnerSources(runner("export {}"));
    const id = builtinRunnerInstallationId("reference-code");
    const first = Object.values(states.get(id)!.workspaces)[0]!.sourceDigest;
    states.get(id)!.workspaces = {};
    await stageBuiltinRunnerSources(runner("export const changed = 1;"));
    const second = Object.values(states.get(id)!.workspaces)[0]!.sourceDigest;
    expect(second).not.toBe(first);
    expect(builds).toHaveLength(2);
    expect(builds[0]).not.toEqual(builds[1]);
    expect(states.get(id)!.installation).toMatchObject({ enabled: false, activeReleaseId: null });
    expect(approved).toHaveLength(0);
  });

  test("wait for an active administrator, and skip an uninstalled package", async () => {
    users = [];
    await stageBuiltinRunnerSources(runner("export {}"));
    expect(states.size).toBe(0);
    users = [{ id: "admin", role: "admin", status: "active" }];
    await stageBuiltinRunnerSources(runner("export {}"));
    states.get(builtinRunnerInstallationId("reference-code"))!.installation.uninstalled = true;
    await stageBuiltinRunnerSources(runner("export const again = 1;"));
    expect(builds).toHaveLength(1);
  });

  test("an installation whose owner is no longer active is left for a person, and nothing is built", async () => {
    await stageBuiltinRunnerSources(runner("export {}"));
    states.get(builtinRunnerInstallationId("reference-code"))!.installation.ownerId = "departed";
    await stageBuiltinRunnerSources(runner("export const again = 1;"));
    expect(builds).toHaveLength(1);
  });

  test("a queued build runs in the isolated builder, and a failure there is logged rather than thrown", async () => {
    buildState = "queued";
    await stageBuiltinRunnerSources(runner("export {}"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toEqual([[{ principalId: "admin", scope: "global", kind: "service" }, builtinRunnerInstallationId("reference-code"), "operation"]]);
  });

  test("one package's failure is reported and does not stop the next", async () => {
    const entries = [{ manifestName: "broken", files: { "extension.ts": 1n } as never, entrypoint: "extension.ts" }, ...runner("export {}")];
    await stageBuiltinRunnerSources(entries);
    expect(builds).toHaveLength(1);
  });
});
