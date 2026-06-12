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
  "ask-user:answer",
  // Phase 48 Wave 3: Ez client-side tool delivery. The runtime emits
  // `ez:client-tool` with a top-level conversationId so it's filtered
  // per subscriber the same way ask-user:answer is.
  "ez:client-tool",
  "task:snapshot",
  "task:assignment_update",
  // agent-install-ux-polish Phase 2 (D3): user-scoped, NOT
  // conversation-scoped. Listed here so `isDirectCarrierEvent` treats
  // it as requiring authorization filtering; `shouldDeliverEvent` has
  // a dedicated userId-only branch for it (it carries no
  // conversationId) that fails CLOSED — never broadcast.
  "extensions:installed",
  // /goal Phase 2 (FR-20, D7): the `◎ /goal active|paused` chip is
  // driven by this bus event. Payload carries `conversationId` at the
  // top level so the standard conv-scope branch filters it correctly
  // — the goal-host emits one event per state transition (arm,
  // evaluator update, pause, achieve, clear). Direct-carrier handling
  // guarantees user A's goal state never leaks into user B's chip.
  "goal:update",
  // Daily Briefing Phase 1: server-initiated conversation creation +
  // delivery signals. Both carry an explicit owning `userId` and are
  // handled by a dedicated FAIL-CLOSED userId branch in
  // `shouldDeliverEvent` (mirrors `extensions:installed`) — user B
  // must never receive user A's briefing event.
  "conversation:created",
  "briefing:delivered",
  // NOTE — "ext:page-state" (Extension Pages Hub) is INTENTIONALLY
  // ABSENT: the mediator strips the page tree before emitting, so the
  // event carries only {extensionId, extensionName, pageId} — a
  // content-free "page X changed" signal that is safe to broadcast to
  // every authenticated SSE subscriber. Adding it here would silently
  // drop it (it carries no conversationId/userId to authorize against).
]);

// ── Extension-declared event registry ───────────────────────────────
//
// Phase A2: extensions can declare their own canvas events via
// `permissions.eventSubscriptions: ["<extName>:<event>"]` in the
// manifest. Each entry is registered here at extension load time.
// Both the SSE filter (this module) and the EventSubscriptionDispatcher
// consult this registry to decide whether `<extName>:<event>` is a
// recognized event type.
//
// The static set above continues to enumerate platform events.
// Extension events live here, are auto-pruned when the extension
// reloads, and can never collide with a platform event because the
// platform set is checked first.
//
// Same threat model as the static set: events here MUST carry
// `conversationId` at the top level — `shouldDeliverEvent` filters
// them. Extensions that emit without a conversationId have the event
// pass through unfiltered (matches platform behavior on the three
// optional carriers `run:complete`/`:error`/`:cancel`).

/** Validation regex for extension namespaces. Mirrors manifest.name. */
const NAMESPACE_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

/** namespace → Set<eventName>. Populated by `registerExtensionEvent`,
 *  cleared by `unregisterExtensionEvents`. Read by both the SSE filter
 *  (for delivery scoping) and the EventSubscriptionDispatcher (for the
 *  manifest-clamp at registration time). */
const extensionEventRegistry = new Map<string, Set<string>>();

/**
 * Register an extension-declared event. Called by the dispatcher's
 * `registerExtension` once per declared `<namespace>:<event>` entry
 * in the manifest. Idempotent — re-registering the same pair is a
 * no-op.
 *
 * Validation:
 *   - namespace must match `/^[a-z0-9][a-z0-9-_.]{0,63}$/` (extension
 *     name regex).
 *   - eventName must be a non-empty string with no colon (a colon
 *     would re-prefix the event when the dispatcher composes the bus
 *     event name).
 *   - the composed `<namespace>:<eventName>` MUST NOT collide with
 *     a platform event in `DIRECT_CARRIER_EVENT_TYPES`. Without this
 *     guard, an extension named `ask-user`/`tool`/`task`/`run`/`obs`
 *     could shadow a platform event and POST to it through the
 *     generic events route, bypassing the bespoke route's stricter
 *     authorization (e.g., ask-user's in-memory pending registry).
 *     [F3 from the Phase A security review]
 *
 * Returns true if accepted, false if rejected. Rejection is silent —
 * the dispatcher logs at the call site.
 */
export function registerExtensionEvent(namespace: string, eventName: string): boolean {
  if (!NAMESPACE_REGEX.test(namespace)) return false;
  if (typeof eventName !== "string" || eventName.length === 0) return false;
  if (eventName.includes(":")) return false;
  // Platform-event collision guard — see comment above. The cast
  // mirrors `DIRECT_CARRIER_EVENT_TYPES`'s `keyof AgentEvents`
  // membership check used elsewhere; runtime is just a Set lookup.
  const composed = `${namespace}:${eventName}`;
  if (DIRECT_CARRIER_EVENT_TYPES.has(composed as keyof AgentEvents)) return false;
  let set = extensionEventRegistry.get(namespace);
  if (!set) {
    set = new Set();
    extensionEventRegistry.set(namespace, set);
  }
  set.add(eventName);
  return true;
}

/**
 * Drop a SINGLE registered (namespace, event) tuple. Phase A2 hardens
 * the un-registration path: the prior wholesale-by-namespace API
 * `unregisterExtensionEvents` was retained for back-compat, but the
 * dispatcher now uses this finer-grained helper to avoid wiping
 * sibling extensions when two share a manifest name.
 * [F1 from the Phase A security review]
 *
 * Idempotent — unknown (namespace, event) is a no-op. Empties an
 * empty namespace bucket to keep the registry compact.
 */
