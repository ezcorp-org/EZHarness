import { canonicalizeJson } from "@ezcorp/factory-sdk/canonical";
import { factoryGuestCompletedWithoutOperations, factoryGuestOperationId, factoryGuestPortAddress, readFactoryGuestMaterial, readFactoryGuestRepository, type FactoryGuestBrokerCall } from "@ezcorp/factory-sdk/guest-materials";
import { factoryGuestModelTask, FactoryGuestTaskError } from "@ezcorp/factory-sdk/guest-model";
import { FACTORY_REPOSITORY_TREE_SCHEMA_VERSION, FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION, type FactoryRunnerRequest, type JsonValue } from "@ezcorp/factory-sdk/types";
import { factoryGitTreeId } from "../git-objects";
import { referenceCodeRepositoryPolicy, type ReferenceCodeRepositoryPolicy } from "./candidate-rules";
import { FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION, type FactoryS3AcceptedPublication } from "../release-s3-accepted-publication";
import { referenceCodeProtectedChecks } from "./checks";
import { freezeReferenceCodeCandidate, REFERENCE_CODE_FREEZE_SCHEMA_VERSION, referenceCodePullRequestTitle, type ReferenceCodeCandidate } from "./freeze";
import { parseReferenceCodeReview, REFERENCE_CODE_REVIEW_SYSTEM_PROMPT, referenceCodeReviewClaim, referenceCodeReviewPrompt } from "./review-rules";
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
 * usage. `freezeGitTree`, `protectedChecks` and `supervisedReview` read their inputs the same way.
 */

export const REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION = "factory.reference-code-recorded-tree.v1" as const;
export const REFERENCE_CODE_SNAPSHOT_OUTPUT = "snapshot.json";
export const REFERENCE_CODE_GENERATION_OUTPUT = "generation.json";
export const REFERENCE_CODE_CANDIDATE_OUTPUT = "candidate.json";
export const REFERENCE_CODE_CHECKS_OUTPUT = "checks.json";
/** The review's output bound: three booleans and one sentence. */
export const REFERENCE_CODE_REVIEW_MAX_OUTPUT_TOKENS = 1_024;
/** How much of one command's output the checks evidence keeps. */
const EVIDENCE_OUTPUT_LIMIT = 4 * 1024;
export const REFERENCE_CODE_RESULT_OUTPUT = "result.json";
const CHECKPOINT_SCHEMA = "factory.reference-code-runner.checkpoint.v1";

export type ReferenceCodeRunnerErrorCode =
  | "reference_code_repository_reader_unavailable"
  | "reference_code_snapshot_output_invalid"
  | "reference_code_recorded_tree_mismatch"
  | "reference_code_runner_input_invalid";

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

/** A live connection: a declared source's handle and the policy the operator states for it (W4H-28). */
interface ReferenceCodeLiveConnection {
  readonly source: string;
  readonly policy: unknown;
}

function isLiveConnection(value: unknown): value is ReferenceCodeLiveConnection {
  return !!value && typeof value === "object" && typeof (value as { source?: unknown }).source === "string" && (value as { schemaVersion?: unknown }).schemaVersion === undefined;
}

/**
 * Reads one commit of a declared repository source through the host's repository-read operation and
 * returns it as a recorded tree, with the connection's policy (W4H-28 P2). The host holds the
 * credential; the guest recomputes the tree id from the bytes, as for any recorded tree.
 */
async function liveRecordedTree(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall, connection: ReferenceCodeLiveConnection, commitSha: string): Promise<ReferenceCodeRecordedTree> {
  const index = request.authority.nextOperationIndex;
  const read = await readFactoryGuestRepository(call, { operationId: factoryGuestOperationId(request, index), operationIndex: index, source: connection.source, commitSha });
  const tree = jsonOf(read.content, "the repository tree");
  if (tree.schemaVersion !== FACTORY_REPOSITORY_TREE_SCHEMA_VERSION || tree.commitSha !== commitSha || typeof tree.treeSha !== "string" || !Array.isArray(tree.files)) {
    throw new ReferenceCodeRunnerError("reference_code_repository_reader_unavailable", "the host answered with a tree of another commit or shape");
  }
  return { schemaVersion: REFERENCE_CODE_RECORDED_TREE_SCHEMA_VERSION, commitSha, treeSha: tree.treeSha, committedAtSeconds: tree.committedAtSeconds as number, policy: connection.policy as ReferenceCodeRepositoryPolicy, files: tree.files as ReferenceCodeWireFile[] };
}

