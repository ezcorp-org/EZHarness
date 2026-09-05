// ── Async locks ─────────────────────────────────────────────────
//
// v4 invocations use host-held locks across workers. Standalone calls
// retain local sequencing. v4 createMutex requires a stable key.
//
// Rejections in `fn` do NOT poison the chain — a failing critical section
// still releases the next waiter. The rejection propagates to the caller
// who scheduled it.

/**
 * Module-level per-key queue of tail promises. The value is the promise
 * representing "everything scheduled on this key so far"; new callers
 * chain after it.
 *
 * Using `Promise<unknown>` instead of `Promise<void>` so we can reuse the
 * same entry for every subsequent caller without caring what they return.
 */
import { getExtensionContext } from "../v4/context";
import { ContractError } from "@ezcorp/extension-contract";

const tails = new Map<string, Promise<unknown>>();

async function hostLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const context = getExtensionContext();
  if (!context) return fn();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(key)) throw new ContractError("INVALID_LOCK", "Provide a stable lock key of 1-128 safe characters");
  const deadline = Math.min(context.invocation.deadline, Date.now() + 30_000);
  let fence: string | undefined;
  while (!fence) {
    context.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new ContractError("LOCK_TIMEOUT", "Lock wait exceeded its bounded deadline");
    const response = await context.call("ezcorp/lock.acquire", { key });
    if (!response || typeof response !== "object" || Array.isArray(response) || !("acquired" in response) || typeof response.acquired !== "boolean") throw new ContractError("INVALID_LOCK", "Invalid lock response");
    if (response.acquired) {
      if (!("fence" in response) || typeof response.fence !== "string" || response.fence.length > 128 || !response.fence) throw new ContractError("INVALID_LOCK", "Invalid lock fence");
      fence = response.fence;
    } else await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
  try { context.signal.throwIfAborted(); return await fn(); }
  finally { if (!context.signal.aborted && Date.now() < context.invocation.deadline) await context.call("ezcorp/lock.release", { key, fence }); }
}

/**
 * Serialize `fn` against every other call with the same `key`. Calls with
 * different keys run concurrently. Rejections in `fn` do not prevent
 * subsequent callers on the same key from running.
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();

  // The tail we publish back to the map: it resolves when `fn` settles
  // (success OR failure), so the next caller runs no matter what.
  const run = prev.then(() => hostLock(key, fn));
  // Publish a tail that NEVER rejects, so future `.then(() => fn())`
  // always moves forward. Caller still sees the real rejection via `run`.
  const tail = run.catch(() => undefined);

  tails.set(key, tail);

  // Opportunistic cleanup: if we're still the latest tail after this fn
  // settles, drop the map entry so keys don't leak forever.
  tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });

  return run;
}

/**
 * Create a single-chain mutex. A stable key is required inside v4 workers.
 * Rejection in `fn` does not poison the chain.
 */
export function createMutex(key?: string): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(() => {
      if (getExtensionContext() && key === undefined) throw new ContractError("LOCK_KEY_REQUIRED", "v4 createMutex requires a stable explicit key");
      return key === undefined ? fn() : hostLock(key, fn);
    });
    tail = run.catch(() => undefined);
    return run;
  };
}
