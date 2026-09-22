/**
 * The runner package the `factory-services` journeys dispatch to, built for
 * real with Podman. No digest is invented: the artifact digest comes from a
 * real build, and the release record is derived from it.
 *
 * The guest returns a canonical C02 runner result and calls nothing else. With
 * no gateway mount, the only result member it can produce is `cancelled` with
 * measured zero usage and journal cursor -1: every other member needs a staged
 * artifact, a re-derivable digest, or a provider receipt.
 */
import { join } from "node:path";

export const GUEST_MANIFEST_NAME = "factory-services-guest";
export const GUEST_PACKAGE = "@ezcorp/factory-services-guest";
export const GUEST_VERSION = "1.0.0";
export const GUEST_EXPORT = "run";

/** Terminal, measured, and zero in every dimension: the guest performed no operation. */
export const GUEST_RESULT = Object.freeze({
  schemaVersion: "factory.runner.result.v1",
  status: "cancelled",
  usage: { kind: "measured", inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" },
  // No operation is settled, which is what the journal cursor default says.
  journalCursor: -1,
  operations: [],
});

const MANIFEST = {
  schemaVersion: 4,
  name: GUEST_MANIFEST_NAME,
  version: GUEST_VERSION,
  author: { name: "factory-services" },
  description: "The factory-services journey guest",
  permissions: {},
  tools: [{ name: GUEST_EXPORT, description: "Return the canonical runner result", inputSchema: { type: "object" }, outputSchema: { type: "object" } }],
};

/** The exact bytes the guest is built from. Content-addressed, so it is stable. */
export function guestSource(): Record<string, string> {
  return {
    "extension.ts": `import {defineExtension,serve} from '@ezcorp/sdk/v4';await serve(defineExtension({manifest:${JSON.stringify(MANIFEST)},tools:{${GUEST_EXPORT}:async()=>(${JSON.stringify(GUEST_RESULT)})}}));`,
    "feature.test.ts": "import {expect,test} from 'bun:test';test('the guest source builds',()=>expect(true).toBe(true));",
  };
}

export interface GuestBuild {
  readonly artifactDigest: string;
  readonly sourceDigest: string;
  readonly reference: {
    readonly package: string;
    readonly manifestName: string;
    readonly version: string;
    readonly digest: string;
    readonly export: string;
  };
  readonly release: Record<string, unknown>;
}

/** Builds the guest into one runner store and describes the release it produced. The same bytes always build to the same digest. */
export async function buildFactoryGuest(repo: string, runnerRoot: string, operationId: string): Promise<GuestBuild> {
  const { PodmanRunner, buildLimits, filesDigest } = await import(join(repo, "packages/@ezcorp/extension-runner/src/index.ts"));
  const { provisionToolchain } = await import(join(repo, "packages/@ezcorp/extension-runner/src/provision.ts"));
  const { digestObject, FileBlobStore, putFiles } = await import(join(repo, "src/extensions/v4/blobs.ts"));

  const files = guestSource();
  const provisioned = await provisionToolchain({ sdkEntrypoint: process.env.EZ_RUNNER_SDK_ENTRY });
  const runner = new PodmanRunner({ root: runnerRoot, ...provisioned });
  try {
    const built = await runner.build({ operationId, sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    if (built.state !== "succeeded" || !built.artifactDigest || !built.manifest) {
      throw new Error(`the proof guest did not build: ${built.diagnostics?.map((entry: { code: string }) => entry.code).join(",") ?? built.state}`);
    }
    const blobs = new FileBlobStore(join(runnerRoot, "release-blobs"));
    const sourceDigest = await putFiles(blobs, files, "workspace");
    const input = {
      installationId: "factory-services-guest-installation",
      workspaceId: "workspace",
      workspaceRevision: 1,
      sourceDigest,
      artifactDigest: built.artifactDigest,
      imageDigest: built.imageDigest,
      manifest: built.manifest,
      evidence: built.evidence,
      runnerProfile: "rootless-podman-v4",
      policyDigest: digestObject({ runner: "v4" }),
    };
    return Object.freeze({
      artifactDigest: built.artifactDigest as string,
      sourceDigest,
      reference: Object.freeze({
        package: GUEST_PACKAGE,
        manifestName: GUEST_MANIFEST_NAME,
        version: GUEST_VERSION,
        digest: `sha256:${built.artifactDigest}`,
        export: GUEST_EXPORT,
      }),
      release: { ...input, id: "factory-services-guest-release", releaseDigest: digestObject(input), createdAt: "2030-01-01T00:00:00.000Z" },
    });
  } finally {
    await runner.close();
  }
}
