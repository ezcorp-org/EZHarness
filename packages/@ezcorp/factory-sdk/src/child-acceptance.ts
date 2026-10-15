import type { JsonValue, PortSchema } from "./types.js";

export const FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION = "factory.child-acceptance.v1" as const;

/**
 * What a child composed with `releaseMode: "none"` returns (C10).
 *
 * `none` "returns accepted artifact/evidence references without creating
 * release operations", and this is that return value. It names the accepted
 * bytes and the sealed acceptance decision that accepted them; nothing here is
 * a release, an effect claim, or an approval.
 *
 * The evidence reference is the DECISION, not a list of artifacts. A parent
 * that needs the child's evidence proves it through the sealed decision and
 * binds the accepted artifact through the child-artifact alias, both of which
 * re-verify every ancestry fact. Copying an evidence list into this envelope
 * would hand the parent a set of references it could not check.
 *
 * **A child's acceptance is never the parent's.** This envelope is an input to
 * the parent's own protected checks and its own acceptance node; the parent's
 * acceptance decision lives in a different table entirely.
 *
 * It lives in the SDK, beside the reference definitions, because the value and
 * the port schema that admits it must be one declaration. The host writes the
 * value and `references.ts` declares the port; two mirrored copies in trees
 * that cannot import each other would drift, and the drift would be a parent
 * silently accepting a shape its own contract never described.
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

export class FactoryChildAcceptanceError extends Error {
  constructor(readonly code: "factory_child_acceptance_invalid") {
    super(code);
    this.name = "FactoryChildAcceptanceError";
  }
}

/** `sha256:` plus 64 lower-case hex, which is 71 characters. */
const DIGEST_LENGTH = 71;
const DIGEST_PREFIX = "sha256:";
const HEX = "0123456789abcdef";

/**
 * Digest check without a regular expression.
 *
 * `validation.ts` and `expressions.ts` are the two files the C13 boundary check
 * forbids regular expressions in, and this file is neither — but it is compiled
 * into the same deterministic closure and read by the same validators, so it
 * keeps the same discipline rather than relying on being just outside the rule.
 */
function isDigest(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== DIGEST_LENGTH || !value.startsWith(DIGEST_PREFIX)) return false;
  for (let index = DIGEST_PREFIX.length; index < value.length; index += 1) {
    if (!HEX.includes(value[index] as string)) return false;
  }
  return true;
}

/**
 * The port schema a parent declares for an acceptance-only child.
 *
 * Deriving both the value and this schema from one module is what makes the
 * output port a real boundary: a publishing child's provider receipt has no
 * `releaseMode` and no sealed decision, so it can never satisfy this, and an
 * `authorized` child cannot be quietly composed where a `none` one was
 * declared.
 */
export const factoryChildAcceptancePortSchema: PortSchema = Object.freeze({
  type: "object",
  properties: {
    schemaVersion: { type: "string", enum: [FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION] },
    releaseMode: { type: "string", enum: ["none"] },
    decisionId: { type: "string", minLength: 1 },
    contractDigest: { type: "string", minLength: DIGEST_LENGTH, maxLength: DIGEST_LENGTH },
    candidateDigest: { type: "string", minLength: DIGEST_LENGTH, maxLength: DIGEST_LENGTH },
    evidenceSetDigest: { type: "string", minLength: DIGEST_LENGTH, maxLength: DIGEST_LENGTH },
    artifact: {
      type: "object",
      properties: {
        digest: { type: "string", minLength: DIGEST_LENGTH, maxLength: DIGEST_LENGTH },
        mediaType: { type: "string", minLength: 1 },
        storage: { type: "string", minLength: 1 },
      },
      required: ["digest", "mediaType", "storage"],
      additionalProperties: false,
    },
  },
  required: ["schemaVersion", "releaseMode", "decisionId", "contractDigest", "candidateDigest", "evidenceSetDigest", "artifact"],
  additionalProperties: false,
} satisfies PortSchema);

/**
 * Refuses anything that is not an acceptance-only result.
 *
 * Every field is named rather than spread, so a caller that hands in a wider
 * object cannot smuggle one through: the returned value carries exactly the
 * seven fields and nothing else.
 */
export function assertFactoryChildAcceptanceResult(value: unknown): FactoryChildAcceptanceResult {
  const candidate = value as Partial<FactoryChildAcceptanceResult> | null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || candidate.schemaVersion !== FACTORY_CHILD_ACCEPTANCE_SCHEMA_VERSION
    || candidate.releaseMode !== "none"
    || typeof candidate.decisionId !== "string" || candidate.decisionId.length === 0
    || !isDigest(candidate.contractDigest)
    || !isDigest(candidate.candidateDigest)
    || !isDigest(candidate.evidenceSetDigest)
    || candidate.artifact === undefined) throw new FactoryChildAcceptanceError("factory_child_acceptance_invalid");
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
