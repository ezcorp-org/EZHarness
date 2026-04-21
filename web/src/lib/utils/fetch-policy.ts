/**
 * Centralized fetch policy for the chat route (+page.svelte and its child
 * components). Exists because the chat page has many reactive effects,
 * polling intervals, and event handlers that all call `fetch()`
 * independently — and a single flaky SSE connection or an unguarded
 * $effect was enough to spam the server with N copies of the same request.
 *
 * Contract:
 *   - `userFetch(url, opts)` — use for fetches the USER initiated (send
 *     message, retry button, submit form, OAuth callback). Never
 *     throttled, never deduped.
 *   - `backgroundFetch(key, url, opts, policy?)` — use for EVERY
 *     background refresh (reactive effect, setInterval, reconnect
 *     re-sync). Returns `null` when throttled; returns the shared
 *     promise when an in-flight call for the same `key` already exists.
 *   - `invalidate(keyPrefix)` — clear throttle timestamps for all keys
 *     beginning with `keyPrefix`. Call on conversation switch.
 *
 * New fetch call sites in the chat area MUST pick one of the two
 * wrappers. The regression test `web/e2e/chat-fetch-budget.spec.ts`
 * enforces this by asserting a total-fetch budget over an adversarial
 * (flap + idle) scenario.
 */

interface BackgroundOpts {
  /** Minimum time between allowed calls for the same key. Default 5_000. */
  minIntervalMs?: number;
  /** If true and an identical-key call is in flight, return its promise. Default true. */
  dedupInFlight?: boolean;
}

/** Last-allowed timestamp, per semantic key. */
const lastFetchedAt = new Map<string, number>();
/** Currently in-flight promises, per semantic key. */
const inFlight = new Map<string, Promise<Response>>();

/**
 * Debug counters exposed on `window.__ezFetchStats` in non-production.
 * The budget regression test reads these to assert spam bounds.
 */
interface FetchStats {
  issued: Record<string, number>;
  throttled: Record<string, number>;
  deduped: Record<string, number>;
}
const stats: FetchStats = { issued: {}, throttled: {}, deduped: {} };

function bump(bucket: keyof FetchStats, key: string) {
  const b = stats[bucket];
  b[key] = (b[key] ?? 0) + 1;
}

if (typeof window !== 'undefined') {
  (window as unknown as { __ezFetchStats: FetchStats }).__ezFetchStats = stats;
}

/**
 * Throttled + deduped background fetch. Returns null when the call was
 * skipped because an identical key fired within `minIntervalMs`.
 */
export async function backgroundFetch(
  key: string,
  url: string,
  opts: RequestInit = {},
  policy: BackgroundOpts = {},
): Promise<Response | null> {
  const { minIntervalMs = 5_000, dedupInFlight = true } = policy;
  const method = (opts.method ?? 'GET').toUpperCase();

  // In-flight dedup only makes sense for idempotent reads. Never collapse
  // mutating requests — those are always user-initiated anyway.
  const isIdempotent = method === 'GET' || method === 'HEAD';

  if (dedupInFlight && isIdempotent) {
    const existing = inFlight.get(key);
    if (existing) {
      bump('deduped', key);
      return existing;
    }
  }

  const now = Date.now();
  const last = lastFetchedAt.get(key) ?? 0;
  if (now - last < minIntervalMs) {
    bump('throttled', key);
    return null;
  }
  lastFetchedAt.set(key, now);
  bump('issued', key);

  const promise = fetch(url, opts);
  if (dedupInFlight && isIdempotent) {
    inFlight.set(key, promise);
    // Clean up on settle. We consume the chained promise with a no-op
    // .catch so a rejected fetch() doesn't produce an unhandled rejection
    // (the ORIGINAL promise is still returned to the caller, who is
    // responsible for handling it — this just prevents the cleanup chain
    // from becoming an orphaned rejection).
    const cleanup = () => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    };
    promise.then(cleanup, cleanup);
  }
  return promise;
}

/**
 * Pass-through wrapper for user-initiated fetches. No throttle, no dedup.
 * Exists so call sites document intent: if you're using `userFetch` it's
 * because a human click is behind the request.
 */
export function userFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

/** Drop all throttle timestamps matching the prefix. */
export function invalidate(keyPrefix: string): void {
  for (const key of [...lastFetchedAt.keys()]) {
    if (key.startsWith(keyPrefix)) lastFetchedAt.delete(key);
  }
  // Don't clear inFlight — an in-flight request should still dedupe its
  // response. We just want to allow a NEW request to fire immediately.
}

/** Test-only helper: reset all state. Not exported from the barrel. */
export function __resetFetchPolicy_forTests(): void {
  lastFetchedAt.clear();
  inFlight.clear();
  stats.issued = {};
  stats.throttled = {};
  stats.deduped = {};
}

/** Test-only helper: read stats snapshot. */
export function __getFetchStats_forTests(): FetchStats {
  return {
    issued: { ...stats.issued },
    throttled: { ...stats.throttled },
    deduped: { ...stats.deduped },
  };
}
