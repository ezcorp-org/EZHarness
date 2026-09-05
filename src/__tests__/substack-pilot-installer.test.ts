import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PodmanRunner, buildLimits, DEFAULT_IMAGE, provisionToolchain } from "@ezcorp/extension-runner";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";
import { createUser } from "../db/queries/users";
import { getExtensionByName } from "../db/queries/extensions";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { ExtensionLifecycle, FileBlobStore, type LifecycleActor } from "../extensions/v4";
import { publishExtensionGeneration, verifyExtensionCandidate } from "../extensions/extension-lifecycle-service";
import { requestedReleaseGrants } from "../extensions/extension-control";
import { snapshotFirstPartyExtension } from "../../scripts/migrate-extension-v4";
import { getProjectRoot } from "../extensions/project-root";
import { handleCredentialBroker } from "../extensions/credential-broker";
import { registerCallProvenance, releaseCallProvenance } from "../extensions/call-provenance";
import type { RpcHandlerDeps } from "../extensions/tool-executor/rpc-handlers";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import { ExtensionRegistry } from "../extensions/registry";

mockDbConnection();
let root: string;
let runner: PodmanRunner;
let lifecycle: ExtensionLifecycle;
let actor: LifecycleActor;
let installationId: string;
const settingsKeys = ["substack_publication_url", "substack_session_token", "substack_user_id"];

beforeAll(async () => {
  await setupTestDb();
  const user = await createUser({ email: "substack-install@example.test", name: "Owner", passwordHash: "fixture", role: "admin" });
  actor = { principalId: user.id, kind: "human", scope: "global" };
  root = await mkdtemp(join(tmpdir(), "substack-install-v4-"));
  runner = new PodmanRunner({ root: join(root, "runner"), ...await provisionToolchain() });
  await runner.initialize();
  lifecycle = new ExtensionLifecycle({
    repository: new DatabaseLifecycleRepository(getTestDb()), blobs: new FileBlobStore(join(root, "blobs")),
    runner, buildLimits, runnerProfile: "podman-v1", runnerImageDigest: DEFAULT_IMAGE, validatorVersion: "runner-v4.1",
    authorize: async identity => { if (identity.principalId !== actor.principalId) throw new Error("Unknown principal"); },
    verifyCandidate: release => verifyExtensionCandidate(runner, release),
    publish: async (installation, release) => publishExtensionGeneration(installation, release, release ? await runner.collectArtifacts(release.artifactDigest) : undefined),
  });
}, 120000);

afterAll(async () => {
  await runner?.close();
  ExtensionRegistry.resetInstance();
  await closeTestDb();
  if (root) await rm(root, { recursive: true, force: true });
});

test("Substack source seals settings and checksums, then publishes only its exact human-approved release", async () => {
  const source = await snapshotFirstPartyExtension(getProjectRoot(), "substack-pilot");
  const created = await lifecycle.createWorkspace(actor, { files: source.files });
  installationId = created.installation.id;
  const operation = await lifecycle.build(actor, { installationId, workspaceId: created.workspace.id, expectedRevision: 1, idempotencyKey: "substack-build" });
  const built = await lifecycle.runBuild(actor, installationId, operation.id);
  expect(built.diagnostics).toEqual([]);
  expect(built.state).toBe("verified");
  const state = await lifecycle.inspect(actor, installationId);
  const release = state.releases[built.releaseId!]!;
  expect(release.manifest).toMatchObject({ schemaVersion: 4, name: "substack-pilot", version: "1.0.0" });
  expect(release.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(release.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(release.manifest.settings ?? {}).sort()).toEqual(settingsKeys);
  for (const setting of Object.values(release.manifest.settings ?? {})) expect(setting).toMatchObject({ type: "text", label: expect.any(String), pattern: expect.any(String) });
  expect(release.manifest.permissions.env ?? []).toEqual([]);
  expect(state.installation).toMatchObject({ enabled: false, activeReleaseId: null, grants: [] });
  expect(await getExtensionByName("substack-pilot")).toBeNull();
  const approval = await lifecycle.requestApproval(actor, { installationId, releaseId: release.id, grants: requestedReleaseGrants(release.manifest), expectedActiveReleaseId: null });
  await expect(lifecycle.activate(actor, { installationId, approvalId: approval.id, idempotencyKey: "no-review" })).rejects.toThrow();
  await expect(lifecycle.approve({ ...actor, kind: "agent" }, installationId, approval.id, true)).rejects.toThrow();
  expect(await getExtensionByName("substack-pilot")).toBeNull();
  await lifecycle.approve(actor, installationId, approval.id, true);
  const activated = await lifecycle.activate(actor, { installationId, approvalId: approval.id, idempotencyKey: "reviewed" });
  expect(activated.diagnostics).toEqual([]);
  const projection = await getExtensionByName("substack-pilot");
  expect(projection).toMatchObject({ id: installationId, name: "substack-pilot", creatorUserId: actor.principalId, enabled: true, source: "release-v4", installPath: null });
  expect(projection?.manifest.settings).toEqual(release.manifest.settings);
  expect((await lifecycle.inspect(actor, installationId)).installation.grants).toEqual(requestedReleaseGrants(release.manifest));
}, 120000);

for (const name of ["SUBSTACK_SESSION_TOKEN", "SUBSTACK_USER_ID"]) test(`Substack setting ${name} cannot read host environment through the credential broker`, async () => {
  const before = await lifecycle.inspect(actor, installationId);
  const token = registerCallProvenance({ actorExtensionId: installationId, onBehalfOf: actor.principalId, conversationId: null, runId: null, parentCallId: null, kind: "tool", ownerless: false });
  const resolveCredential = mock(async () => "host-secret-must-not-leak");
  try {
    const dependencies: RpcHandlerDeps = { registry: ExtensionRegistry.getInstance(), engine: createStubPermissionEngine(), resolveExtensionScopeGrant: async () => false };
    const response = await handleCredentialBroker(dependencies, installationId, { jsonrpc: "2.0", id: name, method: "ezcorp/env.get", params: { name, _meta: { ezCallId: token } } }, { resolveCredential });
    expect(response).toMatchObject({ error: { message: "Only approved provider credential handles are available." } });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain("host-secret-must-not-leak");
    expect((await lifecycle.inspect(actor, installationId)).installation).toEqual(before.installation);
    expect(Object.keys((await getExtensionByName("substack-pilot"))!.manifest.settings ?? {}).sort()).toEqual(settingsKeys);
  } finally { releaseCallProvenance(token); }
});
