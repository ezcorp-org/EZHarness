import { canonicalJson } from "@ezcorp/extension-contract";
import type { JsonValue, RunnerReference } from "@ezcorp/factory-sdk";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryAcceptanceDecision } from "./assurance";
import { FACTORY_RELEASE_MAX_REQUEST_BYTES, type FactoryReleaseDestination, type FactoryReleaseMaterial } from "./releases";

export const FACTORY_RELEASE_RESOLVE_TIMEOUT_MS = 120_000;
export const FACTORY_RELEASE_PROFILE_RESULT_SCHEMA_VERSION = "factory.release-profile-result.v1" as const;

export interface FactoryReleaseProfileInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  /** Exact accepted candidate, already frozen by the acceptance decision. */
  readonly acceptedManifest: JsonValue;
  readonly requestedDestination: JsonValue;
  readonly decision: FactoryAcceptanceDecision;
  readonly material: FactoryReleaseMaterial;
}

export interface FactoryReleaseProfileResult {
  readonly schemaVersion: "factory.release-profile-result.v1";
  readonly destination: FactoryReleaseDestination;
  readonly request: JsonValue;
  readonly estimatedSpendMicros: number;
  /** `sha256:` digest of the canonical input this result was resolved from. */
  readonly inputDigest: string;
  /** `sha256:` digest of the canonical result, excluding this field. */
  readonly resultDigest: string;
  readonly resolvedAtMs: number;
}

/** What an adapter implements. `resolve` runs outside every transaction, under a deadline. */
export interface FactoryAsyncReleaseProfile {
  readonly adapter: RunnerReference;
  readonly action: string;
  /**
   * Selects the exact destination, request bytes, and estimated spend for one accepted candidate.
   *
   * The name matches `FactoryReleaseProviderResolver.resolve`, which is a different concern:
   * that one selects which provider serves an operation, this one builds the request that
   * provider will be given.
   */
  resolve(input: FactoryReleaseProfileInput, signal: AbortSignal): Promise<FactoryReleaseProfileResult>;
}

export class FactoryReleaseProfileError extends Error {
  constructor(readonly code: "factory_release_profile_invalid" | "factory_release_profile_stale" | "factory_release_profile_aborted") {
    super(code);
    this.name = "FactoryReleaseProfileError";
  }
}

const hash = (value: unknown): string => `sha256:${digestObject(value)}`;
const snapshot = <Value>(value: Value): Value => JSON.parse(canonicalJson(value)) as Value;

function invalid(): never {
  throw new FactoryReleaseProfileError("factory_release_profile_invalid");
}

/** The canonical seal of the input a result is bound to. */
export function factoryReleaseProfileInputDigest(input: FactoryReleaseProfileInput): string {
  return hash(snapshot(input));
}

/**
 * Completes a partial adapter result into a sealed one.
 *
 * Adapters call this rather than computing digests themselves, so the two digests always cover
 * the same canonical bytes that `assertFactoryReleaseProfileResult` later re-derives.
 */
export function sealFactoryReleaseProfileResult(
  input: FactoryReleaseProfileInput,
  value: Pick<FactoryReleaseProfileResult, "destination" | "request" | "estimatedSpendMicros">,
  resolvedAtMs: number,
): FactoryReleaseProfileResult {
  const body = {
    schemaVersion: FACTORY_RELEASE_PROFILE_RESULT_SCHEMA_VERSION,
    destination: snapshot(value.destination),
    request: snapshot(value.request),
    estimatedSpendMicros: value.estimatedSpendMicros,
    inputDigest: factoryReleaseProfileInputDigest(input),
    resolvedAtMs,
  } as const;
  return { ...body, resultDigest: hash(body) };
}

/**
 * Every rule the freeze names for a resolved profile.
 *
 * `expectedInputDigest` is the digest re-derived inside the final product transaction, so a
 * result that no longer matches its input is `factory_release_profile_stale` rather than a
 * publication against changed bytes.
 */
export function assertFactoryReleaseProfileResult(
  value: FactoryReleaseProfileResult,
  expectedInputDigest: string,
  nowMs: number,
): FactoryReleaseProfileResult {
  const result = snapshot(value);
  if (result.schemaVersion !== FACTORY_RELEASE_PROFILE_RESULT_SCHEMA_VERSION) invalid();
  if (Object.keys(result).length !== 7) invalid();
  if (!Number.isSafeInteger(result.estimatedSpendMicros) || result.estimatedSpendMicros < 0) invalid();
  if (!Number.isSafeInteger(result.resolvedAtMs) || result.resolvedAtMs < 1 || !Number.isSafeInteger(nowMs)) invalid();
  if (!/^sha256:[0-9a-f]{64}$/.test(result.inputDigest) || !/^sha256:[0-9a-f]{64}$/.test(result.resultDigest)) invalid();
  const destination = result.destination;
  if (typeof destination !== "object" || destination === null || Array.isArray(destination)) invalid();
  for (const field of [destination.provider, destination.account, destination.object]) {
    if (typeof field !== "string" || field.length < 1 || field.length > 512 || field.includes("\0")) invalid();
  }
  if (destination.expectedVersion !== undefined && (typeof destination.expectedVersion !== "string" || destination.expectedVersion.length < 1 || destination.expectedVersion.length > 512)) invalid();
  if (new TextEncoder().encode(canonicalJson(result.request)).byteLength > FACTORY_RELEASE_MAX_REQUEST_BYTES) invalid();
  const { resultDigest, ...body } = result;
  if (hash(body) !== resultDigest) invalid();
  if (result.inputDigest !== expectedInputDigest) throw new FactoryReleaseProfileError("factory_release_profile_stale");
  // A result older than the resolve timeout is unusable; re-resolve rather than reuse.
  if (nowMs - result.resolvedAtMs > FACTORY_RELEASE_RESOLVE_TIMEOUT_MS || result.resolvedAtMs > nowMs) throw new FactoryReleaseProfileError("factory_release_profile_stale");
  return result;
}

function abortReason(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(new FactoryReleaseProfileError("factory_release_profile_aborted")); return; }
    signal.addEventListener("abort", () => { reject(new FactoryReleaseProfileError("factory_release_profile_aborted")); }, { once: true });
  });
}

/**
 * Runs one adapter's `resolve` outside every transaction, under the caller's signal and the
 * resolve timeout, and returns a sealed, validated result.
 *
 * A profile that ignores its signal cannot hold the caller: the race rejects on abort, and a
 * result that arrives after the abort is refused rather than used.
 */
export async function resolveFactoryReleaseProfile(
  /** Only `resolve` is used, so a caller that holds its own request needs no adapter reference. */
  profile: Pick<FactoryAsyncReleaseProfile, "resolve">,
  input: FactoryReleaseProfileInput,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<FactoryReleaseProfileResult> {
  if (signal.aborted) throw new FactoryReleaseProfileError("factory_release_profile_aborted");
  const deadline = AbortSignal.timeout(FACTORY_RELEASE_RESOLVE_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, deadline]);
  const running = profile.resolve(snapshot(input), combined);
  running.catch(() => {});
  const resolved = await Promise.race([running, abortReason(combined)]);
  if (combined.aborted) throw new FactoryReleaseProfileError("factory_release_profile_aborted");
  return assertFactoryReleaseProfileResult(resolved, factoryReleaseProfileInputDigest(input), now());
}
