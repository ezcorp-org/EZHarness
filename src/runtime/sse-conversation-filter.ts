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
  // Sessions P4 (rewind/checkpoint): the conversation's message tree / leaf
  // pointer changed. Carries `conversationId` at the top level so it's scoped
  // per subscriber — but via a dedicated FAIL-CLOSED branch in
  // `shouldDeliverEvent` (NOT the fail-open default the other conv carriers
  // use): the payload carries the conversation id + rewound-leaf id, and a
  // dropped nudge self-heals on reconnect/refetch, so dropping-on-DB-error
  // beats leaking those ids cross-user.
  "conversation:tree-changed",
  // Loops EZ Mode Phase 2: approval-pending / resolved nudges. OPTIONAL
  // carriers — like `run:complete`/`:error`/`:cancel`, the payload's
  // `conversationId` is present only for a conversation-wired loop (scoped to
  // that owner, fail-open) and ABSENT for a global-scope loop, where the
  // content-free nudge falls through to the broadcast branch (safe: the body
  // never rides the event; the authorized dashboard/GET is the source of
  // truth). Listed here so `isDirectCarrierEvent` treats a conversation-wired
  // one as requiring the scope filter.
  "loops:approval_pending",
  "loops:approval_resolved",
  // Loops auto-disable notice — same optional-carrier semantics.
  "loops:auto_disabled",
  // NOTE — "ext:page-state" (Extension Pages Hub) is INTENTIONALLY
  // ABSENT: the mediator strips the page tree before emitting, so the
  // event carries only {extensionId, extensionName, pageId} — a
  // content-free "page X changed" signal that is safe to broadcast to
  // every authenticated SSE subscriber. Adding it here would silently
  // drop it (it carries no conversationId/userId to authorize against).
]);

/**
 * Wave 0 (orchestration-upgrade): run-scoped streaming events. These
 * carry a `runId` (and sometimes `parentConversationId` / `userId`)
 * instead of a top-level `conversationId`, and previously broadcast to
 * EVERY authenticated SSE subscriber — `run:token` leaked one user's
 * raw streamed LLM text to all connected clients.
 *
 * Members are filtered FAIL-CLOSED by `shouldDeliverEvent`, resolving
 * scope in this order:
 *   1. `payload.conversationId`        → conversation-ownership check
 *   2. `payload.parentConversationId`  → conversation-ownership check
 *   3. `payload.userId`                → exact subscriber match
 *   4. `payload.runId` via the injected run-scope resolver
 *      (executor `runConversations` map + persisted run row)
 *   5. `payload.subConversationId`     → conversation-ownership check
 *   6. otherwise                       → DROPPED (never broadcast)
 *
 * This set is intentionally SEPARATE from `DIRECT_CARRIER_EVENT_TYPES`:
 * that set doubles as the allowlist of platform events extensions may
 * subscribe to (`event-subscription-dispatcher.ts` branch 1), and
 * run-scoped streaming events (raw tokens!) must NOT become
 * extension-subscribable as a side effect of SSE scoping.
 *
 * `run:complete` / `run:error` / `run:cancel` stay in the legacy set
 * above (optional-carrier semantics) for extension-subscription
 * compatibility, but `shouldDeliverEvent` upgrades their missing-
 * conversationId path to the same runId resolution before falling back
 * to the historical pass-through.
 */
