import { beforeEach, expect, mock, test } from "bun:test";
import type { InstallationState } from "../v4/types";

const states = new Map<string, InstallationState>();
const builds: unknown[] = [];
const approved: unknown[] = [];
let users = [{ id: "admin", role: "admin", status: "active" }];
let legacy: { id: string; creatorUserId: string | null; enabled: boolean } | undefined;
const updates: unknown[] = [];
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
  async build(actor: unknown, input: unknown) { builds.push({ actor, input }); return { id: "operation", state: "awaiting_approval" }; },
  async runBuild() { throw new Error("Completed operation must not restart"); },
  async approve(...args: unknown[]) { approved.push(args); },
}) }));
const { stageBundledExtensionSources, bundledInstallationId } = await import("../bundled-bootstrap");
beforeEach(() => { states.clear(); builds.length = 0; approved.length = 0; updates.length = 0; legacy = undefined; users = [{ id: "admin", role: "admin", status: "active" }]; });

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
