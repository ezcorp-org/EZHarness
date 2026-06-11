/**
 * Daily Briefing — per-user config queries (Phase 1).
 *
 * Owns the three state-machine touchpoints of the briefing engine:
 *
 *   1. `upsertBriefingConfig` — API writes. Recomputes `next_fire_at`
 *      from the (possibly updated) cron + timezone via `parseCron`
 *      (src/extensions/cron.ts, reused as-is — DRY).
 *   2. `claimDueBriefingConfigs` — the daemon's claim-before-dispatch.
 *      One transaction: SELECT … FOR UPDATE SKIP LOCKED → advance
 *      `next_fire_at` to the next slot from NOW → return the claimed
 *      rows. Advancing from `now` (not enumerating missed slots) is
 *      what implements the hardcoded **fire-once** missed-run policy:
 *      a host that slept through three slots fires exactly once.
 *   3. `recordBriefingFireResult` — completion bookkeeping. `error`
 *      increments `consecutive_errors` and auto-disables at
 *      {@link BRIEFING_AUTO_DISABLE_AFTER}, mirroring the
 *      ScheduleDaemon's locked invariant.
 *
 * PGlite note: PGlite is single-connection so FOR UPDATE SKIP LOCKED
 * never actually contends there; on external Postgres (Bun.sql) it is
 * the real at-most-once guard across processes.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { briefingConfigs, type BriefingConfig } from "../schema";
import { parseCron } from "../../extensions/cron";
import { logger } from "../../logger";

const log = logger.child("db.queries.briefing-configs");

/** Consecutive-error count at which a config is auto-disabled. */
export const BRIEFING_AUTO_DISABLE_AFTER = 5;

/** Defaults applied when a user has no stored config yet. Exported so
 *  the GET /api/briefing/config route and run-now can present/operate
 *  on a consistent default shape without duplicating it. */
export const BRIEFING_CONFIG_DEFAULTS = {
  enabled: false,
  cron: "0 7 * * *",
  timezone: "UTC",
  projectId: null as string | null,
  instructions: "",
  watchlist: [] as Array<{ topic: string; addedAt: string }>,
  model: null as string | null,
  provider: null as string | null,
} as const;

export type { BriefingConfig };

/** Mutable subset the API may write. Everything else (fire bookkeeping,
 *  timestamps) is daemon-owned. */
export interface BriefingConfigInput {
  enabled?: boolean;
  cron?: string;
  timezone?: string;
  projectId?: string | null;
  instructions?: string;
  watchlist?: Array<{ topic: string; addedAt: string }>;
  model?: string | null;
  provider?: string | null;
}

export async function getBriefingConfig(userId: string): Promise<BriefingConfig | null> {
  const rows = await getDb()
    .select()
    .from(briefingConfigs)
    .where(eq(briefingConfigs.userId, userId));
  return rows[0] ?? null;
}

/**
 * Create or update the user's briefing config. Recomputes
 * `next_fire_at` (enabled → next cron slot strictly after `now`;
 * disabled → NULL so the daemon's claim scan never sees the row).
 *
 * Re-enabling resets `consecutive_errors` to 0 — otherwise a config
 * auto-disabled at 5 would re-disable on its first post-re-enable
 * error.
 *
 * Throws when the merged cron/timezone pair fails `parseCron` — the
 * API layer validates first (see runtime/briefing/config-validation),
 * so this throw is a defense-in-depth guard, not a UX path.
 */
export async function upsertBriefingConfig(
  userId: string,
  input: BriefingConfigInput,
  now: Date = new Date(),
): Promise<BriefingConfig> {
  if (!userId) throw new Error("userId is required");
  const existing = await getBriefingConfig(userId);

  const merged = {
    enabled: input.enabled ?? existing?.enabled ?? BRIEFING_CONFIG_DEFAULTS.enabled,
    cron: input.cron ?? existing?.cron ?? BRIEFING_CONFIG_DEFAULTS.cron,
    timezone: input.timezone ?? existing?.timezone ?? BRIEFING_CONFIG_DEFAULTS.timezone,
    projectId: input.projectId !== undefined ? input.projectId : (existing?.projectId ?? null),
    instructions: input.instructions ?? existing?.instructions ?? BRIEFING_CONFIG_DEFAULTS.instructions,
    watchlist: input.watchlist ?? existing?.watchlist ?? [],
    model: input.model !== undefined ? input.model : (existing?.model ?? null),
    provider: input.provider !== undefined ? input.provider : (existing?.provider ?? null),
  };

  // Throws on an invalid cron/timezone pair — intentional (see docblock).
  const nextFireAt = merged.enabled
    ? parseCron(merged.cron, merged.timezone).next(now)
    : null;

  const reenabled = merged.enabled && existing?.enabled === false;

  const rows = await getDb()
    .insert(briefingConfigs)
    .values({
      userId,
      ...merged,
      nextFireAt,
      consecutiveErrors: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: briefingConfigs.userId,
      set: {
        ...merged,
        nextFireAt,
        updatedAt: now,
        ...(reenabled ? { consecutiveErrors: 0 } : {}),
      },
    })
    .returning();
  return rows[0]!;
}

