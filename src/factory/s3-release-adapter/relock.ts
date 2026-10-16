import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "@ezcorp/extension-contract";
import { buildLimits, DEFAULT_IMAGE, filesDigest, PodmanRunner, provisionToolchain } from "@ezcorp/extension-runner";
import { S3_RELEASE_ADAPTER_ENTRYPOINT, s3ReleaseAdapterFiles, s3ReleaseAdapterProvidedDigests, type S3ReleaseAdapterLock } from "./package";

/**
 * Re-locking the reference S3 release adapter (W4H-28, ruling A): one command rebuilds the adapter in the pinned image
 * and writes every digest the lock records into `lock.json` and the one SDK literal that names the artifact.
 */
export const S3_RELEASE_ADAPTER_LOCK_PATH = "src/factory/s3-release-adapter/lock.json";
export const S3_RELEASE_ADAPTER_SDK_PATH = "packages/@ezcorp/factory-sdk/src/references.ts";

export class S3ReleaseAdapterRelockError extends Error {
  constructor(readonly code: "relock_dirty_tree" | "relock_sdk_literal_not_found", message: string) {
    super(message);
    this.name = "S3ReleaseAdapterRelockError";
  }
}

export interface S3ReleaseAdapterRelockDependencies {
  /** True only when the working tree has no change: a re-lock must describe committed bytes. */
  clean(): Promise<boolean>;
  build(): Promise<S3ReleaseAdapterLock>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

/** What builds the adapter: the product's Podman runner by default (a test may pass another). */
export type S3ReleaseAdapterBuilder = Pick<Runner, "build"> & { close(): Promise<void> };
const podmanBuilder = async (root: string): Promise<S3ReleaseAdapterBuilder> => new PodmanRunner({ root, ...await provisionToolchain() });

/** The lock a build in the pinned image gives now: the source, the provided SDK and toolchain, and the artifact. */
export async function buildS3ReleaseAdapterLock(open: (root: string) => Promise<S3ReleaseAdapterBuilder> = podmanBuilder): Promise<S3ReleaseAdapterLock> {
  const root = await mkdtemp(join(tmpdir(), "s3-release-adapter-"));
  const runner = await open(root);
  try {
    const files = await s3ReleaseAdapterFiles();
    const build = await runner.build({ operationId: "s3-release-adapter-build", sourceDigest: filesDigest(files), files, entrypoint: S3_RELEASE_ADAPTER_ENTRYPOINT, limits: buildLimits });
    if (build.state !== "succeeded") throw new Error(`the S3 release adapter did not build: ${JSON.stringify(build.diagnostics)}`);
    return { sourceDigest: `sha256:${filesDigest(files)}`, ...await s3ReleaseAdapterProvidedDigests(), artifactDigest: `sha256:${build.artifactDigest}`, image: DEFAULT_IMAGE };
  } finally {
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Rebuilds, then writes the lock and the SDK literal; returns the old and the new lock. A dirty tree is refused first. */
export async function relockS3ReleaseAdapter(dependencies: S3ReleaseAdapterRelockDependencies): Promise<{ old: S3ReleaseAdapterLock; next: S3ReleaseAdapterLock }> {
  if (!await dependencies.clean()) throw new S3ReleaseAdapterRelockError("relock_dirty_tree", "Commit or stash every change first: a lock must describe committed bytes.");
  const old = JSON.parse(await dependencies.read(S3_RELEASE_ADAPTER_LOCK_PATH)) as S3ReleaseAdapterLock;
  const sdk = await dependencies.read(S3_RELEASE_ADAPTER_SDK_PATH);
  const literal = `digest: "${old.artifactDigest}",`;
  if (sdk.split(literal).length !== 2) throw new S3ReleaseAdapterRelockError("relock_sdk_literal_not_found", `${S3_RELEASE_ADAPTER_SDK_PATH} does not name ${old.artifactDigest} exactly once.`);
  const next = await dependencies.build();
  await dependencies.write(S3_RELEASE_ADAPTER_LOCK_PATH, `${JSON.stringify(next, null, 2)}\n`);
  await dependencies.write(S3_RELEASE_ADAPTER_SDK_PATH, sdk.replace(literal, `digest: "${next.artifactDigest}",`));
  return { old, next };
}
