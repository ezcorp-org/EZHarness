/**
 * LlmQuota — per-extension rolling-hour + calendar-day counters for
 * `ctx.llm.complete()` calls. Mirrors `spawn-quota.ts` but adds a
 * tokens-per-day counter and persistence to `extension_llm_usage`.
 *
 * In-process counters are authoritative for the live process; the
 * `extension_llm_usage` table is the durable record (60s flush) so a
 * crash-restart doesn't reset the day's usage to zero.
 */

import { logger } from "../logger";
import { getDb } from "../db/connection";
import { extensionLlmUsage } from "../db/schema";
import { sql, and, eq } from "drizzle-orm";

const log = logger.child("ext.llm-quota");

export interface LlmQuotaConfig {
  maxCallsPerHour: number;
  maxCallsPerDay: number;
  maxTokensPerDay?: number;
}

export type LlmQuotaDenyReason =
  | "calls-per-hour"
  | "calls-per-day"
  | "tokens-per-day";

export interface LlmQuotaCheckResult {
  ok: boolean;
  reason?: LlmQuotaDenyReason;
  retryAfterMs?: number;
}

export interface LlmQuota {
  /** Pre-flight check + speculative consume. Pass the upper-bound
   *  `tokens` (the request's `maxTokens`) so the day counter doesn't
   *  pretend a 4096-token call only used the count slot. */
  consume(
    extensionId: string,
    cfg: LlmQuotaConfig,
    opts?: { tokens?: number },
  ): LlmQuotaCheckResult;
  /** Adjust the `tokens` count post-call once the actual usage is known.
   *  Pass the delta (actualTokens - prebookedTokens). Negative deltas
   *  are clamped at zero (we don't refund below zero). */
  adjustTokens(extensionId: string, delta: number): void;
  /** Read-only snapshot for `getBudget()`. */
  budget(extensionId: string, cfg: LlmQuotaConfig): {
    callsRemaining: { hour: number; day: number };
    tokensRemaining: { day: number };
  };
  /** Force-flush in-process counters to the DB. Called on shutdown
   *  + by the 60s timer. */
  flush(): Promise<void>;
  /** Hydrate the in-process counter for an extension from the DB.
   *  Restart-resilience: after a host restart, the first
   *  `consume()` call would otherwise reset today's counter to zero
   *  even though `extension_llm_usage` already has the day's
   *  cumulative count. Tests can invoke this to seed counters
   *  before invoking `consume()`. */
  hydrate(extensionId: string): Promise<void>;
  /** Tear down the flush timer. Call on shutdown. */
  dispose(): void;
}

const HOUR_MS = 60 * 60 * 1000;

function todayUtcString(): string {
  // ISO date (YYYY-MM-DD) in UTC. The migration column type is `date`
  // — Postgres stores dates without time-of-day, so the calendar-day
  // boundary is UTC.
  return new Date().toISOString().slice(0, 10);
}

interface ExtCounters {
  hourly: number[]; // sorted ms timestamps
  dailyCalls: number;
  dailyTokens: number;
  day: string; // YYYY-MM-DD UTC
  dirty: boolean; // set when the in-memory counters diverge from DB
}

