import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import { factoryGuestCompletedWithoutOperations, factoryGuestPortAddress, readFactoryGuestMaterial, type FactoryGuestBrokerCall } from "@ezcorp/factory-sdk/guest-materials";
import { factoryGuestModelTask, FactoryGuestTaskError } from "@ezcorp/factory-sdk/guest-model";
import type { FactoryRunnerRequest, JsonValue } from "@ezcorp/factory-sdk/types";
import { factoryGitTreeId } from "../git-objects";
import { referenceCodeRepositoryPolicy, type ReferenceCodeRepositoryPolicy } from "./candidate-rules";
import { freezeReferenceCodeCandidate, referenceCodePullRequestTitle, type ReferenceCodeCandidate } from "./freeze";
import { REFERENCE_CODE_GENERATION_SCHEMA_VERSION, REFERENCE_CODE_GUEST_MAX_OUTPUT_TOKENS, ReferenceCodeAnswerError, referenceCodeApplyGuestAnswer, referenceCodeGuestSystemPrompt, referenceCodeGuestUserPrompt, type ReferenceCodeGuestGeneration } from "./guest-generate";
import {
  ReferenceCodeSnapshotError,
  referenceCodeFilesFromWire,
  referenceCodeFilesToWire,
  sealReferenceCodeSnapshot,
  referenceCodeFilesDigest,
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
 * it does not hold. The connection also states the repository's protected policy and the base
 * commit's time; the snapshot seals both, so every later node reads them from the snapshot and the
 * generator can never change them (W4H-28).
 *
 * `generateCandidate` reads that snapshot through the guest's material read frame and makes ONE
 * model call through the broker (W4H-28 P1); the host plane holds the credential and accounts the
 * usage. The exports still pending refuse by name until the part of W4H-28 that adds them.
 */

export const REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION = "factory.reference-code-recorded-tree.v1" as const;
export const REFERENCE_CODE_SNAPSHOT_OUTPUT = "snapshot.json";
export const REFERENCE_CODE_GENERATION_OUTPUT = "generation.json";
export const REFERENCE_CODE_CANDIDATE_OUTPUT = "candidate.json";
export const REFERENCE_CODE_RESULT_OUTPUT = "result.json";
const CHECKPOINT_SCHEMA = "factory.reference-code-runner.checkpoint.v1";

export type ReferenceCodeRunnerErrorCode =
  | "reference_code_repository_reader_unavailable"
  | "reference_code_snapshot_output_invalid"
  | "reference_code_recorded_tree_mismatch"
  | "reference_code_runner_input_invalid"
  | "reference_code_runner_pending";

export class ReferenceCodeRunnerError extends Error {
  constructor(readonly code: ReferenceCodeRunnerErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ReferenceCodeRunnerError";
  }
}

/** What every connection states beside its tree: the repository's policy and the base commit's time. */
export interface ReferenceCodeConnectionFacts {
  readonly policy: ReferenceCodeRepositoryPolicy;
  /** The base commit's committer time: the candidate commit's recorded time, never a clock read. */
  readonly committedAtSeconds: number;
}

/** A complete tree at one commit, recorded as JSON: the connection `snapshotRepository` reads in a guest. */
export interface ReferenceCodeRecordedTree extends ReferenceCodeConnectionFacts {
  readonly schemaVersion: typeof REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly files: readonly ReferenceCodeWireFile[];
}

export function referenceCodeRecordedTree(input: { readonly commitSha: string; readonly treeSha: string; readonly files: readonly ReferenceCodeFile[] } & ReferenceCodeConnectionFacts): ReferenceCodeRecordedTree {
  return { schemaVersion: REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION, commitSha: input.commitSha, treeSha: input.treeSha, committedAtSeconds: input.committedAtSeconds, policy: input.policy, files: referenceCodeFilesToWire(input.files) };
}

function isRecordedTree(value: unknown): value is ReferenceCodeRecordedTree {
  const tree = value as ReferenceCodeRecordedTree;
  return !!tree && typeof tree === "object" && tree.schemaVersion === REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION
    && typeof tree.commitSha === "string" && typeof tree.treeSha === "string" && Array.isArray(tree.files)
    && tree.files.every(file => !!file && typeof file.path === "string" && typeof file.mode === "string" && typeof file.contentBase64 === "string");
}

/** The facts a connection states, or a named refusal. */
export function referenceCodeConnectionFacts(connection: unknown): ReferenceCodeConnectionFacts {
  const facts = connection as Partial<ReferenceCodeConnectionFacts> | null;
  const committedAtSeconds = facts?.committedAtSeconds;
  if (!Number.isSafeInteger(committedAtSeconds) || (committedAtSeconds as number) < 0) {
    throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "a repository connection states its base commit's committedAtSeconds");
  }
  return Object.freeze({ policy: referenceCodeRepositoryPolicy(facts?.policy), committedAtSeconds: committedAtSeconds as number });
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

/** The snapshot as its output artifact carries it: every field, with file bytes as base64, and the connection's facts. */
export function referenceCodeSnapshotRunnerOutput(snapshot: ReferenceCodeSnapshot, facts: ReferenceCodeConnectionFacts): JsonValue {
  return { ...snapshot, files: referenceCodeFilesToWire(snapshot.files), policy: facts.policy, committedAtSeconds: facts.committedAtSeconds } as unknown as JsonValue;
}

/** A sealed snapshot read back from its output bytes. */
export interface ReferenceCodeSealedSnapshot extends ReferenceCodeConnectionFacts {
  readonly snapshot: ReferenceCodeSnapshot;
}

/**
 * Reads a snapshot output back, re-sealing it from its own files so a recorded digest cannot
 * describe other bytes. The bytes were already proved against the port's digest by the read frame.
 */
export function referenceCodeSnapshotFromRunnerOutput(content: Uint8Array): ReferenceCodeSealedSnapshot {
  let value: { baseSha?: unknown; treeSha?: unknown; files?: unknown; digest?: unknown; policy?: unknown; committedAtSeconds?: unknown };
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)) as typeof value; }
  catch { throw new ReferenceCodeRunnerError("reference_code_snapshot_output_invalid", "the snapshot output is not UTF-8 JSON"); }
  if (!value || typeof value !== "object" || typeof value.baseSha !== "string" || typeof value.treeSha !== "string" || !Array.isArray(value.files)) {
    throw new ReferenceCodeRunnerError("reference_code_snapshot_output_invalid", "the snapshot output is not a sealed snapshot");
  }
  const files = referenceCodeFilesFromWire(value.files as ReferenceCodeWireFile[]);
  const snapshot = sealReferenceCodeSnapshot({ baseSha: value.baseSha, treeSha: value.treeSha, entries: files.map(file => ({ path: file.path, mode: file.mode as string, content: file.content })) });
  if (snapshot.digest !== value.digest) throw new ReferenceCodeRunnerError("reference_code_snapshot_output_invalid", "the snapshot's recorded digest is not its files' digest");
  return Object.freeze({ snapshot, ...referenceCodeConnectionFacts(value) });
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
  const facts = referenceCodeConnectionFacts(repositoryConnection);
  const snapshot = await snapshotReferenceCodeRepository(referenceCodeRecordedTreeReader(repositoryConnection), baseCommitSha);
  // The snapshot is a sealed material; the node's `snapshot` port names it by content digest and handle.
  return factoryGuestCompletedWithoutOperations({
    request, call, outputName: REFERENCE_CODE_RESULT_OUTPUT, checkpointSchema: CHECKPOINT_SCHEMA,
    output: async staging => ({ snapshot: await stagedJson(staging, REFERENCE_CODE_SNAPSHOT_OUTPUT, referenceCodeSnapshotRunnerOutput(snapshot, facts)) }),
  });
}

