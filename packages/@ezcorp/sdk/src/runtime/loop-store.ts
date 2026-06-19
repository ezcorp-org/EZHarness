// ── Loop run store — Storage-backed, per-run keys, withLock ──────────
//
// LOCKED substrate (spec decision #2): run-state lives in the SDK
// `Storage` KV, ONE key per run (`loop:<loopId>:run:<runId>`) plus a small
// index key (`loop:<loopId>:index`) — NEVER one packed JSON blob. This
// fixes ez-code's single `"runs"` key, which read-modify-writes the whole
// array on every mutation and races under concurrent fires.
//
// Every mutation runs inside `withLock(<lock key>)` so two simultaneous
// fires can't clobber the index. The lock is in-process (one subprocess
// per extension), which is the correct scope: all fires for a loop run in
// the same subprocess, so serializing there serializes the only writers.
//
// Scope (`global` | `user` | `conversation`) is the Storage scope; the
// store is constructed per scope and the host partitions the KV rows
// accordingly.

import { Storage, type StorageScope } from "./storage";
import { withLock } from "./lock";
import {
  createRun,
  findOpenDuplicate,
  resolveContract,
  transition as coreTransition,
  trimRetention,
} from "./loop-core";
import type { NewRunInput } from "./loop-core";
import type {
  LoopContract,
  LoopRunState,
  ResolvedContract,
} from "./loop-types";

// Re-export so callers don't reach into loop-core for the input shape.
export type { NewRunInput } from "./loop-core";

/** Per-loop failure bookkeeping (consecutive permanent errors + disable
 *  latch). Kept in its own key so a fire's run write never races the
 *  failure counter. */
export interface LoopMeta {
  consecutiveErrors: number;
  disabled: boolean;
}

const EMPTY_META: LoopMeta = { consecutiveErrors: 0, disabled: false };

/** The `next`-state shape a transition applies. Mirrors `coreTransition`'s
 *  second parameter without the `Parameters<>` indirection (which breaks
 *  generic inference across the two `LoopRunState` instantiations). */
export interface LoopTransitionInput<Outcome = unknown> {
  /** Next run status. OMIT to keep the run's CURRENT status (resolved under
   *  the store lock) — use this for an event-only update (steered/pr_opened)
   *  so it can't race-revert a concurrent status flip. */
  status?: string;
  /** Status for the appended event-log entry; defaults to `status`. */
  eventStatus?: string;
  note?: string;
  outcome?: Outcome;
  externalRunId?: string;
  externalAssignmentId?: string;
  externalTaskId?: string;
  subConversationId?: string;
}

export interface LoopRunStore<Outcome = unknown> {
  readonly loopId: string;
  readonly scope: StorageScope;
  /**
   * Idempotent create. When `contract.idempotencyKey` matched an OPEN run,
   * returns `{ run, created: false }` with the existing run (the fire is a
   * no-op). Otherwise persists a fresh run + index entry and returns
   * `{ run, created: true }`. Trims retention after insert.
   */
  claim(
    input: NewRunInput<Outcome> & { idempotencyKey?: string },
  ): Promise<{ run: LoopRunState<Outcome>; created: boolean }>;
  /** Apply a transition to the run with `runId`. Returns the updated run,
   *  or null when no such run exists (idempotent for late/duplicate
   *  events). */
  transition(
    runId: string,
    next: LoopTransitionInput<Outcome>,
  ): Promise<LoopRunState<Outcome> | null>;
  /** Read one run, or null. */
  get(runId: string): Promise<LoopRunState<Outcome> | null>;
  /** All runs, newest first (index order). */
  list(): Promise<LoopRunState<Outcome>[]>;
  /** Failure bookkeeping. */
  getMeta(): Promise<LoopMeta>;
  setMeta(meta: LoopMeta): Promise<void>;
}

/** Storage key helpers — single source of the key grammar. */
export function runKey(loopId: string, runId: string): string {
  return `loop:${loopId}:run:${runId}`;
}
export function indexKey(loopId: string): string {
  return `loop:${loopId}:index`;
}
export function metaKey(loopId: string): string {
  return `loop:${loopId}:meta`;
}
function lockKey(loopId: string, scope: StorageScope): string {
  return `loop-store:${loopId}:${scope}`;
}

