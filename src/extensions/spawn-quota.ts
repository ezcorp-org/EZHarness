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
  /** Re-key an existing reservation. Used to swap a speculative token
   *  (e.g. `assignment.id` chosen pre-dispatch) for the real
   *  `agentRunId` after `startAssignment` returns. Releases the old
   *  token atomically. No-op if `oldToken` isn't tracked. */
  swapReservation(extensionId: string, oldToken: string, newToken: string): void;
  /** Release a reservation without waiting for the bus. Handler uses
   *  this on error paths (e.g. `startAssignment` threw after reserve). */
  release(reservationToken: string): void;
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
      if (existing !== extensionId) return;
      concurrent.get(extensionId)?.delete(oldToken);
      tokenToExt.delete(oldToken);
      let set = concurrent.get(extensionId);
      if (!set) { set = new Set(); concurrent.set(extensionId, set); }
      set.add(newToken);
      tokenToExt.set(newToken, extensionId);
      // NOTE: hourly entry is NOT touched — the spawn still happened.
    },

    release,

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
