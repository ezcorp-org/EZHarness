import { canonicalizeJson, sha256Hex } from "./canonical.js";
import type { FactoryApiRequest, JsonValue, ValidationResult } from "./types.js";

/** Canonical idempotency payload. Caller key and claimed digest are not self-hashed. */
export function factoryApiMutationPayload(request: FactoryApiRequest): JsonValue {
  if (!("preconditions" in request)) throw new TypeError("Factory API request is not a mutation.");
  const { preconditions, ...fields } = request;
  return JSON.parse(canonicalizeJson({ ...fields, preconditions: { expectedRevision: preconditions.expectedRevision } } as unknown as JsonValue)) as JsonValue;
}

/** Raw lowercase sha256 of the canonical mutation payload. */
export function factoryApiPayloadDigest(request: FactoryApiRequest): string {
  return sha256Hex(canonicalizeJson(factoryApiMutationPayload(request)));
}

/** Compare the claimed route-wrapper digest with the canonical SDK payload. */
export function validateFactoryApiPayloadDigest(request: FactoryApiRequest): ValidationResult {
  if (!("preconditions" in request)) return { ok: false, issues: [{ code: "API_NOT_MUTATION", message: "Factory API request is not a mutation.", path: [] }] };
  return request.preconditions.payloadDigest === factoryApiPayloadDigest(request)
    ? { ok: true }
    : { ok: false, issues: [{ code: "API_PAYLOAD_DIGEST_MISMATCH", message: "Mutation payload digest does not match its canonical request.", path: ["preconditions", "payloadDigest"] }] };
}
