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

/** The import closure of `graph-guest.ts` inside the SDK: `guest-materials.ts` and what it reaches. */
const SDK_MODULES = ["guest-materials.ts", "canonical.ts", "page-bytes.ts", "validation.ts", "schema.ts", "types.ts", "api.ts", "expressions.ts"];
const SDK_SCHEMAS = [
  "factory-guest-material-request.schema.json", "factory-guest-material-response.schema.json",
  "factory-runner-request.schema.json", "factory-runner-result.schema.json",
  "factory-api-request.schema.json", "factory-api-response.schema.json",
  "compiled-factory.schema.json", "compiled-execution-manifest.schema.json",
  "compiled-partition-artifact.schema.json", "factory-definition.schema.json",
  "factory-durable-input.schema.json", "factory-guest-model-request.schema.json",
  "factory-guest-model-response.schema.json", "factory-validator-claims.schema.json",
  "factory-validator-report.schema.json",
];

/** Package specifiers rewritten to the flat files that carry them. */
const FLAT = [
  [/from "@ezcorp\/factory-sdk\/canonical"/g, 'from "./canonical.ts"'],
  [/from "@ezcorp\/factory-sdk\/guest-materials"/g, 'from "./guest-materials.ts"'],
  [/from "@ezcorp\/factory-sdk"/g, 'from "./types.ts"'],
] as const;

/** The exact bytes the guest is built from. */
export async function graphGuestSource(repo: string): Promise<Record<string, string>> {
  const sdk = join(repo, "packages/@ezcorp/factory-sdk/src");
  const files: Record<string, string> = {};
  for (const name of SDK_MODULES) files[name] = (await Bun.file(join(sdk, name)).text()).replaceAll(/from "\.\/([a-z-]+)\.js"/g, 'from "./$1.ts"');
  for (const name of SDK_SCHEMAS) files[name] = await Bun.file(join(sdk, name)).text();
  let guest = await Bun.file(join(repo, "scripts/factory-graph-proof/guest/graph-guest.ts")).text();
  for (const [pattern, flat] of FLAT) guest = guest.replaceAll(pattern, flat);
  files["graph-guest.ts"] = guest;
  files["extension.ts"] = `import { defineExtension, serve } from '@ezcorp/sdk/v4';
import { combine, infer, prepare } from './graph-guest.ts';
import type { FactoryRunnerRequest } from './types.ts';

const manifest = { ...${JSON.stringify(MANIFEST)}, schemaVersion: 4 as const };

interface GuestContext { call(method: string, value: unknown): Promise<unknown> }

/** Each export gets the guest's one reverse capability and nothing else. */
const task = (run: typeof prepare) => async (input: unknown, context: GuestContext) =>
  run(input as FactoryRunnerRequest, async (payload) => context.call('factory.broker', payload));

await serve(defineExtension({ manifest, tools: { prepare: task(prepare), infer: task(infer), combine: task(combine) } }));
`;
  files["feature.test.ts"] = `import { expect, test } from 'bun:test';
import { combineSummary, inferMessages, prepareOutput } from './graph-guest.ts';

test('the staged guest carries the graph logic the harness recomputes', () => {
  expect(prepareOutput('  the primary  colours ')).toEqual({ text: 'the primary colours', count: 3 });
  expect(inferMessages('x')).toHaveLength(2);
  expect(combineSummary(3, 'y')).toBe('3 words in; the model said: y');
});
`;
  return files;
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
  const { PodmanRunner, buildLimits, filesDigest } = await import(join(repo, "packages/@ezcorp/extension-runner/src/index.ts"));
  const { provisionToolchain } = await import(join(repo, "packages/@ezcorp/extension-runner/src/provision.ts"));
  const { digestObject, FileBlobStore, putFiles } = await import(join(repo, "src/extensions/v4/blobs.ts"));
  const runner = new PodmanRunner({ root: runnerRoot, ...await provisionToolchain({ sdkEntrypoint: process.env.EZ_RUNNER_SDK_ENTRY }) });
  try {
    const built = await runner.build({ operationId, sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    if (built.state !== "succeeded" || !built.artifactDigest || !built.manifest) {
      throw new Error(`the graph guest did not build: ${built.diagnostics?.map((entry: { code: string; message?: string }) => `${entry.code}${entry.message ? `: ${entry.message}` : ""}`).join("; ") ?? built.state}`);
    }
    const blobs = new FileBlobStore(join(runnerRoot, "release-blobs"));
    const sourceDigest = await putFiles(blobs, files, "workspace");
    const input = {
      installationId: "w19a-guest-installation",
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
      guest: Object.freeze({ package: GRAPH_GUEST_PACKAGE, manifestName: GRAPH_GUEST_MANIFEST, version: GRAPH_GUEST_VERSION, digest: `sha256:${built.artifactDigest}` }),
      release: { ...input, id: "w19a-guest-release", releaseDigest: digestObject(input), createdAt: "2030-01-01T00:00:00.000Z" },
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
 * deployment fact. The preparation rebuilds the package and refuses unless the
 * artifact digest matches the binding; the second and third references reuse
 * the first one's verified artifacts.
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
    const preparations = new FactoryPackagePreparations(db, options.tenantId, grants, trusts, new FactoryV4PackageCatalog(repository, new FileBlobStore(options.releaseBlobRoot)), runner, buildLimits);
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
