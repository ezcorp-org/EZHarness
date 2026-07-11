/**
 * SpawnQuota — dual tracker for `ezcorp/spawn-assignment` (Phase 2d).
 *
 * Enforces TWO limits per extension that the token-bucket rate limiter
 * (`rate-limit.ts`) doesn't cover:
 *
 *   1. **Rolling hourly quota** — `spawnAgents.maxPerHour` spawns in any
 *      60-minute window. Tracked as a sorted array of timestamps per
 *      extension; pruned on every check.
 *   2. **Concurrent cap** — `spawnAgents.maxConcurrent ?? 3` in-flight
 *      sub-runs at any moment. Decremented when the bus fires
 *      `run:complete` / `run:error` / `run:cancel` for a reserved
 *      `agentRunId`.
 *
 * The instantaneous rate limit (`createRateLimiter(50)` per extension)
 * defends against bursts; this module defends against sustained misuse.
 * Both apply to every spawn request.
 *
 * Thread safety: the runtime is single-threaded. Map mutations between
 * `check()` and `reserve()` are atomic at the JS-engine level. A
 * theoretical TOCTOU exists if a handler awaits multiple things between
 * check and reserve (agent resolution, DB writes), so the handler
 * reserves speculatively on an opaque token right after check() and
 * swaps to the real `agentRunId` via `swapReservation` once
 * `startAssignment` returns. Over-commit window is bounded by the
 * 50/sec rate limit.
 */

import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

export interface SpawnQuotaConfig {
  /** Max spawns in any rolling 60-minute window. Clamped > 0 at grant time. */
  maxPerHour: number;
  /** Max in-flight sub-runs attributed to this extension. */
  maxConcurrent: number;
}

export type SpawnQuotaDenyReason = "hourly-exceeded" | "concurrent-exceeded";

export interface SpawnQuotaCheckResult {
  ok: boolean;
  reason?: SpawnQuotaDenyReason;
  details?: { limit: number; windowMs?: number };
}

export interface SpawnQuota {
  /** Non-mutating pre-flight — returns a deny reason if a reserve() would
   *  cross either limit. */
  check(extensionId: string, cfg: SpawnQuotaConfig): SpawnQuotaCheckResult;
  /** Reserve one slot for this extension under the given token. Call
   *  ONLY after check() returned `ok: true`. */
  reserve(extensionId: string, reservationToken: string): void;
  /** Re-key an existing reservation to `newToken`. Two callers:
   *   1. post-dispatch — swap the speculative `assignment.id` for the real
   *      cycle-1 `agentRunId` after `startAssignment` returns;
   *   2. cycle continuation — swap the completing cycle's run id for the
   *      next cycle's, so the concurrent slot follows the LIVE run and
   *      `ezcorp/cancel-run` can still cancel it (ownership follows too).
   *  Order-independent: `newToken` is reserved even if `oldToken` was
   *  already released by its own terminal bus event (the cycle swap races
   *  that release from inside the same `run:complete`). The old token's
   *  (possibly duplicate) release can't double-free the new slot. Refuses
   *  only when `oldToken` is owned by a DIFFERENT extension. Does NOT touch
   *  the hourly window — a continuation is the same logical spawn. */
  swapReservation(extensionId: string, oldToken: string, newToken: string): void;
  /** Release a reservation without waiting for the bus. Handler uses
   *  this on error paths (e.g. `startAssignment` threw after reserve). */
  release(reservationToken: string): void;
  /** True iff `reservationToken` is currently held by `extensionId`.
   *  Used by `ezcorp/cancel-run` (Phase 4) to enforce that an extension
   *  can only cancel its own spawned runs. */
  isOwner(extensionId: string, reservationToken: string): boolean;
  /** Test-only counter — current live reservations for this extension. */
  _concurrentCount(extensionId: string): number;
  /** Tear down all bus subscriptions. Call on executor shutdown. */
  dispose(): void;
}

const HOUR_MS = 60 * 60 * 1000;

