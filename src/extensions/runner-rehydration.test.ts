import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import type { ReverseRpc, Runner, RunnerExecution, StartRequest, WorkspaceFiles } from "@ezcorp/extension-contract";
import { canonicalJson } from "@ezcorp/extension-contract";
import { executionLimits, filesDigest, PodmanRunner, RunnerError } from "@ezcorp/extension-runner";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import type { TransactionalDb } from "../db/migrations/types";
import { DatabaseLifecycleRepository, releaseNamesArtifact } from "../db/queries/extension-releases";
import { getReadiness, resetReadiness, setReadiness } from "../readiness";
import { FileBlobStore, putFiles } from "./v4/blobs";
import { LifecycleError, type BlobStore } from "./v4/types";
import { ArtifactUnrecoverableError, createRehydratingRunner, productExtensionRunner, RUNNER_ARTIFACT_REHYDRATED } from "./runner-rehydration";

/**
 * C05 "Rehydrate a missing runner artifact" (W4H-32). real-8: a kept installation's runner store lost the only
 * artifact of a release, and activation failed. The product keeps its own copy of every release artifact in its
 * blob store; the host plane restores it from there, checked, and retries once.
 */

const files: WorkspaceFiles = { "extension.js": "export {};", ".runner/recipe.json": "{}" };
const artifact = filesDigest(files);
const bytes = new TextEncoder().encode(canonicalJson(files));
const execution = { workerId: "worker" } as unknown as RunnerExecution;
const noReverse: ReverseRpc = async () => { throw new Error("unused"); };
const missing = () => new RunnerError("artifact_missing", "The release's artifact is not in this runner's store", "runner", false, { errorClass: "Error", errorCode: "ENOENT" });
const request = (workerId = "worker", artifactDigest = artifact) => ({ workerId, artifactDigest } as StartRequest);

/** A runner whose store starts without the artifact; restoreArtifact puts it there. Counts every call. */
function fakeRunner(options: { restore?: false | ((digest: string, given: WorkspaceFiles) => Promise<void>); alwaysMissing?: boolean } = {}) {
  const held = new Set<string>();
  const calls = { start: 0, collect: 0, restore: [] as [string, WorkspaceFiles][] };
  const runner: Runner = {
    build: async () => { throw new Error("unused"); },
    async start(input) { calls.start++; if (options.alwaysMissing || !held.has(input.artifactDigest)) throw missing(); return execution; },
    cancel: async () => {},
    inspect: async id => ({ id, state: "unknown", diagnostics: [] }),
    async collectArtifacts(digest) { calls.collect++; if (options.alwaysMissing || !held.has(digest)) throw missing(); return structuredClone(files); },
    ...(options.restore === false ? {} : {
      async restoreArtifact(digest: string, given: WorkspaceFiles) {
        calls.restore.push([digest, given]);
        if (options.restore) await options.restore(digest, given);
        held.add(digest);
      },
    }),
  };
  return { runner, calls, held };
}

/** The product's blob copy, with reads counted; `answer` replaces what a read returns. */
function fakeBlobs(answer: (digest: string) => Promise<Uint8Array> = async () => bytes) {
  const reads: string[] = [];
  const blobs: BlobStore = { put: async () => { throw new Error("unused"); }, async get(digest) { reads.push(digest); return answer(digest); } };
  return { blobs, reads };
}

function source(blobs: BlobStore, named = true) {
  const lookups: string[] = [];
  const rehydrated: string[] = [];
  return { lookups, rehydrated, source: { blobs, releaseNamesArtifact: async (digest: string) => { lookups.push(digest); return named; }, onRehydrated: (digest: string) => { rehydrated.push(digest); } } };
}

afterEach(() => { resetReadiness(); });

