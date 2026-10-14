import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLimits, DEFAULT_IMAGE, filesDigest, PodmanRunner } from "@ezcorp/extension-runner";
import { referenceS3ReleaseAdapter } from "@ezcorp/factory-sdk";
import { provision } from "../../../packages/@ezcorp/extension-runner/tests/helpers";
import { S3_RELEASE_ADAPTER_ENTRYPOINT, S3_RELEASE_ADAPTER_LOCK, s3ReleaseAdapterFiles } from "./package";

/**
 * The lock's artifact digest is a real build's, not a literal someone typed: the product's isolated
 * build, in the pinned runner image, turns the locked source into exactly the artifact the SDK's
 * reference S3 adapter names.
 */
test("the pinned image builds the locked source into the artifact the SDK names", async () => {
  const root = await mkdtemp(join(tmpdir(), "s3-release-adapter-"));
  const runner = new PodmanRunner({ root, ...await provision() });
  try {
    const files = await s3ReleaseAdapterFiles();
    const build = await runner.build({ operationId: "s3-release-adapter-build", sourceDigest: filesDigest(files), files, entrypoint: S3_RELEASE_ADAPTER_ENTRYPOINT, limits: buildLimits });
    expect(build.state).toBe("succeeded");
    expect(S3_RELEASE_ADAPTER_LOCK.image).toBe(DEFAULT_IMAGE);
    expect(`sha256:${build.artifactDigest}`).toBe(S3_RELEASE_ADAPTER_LOCK.artifactDigest);
    expect(referenceS3ReleaseAdapter.digest).toBe(S3_RELEASE_ADAPTER_LOCK.artifactDigest);
  } finally {
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
}, 600_000);