export async function snapshotRepository(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall): Promise<Record<string, JsonValue>> {
  const { repositoryConnection, baseCommitSha } = boundPorts(request);
  if (typeof baseCommitSha !== "string") throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "baseCommitSha must be a string");
  const connection = isLiveConnection(repositoryConnection) ? await liveRecordedTree(request, call, repositoryConnection, baseCommitSha) : repositoryConnection;
  const facts = referenceCodeConnectionFacts(connection);
  const snapshot = await snapshotReferenceCodeRepository(referenceCodeRecordedTreeReader(connection), baseCommitSha);
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

/**
 * The frozen candidate as its output carries it: every field but the in-memory plan, the snapshot it
 * was frozen against, and the request it answers. Both came from the run, never from the generator.
 */
export function referenceCodeCandidateRunnerOutput(candidate: ReferenceCodeCandidate, snapshotPort: JsonValue, issue: string): JsonValue {
  const { plan: _plan, ...frozen } = candidate;
  return { ...frozen, snapshot: snapshotPort, issue } as unknown as JsonValue;
}

/** What a protected check judges: the frozen candidate, the request, the sealed snapshot, the complete tree. */
export interface ReferenceCodeCheckSubject {
  readonly candidate: Omit<ReferenceCodeCandidate, "plan">;
  readonly issue: string;
  readonly sealed: ReferenceCodeSealedSnapshot;
  readonly files: readonly ReferenceCodeFile[];
}

function jsonOf(content: Uint8Array, what: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)); }
  catch { throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", `${what} is not UTF-8 JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", `${what} is not a JSON object`);
  return value as Record<string, unknown>;
}

/**
 * Reads what a check judges, through the material read frame (W4H-28).
 *
 * A protected-checks TASK is handed the freeze node's `frozen` port inline; a VALIDATOR is handed the
 * freeze node's whole output by reference, `{ candidate, frozen }`, and reads `frozen` from it. Either way the frozen record names
 * the snapshot it was frozen against, and the tree must be the digest the freeze recorded.
 */
export async function referenceCodeCheckSubject(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall): Promise<ReferenceCodeCheckSubject> {
  let port: unknown;
  if (request.input?.kind === "artifact") {
    const output = await readFactoryGuestMaterial(call, { artifactId: request.input.artifact.artifactId, digest: request.input.artifact.digest });
    port = jsonOf(output.content, "the frozen node's output").frozen;
  } else port = boundPorts(request).candidate;
  const frozen = jsonOf((await readFactoryGuestMaterial(call, factoryGuestPortAddress(port))).content, "the frozen candidate");
  const publication = frozen.publication as { files?: unknown } | undefined;
  if (frozen.schemaVersion !== REFERENCE_CODE_FREEZE_SCHEMA_VERSION || typeof frozen.issue !== "string" || !Array.isArray(publication?.files)) {
    throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "the candidate is not a frozen reference-code candidate");
  }
  const sealed = await readSnapshot(call, frozen.snapshot);
  const files = referenceCodeFilesFromWire(publication.files as ReferenceCodeWireFile[]);
  if (referenceCodeFilesDigest(files) !== frozen.filesDigest || frozen.baseSha !== sealed.snapshot.baseSha) {
    throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "the frozen tree is not the digest it records, or not of its snapshot's base");
  }
  const { snapshot: _snapshot, issue, ...candidate } = frozen;
  return Object.freeze({ candidate: candidate as unknown as Omit<ReferenceCodeCandidate, "plan">, issue: issue as string, sealed, files });
}

/**
 * The nine deterministic protected claims, in the guest, on the pinned toolchain (W4H-28 P3).
 *
 * `toolchain` is the package root the guest runtime stages read-only and executable; the validator
 * package's own locked dependency set lives in its `node_modules`. As a validator the tool answers
 * the claims report itself; as the protected-checks task it seals the report and the command record
 * as one evidence material.
 */