/** A claimed fire: the config row as it was at claim time plus the slot
 *  it was scheduled for (the PRE-advance `next_fire_at`). The daemon
 *  derives the catch-up flag from `scheduledFor` vs `now`. */
export interface ClaimedBriefing {
  config: BriefingConfig;
  scheduledFor: Date;
}

/**
 * Claim up to `limit` due configs. Claim-before-dispatch: the
 * transaction advances `next_fire_at` to the next slot (computed from
 * `now` — fire-once) before any caller dispatches work, so a crash
 * between commit and dispatch loses at most one fire and never
 * double-fires.
 *
 * Rows whose stored cron no longer parses (legacy/corrupt data) are
 * disabled in-place with `last_fire_status = 'error'` instead of
 * wedging the claim loop forever.
 */
export async function claimDueBriefingConfigs(now: Date, limit: number): Promise<ClaimedBriefing[]> {
  if (limit <= 0) return [];
  const db = getDb();
  return db.transaction(async (tx: any) => {
    const due: BriefingConfig[] = await tx
      .select()
      .from(briefingConfigs)
      .where(and(eq(briefingConfigs.enabled, true), lte(briefingConfigs.nextFireAt, now)))
      .orderBy(asc(briefingConfigs.nextFireAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    const claimed: ClaimedBriefing[] = [];
    for (const row of due) {
      let next: Date;
      try {
        next = parseCron(row.cron, row.timezone).next(now);
      } catch (err) {
        log.warn("briefing config has unparseable cron — disabling", {
          userId: row.userId,
          cron: row.cron,
          error: String(err),
        });
        await tx
          .update(briefingConfigs)
          .set({ enabled: false, nextFireAt: null, lastFireStatus: "error", updatedAt: now })
          .where(eq(briefingConfigs.userId, row.userId));
        continue;
      }
      await tx
        .update(briefingConfigs)
        .set({ nextFireAt: next, lastFireAt: now, updatedAt: now })
        .where(eq(briefingConfigs.userId, row.userId));
      claimed.push({ config: row, scheduledFor: row.nextFireAt ?? now });
    }
    return claimed;
  });
}

export interface BriefingFireOutcome {
  disabled: boolean;
  consecutiveErrors: number;
}

/**
 * Record a fire's terminal status on the config row.
 *
 *   - `ok`      → lastFireStatus 'ok', consecutive_errors reset to 0.
 *   - `skipped` → lastFireStatus 'skipped' (no project resolvable —
 *                 NOT an error; counter unchanged).
 *   - `error`   → consecutive_errors + 1; auto-disable at
 *                 {@link BRIEFING_AUTO_DISABLE_AFTER}.
 *
 * Returns the post-update outcome, or null when the row vanished
 * (user deleted mid-run — benign).
 *
 * Every branch is a SINGLE atomic UPDATE (SQL-side increment /
 * conditional set, missing-row detection via RETURNING) so an
 * overlapping run-now + scheduled fire can never lose an error
 * increment to a read-then-update race.
 */
export async function recordBriefingFireResult(
  userId: string,
  status: "ok" | "error" | "skipped",
  now: Date = new Date(),
): Promise<BriefingFireOutcome | null> {
  const db = getDb();

  if (status === "ok") {
    const rows = await db
      .update(briefingConfigs)
      .set({ lastFireStatus: "ok", consecutiveErrors: 0, updatedAt: now })
      .where(eq(briefingConfigs.userId, userId))
      .returning();
    if (!rows[0]) return null;
    return { disabled: false, consecutiveErrors: 0 };
  }

  if (status === "skipped") {
    const rows = await db
      .update(briefingConfigs)
      .set({ lastFireStatus: "skipped", updatedAt: now })
      .where(eq(briefingConfigs.userId, userId))
      .returning();
    if (!rows[0]) return null;
    return { disabled: false, consecutiveErrors: rows[0].consecutiveErrors };
  }

  // error: increment + auto-disable in one statement. The CASE guards
  // read the PRE-update column value, so "+ 1" and ">= threshold - 1"
  // agree on the same snapshot even under concurrent writers.
  const rows = await db
    .update(briefingConfigs)
    .set({
      lastFireStatus: "error",
      consecutiveErrors: sql`${briefingConfigs.consecutiveErrors} + 1`,
      enabled: sql`CASE WHEN ${briefingConfigs.consecutiveErrors} + 1 >= ${BRIEFING_AUTO_DISABLE_AFTER} THEN false ELSE ${briefingConfigs.enabled} END`,
      nextFireAt: sql`CASE WHEN ${briefingConfigs.consecutiveErrors} + 1 >= ${BRIEFING_AUTO_DISABLE_AFTER} THEN NULL ELSE ${briefingConfigs.nextFireAt} END`,
      updatedAt: now,
    })
    .where(eq(briefingConfigs.userId, userId))
    .returning();
  if (!rows[0]) return null;
  return {
    disabled: rows[0].consecutiveErrors >= BRIEFING_AUTO_DISABLE_AFTER,
    consecutiveErrors: rows[0].consecutiveErrors,
  };
}
