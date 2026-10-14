import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import { factoryGuestCompletedWithoutOperations, type FactoryGuestBrokerCall } from "@ezcorp/factory-sdk/guest-materials";
import type { FactoryRunnerRequest, JsonValue } from "@ezcorp/factory-sdk/types";
import { factoryGitTreeId } from "../git-objects";
import {
  ReferenceCodeSnapshotError,
  referenceCodeFilesFromWire,
  referenceCodeFilesToWire,
  snapshotReferenceCodeRepository,
  type ReferenceCodeFile,
  type ReferenceCodeRepositoryReader,
  type ReferenceCodeSnapshot,
  type ReferenceCodeWireFile,
} from "./snapshot";

/**
 * The reference-code runner tools, as they run inside one isolated guest (W4H-26).
 *
 * Each REFERENCE_CODE_IMPLEMENTATIONS export is a tool of the v4 runner package the definition
 * names, launched by the host supervisor in the pinned guest (C05: package code runs outside the
 * host plane, "untrusted even in a first-party pack"). A tool takes the runner request and the
 * guest's one reverse capability, `factory.broker`, and nothing else: no network, no subprocess,
 * no credential.
 *
 * `snapshotRepository` runs the product's own `snapshotReferenceCodeRepository` over a recorded
 * tree carried in the run's `repositoryConnection` — the "recorded listing" the reader port was
 * designed for. The guest recomputes the tree id from the bytes, so a recording cannot name a tree
 * it does not hold. The other four exports need a capability the guest does not have yet (a model
 * through the broker, the toolchain lane, a repository read for live connections); each refuses by
 * name until the package that adds it.
 */

export const REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION = "factory.reference-code-recorded-tree.v1" as const;
export const REFERENCE_CODE_SNAPSHOT_OUTPUT = "snapshot.json";
export const REFERENCE_CODE_RESULT_OUTPUT = "result.json";
const CHECKPOINT_SCHEMA = "factory.reference-code-runner.checkpoint.v1";

export type ReferenceCodeRunnerErrorCode =
  | "reference_code_repository_reader_unavailable"
  | "reference_code_recorded_tree_mismatch"
  | "reference_code_runner_input_invalid"
  | "reference_code_runner_pending";

export class ReferenceCodeRunnerError extends Error {
  constructor(readonly code: ReferenceCodeRunnerErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ReferenceCodeRunnerError";
  }
}

/** A complete tree at one commit, recorded as JSON: the connection `snapshotRepository` reads in a guest. */
export interface ReferenceCodeRecordedTree {
  readonly schemaVersion: typeof REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly files: readonly ReferenceCodeWireFile[];
}

export function referenceCodeRecordedTree(input: { readonly commitSha: string; readonly treeSha: string; readonly files: readonly ReferenceCodeFile[] }): ReferenceCodeRecordedTree {
  return { schemaVersion: REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION, commitSha: input.commitSha, treeSha: input.treeSha, files: referenceCodeFilesToWire(input.files) };
}

function isRecordedTree(value: unknown): value is ReferenceCodeRecordedTree {
  const tree = value as ReferenceCodeRecordedTree;
  return !!tree && typeof tree === "object" && tree.schemaVersion === REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION
    && typeof tree.commitSha === "string" && typeof tree.treeSha === "string" && Array.isArray(tree.files)
    && tree.files.every(file => !!file && typeof file.path === "string" && typeof file.mode === "string" && typeof file.contentBase64 === "string");
}

/** The reader port over a recorded tree. Anything else — a live GitHub connection included — is refused by name. */
export function referenceCodeRecordedTreeReader(connection: unknown): ReferenceCodeRepositoryReader {
  if (!isRecordedTree(connection)) {
    throw new ReferenceCodeRunnerError("reference_code_repository_reader_unavailable", "a guest reads only a recorded tree; a live repository read needs the broker operation of a later package");
  }
  const files = referenceCodeFilesFromWire(connection.files);
  const known = (sha: string): void => {
    if (sha !== connection.commitSha) throw new ReferenceCodeSnapshotError("reference_code_base_commit_unknown", `the recording holds ${connection.commitSha}`);
  };
  return {
    async resolveCommit(baseSha) {
      known(baseSha);
      if (factoryGitTreeId(files) !== connection.treeSha) throw new ReferenceCodeRunnerError("reference_code_recorded_tree_mismatch", `the recorded bytes are not tree ${connection.treeSha}`);
      return { commitSha: connection.commitSha, treeSha: connection.treeSha };
    },
    async readTree(commitSha) {
      known(commitSha);
      return files.map(file => ({ path: file.path, mode: file.mode, content: file.content }));
    },
  };
}

/** The snapshot as its output artifact carries it: every field, with file bytes as base64. */
export function referenceCodeSnapshotRunnerOutput(snapshot: ReferenceCodeSnapshot): JsonValue {
  return { ...snapshot, files: referenceCodeFilesToWire(snapshot.files) } as unknown as JsonValue;
}

function boundPorts(request: FactoryRunnerRequest): Record<string, unknown> {
  const input = request.input;
  if (input?.kind !== "inline" || input.value === null || typeof input.value !== "object" || Array.isArray(input.value)) {
    throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "a reference-code task takes an inline object of bound ports");
  }
  return input.value as Record<string, unknown>;
}

export type ReferenceCodeRunnerTool = (request: FactoryRunnerRequest, call: FactoryGuestBrokerCall) => Promise<Record<string, JsonValue>>;

export async function snapshotRepository(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall): Promise<Record<string, JsonValue>> {
  const { repositoryConnection, baseCommitSha } = boundPorts(request);
  if (typeof baseCommitSha !== "string") throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "baseCommitSha must be a string");
  const snapshot = await snapshotReferenceCodeRepository(referenceCodeRecordedTreeReader(repositoryConnection), baseCommitSha);
  // The snapshot is a sealed material; the node's `snapshot` port names it by content digest and handle.
  return factoryGuestCompletedWithoutOperations({
    request, call, outputName: REFERENCE_CODE_RESULT_OUTPUT, checkpointSchema: CHECKPOINT_SCHEMA,
    output: async staging => {
      const staged = await staging.stageOutput(REFERENCE_CODE_SNAPSHOT_OUTPUT, new TextEncoder().encode(canonicalizeJson(referenceCodeSnapshotRunnerOutput(snapshot))), "application/json");
      return { snapshot: { digest: staged.digest, mediaType: "application/json", storage: staged.material.artifactId } };
    },
  });
}

function pending(exported: string, needs: string): ReferenceCodeRunnerTool {
  return async () => { throw new ReferenceCodeRunnerError("reference_code_runner_pending", `${exported} needs ${needs}, which the guest does not have yet`); };
}

export const generateCandidate = pending("generateCandidate", "a model call through the guest broker");
export const freezeGitTree = pending("freezeGitTree", "the generated candidate and the publication inputs");
export const protectedChecks = pending("protectedChecks", "the pinned validator toolchain lane");
export const supervisedReview = pending("supervisedReview", "a model call through the guest broker");

/** One tool per REFERENCE_CODE_IMPLEMENTATIONS export; `runner-packages.test.ts` holds the two lists equal. */
export const REFERENCE_CODE_RUNNER_TOOLS = Object.freeze({
  snapshotRepository, generateCandidate, freezeGitTree, protectedChecks, supervisedReview,
} satisfies Record<string, ReferenceCodeRunnerTool>);
