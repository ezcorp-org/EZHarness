/**
 * Builds the W19a graph guest as one real v4 package, and installs it.
 *
 * Ported from the W09b/W01g real-server harness (`/tmp/factory-platform-evidence/
 * w09b/repro/guest-package.ts`, `w01g/repro/guest-package.ts`), which bind,
 * trust and prepare a runner package with the product's own production classes
 * and a real container build; nothing is seeded, and the preparation rebuilds
 * the same bytes and refuses unless the artifact digest matches.
 *
 * The guest's logic is `guest/graph-guest.ts`, the same file the in-process
 * suite imports. It is staged flat beside the SDK modules it reaches, with
 * its package specifiers rewritten for the flat guest workspace, so the guest
 * this harness ships is the guest that suite proves.
 */
import { join } from "node:path";
import { buildFactoryGuestHarnessRelease, stageFactoryGuestPackage } from "../../src/factory/guest-package-build";
import { GRAPH_GUEST_MANIFEST, GRAPH_GUEST_PACKAGE, GRAPH_GUEST_VERSION, type GraphGuestPackage } from "./graph";

const EXPORTS = ["prepare", "infer", "combine"] as const;

const MANIFEST = {
  schemaVersion: 4 as const,
  name: GRAPH_GUEST_MANIFEST,
  version: GRAPH_GUEST_VERSION,
  author: { name: "w19a-proof" },
  description: "The W19a graph guest: prepare, infer through the broker, combine",
  permissions: {},
  tools: EXPORTS.map(name => ({ name, description: `The graph's ${name} task`, inputSchema: { type: "object" }, outputSchema: { type: "object" } })),
};

/** Package specifiers rewritten to the flat files that carry them. */
const SPECIFIERS = Object.freeze({
  "@ezcorp/factory-sdk/canonical": "./canonical.ts",
  "@ezcorp/factory-sdk/guest-materials": "./guest-materials.ts",
  "@ezcorp/factory-sdk/guest-model": "./guest-model.ts",
  "@ezcorp/factory-sdk": "./types.ts",
});

/** The exact bytes the guest is built from, through the product's one guest-package builder. */
export async function graphGuestSource(repo: string): Promise<Record<string, string>> {
  const generated: Record<string, string> = {};
  generated["extension.ts"] = `import { defineExtension, serve } from '@ezcorp/sdk/v4';
import { combine, infer, prepare } from './graph-guest.ts';
import type { FactoryRunnerRequest } from './types.ts';

const manifest = { ...${JSON.stringify(MANIFEST)}, schemaVersion: 4 as const };

interface GuestContext { call(method: string, value: unknown): Promise<unknown> }

/** Each export gets the guest's one reverse capability and nothing else. */
const task = (run: typeof prepare) => async (input: unknown, context: GuestContext) =>
  run(input as FactoryRunnerRequest, async (payload) => context.call('factory.broker', payload));

await serve(defineExtension({ manifest, tools: { prepare: task(prepare), infer: task(infer), combine: task(combine) } }));
`;
  generated["feature.test.ts"] = `import { expect, test } from 'bun:test';
import { combineSummary, inferMessages, prepareOutput } from './graph-guest.ts';

test('the staged guest carries the graph logic the harness recomputes', () => {
  expect(prepareOutput('  the primary  colours ')).toEqual({ text: 'the primary colours', count: 3 });
  expect(inferMessages('x')).toHaveLength(2);
  expect(combineSummary(3, 'y')).toBe('3 words in; the model said: y');
});
`;
  // The SDK files come from the imports themselves: whatever the guest's own files reach, and whatever
  // those reach, schemas included. A module the SDK gains is staged as soon as something imports it.
  return await stageFactoryGuestPackage(repo, { sources: { "graph-guest.ts": "scripts/factory-graph-proof/guest/graph-guest.ts" }, specifiers: SPECIFIERS, provided: new Set(), generated }) as Record<string, string>;
}

export interface GraphGuestBuild {
  readonly artifactDigest: string;
  readonly sourceDigest: string;
  readonly guest: GraphGuestPackage;
  readonly release: Record<string, unknown>;
}