describe("rehydration of a missing runner artifact (W4H-32)", () => {
  test("a start that misses its artifact restores it from the product's blob copy, retries once, and succeeds", async () => {
    const { runner, calls } = fakeRunner();
    const { blobs, reads } = fakeBlobs();
    const { source: rehydration, lookups, rehydrated } = source(blobs);
    const wrapped = createRehydratingRunner(runner, rehydration);
    expect(await wrapped.start(request(), noReverse)).toBe(execution);
    expect(calls.start).toBe(2);
    expect(calls.restore).toEqual([[artifact, files]]);
    expect({ lookups, reads, rehydrated }).toEqual({ lookups: [artifact], reads: [artifact], rehydrated: [artifact] });
    // The store now holds it: the next start needs no rehydration.
    expect(await wrapped.start(request("worker-2"), noReverse)).toBe(execution);
    expect({ starts: calls.start, restores: calls.restore.length }).toEqual({ starts: 3, restores: 1 });
  });

  test("an artifact read that misses is restored the same way and answers the files", async () => {
    const { runner, calls } = fakeRunner();
    const { source: rehydration } = source(fakeBlobs().blobs);
    expect(await createRehydratingRunner(runner, rehydration).collectArtifacts(artifact)).toEqual(files);
    expect({ collect: calls.collect, restores: calls.restore.length }).toEqual({ collect: 2, restores: 1 });
  });

  test("by default a rehydration is a non-blocking readiness warning with its code, digest and count, never a message", async () => {
    setReadiness({ state: "ready" });
    const { runner, held } = fakeRunner();
    const wrapped = createRehydratingRunner(runner, { blobs: fakeBlobs().blobs, releaseNamesArtifact: async () => true });
    await wrapped.collectArtifacts(artifact);
    held.clear();
    await wrapped.collectArtifacts(artifact);
    const readiness = getReadiness();
    expect(readiness.state).toBe("ready");
    expect(readiness.warnings).toEqual([{ code: RUNNER_ARTIFACT_REHYDRATED, artifactDigest: artifact, count: 2 }]);
  });

  test("a digest no release record names is refused release_unknown before the blob copy is read", async () => {
    const { runner, calls } = fakeRunner();
    const { blobs, reads } = fakeBlobs();
    const { source: rehydration, rehydrated } = source(blobs, false);
    const refusal = await createRehydratingRunner(runner, rehydration).start(request(), noReverse).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ArtifactUnrecoverableError);
    expect(refusal).toMatchObject({ code: "artifact_unrecoverable", expectedDigest: artifact, reason: "release_unknown" });
    expect({ reads, restores: calls.restore.length, starts: calls.start, rehydrated }).toEqual({ reads: [], restores: 0, starts: 1, rehydrated: [] });
  });

  test("a missing blob copy is refused blob_missing, and nothing is restored or retried", async () => {
    const { runner, calls } = fakeRunner();
    const { source: rehydration } = source(fakeBlobs(async () => { throw new LifecycleError("artifact_missing", "One stored extension release blob is missing."); }).blobs);
    await expect(createRehydratingRunner(runner, rehydration).start(request(), noReverse)).rejects.toMatchObject({ code: "artifact_unrecoverable", expectedDigest: artifact, reason: "blob_missing" });
    expect({ restores: calls.restore.length, starts: calls.start }).toEqual({ restores: 0, starts: 1 });
  });

  test("blob bytes that do not hash to the digest are refused digest_mismatch and never reach the runner", async () => {
    const { runner, calls } = fakeRunner();
    const tampered = new TextEncoder().encode(canonicalJson({ ...files, "extension.js": "export const changed = 1;" }));
    const { source: rehydration } = source(fakeBlobs(async () => tampered).blobs);
    await expect(createRehydratingRunner(runner, rehydration).collectArtifacts(artifact)).rejects.toMatchObject({ code: "artifact_unrecoverable", expectedDigest: artifact, reason: "digest_mismatch" });
    expect({ restores: calls.restore.length, collect: calls.collect }).toEqual({ restores: 0, collect: 1 });
  });

  test("a blob store that reports corrupt content, or a runner that refuses the files, is digest_mismatch", async () => {
    const corrupt = source(fakeBlobs(async () => { throw new LifecycleError("artifact_corrupt", "Stored content does not match its digest."); }).blobs).source;
    await expect(createRehydratingRunner(fakeRunner().runner, corrupt).collectArtifacts(artifact)).rejects.toMatchObject({ reason: "digest_mismatch" });
    const refusing = fakeRunner({ restore: async () => { throw new RunnerError("artifact_corrupt", "Restored artifact digest mismatch"); } });
    await expect(createRehydratingRunner(refusing.runner, source(fakeBlobs().blobs).source).collectArtifacts(artifact)).rejects.toMatchObject({ reason: "digest_mismatch" });
  });

  test("a runner that cannot restore is refused runner_unsupported: one without the operation, and an older service that answers unknown_method", async () => {
    const without = fakeRunner({ restore: false });
    await expect(createRehydratingRunner(without.runner, source(fakeBlobs().blobs).source).start(request(), noReverse)).rejects.toMatchObject({ code: "artifact_unrecoverable", reason: "runner_unsupported" });
    const older = fakeRunner({ restore: async () => { throw new RunnerError("unknown_method", "Unknown runner endpoint"); } });
    await expect(createRehydratingRunner(older.runner, source(fakeBlobs().blobs).source).start(request(), noReverse)).rejects.toMatchObject({ reason: "runner_unsupported" });
  });

  test("the retry is exactly one: a runner that still misses after the restore answers its own refusal, with two calls in all", async () => {
    const { runner, calls } = fakeRunner({ alwaysMissing: true });
    await expect(createRehydratingRunner(runner, source(fakeBlobs().blobs).source).start(request(), noReverse)).rejects.toMatchObject({ code: "artifact_missing" });
    expect({ starts: calls.start, restores: calls.restore.length }).toEqual({ starts: 2, restores: 1 });
  });

  test("concurrent starts of one release join one rehydration", async () => {
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const { runner, calls } = fakeRunner({ restore: () => gate });
    const { blobs, reads } = fakeBlobs();
    const { source: rehydration, lookups, rehydrated } = source(blobs);
    const wrapped = createRehydratingRunner(runner, rehydration);
    const starts = Array.from({ length: 5 }, (_, index) => wrapped.start(request(`worker-${index}`), noReverse));
    while (calls.start < 5) await Bun.sleep(0);
    open();
    expect(await Promise.all(starts)).toEqual(Array(5).fill(execution));
    expect({ restores: calls.restore.length, lookups: lookups.length, reads: reads.length, rehydrated: rehydrated.length, starts: calls.start }).toEqual({ restores: 1, lookups: 1, reads: 1, rehydrated: 1, starts: 10 });
  });

  test("a failed rehydration is not remembered: the next miss tries again", async () => {
    let failures = 1;
    const { runner, calls } = fakeRunner({ restore: async () => { if (failures-- > 0) throw new RunnerError("runner_store_busy", "Another runner owns this artifact store"); } });
    const wrapped = createRehydratingRunner(runner, source(fakeBlobs().blobs).source);
    await expect(wrapped.collectArtifacts(artifact)).rejects.toMatchObject({ code: "runner_store_busy" });
    expect(await wrapped.collectArtifacts(artifact)).toEqual(files);
    expect(calls.restore).toHaveLength(2);
  });

  test("any other error passes through unchanged and starts no rehydration, including the blob store's own artifact_missing", async () => {
    const internal = new RunnerError("runner_internal_error", "Runner failed with an internal error", "runner", false, { errorClass: "Error", errorCode: "EACCES" });
    const lifecycleMissing = new LifecycleError("artifact_missing", "Stored extension files are missing.");
    for (const error of [internal, lifecycleMissing, new Error("plain")]) {
      const { runner, calls } = fakeRunner();
      runner.start = async () => { calls.start++; throw error; };
      const { source: rehydration, lookups } = source(fakeBlobs().blobs);
      await expect(createRehydratingRunner(runner, rehydration).start(request(), noReverse)).rejects.toBe(error);
      expect({ starts: calls.start, lookups: lookups.length, restores: calls.restore.length }).toEqual({ starts: 1, lookups: 0, restores: 0 });
    }
    const { runner } = fakeRunner();
    const blobFailure = new Error("disk unreadable");
    await expect(createRehydratingRunner(runner, source(fakeBlobs(async () => { throw blobFailure; }).blobs).source).start(request(), noReverse)).rejects.toBe(blobFailure);
  });

  test("every other runner operation is delegated as it is, and optional ones exist only when the runner has them", async () => {
    const seen: string[] = [];
    const full: Runner = {
      build: async input => { seen.push(`build:${input.operationId}`); return { operationId: input.operationId } as never; },
      start: async () => execution,
      attach: async input => { seen.push(`attach:${input.workerId}`); return execution; },
      cancel: async id => { seen.push(`cancel:${id}`); },
      abort: async id => { seen.push(`abort:${id}`); },
      inspect: async id => { seen.push(`inspect:${id}`); return { id, state: "running", diagnostics: [] }; },
      collectArtifacts: async () => files,
      capabilities: async () => ({ processSpawnEnforcement: true }),
      restoreArtifact: async () => { seen.push("restore"); },
    };
    const wrapped = createRehydratingRunner(full, source(fakeBlobs().blobs).source);
    expect(await wrapped.build({ operationId: "op" } as never)).toEqual({ operationId: "op" } as never);
    expect(await wrapped.attach!(request("attached"), noReverse)).toBe(execution);
    await wrapped.cancel("c");
    await wrapped.abort!("a");
    expect(await wrapped.inspect("i")).toEqual({ id: "i", state: "running", diagnostics: [] });
    expect(await wrapped.capabilities!()).toEqual({ processSpawnEnforcement: true });
    await wrapped.restoreArtifact!(artifact, files);
    expect(seen).toEqual(["build:op", "attach:attached", "cancel:c", "abort:a", "inspect:i", "restore"]);
    const bare = createRehydratingRunner(fakeRunner({ restore: false }).runner, source(fakeBlobs().blobs).source);
    expect({ attach: bare.attach, abort: bare.abort, capabilities: bare.capabilities, restoreArtifact: bare.restoreArtifact }).toEqual({ attach: undefined, abort: undefined, capabilities: undefined, restoreArtifact: undefined });
  });
});

