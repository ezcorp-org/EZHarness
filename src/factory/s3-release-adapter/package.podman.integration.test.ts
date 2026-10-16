import { expect, test } from "bun:test";
import { DEFAULT_IMAGE, filesDigest } from "@ezcorp/extension-runner";
import { referenceS3ReleaseAdapter } from "@ezcorp/factory-sdk";
import { S3_RELEASE_ADAPTER_LOCK } from "./package";
import { buildS3ReleaseAdapter, podmanBuilder, type S3ReleaseAdapterBuilder } from "./relock";

/**
 * The lock's artifact digest is a real build's, not a literal someone typed: the product's isolated
 * build, in the pinned runner image, turns the locked source, SDK bundle and toolchain into exactly
 * the artifact the SDK's reference S3 adapter names (the same build the re-lock script runs).
 */
test("the pinned image builds the locked source into the artifact the SDK names", async () => {
  const { result, lock } = await buildS3ReleaseAdapter();
  // Checked on its own, apart from the lock: a helper that stopped refusing a failed build cannot hide one here.
  expect(result.state).toBe("succeeded");
  expect(result.imageDigest).toBe(DEFAULT_IMAGE);
  expect(S3_RELEASE_ADAPTER_LOCK.image).toBe(DEFAULT_IMAGE);
  expect(lock).toEqual(S3_RELEASE_ADAPTER_LOCK);
  expect(referenceS3ReleaseAdapter.digest).toBe(S3_RELEASE_ADAPTER_LOCK.artifactDigest);
}, 600_000);

/** The real Podman build, with the adapter's feature test replaced by one that fails. */
const failingFeatureTest = async (root: string): Promise<S3ReleaseAdapterBuilder> => {
  const real = await podmanBuilder(root);
  return {
    build: input => {
      const files = { ...input.files, "feature.test.ts": 'import { expect, test } from "bun:test";\ntest("planted", () => { expect(1).toBe(2); });\n' };
      return real.build({ ...input, files, sourceDigest: filesDigest(files) });
    },
    close: () => real.close(),
  };
};

test("a build that fails in the pinned image is refused by name, never turned into a lock", async () => {
  await expect(buildS3ReleaseAdapter(failingFeatureTest)).rejects.toThrow("the S3 release adapter did not build");
}, 600_000);