/** Builds the guest into one runner store and describes the release it produced. */
export async function buildGraphGuest(repo: string, runnerRoot: string, operationId: string): Promise<GraphGuestBuild> {
  const files = await graphGuestSource(repo);
  const { PodmanRunner, buildLimits } = await import(join(repo, "packages/@ezcorp/extension-runner/src/index.ts"));
  const { provisionToolchain } = await import(join(repo, "packages/@ezcorp/extension-runner/src/provision.ts"));
  const { FileBlobStore } = await import(join(repo, "src/extensions/v4/blobs.ts"));
  const runner = new PodmanRunner({ root: runnerRoot, ...await provisionToolchain({ sdkEntrypoint: process.env.EZ_RUNNER_SDK_ENTRY }) });
  try {
    const { build, sourceDigest, release } = await buildFactoryGuestHarnessRelease({
      runner, blobs: new FileBlobStore(join(runnerRoot, "release-blobs")), files, operationId, limits: buildLimits,
      installationId: "w19a-guest-installation", releaseId: "w19a-guest-release",
    });
    return Object.freeze({
      artifactDigest: build.artifactDigest,
      sourceDigest,
      guest: Object.freeze({ package: GRAPH_GUEST_PACKAGE, manifestName: GRAPH_GUEST_MANIFEST, version: GRAPH_GUEST_VERSION, digest: `sha256:${build.artifactDigest}` }),
      release,
    });
  } finally {
    await runner.close();
  }
}

/**
 * Binds, trusts and prepares each runner reference against the product database.
 *
 * Every write goes through the production class that owns it, under the
 * administrator the proof created over HTTP. No product route binds or trusts
 * a runner package yet (W02), which the record states as a harness-supplied
 * deployment fact. The preparation goes through the product runner, which
 * restores the release's artifact copy from the release blobs into the fresh
 * preparation store (C05 "Prepare a release built outside the lifecycle",
 * W4H-32), and refuses unless the artifact digest matches the binding.
 */
export async function installGraphGuest(options: {
  readonly repo: string;
  readonly database: unknown;
  readonly tenantId: string;
  readonly projectId: string;
  readonly adminId: string;
  readonly runnerRoot: string;
  readonly releaseBlobRoot: string;
  readonly build: GraphGuestBuild;
  readonly references: readonly Record<string, unknown>[];
}): Promise<ReadonlyArray<{ readonly reference: Record<string, unknown>; readonly trustRevision: number; readonly receiptDigest: string }>> {
  const { repo, build } = options;
  const { DatabaseLifecycleRepository } = await import(join(repo, "src/db/queries/extension-releases.ts"));
  const { FileBlobStore } = await import(join(repo, "src/extensions/v4/blobs.ts"));
  const { FactoryGrants } = await import(join(repo, "src/factory/grants.ts"));
  const { FactoryPackagePreparations, FactoryPackageTrusts, FactoryV4PackageCatalog } = await import(join(repo, "src/factory/package-preparation.ts"));
  const { PodmanRunner, buildLimits } = await import(join(repo, "packages/@ezcorp/extension-runner/src/index.ts"));
  const { provisionToolchain } = await import(join(repo, "packages/@ezcorp/extension-runner/src/provision.ts"));
  const { productExtensionRunner } = await import(join(repo, "src/extensions/runner-rehydration.ts"));

  const db = options.database as never;
  const admin = { kind: "user" as const, id: options.adminId, authentication: "session" as const };
  const runner = new PodmanRunner({ root: options.runnerRoot, ...await provisionToolchain({ sdkEntrypoint: process.env.EZ_RUNNER_SDK_ENTRY }) });
  try {
    const grants = new FactoryGrants(db, options.tenantId);
    // Project creation issues author, publish, run and operate, never
    // `factory.trust`; an operator issues it deliberately, so the harness does.
    await grants.set(admin, { projectId: options.projectId, principal: admin, action: "factory.trust", expectedRevision: 0, expiresAtMs: null });
    const repository = new DatabaseLifecycleRepository(db);
    const release = build.release as { id: string; installationId: string };
    await repository.create({
      installation: { id: release.installationId, ownerId: options.adminId, scope: `project:${options.projectId}`, generation: 1, activeReleaseId: release.id, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 },
      workspaces: {}, revisions: {}, operations: {}, releases: { [release.id]: build.release }, approvals: {},
    });
    const trusts = new FactoryPackageTrusts(db, options.tenantId, grants);
    const blobs = new FileBlobStore(options.releaseBlobRoot);
    const preparations = new FactoryPackagePreparations(db, options.tenantId, grants, trusts, new FactoryV4PackageCatalog(repository, blobs), productExtensionRunner(blobs, db, runner), buildLimits);
    const installed: Array<{ reference: Record<string, unknown>; trustRevision: number; receiptDigest: string }> = [];
    for (const [index, reference] of options.references.entries()) {
      await preparations.bind(admin, { projectId: options.projectId, reference, installationId: release.installationId, releaseId: release.id }, `w19a-bind-${index}`);
      await trusts.publish(admin, { projectId: options.projectId, reference, expectedRevision: 0 }, `w19a-trust-${index}`);
      const receipt = await preparations.prepare(options.projectId, reference) as { trustRevision: number; receiptDigest: string };
      installed.push({ reference, trustRevision: receipt.trustRevision, receiptDigest: receipt.receiptDigest });
    }
    return installed;
  } finally {
    await runner.close();
  }
}
