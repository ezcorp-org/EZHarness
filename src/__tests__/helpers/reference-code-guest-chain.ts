import type { FactoryArtifactReference, FactoryRunnerRequest, JsonValue } from "@ezcorp/factory-sdk";
import { factoryGitTreeId } from "../../factory/git-objects";
import {
  REFERENCE_CODE_FIXTURE_COMMITTED_AT_SECONDS,
  REFERENCE_CODE_FIXTURE_POLICY,
  REFERENCE_CODE_FIXTURE_REQUEST,
  referenceCodeFixtureCandidate,
  referenceCodeLaunchRepository,
  type ReferenceCodeFixtureName,
} from "../../factory/reference-code/fixtures";
import { REFERENCE_CODE_RESULT_OUTPUT, REFERENCE_CODE_RUNNER_TOOLS, referenceCodeRecordedTree } from "../../factory/reference-code/runner-entry";
import { factoryGuestMaterialHost, factoryGuestStagedJson, type FactoryGuestScriptedModel } from "./factory-guest-material-host";

export const REFERENCE_CODE_CHAIN_COMMIT = "1".repeat(40);
const MODEL = { provider: "ezcorp-mock", model: "mock:chain", configuration: {}, configurationDigest: `sha256:${"a".repeat(64)}`, policy: {}, policyDigest: `sha256:${"a".repeat(64)}` };

/** A guest runner request for one node, with an inline input or a validator's artifact input. */
export function referenceCodeGuestRequest(node: string, input: FactoryRunnerRequest["input"], options: { readonly generation?: number; readonly model?: boolean } = {}): FactoryRunnerRequest {
  return {
    authority: { runId: "run", nodeInstanceId: node, candidateGeneration: options.generation ?? 0, nextOperationIndex: 0 },
    ...(options.model === false ? {} : { model: MODEL }),
    input,
  } as unknown as FactoryRunnerRequest;
}

/** The answer a generator gives for one fixture candidate: its src/slugify.ts, whole. */
export function referenceCodeFixtureAnswer(name: ReferenceCodeFixtureName): string {
  const file = referenceCodeFixtureCandidate(name).find(entry => entry.path === "src/slugify.ts")!;
  return JSON.stringify({ files: [{ path: file.path, content: new TextDecoder().decode(file.content) }], summary: `The ${name} candidate.` });
}

/**
 * snapshot-repository, generate-private-candidate and freeze-complete-git-tree, in process, over one
 * strict in-memory host (W4H-28). The returned `call` is the same host, so a validator tool run next
 * reads exactly what the chain sealed; `frozenOutput` is the reference a validator is handed.
 */
export async function referenceCodeGuestChain(options: { readonly candidate?: ReferenceCodeFixtureName; readonly review?: FactoryGuestScriptedModel; readonly release?: "github" | "s3" } = {}) {
  const files = referenceCodeLaunchRepository();
  const connection = referenceCodeRecordedTree({
    commitSha: REFERENCE_CODE_CHAIN_COMMIT, treeSha: factoryGitTreeId(files), files,
    policy: REFERENCE_CODE_FIXTURE_POLICY, committedAtSeconds: REFERENCE_CODE_FIXTURE_COMMITTED_AT_SECONDS,
  });
  const answer = referenceCodeFixtureAnswer(options.candidate ?? "accepted");
  let calls = 0;
  const host = factoryGuestMaterialHost({ model: request => (calls++ === 0 ? { text: answer } : options.review!(request)) });
  const inline = (value: unknown) => ({ kind: "inline", value }) as FactoryRunnerRequest["input"];
  await REFERENCE_CODE_RUNNER_TOOLS.snapshotRepository(referenceCodeGuestRequest("snapshot-repository", inline({ repositoryConnection: connection, baseCommitSha: REFERENCE_CODE_CHAIN_COMMIT }), { model: false }), host.call);
  const snapshot = (factoryGuestStagedJson(host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { snapshot: JsonValue }).snapshot;
  await REFERENCE_CODE_RUNNER_TOOLS.generateCandidate(referenceCodeGuestRequest("generate-private-candidate", inline({ snapshot, request: REFERENCE_CODE_FIXTURE_REQUEST.issue, baseBranch: "main", remediation: "" })), host.call);
  const generated = (factoryGuestStagedJson(host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { candidate: JsonValue }).candidate;
  const frozen = await REFERENCE_CODE_RUNNER_TOOLS.freezeGitTree(referenceCodeGuestRequest("freeze-complete-git-tree", inline({ candidate: generated, snapshot, baseCommitSha: REFERENCE_CODE_CHAIN_COMMIT, request: REFERENCE_CODE_FIXTURE_REQUEST.issue, baseBranch: "main", release: options.release ?? "github" }), { model: false }), host.call);
  const ports = factoryGuestStagedJson(host.stored, REFERENCE_CODE_RESULT_OUTPUT) as { candidate: JsonValue; frozen: JsonValue };
  return { host, snapshot, generated, candidate: ports.frozen, released: ports.candidate, frozenOutput: frozen.output as unknown as FactoryArtifactReference };
}