/** Stages one JSON material and answers the port value naming it: `{ digest, mediaType, storage }`. */
async function stagedJson(staging: { stageOutput(name: string, bytes: Uint8Array, mediaType?: string): Promise<{ digest: string; material: { artifactId: string } }> }, name: string, value: JsonValue): Promise<JsonValue> {
  const staged = await staging.stageOutput(name, new TextEncoder().encode(canonicalizeJson(value)), "application/json");
  return { digest: staged.digest, mediaType: "application/json", storage: staged.material.artifactId };
}

/** Reads the sealed snapshot a port names, through the guest's material read frame. */
async function readSnapshot(call: FactoryGuestBrokerCall, port: unknown): Promise<ReferenceCodeSealedSnapshot> {
  return referenceCodeSnapshotFromRunnerOutput((await readFactoryGuestMaterial(call, factoryGuestPortAddress(port))).content);
}

/**
 * One bounded model call: the whole snapshot and the request in, every changed file out (W4H-28 P1).
 *
 * The output is a sealed generation material holding the COMPLETE resulting tree; freeze reads it
 * and the snapshot, never anything the model said about the policy.
 */
export async function generateCandidate(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall): Promise<Record<string, JsonValue>> {
  const { snapshot: port, request: issue, remediation } = boundPorts(request);
  if (typeof issue !== "string" || typeof remediation !== "string") throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "request and remediation must be strings");
  const sealed = await readSnapshot(call, port);
  return factoryGuestModelTask({
    request, call, outputName: REFERENCE_CODE_RESULT_OUTPUT, maxOutputTokens: REFERENCE_CODE_GUEST_MAX_OUTPUT_TOKENS,
    messages: [
      { role: "system", text: referenceCodeGuestSystemPrompt(sealed.snapshot, sealed.policy) },
      { role: "user", text: referenceCodeGuestUserPrompt(sealed.snapshot, issue, remediation) },
    ],
    output: async (answer, staging) => {
      let generation: ReferenceCodeGuestGeneration;
      try { generation = referenceCodeApplyGuestAnswer(sealed.snapshot, answer.text); }
      catch (error) {
        if (error instanceof ReferenceCodeAnswerError) throw new FactoryGuestTaskError(error.code, error.message);
        throw error;
      }
      const material = {
        schemaVersion: REFERENCE_CODE_GENERATION_SCHEMA_VERSION, baseSha: sealed.snapshot.baseSha, files: referenceCodeFilesToWire(generation.files),
        filesDigest: generation.filesDigest, changedPaths: generation.changedPaths, summary: generation.summary,
        model: request.model === undefined ? null : { provider: request.model.provider, model: request.model.model },
        usage: { inputTokens: answer.usage.inputTokens, outputTokens: answer.usage.outputTokens },
      } as unknown as JsonValue;
      return { candidate: await stagedJson(staging, REFERENCE_CODE_GENERATION_OUTPUT, material) };
    },
  });
}

