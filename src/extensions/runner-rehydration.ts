/**
 * C05 "Rehydrate a missing runner artifact" (W4H-32).
 *
 * real-8: a kept installation kept its database and its release blobs, but not the runner store a cleanup had
 * removed, so the only artifact of a release was gone and activation failed. The product keeps its own copy of every
 * release artifact in its blob store, keyed by the artifact digest. When the runner answers `artifact_missing`, this
 * wrapper restores that copy into the runner's store and sends the operation again, once.
 *
 * Three checks come before any byte reaches the runner: a release record names the digest (nothing else is ever
 * restored), the blob bytes hash to it (`getFiles`), and the runner hashes the files again before it stores them.
 * Any failure is the named refusal `artifact_unrecoverable`; nothing falls back and nothing is rebuilt here.
 *
 * The retry is safe: the runner refuses a start for a missing artifact before it registers the worker, so the
 * second start is the first one that can have an effect.
 */
import type { Runner, WorkspaceFiles } from "@ezcorp/extension-contract";
import { RunnerError } from "@ezcorp/extension-runner";
import type { MigrationDb } from "../db/migrations/types";
import { releaseNamesArtifact } from "../db/queries/extension-releases";
import { recordReadinessWarning } from "../readiness";
import { createLazyExtensionRunner } from "./runner-connection";
import { getFiles } from "./v4/blobs";
import { LifecycleError, type BlobStore } from "./v4/types";

/** The readiness warning code of one rehydration. */
export const RUNNER_ARTIFACT_REHYDRATED = "runner_artifact_rehydrated";

export type ArtifactUnrecoverableReason = "release_unknown" | "blob_missing" | "digest_mismatch" | "runner_unsupported";

/** The named refusal when a missing runner artifact cannot be restored from the product's own copy. */
export class ArtifactUnrecoverableError extends LifecycleError {
  constructor(readonly expectedDigest: string, readonly reason: ArtifactUnrecoverableReason) {
    super("artifact_unrecoverable", `The runner's copy of release artifact ${expectedDigest} is missing and cannot be restored (${reason}).`);
    this.name = "ArtifactUnrecoverableError";
  }
}

export interface RunnerRehydrationSource {
  /** The product's release blob store: the only source a runner artifact is restored from. */
  readonly blobs: BlobStore;
  /** Whether a release record names the digest. */
  releaseNamesArtifact(artifactDigest: string): Promise<boolean>;
  /** Told once per rehydration. Default: a non-blocking readiness warning. */
  onRehydrated?(artifactDigest: string): void;
}

/** One rehydration per artifact digest in this process; every concurrent miss joins it. */
const rehydrating = new Map<string, Promise<void>>();

function isCode(error: unknown, type: typeof RunnerError | typeof LifecycleError, code: string): boolean {
  return error instanceof type && error.code === code;
}

async function readCopy(source: RunnerRehydrationSource, artifactDigest: string): Promise<WorkspaceFiles> {
  try { return await getFiles(source.blobs, artifactDigest, "artifact"); }
  catch (error) {
    if (isCode(error, LifecycleError, "artifact_missing")) throw new ArtifactUnrecoverableError(artifactDigest, "blob_missing");
    if (isCode(error, LifecycleError, "artifact_corrupt")) throw new ArtifactUnrecoverableError(artifactDigest, "digest_mismatch");
    throw error;
  }
}

async function restore(inner: Runner, source: RunnerRehydrationSource, artifactDigest: string): Promise<void> {
  if (!await source.releaseNamesArtifact(artifactDigest)) throw new ArtifactUnrecoverableError(artifactDigest, "release_unknown");
  const files = await readCopy(source, artifactDigest);
  if (!inner.restoreArtifact) throw new ArtifactUnrecoverableError(artifactDigest, "runner_unsupported");
  try { await inner.restoreArtifact(artifactDigest, files); }
  catch (error) {
    if (isCode(error, RunnerError, "unknown_method")) throw new ArtifactUnrecoverableError(artifactDigest, "runner_unsupported");
    if (isCode(error, RunnerError, "artifact_corrupt")) throw new ArtifactUnrecoverableError(artifactDigest, "digest_mismatch");
    throw error;
  }
  (source.onRehydrated ?? (digest => recordReadinessWarning({ code: RUNNER_ARTIFACT_REHYDRATED, artifactDigest: digest })))(artifactDigest);
}

function rehydrate(inner: Runner, source: RunnerRehydrationSource, artifactDigest: string): Promise<void> {
  let pending = rehydrating.get(artifactDigest);
  if (!pending) {
    pending = restore(inner, source, artifactDigest).finally(() => { rehydrating.delete(artifactDigest); });
    rehydrating.set(artifactDigest, pending);
  }
  return pending;
}

/** `inner` with every operation that reads a release's artifact rehydrated once on the runner's `artifact_missing`. */
export function createRehydratingRunner(inner: Runner, source: RunnerRehydrationSource): Runner {
  async function once<T>(artifactDigest: string, operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (!isCode(error, RunnerError, "artifact_missing")) throw error;
      await rehydrate(inner, source, artifactDigest);
      return operation();
    }
  }
  return {
    build: input => inner.build(input),
    start: (input, reverseRpc) => once(input.artifactDigest, () => inner.start(input, reverseRpc)),
    ...(inner.attach ? { attach: (input, reverseRpc) => inner.attach!(input, reverseRpc) } : {}),
    cancel: id => inner.cancel(id),
    ...(inner.abort ? { abort: id => inner.abort!(id) } : {}),
    inspect: id => inner.inspect(id),
    collectArtifacts: artifactDigest => once(artifactDigest, () => inner.collectArtifacts(artifactDigest)),
    ...(inner.capabilities ? { capabilities: () => inner.capabilities!() } : {}),
    ...(inner.restoreArtifact ? { restoreArtifact: (artifactDigest, files) => inner.restoreArtifact!(artifactDigest, files) } : {}),
  };
}

/** The product's extension runner: the configured runner, rehydrated from the release blobs the lifecycle writes. */
export function productExtensionRunner(blobs: BlobStore, database: Pick<MigrationDb, "execute">, inner: Runner = createLazyExtensionRunner()): Runner {
  return createRehydratingRunner(inner, { blobs, releaseNamesArtifact: artifactDigest => releaseNamesArtifact(database, artifactDigest) });
}
