/**
 * Per-user tool-usage priors for composer suggestions.
 *
 * This is the day-one "learns from people's prompts and tool calls" signal:
 * a recency-decayed usage frequency per tool, computed from the user's own
 * `tool_calls` history and normalized to [0,1]. It only ever REORDERS
 * semantically-relevant candidates (see intent-rank.ts) — it cannot surface
 * an irrelevant tool. Candidates are already mode/toolset-scoped upstream,
 * so the prior is intentionally user-global, not mode-scoped.
 *
 * Privacy: reads tool names + timestamps only — never message content.
 */

import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "../db/connection";
import { toolCalls } from "../db/schema";

export interface ToolUsageRow {
  toolName: string;
  uses: number;
  lastUsedAt: Date | string;
}

/** Usage older than this contributes nothing (also bounds the query). */
export const PRIOR_WINDOW_DAYS = 90;
/** Recency half-life: a tool last used 30 days ago counts half. */
export const PRIOR_HALF_LIFE_DAYS = 30;
const PRIOR_CACHE_TTL_MS = 5 * 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure prior computation: recency-decayed frequency, normalized so the
 * user's most-used recent tool scores 1. Empty history → empty record.
 */
export function computeToolPriors(rows: ToolUsageRow[], nowMs: number): Record<string, number> {
  const raw = new Map<string, number>();
  for (const row of rows) {
    const lastUsedMs = new Date(row.lastUsedAt).getTime();
    if (Number.isNaN(lastUsedMs) || row.uses <= 0) continue;
    const ageDays = Math.max(0, (nowMs - lastUsedMs) / DAY_MS);
    raw.set(row.toolName, row.uses * 0.5 ** (ageDays / PRIOR_HALF_LIFE_DAYS));
  }
  let max = 0;
  for (const value of raw.values()) max = Math.max(max, value);
  if (max <= 0) return {};
  return Object.fromEntries([...raw.entries()].map(([name, value]) => [name, value / max]));
}

/**
 * Derive per-EXTENSION priors from an already-computed per-tool priors map:
 * for each requested extension, the MAX prior over its `${name}__`-prefixed
 * tool keys. MAX (not sum) keeps the result in [0,1] and avoids
 * overweighting an extension merely because it exposes many tools.
 * Extensions with no matching tool key are omitted (absent === 0
 * downstream). Built-in keys (no `__` namespace) are ignored. Pure — reuses
 * the TTL-cached map, no new DB query.
 */
export function deriveExtensionPriors(
  priors: Record<string, number>,
  extensionNames: string[],
): Record<string, number> {
  const wanted = new Set(extensionNames);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(priors)) {
    const sep = key.indexOf("__");
    if (sep <= 0) continue; // no `${ext}__` prefix → built-in, not an extension
    const ext = key.slice(0, sep);
    if (!wanted.has(ext)) continue;
    if (out[ext] === undefined || value > out[ext]!) out[ext] = value;
  }
  return out;
}

const priorCache = new Map<string, { at: number; priors: Record<string, number> }>();

/** Fetch (TTL-cached) usage priors for a user. */
export async function getUserToolPriors(
  userId: string,
  nowMs: number = Date.now(),
): Promise<Record<string, number>> {
  const cached = priorCache.get(userId);
  if (cached && nowMs - cached.at < PRIOR_CACHE_TTL_MS) return cached.priors;

  const cutoff = new Date(nowMs - PRIOR_WINDOW_DAYS * DAY_MS);
  const rows = await getDb()
    .select({
      toolName: toolCalls.toolName,
      uses: sql<number>`count(*)::int`,
      lastUsedAt: sql<string>`max(${toolCalls.createdAt})`,
    })
    .from(toolCalls)
    .where(and(eq(toolCalls.userId, userId), gt(toolCalls.createdAt, cutoff)))
    .groupBy(toolCalls.toolName);

  const priors = computeToolPriors(rows, nowMs);
  priorCache.set(userId, { at: nowMs, priors });
  return priors;
}

/** Reset — for tests. */
export function clearToolPriorsCache(): void {
  priorCache.clear();
}
