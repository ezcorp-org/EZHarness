/**
 * The runner package the `factory-services` journeys dispatch to, built for
 * real with Podman. No digest is invented: the artifact digest comes from a
 * real build, and the release record is derived from it.
 *
 * The guest stages its bytes over the guest broker with the SHIPPED staging
 * client (`@ezcorp/factory-sdk/guest-materials`, W01g) and returns a completed
 * runner result. One package serves three roles, told apart by its input:
 *
 * - a task attempt seals two data members and a candidate manifest, and its
 *   output is an S3 accepted publication naming them (the shape W09c's release
 *   profile publishes);
 * - a task whose message carries {@link GUEST_HOLD_MESSAGE} waits before it
 *   stages anything, so a journey can act on a live attempt;
 * - a protected validator attempt (its input is the candidate artifact) answers
 *   the strict claims report with a PASS verdict for {@link GUEST_CLAIM_ID}.
 */
import { join } from "node:path";

export const GUEST_MANIFEST_NAME = "factory-services-guest";
export const GUEST_PACKAGE = "@ezcorp/factory-services-guest";
export const GUEST_VERSION = "1.0.0";
export const GUEST_EXPORT = "run";
export const GUEST_CLAIM_ID = "claim";
/** A task input carrying this text holds its attempt live before it stages anything. */
export const GUEST_HOLD_MESSAGE = "hold the attempt live";
/** How long a held attempt waits; a journey stops it long before. */
export const GUEST_HOLD_MS = 600_000;

const MANIFEST = {
	schemaVersion: 4,
	name: GUEST_MANIFEST_NAME,
	version: GUEST_VERSION,
	author: { name: "factory-services" },
	description: "The factory-services journey guest",
	permissions: {},
	tools: [{ name: GUEST_EXPORT, description: "Stage a candidate or a validator report and return a completed runner result", inputSchema: { type: "object" }, outputSchema: { type: "object" } }],
};

/** The exact bytes the guest is built from. Content-addressed, so it is stable. */
export async function guestSource(repo: string): Promise<Record<string, string>> {
	const own: Record<string, string> = {
		"extension.ts": `import { defineExtension, serve } from '@ezcorp/sdk/v4';
import { createFactoryGuestStaging } from './guest-materials.ts';

const manifest = { ...${JSON.stringify(MANIFEST)}, schemaVersion: 4 as const };

interface GuestContext { call(method: string, value: unknown): Promise<unknown> }

export async function run(input: unknown, context: GuestContext): Promise<Record<string, unknown>> {
  const request = input as { input?: unknown; authority?: { runId?: string; nodeInstanceId?: string; candidateGeneration?: number; nextOperationIndex?: number } };
  const authority = request?.authority ?? {};
  const operationIndex = authority.nextOperationIndex ?? 0;
  // The material lands under the journalled operation this attempt owns; the guest invents no identity.
  const operationId = \`\${authority.runId}:\${authority.nodeInstanceId}:\${authority.candidateGeneration ?? 0}:\${operationIndex}\`;
  const staging = createFactoryGuestStaging({ call: async (payload) => context.call('factory.broker', payload), operationId, operationIndex });
  const validator = (request?.input as { kind?: string } | undefined)?.kind === 'artifact';
  let value: Parameters<typeof staging.stageResult>[1];
  if (validator) {
    value = { schemaVersion: 'factory.validator-claims.v1', claims: [{ id: ${JSON.stringify(GUEST_CLAIM_ID)}, verdict: 'PASS', decisive: true, summary: 'factory-services validator guest', reasonCode: 'pass', evidence: [], measuredAtMs: Date.now() }] };
  } else {
    if (JSON.stringify(request?.input ?? null).includes(${JSON.stringify(GUEST_HOLD_MESSAGE)})) await new Promise(resolve => setTimeout(resolve, ${GUEST_HOLD_MS}));
    const encoder = new TextEncoder();
    await staging.stageOutput('part-0.csv', encoder.encode('id,value\\n1,alpha\\n'), 'text/csv');
    await staging.stageOutput('part-1.csv', encoder.encode('id,value\\n2,beta\\n'), 'text/csv');
    await staging.stageOutput('candidate.json', encoder.encode('{"accepted":"dataset"}'), 'application/json');
    value = { candidate: {
      schemaVersion: 'factory.s3-accepted-publication.v1', materialOperationId: operationId, candidateObjectName: 'candidate.json', candidateVersion: 1,
      files: [{ name: 'data/part-0.csv', objectName: 'part-0.csv', version: 1 }, { name: 'data/part-1.csv', objectName: 'part-1.csv', version: 1 }],
    } };
  }
  const promoted = await staging.stageResult('result.json', value);
  // This guest settles no operation, so its cursor is -1 and a measured usage is zero in every dimension.
  const cursor = -1;
  const checkpoint = await staging.stageCheckpoint({ schemaVersion: 'factory-services.checkpoint.v1', cursor }, cursor);
  return {
    schemaVersion: 'factory.runner.result.v1', status: 'completed', journalCursor: cursor, operations: [],
    resultDigest: promoted.resultDigest, output: promoted.output,
    usage: { kind: 'measured', inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: '0' },
    workspaceCheckpoint: checkpoint,
  };
}

await serve(defineExtension({ manifest, tools: { ${GUEST_EXPORT}: run } }));
`,
		"feature.test.ts": `import { expect, test } from 'bun:test';
import { createFactoryGuestStaging } from './guest-materials.ts';

test('the guest carries the shipped staging client', () => {
  const staging = createFactoryGuestStaging({ call: async () => { throw new Error('no host in the build lane'); }, operationId: 'r:n:0:0', operationIndex: 0 });
  expect(typeof staging.stageOutput).toBe('function');
  expect(typeof staging.stageResult).toBe('function');
});
`,
	};
	// The shipped staging client and everything it reaches in the SDK, found by following imports (W14b).
	const { factorySdkClosure } = await import(join(repo, "src/factory/guest-sdk-closure.ts"));
	return { ...await factorySdkClosure(join(repo, "packages/@ezcorp/factory-sdk/src"), own), ...own };
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

	const files = await guestSource(repo);
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
