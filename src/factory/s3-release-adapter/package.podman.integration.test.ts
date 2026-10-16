import { expect, test } from "bun:test";
import { DEFAULT_IMAGE } from "@ezcorp/extension-runner";
import { referenceS3ReleaseAdapter } from "@ezcorp/factory-sdk";
import { S3_RELEASE_ADAPTER_LOCK } from "./package";
import { buildS3ReleaseAdapterLock } from "./relock";

/**
 * The lock's artifact digest is a real build's, not a literal someone typed: the product's isolated
 * build, in the pinned runner image, turns the locked source, SDK bundle and toolchain into exactly
 * the artifact the SDK's reference S3 adapter names (the same build the re-lock script runs).
 */
test("the pinned image builds the locked source into the artifact the SDK names", async () => {
  expect(S3_RELEASE_ADAPTER_LOCK.image).toBe(DEFAULT_IMAGE);
  expect(await buildS3ReleaseAdapterLock()).toEqual(S3_RELEASE_ADAPTER_LOCK);
  expect(referenceS3ReleaseAdapter.digest).toBe(S3_RELEASE_ADAPTER_LOCK.artifactDigest);
}, 600_000);
