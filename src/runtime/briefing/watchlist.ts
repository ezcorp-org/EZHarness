/**
 * Daily Briefing — shared watchlist add/remove primitive.
 *
 * The SINGLE framework-free place that mutates a user's briefing
 * watchlist: load → case-insensitive dedup/match → validate via the
 * shared `validateBriefingConfigInput` (caps: MAX_WATCHLIST_TOPICS=25,
 * MAX_TOPIC_LENGTH=200) → persist via `upsertBriefingConfig` (preserve
 * semantics + next_fire_at recompute).
 *
 * DRY: both the conversational tools (`chat-tools.ts` —
 * `briefing_watch`/`briefing_unwatch`) AND the Hub page action handlers
 * (`hub-page.ts` — `add-watchlist`/`remove-watchlist`) call these. Every
 * write is user-scoped; callers pass the resolved `userId`. Failures are
 * returned as `{ ok: false, error }` (never thrown) so callers stay
 * fail-soft.
 */
import {
  getBriefingConfig,
  upsertBriefingConfig,
} from "../../db/queries/briefing-configs";
import { validateBriefingConfigInput } from "./config-validation";

type WatchEntry = { topic: string; addedAt: string };

export type AddWatchlistResult =
  | { ok: true; added: boolean; size: number }
  | { ok: false; error: string };

export type RemoveWatchlistResult =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

async function loadWatchlist(userId: string): Promise<WatchEntry[]> {
  const existing = await getBriefingConfig(userId);
  return existing?.watchlist ?? [];
}

/** Persist a watchlist through the shared validator + upsert. Returns an
 *  error string instead of throwing so callers stay clean. */
async function persist(userId: string, watchlist: WatchEntry[]): Promise<string | null> {
  const validated = validateBriefingConfigInput({ watchlist });
  if (!validated.ok) return validated.error;
  await upsertBriefingConfig(userId, validated.input);
  return null;
}

/**
 * Add a topic to the user's watchlist. `added:false` means the topic was
 * already present (case-insensitive) — a friendly no-op, not an error.
 * `{ ok:false }` carries a validation/cap failure message.
 */
export async function addWatchlistTopic(
  userId: string,
  rawTopic: string,
): Promise<AddWatchlistResult> {
  const topic = typeof rawTopic === "string" ? rawTopic.trim() : "";
  if (!topic) return { ok: false, error: "Topic is required" };

  const watchlist = await loadWatchlist(userId);
  if (watchlist.some((w) => w.topic.toLowerCase() === topic.toLowerCase())) {
    return { ok: true, added: false, size: watchlist.length };
  }

  const next = [...watchlist, { topic, addedAt: new Date().toISOString() }];
  const failure = await persist(userId, next);
  if (failure) return { ok: false, error: failure };
  return { ok: true, added: true, size: next.length };
}

/**
 * Remove a topic (case-insensitive match) from the user's watchlist.
 * `removed:false` means it wasn't there — a friendly no-op.
 */
export async function removeWatchlistTopic(
  userId: string,
  rawTopic: string,
): Promise<RemoveWatchlistResult> {
  const topic = typeof rawTopic === "string" ? rawTopic.trim() : "";
  if (!topic) return { ok: false, error: "Topic is required" };

  const watchlist = await loadWatchlist(userId);
  const match = watchlist.find((w) => w.topic.toLowerCase() === topic.toLowerCase());
  if (!match) return { ok: true, removed: false };

  const next = watchlist.filter((w) => w !== match);
  const failure = await persist(userId, next);
  if (failure) return { ok: false, error: failure };
  return { ok: true, removed: true };
}
