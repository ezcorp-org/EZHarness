/**
 * Every deadline a harness shutdown relies on, in one place so their order can
 * be read, and pinned by tests, without opening four modules.
 *
 * The harness shutdown (`web/src/lib/server/shutdown.ts`) drains requests for up
 * to 10 s, then runs its teardowns in reverse registration order, each for at
 * most `TEARDOWN_TIMEOUT_MS`, and force-exits at 25 s. Inside that:
 *
 *   - the factory roles stop within `FACTORY_WORKER_STOP_DEADLINE_MS`, so their
 *     per-role line is logged before the teardown deadline;
 *   - the database close (the last teardown) gives the pool
 *     `DB_POOL_CLOSE_DEADLINE_MS`, then spends at most
 *     `DB_OPEN_CONNECTIONS_QUERY_DEADLINE_MS` listing the connections still
 *     open, so the listing is logged before the teardown deadline too.
 *
 * Why these exist (W16d): W16's lifecycle holds found harness stops that never
 * finished, because one background step or the Bun.sql pool close awaited a
 * request the driver never completed.
 */

/** How long a stop of the factory background roles waits for in-flight steps. */
export const FACTORY_WORKER_STOP_DEADLINE_MS = 5_000;

/** How long closing the database pool may take before it is left to the process exit. */
export const DB_POOL_CLOSE_DEADLINE_MS = 3_000;

/** How long the one side query that lists still-open connections may take. */
export const DB_OPEN_CONNECTIONS_QUERY_DEADLINE_MS = 2_000;

/** How long one shutdown teardown may run before shutdown names it and moves on. */
export const TEARDOWN_TIMEOUT_MS = 6_000;

/** The outcome of racing work against a deadline. */
export type DeadlineOutcome<T> = { readonly settled: true; readonly value: T } | { readonly settled: false };

/**
 * Race `work` against a deadline of `milliseconds`.
 *
 * Resolves with the work's value when it settles first, and with
 * `{ settled: false }` when the deadline passes first; the work itself is left
 * running. A rejection of the work propagates. The timer never holds the
 * process open.
 */
export async function withinDeadline<T>(work: Promise<T>, milliseconds: number): Promise<DeadlineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<DeadlineOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), milliseconds);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then((value): DeadlineOutcome<T> => ({ settled: true, value })), expired]);
  } finally {
    clearTimeout(timer);
  }
}
