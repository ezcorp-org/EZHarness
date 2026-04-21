/**
 * Server-side conversation filter for the SSE bus stream.
 *
 * Motivation: `web/src/routes/api/runtime-events/+server.ts` broadcasts
 * every bus event to every connected SSE client; the browser filters
 * client-side by matching `event.conversationId` against the page's
 * active conversation. That means:
 *   (1) user A's `tool:complete` output can momentarily land in user
 *       B's stream — leaked cross-user if the browser filter has a
 *       logic bug or race.
 *   (2) The Phase 2+ `ezcorp/emit-task-event` reverse RPC will make
 *       extensions capable of emitting events. Without a server-side
 *       filter, a misconfigured extension could forge a
 *       `tool:complete` with another conversation's id and it would
 *       reach that user's UI.
 *
 * This module closes both by filtering events at emit-to-SSE time.
 *
 * The filter is intentionally limited:
 *   - Only the 13 "direct carrier" event types listed in
 *     `.planning/phase-2a-prereqs.md` are filtered. These carry
 *     `conversationId` at the top level of the payload.
 *   - Other event types pass through unchanged (they carry either
 *     only `runId` which the client already resolves to a
 *     conversation, or they're not conversation-scoped at all).
 *
 * Fail-open behavior: if the authorization check throws (DB unavailable,
 * unexpected error), the event is PASSED — individual leaks are a
 * lower-priority concern than blacking out the whole UI. The fail-open
 * error is logged so operators can catch recurring leaks.
 */

import type { AgentEvents } from "../types";
import { logger } from "../logger";

const log = logger.child("sse-filter");

/**
 * Event types that carry `conversationId` at the top level of their
 * payload. Enumerated explicitly (not derived) because the shape of
 * `AgentEvents` varies per type and a programmatic heuristic would
 * silently include events we haven't audited.
 *
 * See `.planning/phase-2a-prereqs.md` section A for the audit.
 */
export const DIRECT_CARRIER_EVENT_TYPES: ReadonlySet<keyof AgentEvents> = new Set([
  "run:complete",       // optional conversationId — filtered when present
  "run:error",          // optional conversationId — filtered when present
  "run:cancel",         // optional conversationId — filtered when present
  "run:turn_saved",
  "tool:start",
  "tool:complete",
  "tool:error",
  "tool:permission_request",
  "tool:permission_mode_change",
  "obs:turn",
  "orchestrator:human_input",
  "task:snapshot",
  "task:assignment_update",
]);

/**
 * Membership cache for `isAuthorizedForConversation`. Per-process,
 * per-(userId,conversationId) with a 30s TTL. Prevents N+1 DB queries
 * when a busy conversation produces high event volume.
 */
interface CacheEntry { authorized: boolean; expiresAt: number; }
const CACHE_TTL_MS = 30_000;
const membershipCache = new Map<string, CacheEntry>();

function cacheKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

/**
 * Returns true if the given user is authorized to receive events for
 * the given conversation. Strict mode: only the owner today. Team-shares
 * are a future extension point (see `conversation_shares` when added).
 *
 * Cached for 30s per (userId, conversationId). The cache is in-process
 * only; no cross-process coherence — acceptable because (1) revoking
 * access is rare, (2) the cache only grants 30s of stale access after
 * revocation, and (3) the SSE stream auto-reconnects which re-runs
 * this check.
 */
export async function isAuthorizedForConversation(
  userId: string,
  conversationId: string,
  getConversation: (id: string) => Promise<{ userId?: string | null } | null>,
): Promise<boolean> {
  const key = cacheKey(userId, conversationId);
  const now = Date.now();
  const hit = membershipCache.get(key);
  if (hit && hit.expiresAt > now) return hit.authorized;

  try {
    const conv = await getConversation(conversationId);
    const authorized = conv?.userId === userId;
    membershipCache.set(key, { authorized, expiresAt: now + CACHE_TTL_MS });
    return authorized;
  } catch (err) {
    // Fail-open — see module-level rationale. Log so recurring leaks
    // surface in operator dashboards.
    log.warn("conversation-membership lookup failed, passing event through (fail-open)", {
      userId,
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/** Clear the membership cache. Test-only. */
export function __clearMembershipCacheForTests(): void {
  membershipCache.clear();
}

/**
 * Decide whether an event should be delivered to a given subscriber.
 *
 * @param eventType - The bus event name.
 * @param payload - The event payload. We look for `conversationId` only.
 * @param subscriber - The subscriber context captured at SSE connect.
 * @param getConversation - Injected DB accessor so this module stays
 *                          free of server/client module-path coupling.
 * @returns true if the event should reach the subscriber.
 */
export async function shouldDeliverEvent(
  eventType: keyof AgentEvents | string,
  payload: unknown,
  subscriber: { userId: string; conversationId?: string },
  getConversation: (id: string) => Promise<{ userId?: string | null } | null>,
): Promise<boolean> {
  // Not a direct-carrier event → pass through. Client-side filtering
  // handles any conversation-identity resolution via `runId`.
  if (!DIRECT_CARRIER_EVENT_TYPES.has(eventType as keyof AgentEvents)) return true;

  // Extract conversationId from the payload. If it's absent (valid for
  // the three optional carriers `run:complete`/`:error`/`:cancel`),
  // pass through — we can't filter what we can't see.
  const convId = (payload as { conversationId?: unknown } | null | undefined)?.conversationId;
  if (typeof convId !== "string" || !convId) return true;

  // Filter: subscriber must be authorized for the event's conversation.
  return isAuthorizedForConversation(subscriber.userId, convId, getConversation);
}
