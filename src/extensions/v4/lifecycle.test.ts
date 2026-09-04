import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BuildResult, WorkspaceFiles } from "@ezcorp/extension-contract";
import { up } from "../../db/migrations/add-extension-releases";
import { DatabaseLifecycleRepository } from "../../db/queries/extension-releases";
import { canonicalJson, digestObject, FileBlobStore } from "./blobs";
import { ExtensionLifecycle } from "./lifecycle";
import { LifecycleError, type LifecycleActor, type LifecycleDependencies, type LifecycleRepository } from "./types";

const actor: LifecycleActor = { principalId: "owner", scope: "project:one", kind: "agent" };
const human: LifecycleActor = { ...actor, kind: "human" };
let database: PGlite;
let repository: DatabaseLifecycleRepository;
let root: string;
let blobs: FileBlobStore;

beforeAll(async () => {
  database = new PGlite();
  const db = drizzle(database);
  await up(db);
  await up(db);
  repository = new DatabaseLifecycleRepository(db);
  root = await mkdtemp(join(tmpdir(), "extension-lifecycle-"));
  blobs = new FileBlobStore(root);
});

afterAll(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });

function harness(overrides: Partial<LifecycleDependencies> = {}) {
  const extensionName = `fixture-${randomUUID()}`;
  const collected = new Map<string, WorkspaceFiles>();
  const builds: WorkspaceFiles[] = [];
  const published: number[] = [];
  const dependencies: LifecycleDependencies = {
    repository, blobs, runnerProfile: "podman-v1", runnerImageDigest: `sha256:${"a".repeat(64)}`, validatorVersion: "host-v1",
    buildLimits: { memoryBytes: 1024, cpuMillis: 1000, pids: 16, tmpBytes: 1024, outputBytes: 1024, timeoutMs: 5000 },
    runner: {
      async build(request) {
        builds.push(structuredClone(request.files));
        const artifacts = { "extension.js": request.files[request.entrypoint]! };
        const artifactDigest = digestObject(artifacts);
        collected.set(artifactDigest, artifacts);
        const manifest = { schemaVersion: 4 as const, name: extensionName, version: "1.0.0", description: "fixture", author: { name: "Test" }, entrypoint: "extension.js", permissions: {} };
        return { operationId: request.operationId, state: "succeeded", sourceDigest: request.sourceDigest, artifactDigest, imageDigest: `sha256:${"a".repeat(64)}`, manifest, evidence: { protocolVersion: 4, validatorVersion: "host-v1", discoveryDigest: digestObject(manifest), tests: [{ name: "host-protocol", passed: true }] }, diagnostics: [] } satisfies BuildResult;
      },
      async collectArtifacts(digest) { const files = collected.get(digest); if (!files) throw new Error("missing artifact"); return files; },
      async cancel() {},
    },
    async authorize() {},
    async verifyCandidate() {},
    async publish(installation) { published.push(installation.generation); },
    ...overrides,
  };
  return { lifecycle: new ExtensionLifecycle(dependencies), dependencies, builds, published };
}

async function releaseFixture(setup = harness()) {
  const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "export default 1", "src/nested.ts": "nested" } });
  const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "build" });
  const result = await setup.lifecycle.runBuild(actor, installation.id, operation.id);
  expect(result.state).toBe("verified");
  return { ...setup, installation, workspace, operation: result, releaseId: result.releaseId! };
}

async function approved(setup: Awaited<ReturnType<typeof releaseFixture>>, key = "activate") {
  const state = await setup.lifecycle.inspect(actor, setup.installation.id);
  const approval = await setup.lifecycle.requestApproval(actor, { installationId: setup.installation.id, releaseId: setup.releaseId, grants: ["storage:read"], expectedActiveReleaseId: state.installation.activeReleaseId });
  await setup.lifecycle.approve(human, setup.installation.id, approval.id, true);
  return { installationId: setup.installation.id, approvalId: approval.id, idempotencyKey: key };
}