export function createLlmQuota(): LlmQuota {
  const counters = new Map<string, ExtCounters>();

  function getOrInit(extensionId: string): ExtCounters {
    const today = todayUtcString();
    let entry = counters.get(extensionId);
    if (!entry || entry.day !== today) {
      // Day rollover (or first call). New buckets.
      entry = { hourly: [], dailyCalls: 0, dailyTokens: 0, day: today, dirty: false };
      counters.set(extensionId, entry);
    }
    return entry;
  }

  /** Restart-resilience: on first lookup of an extension, fetch
   *  today's row from `extension_llm_usage` so the in-process
   *  daily counters are seeded with the persisted total. The 60s
   *  flush already writes — hydration is the missing inverse. */
  async function hydrateImpl(extensionId: string): Promise<void> {
    const today = todayUtcString();
    let entry = counters.get(extensionId);
    if (entry && entry.day === today && (entry.dailyCalls > 0 || entry.dailyTokens > 0)) {
      // Already populated for today — don't clobber.
      return;
    }
    try {
      const rows = await getDb().select().from(extensionLlmUsage).where(and(
        eq(extensionLlmUsage.extensionId, extensionId),
        eq(extensionLlmUsage.day, today),
      ));
      const seed = rows[0];
      if (!entry || entry.day !== today) {
        entry = { hourly: [], dailyCalls: 0, dailyTokens: 0, day: today, dirty: false };
        counters.set(extensionId, entry);
      }
      if (seed) {
        entry.dailyCalls = seed.calls;
        entry.dailyTokens = seed.outputTokens;
        // Don't seed `hourly` — the rolling-hour timestamps aren't
        // persisted (intentional: a stale rolling-hour after a long
        // outage is worse than starting fresh).
      }
    } catch (err) {
      log.warn("hydrate-failed", { extensionId, error: String(err) });
    }
  }

  function pruneHourly(entry: ExtCounters, now: number): void {
    const cutoff = now - HOUR_MS;
    while (entry.hourly.length > 0 && entry.hourly[0]! < cutoff) {
      entry.hourly.shift();
    }
  }

  async function flushImpl(): Promise<void> {
    const entries = [...counters.entries()].filter(([, e]) => e.dirty);
    if (entries.length === 0) return;
    for (const [extensionId, e] of entries) {
      try {
        await getDb()
          .insert(extensionLlmUsage)
          .values({
            extensionId,
            day: e.day,
            calls: e.dailyCalls,
            outputTokens: e.dailyTokens,
          })
          .onConflictDoUpdate({
            target: [extensionLlmUsage.extensionId, extensionLlmUsage.day],
            set: {
              calls: e.dailyCalls,
              outputTokens: e.dailyTokens,
              updatedAt: sql`NOW()`,
            },
          });
        e.dirty = false;
      } catch (err) {
        log.warn("flush-failed", { extensionId, error: String(err) });
      }
    }
  }

  // 60s flush timer — survives a single missed tick gracefully because
  // every consume() marks `dirty: true`.
  const timer = setInterval(() => {
    flushImpl().catch((err) => log.warn("timer-flush-failed", { error: String(err) }));
  }, 60_000);
  // Don't keep the process alive for this timer.
  if (typeof timer === "object" && "unref" in timer) {
    (timer as unknown as { unref: () => void }).unref();
  }

  return {
    consume(extensionId, cfg, opts) {
      const e = getOrInit(extensionId);
      const now = Date.now();
      pruneHourly(e, now);

      if (e.hourly.length >= cfg.maxCallsPerHour) {
        // Time until the oldest entry ages out.
        const retryAfterMs = (e.hourly[0]! + HOUR_MS) - now;
        return { ok: false, reason: "calls-per-hour", retryAfterMs: Math.max(0, retryAfterMs) };
      }
      if (e.dailyCalls >= cfg.maxCallsPerDay) {
        // Until UTC midnight.
        const tomorrow = new Date();
        tomorrow.setUTCHours(24, 0, 0, 0);
        return { ok: false, reason: "calls-per-day", retryAfterMs: tomorrow.getTime() - now };
      }
      const tokens = Math.max(0, opts?.tokens ?? 0);
      if (cfg.maxTokensPerDay !== undefined && e.dailyTokens + tokens > cfg.maxTokensPerDay) {
        const tomorrow = new Date();
        tomorrow.setUTCHours(24, 0, 0, 0);
        return { ok: false, reason: "tokens-per-day", retryAfterMs: tomorrow.getTime() - now };
      }

      e.hourly.push(now);
      e.dailyCalls += 1;
      e.dailyTokens += tokens;
      e.dirty = true;
      return { ok: true };
    },

    adjustTokens(extensionId, delta) {
      const e = counters.get(extensionId);
      if (!e) return;
      e.dailyTokens = Math.max(0, e.dailyTokens + delta);
      e.dirty = true;
    },

    budget(extensionId, cfg) {
      const e = getOrInit(extensionId);
      pruneHourly(e, Date.now());
      const day = cfg.maxTokensPerDay !== undefined
        ? Math.max(0, cfg.maxTokensPerDay - e.dailyTokens)
        : Number.MAX_SAFE_INTEGER;
      return {
        callsRemaining: {
          hour: Math.max(0, cfg.maxCallsPerHour - e.hourly.length),
          day: Math.max(0, cfg.maxCallsPerDay - e.dailyCalls),
        },
        tokensRemaining: { day },
      };
    },

    flush: flushImpl,

    hydrate: hydrateImpl,

    dispose() {
      clearInterval(timer);
    },
  };
}

// Singleton — one per host process. The host wires it once via
// `setLlmQuota` on the ToolExecutor.
let singleton: LlmQuota | undefined;
export function getLlmQuota(): LlmQuota {
  if (!singleton) singleton = createLlmQuota();
  return singleton;
}

/** Test-only — replace the singleton with a fresh instance so a test
 *  doesn't see counters from a sibling test run. */
export function _resetLlmQuotaForTests(): void {
  singleton?.dispose();
  singleton = undefined;
}
