/**
 * Resource-aware local-model support gate for Topic Contexts.
 *
 * The default lane runs on a local sidecar model (see `src/suggest/config.ts`
 * — now a 4B-class tag). A modest CPU-only host may not be able to LOAD that
 * model: the first real detection/extraction call would then hang for the full
 * 120s completion budget before failing. This module probes support BEFORE any
 * real use so the ladder can skip the sidecar and fall back cleanly, and the UI
 * can tell the user why.
 *
 * The probe is a BINARY supported/unsupported check (design decision — no
 * adaptive tier-picking, no auto-downgrade). Ground truth for "the machine can
 * run it" is a REAL tiny inference (exercises RAM + weight load + the server's
 * configured context window), reusing the `local-model-check` helpers.
 *
 * State lifecycle:
 *   - in-memory, keyed by `baseUrl::model` (no DB persistence — the on/off
 *     switch is server state);
 *   - supported results cached for `SUPPORTED_TTL_MS` (5 min), failures for a
 *     shorter `FAILURE_TTL_MS` (1 min) so a box whose Ollama just finished
 *     loading recovers quickly;
 *   - a change to `suggest:model` / `suggest:ollama-url` changes the resolved
 *     key, so the next lookup re-probes automatically; `invalidateModelSupport`
 *     force-clears every entry (used by the settings "re-check" affordance);
 *   - `warmupModelSupport` primes the default-local entry at boot (precedent:
 *     the suggestions/embedding warmups in `src/startup/background-timers.ts`).
 *
 * Every dependency is injectable so each branch is unit-testable with no
 * network, DB, or model.
 */

import {
  checkEndpointReachability,
  checkModelAvailability,
  testInference,
} from "../providers/local-model-check";
import { getSuggestConfig } from "../suggest/config";
import { logger } from "../logger";

const log = logger.child("contexts.model-support");

/** Why a model is unsupported. `endpoint-down` also covers "no local endpoint
 *  is configured at all" (there is nothing to reach). */
export type ModelSupportReason = "endpoint-down" | "model-missing" | "load-failed" | "timeout";

export interface ModelSupportResult {
  supported: boolean;
  baseUrl: string;
  model: string;
  reason?: ModelSupportReason;
  /** Epoch ms the probe completed — drives TTL expiry. */
  checkedAt: number;
}

/** Cold-load budget for the ground-truth inference. A multi-GB model + KV
 *  cache can take well past the 15s default on a CPU-only host. */
export const MODEL_SUPPORT_LOAD_BUDGET_MS = 30_000;
/** A supported model rarely becomes unsupported mid-session; cache generously. */
export const SUPPORTED_TTL_MS = 5 * 60_000;
/** Re-probe failures sooner so a box that just finished loading recovers. */
export const FAILURE_TTL_MS = 60_000;

export interface ModelSupportDeps {
  checkReachability?: typeof checkEndpointReachability;
  checkAvailability?: typeof checkModelAvailability;
  runInference?: typeof testInference;
  getSuggestConfig?: () => Promise<{ baseUrl: string | null; model: string }>;
  nowFn?: () => number;
}

/** Strip trailing slashes/colons so the same endpoint keys consistently. */
function normalizeUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/[/:]+$/, "");
}

function cacheKey(baseUrl: string, model: string): string {
  return `${normalizeUrl(baseUrl)}::${model}`;
}

const cache = new Map<string, ModelSupportResult>();

/** Classify a failed inference: an abort/timeout means the load budget was
 *  exceeded (the machine is too slow / can't fit it); anything else is a hard
 *  load failure (OOM, model error). */
function classifyInferenceError(error: string | undefined): ModelSupportReason {
  return /timeout|abort|timed out/i.test(error ?? "") ? "timeout" : "load-failed";
}

/**
 * Probe whether the machine can actually run `model` at `baseUrl`:
 *   1. endpoint reachable,
 *   2. model tag present,
 *   3. a real tiny inference completes within the cold-load budget.
 * Returns the binary result + the failing reason. Never throws.
 */
