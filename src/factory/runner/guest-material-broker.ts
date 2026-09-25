import {
  isFactoryGuestMaterialFrame,
  validateFactoryGuestMaterialRequest,
  type FactoryArtifactReference,
  type FactoryGuestMaterialRefusal,
  type FactoryGuestMaterialRequest,
  type FactoryGuestMaterialResponse,
  type FactoryRunnerRequest,
} from "@ezcorp/factory-sdk";
import { decodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { artifactJson, type FactoryArtifacts } from "../artifacts";
import {
  FactoryArtifactAccessError,
  FactoryAttemptMaterials,
  FactoryMaterialError,
  FactoryScopedMaterials,
  type FactoryMaterialIdentity,
  type FactoryMaterialStoreOptions,
  type FactoryMaterialRecord,
  type FactoryScopedArtifactReader,
} from "../artifact-materials";
import { FactoryAttemptLivenessError, type FactoryAttemptAuthority, type FactoryExecutionJournal } from "../executions";
import { FactoryGrantError } from "../grants";
import { FactoryRunLifecycleError } from "../run-lifecycle";
import { factoryRunnerRequestAuthority } from "./attempt-authority";
import { FactoryGuestFrameError } from "./guest-frames";
import type { FactoryGuestBroker } from "./guest-model-broker";

/**
 * The host half of guest material staging, and all of it.
 *
 * A sandboxed guest has no network, so the reverse control frame is its only
 * route out and this answers on the other end. Every frame becomes a call on
 * W04's `FactoryAttemptMaterials` under the attempt's own verified authority.
 * The adapter adds no authority and no bypass: the scope a material is written
 * into — tenant, project, run, attempt — comes from the verified attempt, and
 * the material service rechecks the journal's liveness fence inside each of its
 * own transactions. A frame names an operation, an object, and a version, and
 * nothing else.
 *
 * Refusals are named rather than thrown. A guest told `sealed` can stop; a
 * guest told `stale_epoch` knows its attempt was superseded and that retrying
 * is pointless. A thrown transport error would look identical for all of them,
 * which is how a real refusal becomes indistinguishable from a broken pipe.
 */

/** The one failure the candidate-output promotion adds to the material service's own. */
export class FactoryCandidateOutputError extends Error {
  readonly code = "output_not_canonical_json";
  constructor() {
    super("A promoted candidate output must be canonical I-JSON.");
    this.name = "FactoryCandidateOutputError";
  }
}

/** Everything the broker needs, each built per attempt from verified authority. */
export interface FactoryGuestMaterialServices {
  materials(authority: FactoryAttemptAuthority): FactoryAttemptMaterials;
  reader(authority: FactoryAttemptAuthority): FactoryScopedArtifactReader;
  /** Promotes verified sealed bytes to this attempt's candidate output. */
  output(authority: FactoryAttemptAuthority, content: Uint8Array): Promise<FactoryArtifactReference>;
}

export interface FactoryGuestMaterialBrokerOptions {
  readonly services: FactoryGuestMaterialServices;
  /**
   * Where a reverse payload that is not a staging frame goes. The model broker
   * is one, so composing the two must strand neither.
   */
  readonly delegate?: FactoryGuestBroker;
  readonly now?: () => number;
}

type FactoryGuestMaterialFrameIdentity = Pick<FactoryGuestMaterialRequest, "operationId" | "operationIndex" | "objectName" | "version">;

/**
 * Every refusal the material service can raise, named for the guest.
 *
 * The table is exhaustive on purpose: a code that reached here unmapped would
 * become `unavailable`, which reads to a guest as "try later" for a fault that
 * may be permanent. The suite asserts this table names every `factory_material_*`
 * code the service module declares, so a new one fails the test rather than
 * quietly becoming `unavailable`.
 */
export const FACTORY_GUEST_MATERIAL_REFUSALS: Readonly<Record<string, FactoryGuestMaterialRefusal>> = Object.freeze({
  factory_material_chunk_index_invalid: "chunk_out_of_order",
  factory_material_incomplete: "chunk_out_of_order",
  factory_material_checkpoint_cursor_invalid: "invalid_request",
  factory_material_digest_mismatch: "digest_mismatch",
  factory_material_chunk_digest_mismatch: "digest_mismatch",
  factory_material_bytes_changed: "digest_mismatch",
  factory_material_sealed: "sealed",
  factory_material_not_found: "unknown_material",
  factory_material_chunk_not_found: "unknown_material",
  factory_material_operation_full: "operation_full",
  factory_material_conflict: "conflict",
  factory_material_version_conflict: "conflict",
  factory_material_chunk_conflict: "conflict",
  factory_material_bytes_invalid: "oversize",
  factory_material_chunk_bytes_invalid: "oversize",
  factory_material_chunk_count_invalid: "oversize",
  factory_material_media_type_invalid: "invalid_request",
  factory_material_name_invalid: "invalid_request",
  factory_material_version_invalid: "invalid_request",
  factory_material_digest_invalid: "invalid_request",
  factory_material_manifest_invalid: "unavailable",
  factory_material_manifest_oversized: "unavailable",
  factory_material_scope_denied: "unknown_attempt",
  factory_material_scope_invalid: "unknown_attempt",
  factory_material_corrupt: "unavailable",
  factory_material_admission_failed: "unavailable",
});

/** Which SDK issue codes mean the frame asked for more than the channel carries. */
const OVERSIZE_ISSUES: ReadonlySet<string> = new Set(["GUEST_MATERIAL_BYTES", "GUEST_MATERIAL_CHUNK_BYTES", "GUEST_MATERIAL_CHUNK_COUNT"]);

function detail(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message.slice(0, 4_096) : fallback;
}

/** The run lifecycle's refusals of an attempt's authority, named for the guest. */
const RUN_LIFECYCLE_REFUSALS: Readonly<Record<string, FactoryGuestMaterialRefusal>> = Object.freeze({
  factory_run_not_found: "unknown_attempt",
  factory_scope_mismatch: "unknown_attempt",
  factory_run_fence_changed: "stale_epoch",
  factory_run_stopped: "stale_epoch",
  factory_run_terminal: "stale_epoch",
});

/** The grant refusals that mean the run's initiator no longer holds its authority. */
const GRANT_REFUSALS: Readonly<Record<string, FactoryGuestMaterialRefusal>> = Object.freeze({
  factory_forbidden: "stale_epoch",
  factory_grant_stale: "stale_epoch",
});

/**
 * Classifies one failure.
 *
 * Every refusal the services raise is typed and maps by its code: the
 * material service's own, the journal's liveness fence (an attempt never
 * admitted here is `unknown_attempt`; one whose fence moved is `stale_epoch`),
 * and the run lifecycle and grant checks the fence calls. Anything untyped is
 * a fault in the database or the object store, not a decision about this
 * attempt, so it is `unavailable`: the guest retries rather than stops.
 */
export function factoryGuestMaterialRefusal(error: unknown): FactoryGuestMaterialRefusal {
  if (error instanceof FactoryCandidateOutputError) return "output_not_canonical_json";
  if (error instanceof FactoryMaterialError) return FACTORY_GUEST_MATERIAL_REFUSALS[error.code] ?? "unavailable";
  if (error instanceof FactoryArtifactAccessError) return "unknown_material";
  if (error instanceof FactoryAttemptLivenessError) return error.code === "factory_attempt_unknown" ? "unknown_attempt" : "stale_epoch";
  if (error instanceof FactoryRunLifecycleError) return RUN_LIFECYCLE_REFUSALS[error.code] ?? "unavailable";
  if (error instanceof FactoryGrantError) return GRANT_REFUSALS[error.code] ?? "unavailable";
  return "unavailable";
}

/**
 * The identity a refusal echoes when the frame itself did not validate.
 *
 * A guest correlates an answer by these four fields, so a refusal that dropped
 * them would be unattributable. They are clamped to shapes the response schema
 * accepts, because an invalid frame can carry anything at all.
 */
function frameIdentity(payload: unknown): FactoryGuestMaterialFrameIdentity {
  const value = (payload ?? {}) as Partial<FactoryGuestMaterialFrameIdentity>;
  const operationIndex = Number.isSafeInteger(value.operationIndex) && (value.operationIndex as number) >= 0 ? value.operationIndex as number : 0;
  const named = typeof value.operationId === "string" && value.operationId.length > 0 && value.operationId.length <= 512 && value.operationId.endsWith(`:${operationIndex}`);
  const objectName = typeof value.objectName === "string" && value.objectName.length > 0 && value.objectName.length <= 512 && !value.objectName.includes("/") ? value.objectName : "unknown";
  return {
    operationId: named ? value.operationId as string : `unknown:${operationIndex}`,
    operationIndex,
    objectName,
    version: Number.isSafeInteger(value.version) && (value.version as number) >= 1 ? value.version as number : 1,
  };
}

/**
 * One answer's own fields, without the identity every answer echoes.
 *
 * `Omit` over a union collapses it to the fields the members share, which here
 * is `status` alone; the conditional distributes it across the members instead,
 * so a `begun` answer cannot be built with a `sealed` answer's fields.
 */
type FactoryGuestMaterialOutcome = FactoryGuestMaterialResponse extends infer Member
  ? Member extends FactoryGuestMaterialResponse ? Omit<Member, keyof FactoryGuestMaterialFrameIdentity | "schemaVersion"> : never
  : never;

/**
 * One answer, carrying the four identity fields and nothing else the frame had.
 *
 * The projection is explicit rather than a spread of the caller's object: a
 * frame is structurally assignable to the identity type, so spreading one would
 * leak its own `schemaVersion`, `mediaType` and payload into the answer, and
 * the generated response schema — which sets `additionalProperties: false` —
 * would then refuse every reply the host sent.
 */
function respond(source: FactoryGuestMaterialFrameIdentity, outcome: FactoryGuestMaterialOutcome): FactoryGuestMaterialResponse {
  return Object.freeze({
    schemaVersion: "factory.guest-material-response.v1",
    operationId: source.operationId,
    operationIndex: source.operationIndex,
    objectName: source.objectName,
    version: source.version,
    ...outcome,
  } as FactoryGuestMaterialResponse);
}

function refused(identity: FactoryGuestMaterialFrameIdentity, code: FactoryGuestMaterialRefusal, message: string): FactoryGuestMaterialResponse {
  return respond(identity, { status: "refused", refusal: Object.freeze({ code, message }) });
}

/**
 * The staging broker in the shape the wire needs: one verified attempt
 * authority and one frame.
 *
 * The in-process runtime holds the whole runner request and the remote host
 * route holds only what the attempt token proved, and the token proves the
 * authority. Deriving the authority once, at each edge, is what lets both
 * deployments share this one implementation instead of two.
 */
export interface FactoryGuestMaterialFrameBroker {
  frame(authority: FactoryAttemptAuthority, payload: unknown): Promise<FactoryGuestMaterialResponse>;
}

export function createFactoryGuestMaterialFrameBroker(options: Omit<FactoryGuestMaterialBrokerOptions, "delegate">): FactoryGuestMaterialFrameBroker {
  const now = options.now ?? Date.now;

  /** The one sealed record a promotion may name, proved against the frame's own digest. */
  const sealedRecord = async (materials: FactoryAttemptMaterials, identity: FactoryMaterialIdentity, digest: string): Promise<FactoryMaterialRecord & { artifact: FactoryArtifactReference }> => {
    const held = await materials.list({ tenantId: identity.tenantId, projectId: identity.projectId, runId: identity.runId, attemptId: identity.attemptId, operationId: identity.operationId });
    const record = held.find(candidate => candidate.objectName === identity.objectName && candidate.version === identity.version);
    if (!record?.sealed || !record.artifact) throw new FactoryMaterialError("factory_material_not_found");
    // The frame repeats the digest, so a promotion cannot name one version and
    // receive another version's bytes.
    if (record.digest !== digest) throw new FactoryMaterialError("factory_material_digest_mismatch");
    return record as FactoryMaterialRecord & { artifact: FactoryArtifactReference };
  };

  const staged = async (frame: FactoryGuestMaterialRequest, materials: FactoryAttemptMaterials, identity: FactoryMaterialIdentity, authority: FactoryAttemptAuthority): Promise<FactoryGuestMaterialResponse> => {
    if (frame.schemaVersion === "factory.guest-material-begin.v1") {
      const record = await materials.begin(identity, frame.mediaType, frame.totalBytes, frame.chunkCount);
      return respond(frame, { status: "begun", totalBytes: record.totalBytes, chunkCount: record.chunkCount });
    }
    if (frame.schemaVersion === "factory.guest-material-chunk.v1") {
      let content: Uint8Array;
      // The strict decoder also refuses non-zero trailing bits, which the frame
      // validator does not check. That is a malformed frame, not a stale
      // attempt, so it is named here rather than falling to the catch below.
      try { content = decodeFactoryPageBase64(frame.contentBase64); }
      catch (error) { return refused(frame, "invalid_request", detail(error, "A chunk's base64 content is not canonical.")); }
      await materials.writeChunk(identity, { index: frame.index, digest: frame.digest, encodedBytes: frame.encodedBytes }, content);
      return respond(frame, { status: "stored", index: frame.index, digest: frame.digest });
    }
    if (frame.schemaVersion === "factory.guest-material-seal.v1") {
      const material = await materials.seal(identity, frame.digest);
      return respond(frame, { status: "sealed", material });
    }
    const record = await sealedRecord(materials, identity, frame.digest);
    const content = await options.services.reader(authority).read(identity, record.artifact);
    const output = await options.services.output(authority, content);
    // The candidate artifact's own digest IS the result digest, minus the
    // namespace: `verifyCompletedEvidence` compares `output.digest` with
    // `sha256:${resultDigest}`, so deriving one from the other is what makes
    // the pair impossible to disagree.
    return respond(frame, { status: "output", output, resultDigest: output.digest.slice("sha256:".length) });
  };

  return Object.freeze({
    async frame(authority: FactoryAttemptAuthority, payload: unknown): Promise<FactoryGuestMaterialResponse> {
      const validation = validateFactoryGuestMaterialRequest(payload);
      if (!validation.ok) {
        const code: FactoryGuestMaterialRefusal = OVERSIZE_ISSUES.has(validation.issues[0]?.code ?? "") ? "oversize" : "invalid_request";
        return refused(frameIdentity(payload), code, validation.issues[0]?.message ?? "A guest staging frame is invalid.");
      }
      const request = payload as FactoryGuestMaterialRequest;

      // Checked here rather than left to the journal, because the attempt's own
      // signed deadline is a fact this adapter already holds and the journal
      // refuses an expired attempt together with five other reasons.
      if (authority.deadlineAt.getTime() <= now()) return refused(request, "deadline_expired", "This attempt's effect deadline has passed; no further material may be staged.");

      let materials: FactoryAttemptMaterials;
      try { materials = options.services.materials(authority); }
      catch (error) { return refused(request, "unknown_attempt", detail(error, "This host serves no material service for that attempt.")); }

      const identity: FactoryMaterialIdentity = { ...materials.scope(request.operationId), objectName: request.objectName, version: request.version };
      try { return await staged(request, materials, identity, authority); }
      catch (error) { return refused(request, factoryGuestMaterialRefusal(error), detail(error, "The material service refused this frame.")); }
    },
  });
}

/**
 * The same broker behind the reverse-capability seam the in-process runtime
 * drives, which hands over the whole runner request.
 */
export function createFactoryGuestMaterialBroker(options: FactoryGuestMaterialBrokerOptions): FactoryGuestBroker {
  const frames = createFactoryGuestMaterialFrameBroker(options);
  return Object.freeze({
    async invoke(request: FactoryRunnerRequest, payload: unknown): Promise<unknown> {
      if (isFactoryGuestMaterialFrame(payload)) return frames.frame(factoryRunnerRequestAuthority(request), payload);
      if (options.delegate) return options.delegate.invoke(request, payload);
      throw new FactoryGuestFrameError("frame_invalid", "Factory guest reverse payload is not a staging frame and this broker has no other route.");
    },
  });
}

export interface FactoryCandidateOutputWriterOptions {
  readonly database: TransactionalDb;
  readonly artifacts: FactoryArtifacts;
  readonly journal: FactoryExecutionJournal;
}

/**
 * Promotes one sealed material to the attempt's candidate output.
 *
 * The bytes are neither resent nor re-derived: they are the exact verified
 * bytes the scoped reader returned. Both facts a candidate output carries — its
 * node instance and its candidate generation — come from the verified attempt
 * authority, so a guest cannot stage into another node's slot by asking. The
 * write recomputes the journal's liveness fence in its own transaction, so an
 * attempt cancelled or superseded between the seal and the promotion cannot
 * commit a candidate.
 *
 * `stageCandidateOutputInTransaction` is idempotent at that coordinate: the
 * same bytes return the same reference and different bytes conflict, which is
 * what makes a promotion safe to repeat after a lost response.
 */
export function createFactoryCandidateOutputWriter(options: FactoryCandidateOutputWriterOptions): (authority: FactoryAttemptAuthority, content: Uint8Array) => Promise<FactoryArtifactReference> {
  return async (authority: FactoryAttemptAuthority, content: Uint8Array): Promise<FactoryArtifactReference> => {
    // `artifactJson.parse` is the SAME rule `verifyCompletedEvidence` applies
    // to these bytes on the way back out, called rather than restated so the
    // two cannot drift. Checked before the transaction opens, because a guest
    // that promoted the wrong bytes should learn that rather than hold a row
    // lock while it does.
    try { artifactJson.parse(content); }
    catch { throw new FactoryCandidateOutputError(); }
    return options.database.transaction(async (transaction: MigrationDb) => {
      await options.journal.authorizeMaterialWriteInTransaction(transaction, authority);
      return options.artifacts.stageCandidateOutputInTransaction(
        transaction,
        { tenantId: authority.tenantId, projectId: authority.projectId, logicalRunId: authority.runId },
        authority.nodeInstanceId,
        authority.candidateGeneration,
        content,
      );
    });
  };
}

/**
 * The broker's services over one database, one artifact store, and one journal.
 *
 * Each attempt gets its own material service bound to its verified authority.
 * The reader and the candidate writer hold no authority of their own, so one
 * of each serves every attempt.
 */
export function createFactoryGuestMaterialServices(options: FactoryMaterialStoreOptions & { readonly journal: FactoryExecutionJournal }): FactoryGuestMaterialServices {
  const reader = new FactoryScopedMaterials(options);
  return Object.freeze({
    materials: (authority: FactoryAttemptAuthority) => new FactoryAttemptMaterials({ ...options, authority }),
    reader: () => reader,
    output: createFactoryCandidateOutputWriter(options),
  });
}