describe("two boots on a kept installation whose runner store is fresh (W4H-32)", () => {
  let database: PGlite;
  let db: TransactionalDb;
  const roots: string[] = [];
  /** A real store; its kernel probe is a no-op, so a start runs up to the recipe check without Podman. */
  class StoreRunner extends PodmanRunner {
    put(digest: string, given: WorkspaceFiles) { return this.storeArtifact(digest, given); }
    protected override async probeSecurity(): Promise<void> {}
  }
  beforeAll(async () => {
    database = new PGlite({ extensions: { vector, pg_trgm } });
    await database.waitReady;
    db = drizzle(database, { schema }) as unknown as TransactionalDb;
    await migrate(db as never);
    const release = { id: "kept-release", installationId: "kept-installation", artifactDigest: artifact, sourceDigest: "0".repeat(64) };
    await new DatabaseLifecycleRepository(db).create({ installation: { id: "kept-installation", ownerId: "owner", scope: "global", generation: 1, enabled: true, uninstalled: false } as never, workspaces: {}, revisions: {}, operations: {}, releases: { [release.id]: release as never }, approvals: {} });
  });
  afterAll(async () => { await database.close(); for (const root of roots) await rm(root, { recursive: true, force: true }); });

  test("the release records name the artifact digests they hold, and no other", async () => {
    expect(await releaseNamesArtifact(db, artifact)).toBe(true);
    expect(await releaseNamesArtifact(db, "f".repeat(64))).toBe(false);
  });

  test("boot 1 builds into the store; the store is lost; boot 2 rehydrates lazily from the product's copy, warns once, and starts the worker", async () => {
    const installation = await mkdtemp(join(tmpdir(), "ez-kept-installation-"));
    roots.push(installation);
    const storeRoot = join(installation, "runner-store");
    const blobs = new FileBlobStore(join(installation, "extension-releases"));
    // Boot 1: the lifecycle's build stores the artifact in the runner's store and the product's copy in its blobs.
    await mkdir(join(storeRoot, "artifacts"), { recursive: true, mode: 0o700 });
    const first = new StoreRunner({ root: storeRoot });
    await first.put(artifact, files);
    expect(await putFiles(blobs, files, "artifact")).toBe(artifact);
    await first.close();
    // Between boots the runner store is removed (real-8: a cleanup deleted the store the release was built into).
    await rm(storeRoot, { recursive: true, force: true });
    // Boot 2: the same installation, a fresh store, a new process's runner.
    setReadiness({ state: "ready" });
    const second = new StoreRunner({ root: storeRoot });
    try {
      const product = productExtensionRunner(blobs, db, second);
      const deadline = Date.now() + 60_000;
      const start = { workerId: "kept-worker", artifactDigest: artifact, context: { invocationId: "kept-call", workerId: "kept-worker", releaseId: "kept-release", principalId: "owner", scopeId: "scope", token: "token", deadline }, limits: executionLimits, processSpawn: "deny" as const };
      // The fixture's recipe names no image, so the retried start stops at the profile check: past the artifact.
      await expect(product.start(start, noReverse)).rejects.toMatchObject({ code: "runtime_profile_changed" });
      expect(await second.collectArtifacts(artifact)).toEqual(files);
      expect(getReadiness().warnings).toEqual([{ code: RUNNER_ARTIFACT_REHYDRATED, artifactDigest: artifact, count: 1 }]);
      // A digest no release names is never restored, even when the blob store holds the bytes.
      const stray = { ...files, "extension.js": "export const stray = 1;" };
      await putFiles(blobs, stray, "artifact");
      await expect(product.collectArtifacts(filesDigest(stray))).rejects.toMatchObject({ code: "artifact_unrecoverable", reason: "release_unknown" });
    } finally { await second.close(); }
  });
});
