/**
 * EventSubscriptionDispatcher — server→extension bus-event delivery (Phase 2c).
 *
 * Sibling of `LifecycleHookDispatcher`. Differences:
 *  - Only the 13 direct-carrier event types from `sse-conversation-filter.ts`
 *    are deliverable; any other event declared in a manifest's
 *    `eventSubscriptions` is silently dropped at `registerExtension` time.
 *  - Delivery is ALWAYS gated on `conversation_extensions` wiring for the
 *    event's `conversationId`. An extension never sees traffic from a
 *    conversation it wasn't wired into — no admin bypass, no opt-out.
 *  - Per-extension rate limit via the shared `createRateLimiter(50)`
 *    helper. Over-rate drops are audited via `EVENT_SUBSCRIPTION_DENIED`,
 *    throttled to one row per 1-second window per extension to avoid
 *    audit amplification on a busy conversation.
 *  - Single kill-switch gate: `capabilityToolsDisabled()` short-circuits
 *    `start()` entirely. With the flag set, the dispatcher's map is
 *    never wired onto the bus, so no events are delivered.
 *
 * Backpressure: drop, never queue, never disconnect. If a subprocess is
 * sleeping (`getProcessIfRunning` returns null) the delivery is a no-op;
 * if its stdin is closed, `sendNotification`'s internal try/catch in
 * `subprocess.ts` swallows the error. Mirrors the `LifecycleHookDispatcher`
 * fire-and-forget shape.
 */

import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import type { ExtensionRegistry } from "./registry";
import {
  DIRECT_CARRIER_EVENT_TYPES,
} from "../runtime/sse-conversation-filter";
import { createRateLimiter } from "./rate-limit";
import { capabilityToolsDisabled } from "./capability-flags";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";

// ── Types ───────────────────────────────────────────────────────────

type SubscribableEvent = keyof AgentEvents & string;

/** Injectable DB accessor — same pattern as sse-conversation-filter. Lets
 *  tests feed a pure-function fake without spinning up PGlite. */
export type WiredExtensionLookup = (conversationId: string) => Promise<string[]>;

export interface EventSubscriptionDispatcherOptions {
  /** Max notifications per second per extensionId. Defaults to 50,
   *  matching the capability-RPC rate limit. */
  maxOpsPerSecond?: number;
  /** Minimum interval between audited overflow rows per extensionId.
   *  Defaults to 1 second. Prevents audit amplification on a busy
   *  conversation. */
  overflowAuditMs?: number;
}

const DEFAULT_MAX_OPS = 50;
const DEFAULT_OVERFLOW_AUDIT_MS = 1000;

// ── Dispatcher ──────────────────────────────────────────────────────

export class EventSubscriptionDispatcher {
  /** extensionId → set of subscribed event types (post-clamp). */
  private readonly subscriptions = new Map<string, Set<SubscribableEvent>>();
  /** event type → set of extensionIds subscribed to it. Mirror of
   *  `subscriptions` so `dispatch` can fan out without a full-map scan. */
  private readonly eventToExtensions = new Map<SubscribableEvent, Set<string>>();
  /** bus.on() unsubscribers, populated by `start()`. */
  private readonly unsubscribers: Array<() => void> = [];
  /** Token-bucket limiter — 50 ops/sec per extensionId by default. */
  private readonly consume: (id: string, count: number) => boolean;
  /** extensionId → timestamp of last audited overflow (ms). Throttles
   *  EVENT_SUBSCRIPTION_DENIED audit writes to avoid amplification. */
  private readonly lastOverflowAudit = new Map<string, number>();
  private readonly overflowAuditMs: number;
  private started = false;

  constructor(
    private readonly bus: EventBus<AgentEvents>,
    private readonly registry: ExtensionRegistry,
    private readonly getWiredExtensions: WiredExtensionLookup,
    options: EventSubscriptionDispatcherOptions = {},
  ) {
    this.consume = createRateLimiter(options.maxOpsPerSecond ?? DEFAULT_MAX_OPS);
    this.overflowAuditMs = options.overflowAuditMs ?? DEFAULT_OVERFLOW_AUDIT_MS;
  }