describe("durable extension lifecycle", () => {
  test("nested edits are atomic; deletion is explicit; concurrent revisions conflict", async () => {
    const { lifecycle } = harness();
    const { installation, workspace } = await lifecycle.createWorkspace(actor, { files: { "extension.ts": "one", "src/remove.ts": "remove" } });
    const edits = await Promise.allSettled(["first", "second"].map((value) => lifecycle.editWorkspace(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, writes: { "src/nested/file.ts": value }, deletes: ["src/remove.ts"] })));
    expect(edits.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(edits.filter((result) => result.status === "rejected")).toHaveLength(1);
    const result = await lifecycle.readWorkspace(actor, installation.id, workspace.id);
    expect(result.workspace.revision).toBe(2);
    expect(result.files["src/remove.ts"]).toBeUndefined();
    expect(result.files["src/nested/file.ts"]).toBeDefined();
    await expect(lifecycle.editWorkspace(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 2, writes: { "../escape.ts": "bad" } })).rejects.toMatchObject({ code: "invalid_path" });
    expect((await lifecycle.readWorkspace(actor, installation.id, workspace.id)).workspace.revision).toBe(2);
  });

  test("source snapshots survive edits and idempotency binds exact inputs", async () => {
    const setup = harness();
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "before" } });
    const input = { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "same" };
    const operation = await setup.lifecycle.build(actor, input);
    await setup.lifecycle.editWorkspace(actor, { ...input, expectedRevision: 1, writes: { "extension.ts": "after" } });
    expect((await setup.lifecycle.build(actor, input)).id).toBe(operation.id);
    await expect(setup.lifecycle.build(actor, { ...input, expectedRevision: 2 })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await setup.lifecycle.runBuild(actor, installation.id, operation.id);
    expect(setup.builds).toEqual([{ "extension.ts": "before" }]);
    const restarted = new ExtensionLifecycle(setup.dependencies);
    expect((await restarted.inspect(actor, installation.id)).operations[operation.id]?.state).toBe("verified");
  });

  test("cross-user and cross-scope state is inaccessible including approval and fork", async () => {
    const setup = await releaseFixture();
    for (const foreign of [{ ...actor, principalId: "other" }, { ...actor, scope: "project:two" }]) {
      await expect(setup.lifecycle.inspect(foreign, setup.installation.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(setup.lifecycle.createWorkspace(foreign, { installationId: setup.installation.id, releaseId: setup.releaseId })).rejects.toMatchObject({ code: "not_found" });
      expect(await setup.lifecycle.list(foreign)).toEqual([]);
    }
  });

  test("the builder cannot self-approve and stale approval cannot replace a generation", async () => {
    const setup = await releaseFixture();
    const pending = await setup.lifecycle.requestApproval(actor, { installationId: setup.installation.id, releaseId: setup.releaseId, grants: [], expectedActiveReleaseId: null });
    await expect(setup.lifecycle.approve(actor, setup.installation.id, pending.id, true)).rejects.toMatchObject({ code: "human_approval_required" });
    await expect(setup.lifecycle.activate(actor, { installationId: setup.installation.id, approvalId: pending.id, idempotencyKey: "self" })).rejects.toMatchObject({ code: "stale_approval" });
    const first = await approved(setup);
    await setup.lifecycle.approve(human, setup.installation.id, pending.id, true);
    expect((await setup.lifecycle.activate(actor, first)).state).toBe("active");
    expect((await setup.lifecycle.activate(actor, first)).state).toBe("active");
    expect(setup.published).toEqual([1]);
    await expect(setup.lifecycle.activate(actor, { ...first, approvalId: pending.id, idempotencyKey: "stale" })).rejects.toMatchObject({ code: "stale_approval" });
  });

  test("host candidate checks cannot be replaced by builder evidence", async () => {
    const setup = harness({ async verifyCandidate() { throw new LifecycleError("host_test_failed", "Host protocol check failed."); } });
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "console.log('PASS')" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "printed-pass" });
    const result = await setup.lifecycle.runBuild(actor, installation.id, operation.id);
    expect(result.state).toBe("failed");
    expect(result.diagnostics[0]?.code).toBe("host_test_failed");
    expect(Object.keys((await setup.lifecycle.inspect(actor, installation.id)).releases)).toHaveLength(0);
  });

  test("lost acknowledgement is durable and recovers without a second pointer switch", async () => {
    let failPublish = true;
    const setup = await releaseFixture(harness({ async publish() { if (failPublish) throw new Error("lost acknowledgement"); } }));
    const activation = await setup.lifecycle.activate(actor, await approved(setup));
    expect(activation.state).toBe("reconciling");
    let state = await setup.lifecycle.inspect(actor, setup.installation.id);
    expect(state.installation.generation).toBe(1);
    expect(state.installation.acknowledgedGeneration).toBe(0);
    failPublish = false;
    await new ExtensionLifecycle(setup.dependencies).recover(actor, setup.installation.id);
    state = await setup.lifecycle.inspect(actor, setup.installation.id);
    expect(state.installation.generation).toBe(1);
    expect(state.installation.acknowledgedGeneration).toBe(1);
    expect(state.operations[activation.id]?.state).toBe("active");
  });

  test("disable revokes pending approvals and uninstall retains source, releases, and user data", async () => {
    const setup = await releaseFixture();
    await database.exec("CREATE TABLE IF NOT EXISTS fixture_user_data (value TEXT); INSERT INTO fixture_user_data VALUES ('keep-me')");
    const pending = await approved(setup);
    await setup.lifecycle.disable(actor, setup.installation.id);
    await expect(setup.lifecycle.activate(actor, pending)).rejects.toMatchObject({ code: "stale_approval" });
    const fresh = await approved(setup, "fresh");
    expect((await setup.lifecycle.activate(actor, fresh)).state).toBe("active");
    await setup.lifecycle.uninstall(actor, setup.installation.id);
    const state = await setup.lifecycle.inspect(actor, setup.installation.id);
    expect(state.installation.uninstalled).toBe(true);
    expect(state.installation.enabled).toBe(false);
    expect(state.releases[setup.releaseId]).toBeDefined();
    expect((await setup.lifecycle.readWorkspace(actor, setup.installation.id, setup.workspace.id)).files["extension.ts"]).toBe("export default 1");
    expect((await database.query("SELECT value FROM fixture_user_data")).rows).toContainEqual({ value: "keep-me" });
  });

  test("rollback requires a fresh exact approval and keeps data", async () => {
    const setup = await releaseFixture();
    await setup.lifecycle.activate(actor, await approved(setup));
    const workspace = await setup.lifecycle.editWorkspace(actor, { installationId: setup.installation.id, workspaceId: setup.workspace.id, expectedRevision: 1, writes: { "extension.ts": "version-two" } });
    const operation = await setup.lifecycle.build(actor, { installationId: setup.installation.id, workspaceId: workspace.id, expectedRevision: 2, idempotencyKey: "build-two" });
    const built = await setup.lifecycle.runBuild(actor, setup.installation.id, operation.id);
    await setup.lifecycle.activate(actor, await approved({ ...setup, releaseId: built.releaseId! }, "activate-two"));
    const rollback = await approved(setup, "rollback");
    expect((await setup.lifecycle.rollback(actor, rollback)).state).toBe("active");
    expect((await setup.lifecycle.inspect(actor, setup.installation.id)).installation.activeReleaseId).toBe(setup.releaseId);
  });

  test("a revoked permission between candidate startup and commit blocks activation", async () => {
    let denied = false;
    const setup = await releaseFixture(harness({ async authorize(_actor, action) { if (action === "activate" && denied) throw new LifecycleError("permission_revoked", "Permission revoked."); } }));
    const input = await approved(setup);
    setup.dependencies.verifyCandidate = async () => { denied = true; };
    const result = await setup.lifecycle.activate(actor, input);
    expect(result.state).toBe("failed");
    expect((await setup.lifecycle.inspect(actor, setup.installation.id)).installation.activeReleaseId).toBeNull();
  });

  test("expired build holders cannot publish after another worker recovers", async () => {
    let now = 1_000;
    let unblock: () => void = () => {};
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const setup = harness({ now: () => now, leaseMs: 100 });
    const build = setup.dependencies.runner.build;
    let calls = 0;
    setup.dependencies.runner.build = async (request) => { calls += 1; if (calls === 1) await blocked; return build(request); };
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "one" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "lease" });
    const stale = setup.lifecycle.runBuild(actor, installation.id, operation.id);
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    now += 101;
    await new ExtensionLifecycle(setup.dependencies).recover(actor, installation.id);
    unblock();
    await stale;
    const state = await setup.lifecycle.inspect(actor, installation.id);
    expect(state.operations[operation.id]?.state).toBe("verified");
    expect(Object.keys(state.releases)).toHaveLength(1);
    expect(state.operations[operation.id]?.lease?.fence).toBe(2);
  });

  test("a transaction failure before pointer commit leaves the old active release", async () => {
    let failCommit = false;
    const faulty: LifecycleRepository = {
      create: (state) => repository.create(state), read: (id) => repository.read(id), list: (owner, scope) => repository.list(owner, scope),
      transact: (id, change) => repository.transact(id, async (state) => { const result = await change(state); if (failCommit && state.installation.status === "reconciling") throw new Error("database unavailable"); return result; }),
    };
    const setup = await releaseFixture(harness({ repository: faulty }));
    const input = await approved(setup);
    failCommit = true;
    expect((await setup.lifecycle.activate(actor, input)).state).toBe("failed");
    const state = await setup.lifecycle.inspect(actor, setup.installation.id);
    expect(state.installation.activeReleaseId).toBeNull();
    expect(state.approvals[input.approvalId]?.status).toBe("approved");
  });

  test("database refuses release mutation and record deletion", async () => {
    const setup = await releaseFixture();
    await expect(repository.transact(setup.installation.id, (state) => { state.releases[setup.releaseId]!.artifactDigest = "changed"; })).rejects.toMatchObject({ code: "immutable_release" });
    await expect(repository.transact(setup.installation.id, (state) => { delete state.releases[setup.releaseId]; })).rejects.toMatchObject({ code: "retention_required" });
  });

  test("an explicit host access policy permits admin approval without changing owner binding", async () => {
    const setup = await releaseFixture(harness({ async authorizeAccess(candidate) { if (!["owner", "admin"].includes(candidate.principalId)) throw new LifecycleError("not_found", "Installation not found."); } }));
    const approval = await setup.lifecycle.requestApproval(actor, { installationId: setup.installation.id, releaseId: setup.releaseId, grants: [], expectedActiveReleaseId: null });
    const result = await setup.lifecycle.approve({ principalId: "admin", scope: "global", kind: "human" }, setup.installation.id, approval.id, true);
    expect(result.principalId).toBe("owner");
    expect(result.scope).toBe("project:one");
    expect(result.approvedBy).toBe("admin");
  });

  test("policy drift invalidates previously approved releases", async () => {
    const setup = await releaseFixture();
    const input = await approved(setup);
    const changedPolicy = new ExtensionLifecycle({ ...setup.dependencies, buildLimits: { ...setup.dependencies.buildLimits, memoryBytes: 2048 } });
    await expect(changedPolicy.activate(actor, input)).rejects.toMatchObject({ code: "stale_approval" });
  });

  test("concurrent activation admits only one live lease", async () => {
    const setup = await releaseFixture();
    const first = await approved(setup, "first");
    const second = await approved(setup, "second");
    let started = false;
    let unblock: () => void = () => {};
    setup.dependencies.verifyCandidate = async () => { started = true; await new Promise<void>((resolve) => { unblock = resolve; }); };
    const running = setup.lifecycle.activate(actor, first);
    while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
    await expect(setup.lifecycle.activate(actor, second)).rejects.toMatchObject({ code: "activation_busy" });
    unblock();
    expect((await running).state).toBe("active");
    const state = await setup.lifecycle.inspect(actor, setup.installation.id);
    expect(state.installation.generation).toBe(1);
  });

  test("cancel fences a build that returns after cancellation", async () => {
    const setup = harness();
    const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "one" } });
    const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "cancel" });
    let started = false;
    let unblock: () => void = () => {};
    const build = setup.dependencies.runner.build;
    setup.dependencies.runner.build = async (input) => { started = true; await new Promise<void>((resolve) => { unblock = resolve; }); return build(input); };
    const running = setup.lifecycle.runBuild(actor, installation.id, operation.id);
    while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
    await setup.lifecycle.cancel(actor, installation.id, operation.id);
    unblock();
    expect((await running).state).toBe("cancelled");
    expect(Object.keys((await setup.lifecycle.inspect(actor, installation.id)).releases)).toHaveLength(0);
  });

  test("a lost database response after pointer commit resumes the durable outbox", async () => {
    let loseResponse = false;
    const faulty: LifecycleRepository = {
      create: (state) => repository.create(state), read: (id) => repository.read(id), list: (owner, scope) => repository.list(owner, scope),
      async transact(id, change) {
        const result = await repository.transact(id, change);
        if (loseResponse && (await repository.read(id))?.installation.status === "reconciling") { loseResponse = false; throw new Error("connection lost after commit"); }
        return result;
      },
    };
    const setup = await releaseFixture(harness({ repository: faulty }));
    const input = await approved(setup);
    loseResponse = true;
    expect((await setup.lifecycle.activate(actor, input)).state).toBe("reconciling");
    await new ExtensionLifecycle(setup.dependencies).recover(actor, setup.installation.id);
    const state = await setup.lifecycle.inspect(actor, setup.installation.id);
    expect(state.installation.generation).toBe(1);
    expect(state.installation.status).toBe("active");
  });

  test("queued builds survive closing and reopening the actual database", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "extension-db-restart-"));
    let persistent = new PGlite(storagePath);
    try {
      let driver = drizzle(persistent);
      await up(driver);
      const setup = harness({ repository: new DatabaseLifecycleRepository(driver) });
      const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "persisted" } });
      const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "restart" });
      await persistent.close();
      persistent = new PGlite(storagePath);
      driver = drizzle(persistent);
      const restarted = new ExtensionLifecycle({ ...setup.dependencies, repository: new DatabaseLifecycleRepository(driver) });
      await restarted.recover(actor, installation.id);
      const state = await restarted.inspect(actor, installation.id);
      expect(state.operations[operation.id]?.state).toBe("verified");
      expect(Object.keys(state.revisions)).toHaveLength(1);
    } finally { await persistent.close(); await rm(storagePath, { recursive: true, force: true }); }
  });
});

describe("host immutable blob store", () => {
  test("concurrent identical writes are content addressed and tampering fails", async () => {
    const bytes = new TextEncoder().encode(canonicalJson({ "file.ts": "one" }));
    const results = await Promise.all([blobs.put(bytes), blobs.put(bytes)]);
    expect(results[0]).toBe(results[1]);
    expect(await blobs.get(results[0]!)).toEqual(bytes);
    await expect(writeFile(join(root, results[0]!), "corrupt")).rejects.toThrow();
    await chmod(join(root, results[0]!), 0o600);
    await writeFile(join(root, results[0]!), "corrupt");
    await expect(blobs.get(results[0]!)).rejects.toMatchObject({ code: "artifact_corrupt" });
  });

  test("symlink objects and roots are refused", async () => {
    const target = join(root, "target");
    await writeFile(target, "secret");
    await symlink(target, join(root, "e".repeat(64)));
    await expect(blobs.get("e".repeat(64))).rejects.toThrow();
    const linkRoot = `${root}-link`;
    await symlink(root, linkRoot);
    try { await expect(new FileBlobStore(linkRoot).put(new Uint8Array())).rejects.toMatchObject({ code: "unsafe_blob_root" }); } finally { await rm(linkRoot); }
  });
});
