import { afterAll, beforeAll, expect, } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BuildResult, WorkspaceFiles } from "@ezcorp/extension-contract";
import { workspaceText } from "@ezcorp/extension-contract";
import { RunnerError } from "@ezcorp/extension-runner";
import { up } from "../../db/migrations/add-extension-releases";
import { DatabaseLifecycleRepository } from "../../db/queries/extension-releases";
import { canonicalJson, digestObject, FileBlobStore, getFiles, putFiles } from "../../extensions/v4/blobs";
import { ExtensionLifecycle, runnerBusyRetryMs } from "../../extensions/v4/lifecycle";
import { LifecycleError, type LifecycleActor, type LifecycleDependencies, type LifecycleRepository } from "../../extensions/v4/types";
import { createLifecycleRecoveryScheduler } from "../../extensions/lifecycle-recovery-scheduler";

export const actor: LifecycleActor = { principalId: "owner", scope: "project:one", kind: "agent" };

export const human: LifecycleActor = { ...actor, kind: "human" };

export let database: PGlite;

export let repository: DatabaseLifecycleRepository;

export let root: string;

export let blobs: FileBlobStore;

beforeAll(async () => {
  database = new PGlite();
  await database.exec("CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, target TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW())");
  const db = drizzle(database);
  await up(db);
  await up(db);
  repository = new DatabaseLifecycleRepository(db);
  root = await mkdtemp(join(tmpdir(), "extension-lifecycle-"));
  blobs = new FileBlobStore(root);
});

afterAll(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });

export function harness(overrides: Partial<LifecycleDependencies> = {}) {
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

export async function releaseFixture(setup = harness()) {
  const { installation, workspace } = await setup.lifecycle.createWorkspace(actor, { files: { "extension.ts": "export default 1", "src/nested.ts": "nested" } });
  const operation = await setup.lifecycle.build(actor, { installationId: installation.id, workspaceId: workspace.id, expectedRevision: 1, idempotencyKey: "build" });
  const result = await setup.lifecycle.runBuild(actor, installation.id, operation.id);
  expect(result.state).toBe("verified");
  return { ...setup, installation, workspace, operation: result, releaseId: result.releaseId! };
}

export async function approved(setup: Awaited<ReturnType<typeof releaseFixture>>, key = "activate") {
  const state = await setup.lifecycle.inspect(actor, setup.installation.id);
  const approval = await setup.lifecycle.requestApproval(actor, { installationId: setup.installation.id, releaseId: setup.releaseId, grants: ["storage:read"], expectedActiveReleaseId: state.installation.activeReleaseId });
  await setup.lifecycle.approve(human, setup.installation.id, approval.id, true);
  return { installationId: setup.installation.id, approvalId: approval.id, idempotencyKey: key };
}
export { PGlite, drizzle, chmod, mkdtemp, rm, symlink, writeFile, tmpdir, join, workspaceText, RunnerError, up, DatabaseLifecycleRepository, canonicalJson, digestObject, FileBlobStore, getFiles, putFiles, ExtensionLifecycle, runnerBusyRetryMs, LifecycleError, createLifecycleRecoveryScheduler };
export type { LifecycleRepository };
