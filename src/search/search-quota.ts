/**
 * SearchQuota — per-extension calendar-day call counter for
 * `ctx.search.{web,read}`. Mirrors the memory-handler write-quota
 * accounting (`checkAndConsumeWriteQuota`) and the LLM
 * `maxCallsPerDay` day-counter, lifted into its own module so the
 * search handler stays thin.
 *
 * In-process counters are authoritative for the live process; the
 * `extension_search_calls_daily` table is the durable record (async
 * upsert on each consume + `hydrate` on first lookup) so a
 * crash-restart doesn't reset the day's count to zero — same
 * restart-resilience contract as `extension_llm_usage`.
 */
import { logger } from "../logger";
import { getDb } from "../db/connection";
import { extensionSearchCallsDaily } from "../db/schema";
import { sql, and, eq } from "drizzle-orm";

const log = logger.child("search.quota");

function todayUtcString(): string {
  // ISO date (YYYY-MM-DD) in UTC — the column is `date`, so the
  // calendar-day boundary is UTC (mirrors llm-quota).
  return new Date().toISOString().slice(0, 10);
}

interface DayCounter {
  day: string;
  count: number;
}

const counters = new Map<string, DayCounter>();

function getOrInit(extensionId: string): DayCounter {
  const today = todayUtcString();
  let entry = counters.get(extensionId);
  if (!entry || entry.day !== today) {
    entry = { day: today, count: 0 };
    counters.set(extensionId, entry);
  }
  return entry;
}

export interface SearchQuotaResult {
  ok: boolean;
  /** ms until UTC midnight when over quota (for the soft-fail payload). */
  retryAfterMs?: number;
}

/**
 * Restart-resilience: seed today's in-process counter from the durable
 * row before the first `consumeSearchQuota` of the process. Without
 * this, a host restart mid-day would reset the count to zero and let an
 * extension exceed its daily quota. Idempotent — won't clobber a counter
 * already populated for today.
 */
export async function hydrateSearchQuota(extensionId: string): Promise<void> {
  const today = todayUtcString();
  const existing = counters.get(extensionId);
  if (existing && existing.day === today && existing.count > 0) return;
  try {
    const rows = await getDb()
      .select()
      .from(extensionSearchCallsDaily)
      .where(and(
        eq(extensionSearchCallsDaily.extensionId, extensionId),
        eq(extensionSearchCallsDaily.day, today),
      ));
    const seed = rows[0];
    const entry = { day: today, count: seed ? seed.calls : 0 };
    counters.set(extensionId, entry);
  } catch (err) {
    log.warn("hydrate-failed", { extensionId, error: String(err) });
  }
}

/**
 * Pre-flight check + speculative consume against the day quota. Returns
 * `{ ok: false, retryAfterMs }` when the extension has already used its
 * `quota` calls today; otherwise increments the counter (in-process now,
 * durable async) and returns `{ ok: true }`.
 */
export function consumeSearchQuota(extensionId: string, quota: number): SearchQuotaResult {
  const entry = getOrInit(extensionId);
  if (entry.count >= quota) {
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    return { ok: false, retryAfterMs: tomorrow.getTime() - Date.now() };
  }
  entry.count += 1;
  // Async durable upsert — non-blocking; a flush hiccup never blocks the
  // search response (the in-process counter is authoritative live).
  void (async () => {
    try {
      await getDb()
        .insert(extensionSearchCallsDaily)
        .values({ extensionId, day: entry.day, calls: entry.count })
        .onConflictDoUpdate({
          target: [extensionSearchCallsDaily.extensionId, extensionSearchCallsDaily.day],
          // GREATEST(...) instead of an absolute overwrite: the durable count
          // must never REGRESS. An absolute `calls = entry.count` lets a
          // pre-hydrate first write (entry.count=1) clobber a durable 50 —
          // destroying the day's record — and lets unordered in-flight flushes
          // (or last-writer-wins across multi-instance deploys) roll the count
          // backwards. Monotonic max keeps restart-resilience honest.
          set: {
            calls: sql`GREATEST(${extensionSearchCallsDaily.calls}, ${entry.count})`,
            updatedAt: sql`NOW()`,
          },
        });
    } catch (err) {
      log.warn("quota-flush-failed", { extensionId, error: String(err) });
    }
  })();
  return { ok: true };
}

/** Test-only — clear the in-process counters so a suite doesn't see a
 *  sibling test's accumulated count. */
export function _resetSearchQuotaForTests(): void {
  counters.clear();
}