export function referenceCodeProtectedChecksTool(toolchain: string): ReferenceCodeRunnerTool {
  return async (request, call) => {
    const subject = await referenceCodeCheckSubject(request, call);
    const checked = await referenceCodeProtectedChecks({
      candidate: subject.candidate as ReferenceCodeCandidate, snapshot: subject.sealed.snapshot, files: subject.files,
      allowedPaths: subject.sealed.policy.allowedPaths, protectedPaths: subject.sealed.policy.protectedPaths, protectedTestPaths: subject.sealed.policy.protectedTestPaths,
      toolchain,
    });
    const validator = request.input.kind === "artifact";
    return factoryGuestCompletedWithoutOperations({
      request, call, outputName: REFERENCE_CODE_RESULT_OUTPUT, checkpointSchema: CHECKPOINT_SCHEMA,
      output: validator ? checked.report as unknown as JsonValue : async staging => ({
        evidence: [await stagedJson(staging, REFERENCE_CODE_CHECKS_OUTPUT, {
          report: checked.report, verifiedWorkspaceDigest: checked.verifiedWorkspaceDigest,
          commands: checked.commands.map(command => ({ command: command.command, exitCode: command.exitCode, timedOut: command.timedOut, durationMs: command.durationMs, output: command.output.slice(-EVIDENCE_OUTPUT_LIMIT) })),
        } as unknown as JsonValue)],
      }),
    });
  };
}

/**
 * The supervised review, in its own validator guest: one model call, no tool, no filesystem
 * (W4H-28). The rubric, the prompt and the strict parse are the host review's own (`review-rules.ts`).
 */
export async function supervisedReview(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall): Promise<Record<string, JsonValue>> {
  const subject = await referenceCodeCheckSubject(request, call);
  return factoryGuestModelTask({
    request, call, outputName: REFERENCE_CODE_RESULT_OUTPUT, maxOutputTokens: REFERENCE_CODE_REVIEW_MAX_OUTPUT_TOKENS,
    messages: [
      { role: "system", text: REFERENCE_CODE_REVIEW_SYSTEM_PROMPT },
      { role: "user", text: referenceCodeReviewPrompt({ issue: subject.issue, snapshot: subject.sealed.snapshot, files: subject.files, changedPaths: subject.candidate.changedPaths }) },
    ],
    output: async answer => ({ schemaVersion: FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION, claims: [referenceCodeReviewClaim(parseReferenceCodeReview(answer.text), Date.now())] }) as unknown as JsonValue,
  });
}

/**
 * Freezes the generated tree into the exact commit a release creates (W4H-28).
 *
 * The policy, the repository id and the commit time come from the sealed snapshot, and the request
 * and base branch from the run's own inputs; the generator supplies the files and nothing else.
 */
/**
 * What an S3 release of the frozen candidate resolves from: the frozen record itself, sealed by this
 * attempt under its own operation, published as `candidate.json` (W08's accepted publication).
 */
export function referenceCodeS3Publication(request: FactoryRunnerRequest): FactoryS3AcceptedPublication {
  return {
    schemaVersion: FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION,
    materialOperationId: factoryGuestOperationId(request, request.authority.nextOperationIndex),
    candidateObjectName: REFERENCE_CODE_CANDIDATE_OUTPUT, candidateVersion: 1,
    files: [{ name: REFERENCE_CODE_CANDIDATE_OUTPUT, objectName: REFERENCE_CODE_CANDIDATE_OUTPUT, version: 1 }],
  };
}

export async function freezeGitTree(request: FactoryRunnerRequest, call: FactoryGuestBrokerCall): Promise<Record<string, JsonValue>> {
  const { candidate: port, snapshot: snapshotPort, baseCommitSha, request: issue, baseBranch, release } = boundPorts(request);
  if (typeof baseCommitSha !== "string" || typeof issue !== "string" || typeof baseBranch !== "string" || (release !== "github" && release !== "s3")) {
    throw new ReferenceCodeRunnerError("reference_code_runner_input_invalid", "baseCommitSha, request and baseBranch must be strings, and release github or s3");
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
    output: async staging => {
      const frozen = await stagedJson(staging, REFERENCE_CODE_CANDIDATE_OUTPUT, referenceCodeCandidateRunnerOutput(candidate, snapshotPort as JsonValue, issue));
      // The declared release resolves from `candidate`: W07's publication request, or W08's accepted publication.
      const released = release === "github" ? candidate.publication as unknown as JsonValue : referenceCodeS3Publication(request) as unknown as JsonValue;
      return { candidate: released, frozen };
    },
  });
}


/** In a guest the package root is the working directory: the runtime stages the toolchain there. */
export const protectedChecks = referenceCodeProtectedChecksTool(process.cwd());

/** One tool per REFERENCE_CODE_IMPLEMENTATIONS export; `runner-packages.test.ts` holds the two lists equal. */
export const REFERENCE_CODE_RUNNER_TOOLS = Object.freeze({
  snapshotRepository, generateCandidate, freezeGitTree, protectedChecks, supervisedReview,
} satisfies Record<string, ReferenceCodeRunnerTool>);