export function unregisterExtensionEvent(namespace: string, eventName: string): void {
  const set = extensionEventRegistry.get(namespace);
  if (!set) return;
  set.delete(eventName);
  if (set.size === 0) extensionEventRegistry.delete(namespace);
}

/**
 * Drop every event registration for the given namespace. Retained
 * for callers that genuinely own the namespace wholesale. The
 * dispatcher does NOT use this — see `unregisterExtensionEvent`.
 */
export function unregisterExtensionEvents(namespace: string): void {
  extensionEventRegistry.delete(namespace);
}

/**
 * Split a bus event name on the FIRST colon. Returns null if there
 * isn't one or either side is empty. The first-colon rule matches
 * the platform convention (`tool:start`, `ask-user:answer`) and
 * leaves room for extension events to use colons in the suffix
 * (currently rejected by `registerExtensionEvent` — kept disallowed
 * to avoid ambiguity with multi-segment platform events).
 */
function parseEventName(eventType: string): { namespace: string; event: string } | null {
  const idx = eventType.indexOf(":");
  if (idx <= 0 || idx >= eventType.length - 1) return null;
  return {
    namespace: eventType.slice(0, idx),
    event: eventType.slice(idx + 1),
  };
}

/**
 * True iff the event type matches `<namespace>:<event>` AND the
 * extension has declared that event. Platform events (in
 * `DIRECT_CARRIER_EVENT_TYPES`) return false here even though they
 * may share the `<ns>:<event>` shape — the static set is checked
 * first by `shouldDeliverEvent` and `isDirectCarrierEvent`.
 */
export function isRegisteredExtensionEvent(eventType: string): boolean {
  const parsed = parseEventName(eventType);
  if (!parsed) return false;
  return extensionEventRegistry.get(parsed.namespace)?.has(parsed.event) === true;
}

/**
 * True iff the event is a known direct-carrier (platform OR
 * extension-declared). Both kinds carry `conversationId` and require
 * authorization filtering.
 */
export function isDirectCarrierEvent(eventType: string): boolean {
  if (DIRECT_CARRIER_EVENT_TYPES.has(eventType as keyof AgentEvents)) return true;
  return isRegisteredExtensionEvent(eventType);
}

/** Test-only: drop all extension event registrations. */
export function __clearExtensionEventRegistryForTests(): void {
  extensionEventRegistry.clear();
}

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
  // Both platform (`DIRECT_CARRIER_EVENT_TYPES`) and extension-declared
  // events (`isRegisteredExtensionEvent`) get the same scope filter.
  if (!isDirectCarrierEvent(eventType as string)) return true;

  // agent-install-ux-polish Phase 2 (D3): `extensions:installed` is
  // USER-scoped, not conversation-scoped — it carries no
  // `conversationId`, so it must NOT fall through to the "no convId →
  // pass" broadcast branch below. Deliver ONLY to the SSE session
  // whose authenticated `subscriber.userId` matches the event's
  // `userId`. This mirrors `tool:permission_request`'s H7 userId
  // scoping but FAILS CLOSED: a missing / empty / mismatched
  // `userId` => NOT delivered (never broadcast "an extension was
  // installed" cross-user). The host always emits a concrete
  // `ctx.userId`; an absent one means a forged / malformed event and
  // is correctly dropped.
  if (eventType === "extensions:installed") {
    const eventUserId = (payload as { userId?: unknown } | null | undefined)?.userId;
    return (
      typeof eventUserId === "string" &&
      eventUserId.length > 0 &&
      eventUserId === subscriber.userId
    );
  }

  // Daily Briefing Phase 1: `conversation:created` + `briefing:delivered`
  // are USER-scoped delivery signals. They DO carry a `conversationId`,
  // but the conversation is brand-new — no subscriber has it as their
  // active conversation yet, and the userId match is both stricter and
  // cheaper than the DB-backed conversation-ownership check (which
  // fails OPEN on DB errors — unacceptable for a cross-user briefing
  // leak). FAIL CLOSED: missing / empty / mismatched userId → dropped.
  if (eventType === "conversation:created" || eventType === "briefing:delivered") {
    const eventUserId = (payload as { userId?: unknown } | null | undefined)?.userId;
    return (
      typeof eventUserId === "string" &&
      eventUserId.length > 0 &&
      eventUserId === subscriber.userId
    );
  }

  // Extract conversationId from the payload. If it's absent (valid for
  // the three optional carriers `run:complete`/`:error`/`:cancel`),
  // pass through — we can't filter what we can't see.
  const convId = (payload as { conversationId?: unknown } | null | undefined)?.conversationId;
  if (typeof convId !== "string" || !convId) return true;

  // Phase 6 H7: `tool:permission_request` carries an OPTIONAL `userId`
  // that names the originating user. When present, deliver the event
  // ONLY to that user — even users authorized for the same conversation
  // (admins, future team-shares) should not see another user's
  // permission prompt. This closes the leak where extensions emit
  // permission events that fan out to every SSE subscriber.
  //
  // Backwards-compat: legacy emits without `userId` fall through to
  // the conversation-scoped check, matching pre-Phase-6 behavior.
  if (eventType === "tool:permission_request") {
    const eventUserId = (payload as { userId?: unknown } | null | undefined)?.userId;
    if (typeof eventUserId === "string" && eventUserId.length > 0) {
      if (eventUserId !== subscriber.userId) return false;
    }
  }

  // Filter: subscriber must be authorized for the event's conversation.
  return isAuthorizedForConversation(subscriber.userId, convId, getConversation);
}
