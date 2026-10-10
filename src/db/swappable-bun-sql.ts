/**
 * A Bun.sql pool that can be replaced under a live Drizzle handle.
 *
 * Why (W09f): Bun 1.3.14's Postgres request queue can leave a pooled
 * connection with its prepared-statement bookkeeping out of step with the
 * server (a Bind sent to another query's statement, 08P01). Bun offers no way
 * to evict one chosen pooled connection, so the only discard that reaches a
 * poisoned connection is the whole pool: open a fresh one, route all new work
 * to it, and close the old one after its in-flight work drains.
 *
 * Drizzle keeps the client it was built with, and the rest of the process
 * keeps that Drizzle handle, so the swap happens underneath: `client` forwards
 * every call, property read and write to whichever pool is current. A
 * transaction already running on the old pool holds the old pool's reserved
 * connection and finishes there; the drain timeout bounds how long that is
 * allowed to take.
 *
 * The old pool's close is also raced against its own deadline (the drain time
 * plus `DB_POOL_CLOSE_DEADLINE_MS`). A close that never returns, which Bun
 * 1.3.14 can do when a queued request was never written, is reported and left
 * behind. Without that bound the pending close kept `replace()` returning the
 * same finished-looking promise, so every later replacement was silently
 * skipped (W16d).
 */
import { DB_POOL_CLOSE_DEADLINE_MS, withinDeadline } from "../shutdown-deadlines";

export interface BunSqlLike {
  (...args: unknown[]): unknown;
  close(options?: { timeout?: number }): Promise<unknown>;
}

export interface SwappableBunSql<Client extends BunSqlLike> {
  /** The client to hand to Drizzle; every call reaches the current pool. */
  readonly client: Client;
  /** Pools opened so far: 1 until the first replacement. */
  readonly generation: number;
  /** Replace the pool. Concurrent calls share one replacement. */
  replace(): Promise<void>;
}

export interface SwappableBunSqlOptions {
  /** Seconds the old pool may spend finishing in-flight work before it is closed hard. */
  readonly drainSeconds: number;
  /** Where a failure to close the old pool is reported; it never fails the replacement. */
  readonly onCloseError: (error: unknown) => void;
  /** How long the old pool's close may take in all; defaults to the drain time plus `DB_POOL_CLOSE_DEADLINE_MS`. */
  readonly closeDeadlineMs?: number;
}

export function swappableBunSql<Client extends BunSqlLike>(open: () => Client, options: SwappableBunSqlOptions): SwappableBunSql<Client> {
  let current = open();
  let generation = 1;
  let replacing: Promise<void> | null = null;

  const client = new Proxy(function forwardedBunSql() {} as unknown as Client, {
    apply: (_target, _thisArg, args: unknown[]) => Reflect.apply(current, current, args),
    get: (_target, property) => {
      const value = Reflect.get(current, property, current) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(current) : value;
    },
    set: (_target, property, value) => Reflect.set(current, property, value),
    has: (_target, property) => Reflect.has(current, property),
  });

  const replace = (): Promise<void> => {
    if (replacing) return replacing;
    const old = current;
    current = open();
    generation += 1;
    const deadlineMs = options.closeDeadlineMs ?? options.drainSeconds * 1_000 + DB_POOL_CLOSE_DEADLINE_MS;
    replacing = withinDeadline(old.close({ timeout: options.drainSeconds }), deadlineMs)
      .then(({ settled }) => {
        if (!settled) options.onCloseError(new Error(`the replaced pool did not close within ${deadlineMs} ms; left to the process exit`));
      }, (error: unknown) => { options.onCloseError(error); })
      .finally(() => { replacing = null; });
    return replacing;
  };

  return {
    client,
    get generation() { return generation; },
    replace,
  };
}
