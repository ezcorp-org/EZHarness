import { filesDigest, provisionToolchain } from "@ezcorp/extension-runner";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { getProjectRoot } from "../../extensions/project-root";
import { stageFactoryGuestPackage } from "../guest-package-build";
import lock from "./lock.json" with { type: "json" };

/**
 * The reference S3 release adapter's staged files and its lock (W4H-28 P4; re-locked after ruling A+B).
 *
 * `lock.json` records every input of the ARTIFACT the product's isolated build produces in the pinned runner image
 * (what the SDK's `referenceS3ReleaseAdapter` names): the staged SOURCE, the provided SDK bundle (the sdk and
 * extension-contract packages, embedded in every v4 artifact) and the provided TOOLCHAIN, plus the image. A change to
 * any of them moves the artifact digest: a platform change to the sdk or extension-contract package does too. The fast
 * unit test recomputes the source, SDK and toolchain digests, so such a change goes red in its own commit; the Podman
 * test rebuilds the artifact. `bun scripts/relock-s3-release-adapter.ts` re-locks this file and the SDK literal.
 */

export const S3_RELEASE_ADAPTER_ENTRYPOINT = "extension.ts";

export interface S3ReleaseAdapterLock {
  readonly sourceDigest: string;
  readonly sdkDigest: string;
  readonly toolchainDigest: string;
  readonly artifactDigest: string;
  readonly image: string;
}

export const S3_RELEASE_ADAPTER_LOCK: S3ReleaseAdapterLock = Object.freeze({ ...lock });

const FEATURE_TEST = [
  'import { expect, test } from "bun:test";',
  'import { publish } from "./extension.ts";',
  "",
  'test("the adapter never publishes from a guest", async () => {',
  '  await expect(publish()).rejects.toThrow("factory_release_adapter_host_only");',
  "});",
  "",
].join("\n");

/** The exact files the adapter package is built from. */
export async function s3ReleaseAdapterFiles(): Promise<WorkspaceFiles> {
  return stageFactoryGuestPackage(getProjectRoot(), {
    sources: { [S3_RELEASE_ADAPTER_ENTRYPOINT]: "src/factory/s3-release-adapter/guest.ts" },
    specifiers: {},
    provided: new Set(["@ezcorp/sdk/v4"]),
    generated: { "feature.test.ts": FEATURE_TEST },
  });
}

/** The staged source's digest, as the lock records it. */
export async function s3ReleaseAdapterSourceDigest(): Promise<string> {
  return `sha256:${filesDigest(await s3ReleaseAdapterFiles())}`;
}

/** The digests of the provided SDK bundle and toolchain every build of this adapter embeds (fast: no container). */
export async function s3ReleaseAdapterProvidedDigests(): Promise<{ sdkDigest: string; toolchainDigest: string }> {
  const { sdkFiles, toolchainFiles } = await provisionToolchain();
  return { sdkDigest: `sha256:${filesDigest(sdkFiles)}`, toolchainDigest: `sha256:${filesDigest(toolchainFiles)}` };
}