/** The generation a port names, read back and proved: its files are the digest it records, on the snapshot's base. */
async function readGeneration(call: FactoryGuestBrokerCall, port: unknown, baseSha: string): Promise<readonly ReferenceCodeFile[]> {
  const { content } = await readFactoryGuestMaterial(call, factoryGuestPortAddress(port));
  let value: { schemaVersion?: unknown; baseSha?: unknown; files?: unknown; filesDigest?: unknown };
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)) as typeof value; }
  catch { throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "the generation is not UTF-8 JSON"); }
  if (value?.schemaVersion !== REFERENCE_CODE_GENERATION_SCHEMA_VERSION || value.baseSha !== baseSha || !Array.isArray(value.files)) {
    throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "the candidate is not a generation of this snapshot's base");
  }
  const files = referenceCodeFilesFromWire(value.files as ReferenceCodeWireFile[]);
  if (referenceCodeFilesDigest(files) !== value.filesDigest) throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "the generation's files are not the digest it records");
  return files;
}

/** The frozen candidate as its output carries it: every field but the in-memory plan, and the snapshot it was frozen against. */
export function referenceCodeCandidateRunnerOutput(candidate: ReferenceCodeCandidate, snapshotPort: JsonValue): JsonValue {
  const { plan: _plan, ...frozen } = candidate;
  return { ...frozen, snapshot: snapshotPort } as unknown as JsonValue;
}

/**
 * Freezes the generated tree into the exact commit a release creates (W4H-28).
 *
 * The policy, the repository id and the commit time come from the sealed snapshot, and the request
 * and base branch from the run's own inputs; the generator supplies the files and nothing else.
 */
export async function freezeGitTree(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall): Promise<Record<string, JsonValue>> {
  const { candidate: port, snapshot: snapshotPort, baseCommitSha, request: issue, baseBranch } = boundPorts(request);
  if (typeof baseCommitSha !== "string" || typeof issue !== "string" || typeof baseBranch !== "string") {
    throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "baseCommitSha, request and baseBranch must be strings");
  }
  const sealed = await readSnapshot(call, snapshotPort);
  if (sealed.snapshot.baseSha !== baseCommitSha) throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "the snapshot is not of the run's base commit");
  const files = await readGeneration(call, port, sealed.snapshot.baseSha);
  const candidate = freezeReferenceCodeCandidate({
    snapshot: sealed.snapshot, files, repositoryId: sealed.policy.repositoryId, baseBranch, issue, title: referenceCodePullRequestTitle(issue),
    allowedPaths: sealed.policy.allowedPaths, protectedPaths: sealed.policy.protectedPaths, authoredAtSeconds: sealed.committedAtSeconds,
    candidateGeneration: request.authority.candidateGeneration,
  });
  return factoryGuestCompletedWithoutOperations({
    request, call, outputName: REFERENCE_CODE_RESULT_OUTPUT, checkpointSchema: CHECKPOINT_SCHEMA,
    output: async staging => ({ candidate: await stagedJson(staging, REFERENCE_CODE_CANDIDATE_OUTPUT, referenceCodeCandidateRunnerOutput(candidate, snapshotPort as JsonValue)) }),
  });
}

function pending(exported: string, needs: string): ReferenceCodeRunnerTool {
  return async () => { throw new ReferenceCodeRunnerError("reference_code_runner_pending", `${exported} needs ${needs}, which the guest does not have yet`); };
}

export const protectedChecks = pending("protectedChecks", "the pinned validator toolchain lane");
export const supervisedReview = pending("supervisedReview", "a model call through the guest broker");

/** One tool per REFERENCE_CODE_IMPLEMENTATIONS export; `runner-packages.test.ts` holds the two lists equal. */
export const REFERENCE_CODE_RUNNER_TOOLS = Object.freeze({
  snapshotRepository, generateCandidate, freezeGitTree, protectedChecks, supervisedReview,
} satisfies Record<string, ReferenceCodeRunnerTool>);