export const SCOPED_RUNTIME_EVENT_TYPES: ReadonlySet<keyof AgentEvents> = new Set([
  "run:start",
  "run:log",
  "run:status",
  "run:token",
  "run:usage",
  "run:turn_text_reset",
  "agent:spawn",
  "agent:status",
  "agent:complete",
  "pipeline:start",
  "pipeline:step",
  "pipeline:complete",
  "pipeline:error",
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
  // Wave 0: the scoped runtime events are equally off-limits — an
  // extension named `run` must not shadow `run:token`.
  const composed = `${namespace}:${eventName}`;
  if (DIRECT_CARRIER_EVENT_TYPES.has(composed as keyof AgentEvents)) return false;
  if (SCOPED_RUNTIME_EVENT_TYPES.has(composed as keyof AgentEvents)) return false;
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
 * True iff the event requires authorization filtering before SSE
 * delivery: a direct carrier (platform OR extension-declared) or a
 * Wave-0 run-scoped streaming event.
 */
export function isDirectCarrierEvent(eventType: string): boolean {
  if (DIRECT_CARRIER_EVENT_TYPES.has(eventType as keyof AgentEvents)) return true;
  if (SCOPED_RUNTIME_EVENT_TYPES.has(eventType as keyof AgentEvents)) return true;
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

/** Conversation row shape the filter needs. `parentConversationId`
 *  powers the sub-conversation ownership walk below. */
export interface ConversationScopeRow {
  userId?: string | null;
  parentConversationId?: string | null;
}

/** Ownership-walk depth cap. Mirrors the executor's MAX_SPAWN_DEPTH
 *  (spawn-assignment-handler.ts) — sub-conversations never nest deeper. */
const OWNER_WALK_MAX_DEPTH = 10;

/**
 * Returns true if the given user is authorized to receive events for
 * the given conversation. Strict mode: only the owner today. Team-shares
 * are a future extension point (see `conversation_shares` when added).
 *
 * Sub-conversations (orchestration spawns) historically persisted with
 * `userId: null` — ownership is inherited from the parent chain, so a
 * null-owner conversation with a `parentConversationId` walks upward
 * (capped at {@link OWNER_WALK_MAX_DEPTH}) until an owner is found.
 * A chain that ends ownerless is NOT authorized for anyone.
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
  getConversation: (id: string) => Promise<ConversationScopeRow | null>,
  failMode: "open" | "closed" = "open",
): Promise<boolean> {
  const key = cacheKey(userId, conversationId);
  const now = Date.now();
  const hit = membershipCache.get(key);
  if (hit && hit.expiresAt > now) return hit.authorized;

  try {
    let authorized = false;
    let currentId: string | null = conversationId;
    for (let depth = 0; depth <= OWNER_WALK_MAX_DEPTH && currentId; depth++) {
      const conv: ConversationScopeRow | null = await getConversation(currentId);
      if (!conv) break;
      if (typeof conv.userId === "string" && conv.userId.length > 0) {
        authorized = conv.userId === userId;
        break;
      }
      currentId = conv.parentConversationId ?? null;
    }
    membershipCache.set(key, { authorized, expiresAt: now + CACHE_TTL_MS });
    return authorized;
  } catch (err) {
    // Legacy direct carriers fail OPEN (an individual leak beats a
    // blacked-out UI — see module-level rationale). Wave-0 scoped
    // streaming events (raw tokens) fail CLOSED: re-opening the
    // cross-user token leak under DB stress is exactly the failure
    // this filter exists to prevent. Errors are never cached.
    log.warn(`conversation-membership lookup failed, ${failMode === "open" ? "passing event through (fail-open)" : "dropping event (fail-closed)"}`, {
      userId,
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return failMode === "open";
  }
}

/** Clear the membership cache. Test-only. */
export function __clearMembershipCacheForTests(): void {
  membershipCache.clear();
}

// ── Run-scope resolution (Wave 0) ───────────────────────────────────

/** Resolved delivery scope for a run: the owning conversation (chat
 *  runs) and/or the initiating user (agent/CLI runs). */
export interface RunScope {
  conversationId?: string | null;
  userId?: string | null;
}

/** Resolver injected by the SSE route — backed by the executor's
 *  in-memory `runConversations` map with a persisted-row fallback
 *  (`AgentExecutor.getRunConversationId` / `getRunOwnership`). */
export type GetRunScope = (runId: string) => Promise<RunScope | null>;

/**
 * Per-process cache for runId → scope. A run's conversation/user never
 * changes after creation, so the TTL exists only to bound memory (the
 * hot case — `run:token` — fires many times per second per run).
 */
interface RunScopeCacheEntry { scope: RunScope | null; expiresAt: number; }
const runScopeCache = new Map<string, RunScopeCacheEntry>();

async function resolveRunScope(
  runId: string,
  getRunScope: GetRunScope,
): Promise<RunScope | null> {
  const now = Date.now();
  const hit = runScopeCache.get(runId);
  if (hit && hit.expiresAt > now) return hit.scope;
  const scope = await getRunScope(runId);
  // Don't cache unresolved scopes: the run row may simply not be
  // written yet (insertRun races the first `run:start` emit).
  if (scope && (scope.conversationId || scope.userId)) {
    runScopeCache.set(runId, { scope, expiresAt: now + CACHE_TTL_MS });
  }
  return scope;
}

/** Clear the run-scope cache. Test-only. */
export function __clearRunScopeCacheForTests(): void {
  runScopeCache.clear();
}

/** The three legacy optional-carrier terminal events. When their
 *  optional `conversationId` is absent, Wave 0 upgrades them to runId
 *  resolution before falling back to the historical pass-through. */
const RUN_TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run:complete",
  "run:error",
  "run:cancel",
]);

/** Extract a run id from a payload: top-level `runId`, else `run.id`. */
function extractRunId(payload: unknown): string | undefined {
  const p = (payload ?? {}) as { runId?: unknown; run?: { id?: unknown } | null };
  if (typeof p.runId === "string" && p.runId) return p.runId;
  const nested = p.run?.id;
  return typeof nested === "string" && nested ? nested : undefined;
}

/**
 * Wave-0 fail-closed delivery decision for {@link SCOPED_RUNTIME_EVENT_TYPES}.
 * Resolution order documented on the set definition.
 */
async function deliverScopedRuntimeEvent(
  payload: unknown,
  subscriber: { userId: string; conversationId?: string },
  getConversation: (id: string) => Promise<ConversationScopeRow | null>,
  getRunScope: GetRunScope | undefined,
): Promise<boolean> {
  const p = (payload ?? {}) as Record<string, unknown>;

  // 1+2. Direct conversation carriers (agent:spawn/complete carry
  // `parentConversationId`; future emitters may carry `conversationId`).
  for (const key of ["conversationId", "parentConversationId"] as const) {
    const v = p[key];
    if (typeof v === "string" && v) {
      return isAuthorizedForConversation(subscriber.userId, v, getConversation, "closed");
    }
  }

  // 3. Explicit user scope (pipeline:* carry the initiating userId).
  if (typeof p.userId === "string" && p.userId) {
    return p.userId === subscriber.userId;
  }

  // 4. runId → scope resolution via the executor-backed resolver.
  const runId = extractRunId(p);
  if (runId && getRunScope) {
    try {
      const scope = await resolveRunScope(runId, getRunScope);
      if (typeof scope?.conversationId === "string" && scope.conversationId) {
        return isAuthorizedForConversation(
          subscriber.userId,
          scope.conversationId,
          getConversation,
          "closed",
        );
      }
      if (typeof scope?.userId === "string" && scope.userId) {
        return scope.userId === subscriber.userId;
      }
    } catch (err) {
      log.warn("run-scope resolution failed, dropping event (fail-closed)", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // 5. Sub-conversation carrier (agent:status). Ownership walks to the
  // parent chain inside isAuthorizedForConversation.
  if (typeof p.subConversationId === "string" && p.subConversationId) {
    return isAuthorizedForConversation(
      subscriber.userId,
      p.subConversationId,
      getConversation,
      "closed",
    );
  }

  // 6. Unattributable → NEVER broadcast.
  return false;
}

/**
 * Decide whether an event should be delivered to a given subscriber.
 *
 * @param eventType - The bus event name.
 * @param payload - The event payload. We look for `conversationId` only.
 * @param subscriber - The subscriber context captured at SSE connect.
 * @param getConversation - Injected DB accessor so this module stays
 *                          free of server/client module-path coupling.
 * @param getRunScope - Optional executor-backed runId→scope resolver
 *                      (Wave 0). Absent (legacy callers/tests) means
 *                      scoped runtime events without a direct carrier
 *                      are dropped — fail closed, never broadcast.
 * @returns true if the event should reach the subscriber.
 */
export async function shouldDeliverEvent(
  eventType: keyof AgentEvents | string,
  payload: unknown,
  subscriber: { userId: string; conversationId?: string },
  getConversation: (id: string) => Promise<ConversationScopeRow | null>,
  getRunScope?: GetRunScope,
): Promise<boolean> {
  // Not a direct-carrier event → pass through. Client-side filtering
  // handles any conversation-identity resolution via `runId`.
  // Both platform (`DIRECT_CARRIER_EVENT_TYPES`) and extension-declared
  // events (`isRegisteredExtensionEvent`) get the same scope filter.
  if (!isDirectCarrierEvent(eventType as string)) return true;

  // Wave 0: run-scoped streaming events — fail-closed multi-key scope
  // resolution (raw-token leak fix). See SCOPED_RUNTIME_EVENT_TYPES.
  if (SCOPED_RUNTIME_EVENT_TYPES.has(eventType as keyof AgentEvents)) {
    return deliverScopedRuntimeEvent(payload, subscriber, getConversation, getRunScope);
  }

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
  // Wave 0 first attempts runId→scope resolution — these events carry
  // `run.result` (agent-run output), so an attributable one is scoped
  // to its owner. Only a genuinely unresolvable event keeps the
  // historical pass-through (extension optional carriers, legacy
  // emitters, callers without a resolver).
  const convId = (payload as { conversationId?: unknown } | null | undefined)?.conversationId;
  if (typeof convId !== "string" || !convId) {
    if (RUN_TERMINAL_EVENT_TYPES.has(eventType as string) && getRunScope) {
      const runId = extractRunId(payload);
      if (runId) {
        const scope = await resolveRunScope(runId, getRunScope).catch(() => null);
        if (typeof scope?.conversationId === "string" && scope.conversationId) {
          return isAuthorizedForConversation(
            subscriber.userId,
            scope.conversationId,
            getConversation,
            "closed",
          );
        }
        if (typeof scope?.userId === "string" && scope.userId) {
          return scope.userId === subscriber.userId;
        }
      }
    }
    return true;
  }

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

  // Sessions P4 `conversation:tree-changed` fails CLOSED: a missed nudge just
  // recovers on the next reconnect/refetch, whereas fail-open would (under DB
  // stress) hand one user's conversation id + rewound-leaf id to another. A
  // dropped nudge is a strictly better trade than that leak — so this event
  // does NOT take the fail-OPEN default the other conv-scoped carriers use.
  if (eventType === "conversation:tree-changed") {
    return isAuthorizedForConversation(subscriber.userId, convId, getConversation, "closed");
  }

  // Filter: subscriber must be authorized for the event's conversation.
  return isAuthorizedForConversation(subscriber.userId, convId, getConversation);
}