/**
 * Construct a run store for one loop + scope. `storageFactory` is injected
 * so tests can substitute an in-memory KV; production passes the real
 * `Storage` constructor.
 */
export function createLoopRunStore<Outcome = unknown>(
  loopId: string,
  contract: LoopContract<unknown> | ResolvedContract<unknown>,
  storageFactory: (scope: StorageScope) => Pick<
    Storage,
    "get" | "set" | "delete" | "list"
  > = (scope) => new Storage(scope),
): LoopRunStore<Outcome> {
  const resolved: ResolvedContract = isResolved(contract)
    ? contract
    : resolveContract(contract);
  const scope = resolved.scope;
  const storage = storageFactory(scope);
  const lk = lockKey(loopId, scope);

  async function readIndex(): Promise<string[]> {
    const res = await storage.get<string[]>(indexKey(loopId));
    return Array.isArray(res.value) ? res.value : [];
  }

  async function readRun(
    runId: string,
  ): Promise<LoopRunState<Outcome> | null> {
    const res = await storage.get<LoopRunState<Outcome>>(runKey(loopId, runId));
    return res.exists && res.value ? res.value : null;
  }

  async function readAll(ids: string[]): Promise<LoopRunState<Outcome>[]> {
    const runs: LoopRunState<Outcome>[] = [];
    for (const id of ids) {
      const run = await readRun(id);
      if (run) runs.push(run);
    }
    return runs;
  }

  return {
    loopId,
    scope,

    async claim(input) {
      return withLock(lk, async () => {
        const ids = await readIndex();
        // Idempotency: a duplicate key on a still-open run is a no-op.
        if (input.idempotencyKey) {
          const existing = await readAll(ids);
          const dupe = findOpenDuplicate(
            existing,
            input.idempotencyKey,
            resolved,
          );
          if (dupe) return { run: dupe, created: false };
        }
        const now = new Date().toISOString();
        const run = createRun<Outcome>(input, resolved, now);
        await storage.set(runKey(loopId, run.id), run);
        // Newest-first index. De-dupe defensively in case a prior crash
        // left a half-written id.
        const nextIds = [run.id, ...ids.filter((id) => id !== run.id)];
        // Retention: trim oldest TERMINAL runs beyond maxRuns. We trim the
        // FULL run set, then rewrite the index + delete evicted keys.
        const all = [run, ...(await readAll(ids))];
        const kept = trimRetention(all, resolved);
        const keptIds = new Set(kept.map((r) => r.id));
        const evicted = nextIds.filter((id) => !keptIds.has(id));
        for (const id of evicted) await storage.delete(runKey(loopId, id));
        const finalIds = nextIds.filter((id) => keptIds.has(id));
        await storage.set(indexKey(loopId), finalIds);
        return { run, created: true };
      });
    },

    async transition(runId, next) {
      return withLock(lk, async () => {
        const run = await readRun(runId);
        if (!run) return null;
        const now = new Date().toISOString();
        // TOCTOU fix: an OMITTED `status` means "keep the run's CURRENT
        // status" — resolved HERE, under the lock, from the freshly-read
        // run. Callers must NOT pre-read the status outside the lock (that
        // race let an event-only update silently revert a concurrent status
        // flip). The event-log entry still uses `eventStatus ?? status`.
        const resolvedStatus = next.status ?? run.status;
        const updated = coreTransition(
          run,
          { ...next, status: resolvedStatus },
          resolved,
          now,
        );
        await storage.set(runKey(loopId, runId), updated);
        return updated;
      });
    },

    async get(runId) {
      return readRun(runId);
    },

    async list() {
      const ids = await readIndex();
      return readAll(ids);
    },

    async getMeta() {
      const res = await storage.get<LoopMeta>(metaKey(loopId));
      return res.exists && res.value ? res.value : { ...EMPTY_META };
    },

    async setMeta(meta) {
      await withLock(lk, async () => {
        await storage.set(metaKey(loopId), meta);
      });
    },
  };
}

function isResolved(
  c: LoopContract<unknown> | ResolvedContract<unknown>,
): c is ResolvedContract<unknown> {
  return (
    typeof (c as ResolvedContract).maxRuns === "number" &&
    typeof (c as ResolvedContract).classify === "function"
  );
}