  /**
   * Record an extension's declared event interest. Event names not in
   * `DIRECT_CARRIER_EVENT_TYPES` are silently filtered — the clamp at
   * install time already does this, so this is defense-in-depth for
   * manifests that bypassed the clamp path.
   */
  registerExtension(extensionId: string, eventTypes: string[]): void {
    const valid = eventTypes.filter((e): e is SubscribableEvent =>
      DIRECT_CARRIER_EVENT_TYPES.has(e as SubscribableEvent),
    );
    if (valid.length === 0) return;

    let extSubs = this.subscriptions.get(extensionId);
    if (!extSubs) {
      extSubs = new Set();
      this.subscriptions.set(extensionId, extSubs);
    }
    for (const eventType of valid) {
      extSubs.add(eventType);
      let extSet = this.eventToExtensions.get(eventType);
      if (!extSet) {
        extSet = new Set();
        this.eventToExtensions.set(eventType, extSet);
      }
      extSet.add(extensionId);
    }
  }

  /**
   * Wire bus listeners for every event type that has at least one
   * subscriber. No-op when the kill-switch is set — the SINGLE GATE that
   * disables the entire Phase 2c tier. After this call, `eventToExtensions`
   * is read-only from the bus-emit path; new `registerExtension` calls
   * won't take effect on already-wired events (same behavior as
   * `LifecycleHookDispatcher`).
   */
  start(): void {
    if (this.started) return;
    if (capabilityToolsDisabled()) return;
    this.started = true;

    for (const eventType of this.eventToExtensions.keys()) {
      const unsub = this.bus.on(eventType as never, (data: unknown) => {
        // Fire-and-forget — bus.emit doesn't await, so we can't either.
        void this.dispatch(eventType, data);
      });
      this.unsubscribers.push(unsub);
    }
  }

  /**
   * Tear down bus listeners. Safe to call on an unstarted dispatcher.
   * Does not clear subscription maps — `start()` is idempotent, but a
   * fresh boot after `stop()` starts from the same registrations.
   */
  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
    this.started = false;
  }

  /**
   * Deliver a single bus event to every wired + rate-limited subscriber.
   * Drops silently when:
   *  - the payload has no top-level string `conversationId` (can't scope),
   *  - the subscriber isn't wired to the event's conversation,
   *  - the subscriber is over its 50 ops/sec budget,
   *  - the subprocess isn't currently running.
   * Audits rate-limit drops (throttled); no-conversation drops are
   * expected for misclassified events and aren't audited.
   */
  private async dispatch(eventType: string, payload: unknown): Promise<void> {
    const subscribers = this.eventToExtensions.get(eventType as SubscribableEvent);
    if (!subscribers || subscribers.size === 0) return;

    const convId = (payload as { conversationId?: unknown } | null)?.conversationId;
    if (typeof convId !== "string" || !convId) return;

    let wired: Set<string>;
    try {
      wired = new Set(await this.getWiredExtensions(convId));
    } catch {
      // DB failure is failure-to-deliver. Drop silently so a transient
      // outage doesn't crash the bus-emit loop.
      return;
    }

    for (const extId of subscribers) {
      if (!wired.has(extId)) continue;
      if (!this.consume(extId, 1)) {
        this.maybeAuditOverflow(extId, eventType);
        continue;
      }
      let proc: ReturnType<ExtensionRegistry["getProcessIfRunning"]>;
      try { proc = this.registry.getProcessIfRunning(extId); } catch { continue; }
      if (!proc) continue;
      try {
        proc.sendNotification(
          `ezcorp/event/${eventType}`,
          sanitize(eventType, payload),
        );
      } catch {
        // sendNotification already swallows; belt-and-suspenders.
      }
    }
  }

  private maybeAuditOverflow(extensionId: string, eventType: string): void {
    const now = Date.now();
    const last = this.lastOverflowAudit.get(extensionId) ?? 0;
    if (now - last < this.overflowAuditMs) return;
    this.lastOverflowAudit.set(extensionId, now);
    // Fire-and-forget; a DB hiccup shouldn't wedge the dispatch loop.
    insertAuditEntry(
      null,
      EXT_AUDIT_ACTIONS.EVENT_SUBSCRIPTION_DENIED,
      extensionId,
      {
        permission: "eventSubscriptions",
        oldValue: eventType,
        newValue: eventType,
        actor: "system",
        reason: "rate-limited",
      },
    ).catch(() => {});
  }
}

// ── sanitize() seam ─────────────────────────────────────────────────
//
// Pass-through for now. Kept as a named function so future work can
// strip fields (e.g. host-owned bookkeeping not meant for extensions)
// at a single choke point. The 13 direct-carrier event types are
// already flat and safe — none embed user secrets or credentials —
// so stripping isn't needed at 2c ship time.

function sanitize(_eventType: string, payload: unknown): Record<string, unknown> {
  return (payload ?? {}) as Record<string, unknown>;
}
