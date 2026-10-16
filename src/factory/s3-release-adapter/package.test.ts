import { expect, test } from "bun:test";
import { referenceS3ReleaseAdapter } from "@ezcorp/factory-sdk";
import { publish, S3_RELEASE_ADAPTER_EXPORT, S3_RELEASE_ADAPTER_MANIFEST, S3_RELEASE_ADAPTER_PACKAGE, S3_RELEASE_ADAPTER_VERSION } from "./guest";
import { S3_RELEASE_ADAPTER_LOCK, s3ReleaseAdapterFiles, s3ReleaseAdapterProvidedDigests, s3ReleaseAdapterSourceDigest } from "./package";

test("the staged source is the locked source", async () => {
  expect(await s3ReleaseAdapterSourceDigest()).toBe(S3_RELEASE_ADAPTER_LOCK.sourceDigest);
  expect(Object.keys(await s3ReleaseAdapterFiles()).sort()).toEqual(["extension.ts", "feature.test.ts"]);
});

test("the provided SDK bundle and toolchain are the locked ones: a change to either moves the artifact, so it goes red here first", async () => {
  expect(await s3ReleaseAdapterProvidedDigests()).toEqual({ sdkDigest: S3_RELEASE_ADAPTER_LOCK.sdkDigest, toolchainDigest: S3_RELEASE_ADAPTER_LOCK.toolchainDigest });
}, 60_000);

test("the SDK's reference S3 adapter names this package and its locked artifact", () => {
  expect(referenceS3ReleaseAdapter).toMatchObject({
    package: S3_RELEASE_ADAPTER_PACKAGE,
    manifestName: S3_RELEASE_ADAPTER_MANIFEST.name,
    version: S3_RELEASE_ADAPTER_VERSION,
    export: S3_RELEASE_ADAPTER_EXPORT,
    digest: S3_RELEASE_ADAPTER_LOCK.artifactDigest,
  });
});

test("a guest call never publishes", async () => {
  await expect(publish()).rejects.toThrow("factory_release_adapter_host_only");
});