export function createSpawnQuota(bus: EventBus<AgentEvents>): SpawnQuota {
  /** extensionId → sorted ms timestamps (one per spawn in the rolling window). */
  const hourly = new Map<string, number[]>();
  /** extensionId → set of live reservation tokens. */
  const concurrent = new Map<string, Set<string>>();
  /** reservation token → extensionId (for bus-driven release). */
  const tokenToExt = new Map<string, string>();

  function release(token: string): void {
    const extId = tokenToExt.get(token);
    if (!extId) return;
    concurrent.get(extId)?.delete(token);
    tokenToExt.delete(token);
  }

  // Decrement on run termination. One subscription per termination event;
  // all three fire with `{ run: { id } }` payloads that identify the
  // agentRunId the handler swapped in post-dispatch.
  const unsubComplete = bus.on("run:complete", (d) => release(d.run.id));
  const unsubError    = bus.on("run:error",    (d) => release(d.run.id));
  const unsubCancel   = bus.on("run:cancel",   (d) => release(d.run.id));

  function prune(extId: string, now: number): void {
    const arr = hourly.get(extId);
    if (!arr) return;
    const cutoff = now - HOUR_MS;
    let i = 0;
    while (i < arr.length && arr[i]! < cutoff) i++;
    if (i > 0) arr.splice(0, i);
  }

  return {
    check(extensionId, cfg) {
      const now = Date.now();
      prune(extensionId, now);
      const hourlyCount = hourly.get(extensionId)?.length ?? 0;
      if (hourlyCount >= cfg.maxPerHour) {
        return {
          ok: false,
          reason: "hourly-exceeded",
          details: { limit: cfg.maxPerHour, windowMs: HOUR_MS },
        };
      }
      const concurrentCount = concurrent.get(extensionId)?.size ?? 0;
      if (concurrentCount >= cfg.maxConcurrent) {
        return {
          ok: false,
          reason: "concurrent-exceeded",
          details: { limit: cfg.maxConcurrent },
        };
      }
      return { ok: true };
    },

    reserve(extensionId, reservationToken) {
      const now = Date.now();
      let arr = hourly.get(extensionId);
      if (!arr) { arr = []; hourly.set(extensionId, arr); }
      arr.push(now);
      let set = concurrent.get(extensionId);
      if (!set) { set = new Set(); concurrent.set(extensionId, set); }
      set.add(reservationToken);
      tokenToExt.set(reservationToken, extensionId);
    },

    swapReservation(extensionId, oldToken, newToken) {
      const existing = tokenToExt.get(oldToken);
      // Cross-ext guard: never touch a token another extension owns.
      if (existing !== undefined && existing !== extensionId) return;
      // Drop the old token if we still hold it. It may already be gone: a
      // cycle continuation re-keys old→new from INSIDE the old run's
      // `run:complete` listener, and THIS module's own run-termination
      // listener (subscribed first, at executor construction) may have
      // released it already. Adding `newToken` UNCONDITIONALLY makes the swap
      // order-independent — the slot follows the live cycle whether the
      // release or the swap runs first, and the old id's (possibly duplicate)
      // bus-release can't double-free the new slot.
      if (existing === extensionId) {
        concurrent.get(extensionId)?.delete(oldToken);
        tokenToExt.delete(oldToken);
      }
      let set = concurrent.get(extensionId);
      if (!set) { set = new Set(); concurrent.set(extensionId, set); }
      set.add(newToken);
      tokenToExt.set(newToken, extensionId);
      // NOTE: hourly entry is NOT touched — the spawn still happened; a cycle
      // continuation is the same logical spawn, so it must not re-bill the
      // rolling window.
    },

    release,

    isOwner(extensionId, reservationToken) {
      return tokenToExt.get(reservationToken) === extensionId;
    },

    _concurrentCount(extensionId) {
      return concurrent.get(extensionId)?.size ?? 0;
    },

    dispose() {
      unsubComplete();
      unsubError();
      unsubCancel();
    },
  };
}
