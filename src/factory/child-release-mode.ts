import type { JsonValue } from "@ezcorp/factory-sdk";
import { digestObject } from "../extensions/v4/blobs";

export const FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION = "factory.child-acceptance.v1" as const;

/**
 * The release authority a run inherits from the subfactory nodes above it.
 *
 * `root` is a run with no parent binding. `none` wins over `authorized`
 * anywhere in the chain: a grandchild cannot be more authorized than the
 * child that composed it, and composing an acceptance-only child must not be
 * a way to reach a publishing grandchild.
 */
export type FactoryInheritedReleaseMode = "root" | "authorized" | "none";

/** The most restrictive of two inherited modes. */
export function narrowerFactoryReleaseMode(left: FactoryInheritedReleaseMode, right: FactoryInheritedReleaseMode): FactoryInheritedReleaseMode {
  if (left === "none" || right === "none") return "none";
  if (left === "authorized" || right === "authorized") return "authorized";
  return "root";
}

/**
 * What an acceptance-only child returns instead of a release receipt (C10).
 *
 * `releaseMode: "none"` "returns accepted artifact/evidence references
 * without creating release operations", and this is that return value. It
 * names the accepted bytes and the sealed acceptance decision that accepted
 * them; nothing here is a release, an effect claim, or an approval.
 *
 * The evidence reference is the decision, not a list of artifacts. A parent
 * that needs the child's evidence proves it through the sealed decision
 * (`FactoryAssurance.readSealedDecisionInTransaction`) and binds the accepted
 * artifact through `FactoryChildArtifacts`, which re-verifies every ancestry
 * fact. Copying an evidence list into this envelope would hand the parent a
 * set of references it could not check, which is the opposite of the point.
 *
 * **A child's acceptance is never the parent's.** This envelope is an input
 * to the parent's own protected checks and its own acceptance node, and the
 * parent's acceptance decision lives in a different table entirely.
 */
export interface FactoryChildAcceptanceResult {
  readonly schemaVersion: typeof FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION;
  readonly releaseMode: "none";
  /** The child's sealed acceptance decision. */
  readonly decisionId: string;
  readonly contractDigest: string;
  readonly candidateDigest: string;
  /** Seals the whole evidence set the decision was taken over. */
  readonly evidenceSetDigest: string;
  /** Exactly the value the child's acceptance decision accepted. */
  readonly artifact: JsonValue;
}

export class FactoryChildReleaseModeError extends Error {
  constructor(readonly code: "factory_child_release_mode_invalid") {
    super(code);
    this.name = "FactoryChildReleaseModeError";
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Builds the envelope from a sealed acceptance decision. */
export function factoryChildAcceptanceResult(input: {
  readonly decisionId: string;
  readonly contractDigest: string;
  readonly candidateDigest: string;
  readonly evidenceSetDigest: string;
  readonly artifact: JsonValue;
}): FactoryChildAcceptanceResult {
  return assertFactoryChildAcceptanceResult({
    schemaVersion: FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION,
    releaseMode: "none",
    decisionId: input.decisionId,
    contractDigest: input.contractDigest,
    candidateDigest: input.candidateDigest,
    evidenceSetDigest: input.evidenceSetDigest,
    artifact: input.artifact,
  });
}

/**
 * Refuses anything that is not an acceptance-only result.
 *
 * A parent whose subfactory port declares this shape is refusing a publishing
 * child's receipt by construction: a release receipt has no `releaseMode` and
 * no sealed decision, so it can never satisfy the schema.
 */
export function assertFactoryChildAcceptanceResult(value: unknown): FactoryChildAcceptanceResult {
  const candidate = value as Partial<FactoryChildAcceptanceResult> | null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || candidate.schemaVersion !== FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION
    || candidate.releaseMode !== "none"
    || typeof candidate.decisionId !== "string" || candidate.decisionId.length === 0
    || typeof candidate.contractDigest !== "string" || !DIGEST.test(candidate.contractDigest)
    || typeof candidate.candidateDigest !== "string" || !DIGEST.test(candidate.candidateDigest)
    || typeof candidate.evidenceSetDigest !== "string" || !DIGEST.test(candidate.evidenceSetDigest)
    || candidate.artifact === undefined) throw new FactoryChildReleaseModeError("factory_child_release_mode_invalid");
  return Object.freeze({
    schemaVersion: FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION,
    releaseMode: "none",
    decisionId: candidate.decisionId,
    contractDigest: candidate.contractDigest,
    candidateDigest: candidate.candidateDigest,
    evidenceSetDigest: candidate.evidenceSetDigest,
    artifact: candidate.artifact,
  });
}

/** A stable identity for one acceptance-only result, for receipts and traces. */
export function factoryChildAcceptanceDigest(result: FactoryChildAcceptanceResult): string {
  return `sha256:${digestObject(result)}`;
}