export async function checkModelSupport(
  baseUrl: string,
  model: string,
  deps: ModelSupportDeps = {},
): Promise<ModelSupportResult> {
  const now = (deps.nowFn ?? Date.now)();
  const checkReachability = deps.checkReachability ?? checkEndpointReachability;
  const checkAvailability = deps.checkAvailability ?? checkModelAvailability;
  const runInference = deps.runInference ?? testInference;

  const reach = await checkReachability(baseUrl);
  if (!reach.reachable || !reach.endpointType) {
    return { supported: false, baseUrl, model, reason: "endpoint-down", checkedAt: now };
  }

  const avail = await checkAvailability(baseUrl, model, reach.endpointType);
  if (!avail.available) {
    return { supported: false, baseUrl, model, reason: "model-missing", checkedAt: now };
  }

  const inference = await runInference(baseUrl, model, reach.endpointType, MODEL_SUPPORT_LOAD_BUDGET_MS);
  if (inference.success) {
    return { supported: true, baseUrl, model, checkedAt: now };
  }
  return {
    supported: false,
    baseUrl,
    model,
    reason: classifyInferenceError(inference.error),
    checkedAt: now,
  };
}

/** True when a cached result is still within its (supported/failure) TTL. */
function isFresh(result: ModelSupportResult, now: number): boolean {
  const ttl = result.supported ? SUPPORTED_TTL_MS : FAILURE_TTL_MS;
  return now - result.checkedAt < ttl;
}

/**
 * Support state for `baseUrl`/`model`, probing (and caching) on a cold or
 * expired entry. Callers on the WRITE path (detect/extract, about to make a
 * 120s LLM call anyway) use this — a bounded 30s probe is far cheaper than the
 * hang it prevents.
 */
export async function getModelSupport(
  baseUrl: string,
  model: string,
  deps: ModelSupportDeps = {},
): Promise<ModelSupportResult> {
  const now = (deps.nowFn ?? Date.now)();
  const key = cacheKey(baseUrl, model);
  const hit = cache.get(key);
  if (hit && isFresh(hit, now)) return hit;

  const result = await checkModelSupport(baseUrl, model, { ...deps, nowFn: () => now });
  cache.set(key, result);
  return result;
}

/**
 * Cached-only read — NEVER probes. Callers on the READ path (the GET topics
 * capability field, which must render instantly) use this: a cold entry
 * returns null and the caller treats "unknown" optimistically. Boot warmup
 * normally primes it before the first read.
 */
export function peekModelSupport(
  baseUrl: string,
  model: string,
  now: number = Date.now(),
): ModelSupportResult | null {
  const hit = cache.get(cacheKey(baseUrl, model));
  if (hit && isFresh(hit, now)) return hit;
  return null;
}

/** Force a fresh probe on the next lookup by clearing every cached entry.
 *  Wired to the settings "re-check" affordance. */
export function invalidateModelSupport(): void {
  cache.clear();
}

/** The effective default-local model (endpoint + tag) from the suggest config;
 *  `baseUrl` is null when no local endpoint is configured. */
export async function resolveLocalModel(
  deps: ModelSupportDeps = {},
): Promise<{ baseUrl: string | null; model: string }> {
  const getConfig = deps.getSuggestConfig ?? getSuggestConfig;
  const cfg = await getConfig();
  return { baseUrl: cfg.baseUrl, model: cfg.model };
}

/**
 * Prime the default-local support entry at boot so the first real use never
 * eats a cold 30s probe. Fire-and-forget + self-catching (the caller wraps it
 * in the never-block-boot contract); a null baseUrl (no local endpoint) is a
 * no-op.
 */
export async function warmupModelSupport(deps: ModelSupportDeps = {}): Promise<void> {
  try {
    const local = await resolveLocalModel(deps);
    if (!local.baseUrl) {
      log.info("no local suggestions endpoint configured; skipping model-support warmup");
      return;
    }
    const result = await getModelSupport(local.baseUrl, local.model, deps);
    log.info("model-support warmup complete", {
      model: local.model,
      supported: result.supported,
      reason: result.reason,
    });
  } catch (e) {
    log.warn("model-support warmup failed", { error: String(e) });
  }
}

/** Test-only: clear the in-memory cache between cases. */
export function _resetModelSupportForTests(): void {
  cache.clear();
}
