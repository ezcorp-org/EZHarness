import { createHash } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";

/** The v4 lifecycle bound, shared by every caller-facing idempotency key. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const FACTORY_IDEMPOTENCY_PREFIX = "factory:";

/** Match the v4 key rule without assigning an error type to its caller. */
export function isBoundedIdempotencyKey(key: string): boolean {
  return key.length > 0
    && key.length <= MAX_IDEMPOTENCY_KEY_LENGTH
    && ![...key].some((character) => character.charCodeAt(0) < 32);
}

/** Canonical, key-order-independent digest used to detect key reuse. */
export function idempotencyInputDigest(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export class InvalidIdempotencyKeyError extends Error {
  readonly code = "invalid_idempotency_key";

  constructor() {
    super("Provide a bounded idempotency key.");
    this.name = "InvalidIdempotencyKeyError";
  }
}

/** Put a caller key in the namespace reserved for factory-owned starts. */
export function factoryIdempotencyKey(callerKey: string): string {
  const key = `${FACTORY_IDEMPOTENCY_PREFIX}${callerKey}`;
  if (callerKey.length === 0 || !isBoundedIdempotencyKey(key)) {
    throw new InvalidIdempotencyKeyError();
  }
  return key;
}

export function isFactoryIdempotencyKey(key: string): boolean {
  return key.startsWith(FACTORY_IDEMPOTENCY_PREFIX)
    && key.length > FACTORY_IDEMPOTENCY_PREFIX.length
    && isBoundedIdempotencyKey(key);
}
