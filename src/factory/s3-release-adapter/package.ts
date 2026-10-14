import { filesDigest } from "@ezcorp/extension-runner";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { getProjectRoot } from "../../extensions/project-root";
import { stageFactoryGuestPackage } from "../guest-package-build";
import lock from "./lock.json" with { type: "json" };

/**
 * The reference S3 release adapter's staged files and its lock (W4H-28 P4).
 *
 * `lock.json` records the two identities the package has: the digest of the staged SOURCE (fast to
 * recompute, so a unit test catches any drift of these bytes) and the digest of the ARTIFACT the
 * product's isolated build produced from them in the pinned runner image (what the SDK's
 * `referenceS3ReleaseAdapter` names; a Podman integration test rebuilds and compares it). The guest
 * imports only the provided v4 SDK, so no factory-sdk change moves either digest.
 */

export const S3_RELEASE_ADAPTER_ENTRYPOINT = "extension.ts";

export interface S3ReleaseAdapterLock {
  readonly sourceDigest: string;
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
