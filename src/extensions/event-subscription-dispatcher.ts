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
  registerExtensionEvent,
  unregisterExtensionEvent,
} from "../runtime/sse-conversation-filter";
import { createRateLimiter } from "./rate-limit";
import { capabilityToolsDisabled } from "./capability-flags";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import { logger } from "../logger";

const log = logger.child("event-subscription-dispatcher");

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
  /** Phase 51.4: per-extension `includeFullPayload` flag.
   *  When true, the dispatcher does NOT strip `input`/`output` from
   *  `tool:start` / `tool:complete` payloads. Default false. */
  private readonly includeFullPayload = new Map<string, boolean>();
  /** bus.on() unsubscribers, populated by `start()`. */
  private readonly unsubscribers: Array<() => void> = [];
  /** Token-bucket limiter — 50 ops/sec per extensionId by default. */
  private readonly consume: (id: string, count: number) => boolean;
  /** extensionId → timestamp of last audited overflow (ms). Throttles
   *  EVENT_SUBSCRIPTION_DENIED audit writes to avoid amplification. */
  private readonly lastOverflowAudit = new Map<string, number>();
  private readonly overflowAuditMs: number;
  private started = false;
  /** Phase 51.4: sample-N for the `ext:sdk-event-delivered` audit row.
   *  1-in-N events get audited. Reads from
   *  `global:eventSubscriptionAuditSampleN` (default 100). The hash
   *  function `{extensionId, eventType, ts}` makes inclusion
   *  reproducible — useful for tests asserting the firing pattern.
   *  Tests inject a fixed value via `setAuditSampleN`. */
  private auditSampleN = 100;

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
   * Record an extension's declared event interest. Two kinds of event
   * names are accepted:
   *
   *   1. Platform events from `DIRECT_CARRIER_EVENT_TYPES` (e.g.
   *      `"task:snapshot"`, `"ask-user:answer"`). Same behavior as
   *      before Phase A2.
   *
   *   2. Extension-declared events of the form `<extName>:<event>`,
   *      where `<extName>` MUST equal this extension's manifest name.
   *      Cross-namespace subscription is rejected — extensions can
   *      only subscribe to their own canvas events. Accepted entries
   *      are also registered with the SSE filter so
   *      `shouldDeliverEvent` treats them as direct carriers.
   *
   * Event names not matching either branch are silently filtered.
   * Defense-in-depth — the manifest clamp at install time should
   * already have rejected them.
   */
  /** Phase 51.4: override the sample-N for tests. Production reads
   *  this from the `global:eventSubscriptionAuditSampleN` setting. */
  setAuditSampleN(n: number): void {
    this.auditSampleN = Math.max(1, Math.floor(n));
  }

  /** Phase 51.4: register the per-extension `includeFullPayload` flag
   *  derived at install time from the manifest's object-form
   *  `eventSubscriptions: {events, includeFullPayload}`. Default
   *  false. */
  setIncludeFullPayload(extensionId: string, value: boolean): void {
    this.includeFullPayload.set(extensionId, value);
  }

  registerExtension(extensionId: string, eventTypes: string[]): void {
    // Defensive: tests pass a stub registry that may not implement
    // `getManifest`. Treat missing as "no manifest", which short-circuits
    // the extension-event branch — platform events still register.
    const manifest =
      typeof this.registry.getManifest === "function"
        ? this.registry.getManifest(extensionId)
        : undefined;
    const ownNamespace = manifest?.name;

    let extSubs = this.subscriptions.get(extensionId);
    let added = 0;

    for (const eventType of eventTypes) {
      // Branch 1: platform event.
      if (DIRECT_CARRIER_EVENT_TYPES.has(eventType as SubscribableEvent)) {
        if (!extSubs) {
          extSubs = new Set();
          this.subscriptions.set(extensionId, extSubs);
        }
        extSubs.add(eventType as SubscribableEvent);
        let extSet = this.eventToExtensions.get(eventType as SubscribableEvent);
        if (!extSet) {
          extSet = new Set();
          this.eventToExtensions.set(eventType as SubscribableEvent, extSet);
        }
        extSet.add(extensionId);
        added++;
        continue;
      }

      // Branch 2: extension-declared event `<extName>:<event>`.
      // Reject if no manifest (extension not registered) or namespace
      // mismatch (cross-namespace subscription).
      if (!ownNamespace) continue;
      const colon = eventType.indexOf(":");
      if (colon <= 0 || colon >= eventType.length - 1) continue;
      const ns = eventType.slice(0, colon);
      const ev = eventType.slice(colon + 1);
      if (ns !== ownNamespace) continue;

      if (!registerExtensionEvent(ns, ev)) continue;

      if (!extSubs) {
        extSubs = new Set();
        this.subscriptions.set(extensionId, extSubs);
      }
      extSubs.add(eventType as SubscribableEvent);
      let extSet = this.eventToExtensions.get(eventType as SubscribableEvent);
      if (!extSet) {
        extSet = new Set();
        this.eventToExtensions.set(eventType as SubscribableEvent, extSet);
      }
      extSet.add(extensionId);
      added++;
    }

    // Touched extension but added nothing — leave maps clean.
    if (added === 0 && extSubs && extSubs.size === 0) {
      this.subscriptions.delete(extensionId);
    }
  }

  /**
   * Drop every registration for an extension. Used when an extension
   * is uninstalled or its manifest reloads with a different event set.
   * Mirrors the SSE filter's `unregisterExtensionEvents` semantics.
   */
  unregisterExtension(extensionId: string): void {
    const subs = this.subscriptions.get(extensionId);
    if (!subs) return;
    // Resolve the extension's own namespace once. We use it to
    // determine which `subs` entries are extension-declared (and
    // therefore have a matching SSE-filter registry entry to clean
    // up) vs platform events (registered as direct carriers; not
    // owned by us).
    const manifest =
      typeof this.registry.getManifest === "function"
        ? this.registry.getManifest(extensionId)
        : undefined;
    const ownNamespace = manifest?.name;

    for (const eventType of subs) {
      const extSet = this.eventToExtensions.get(eventType);
      if (extSet) {
        extSet.delete(extensionId);
        if (extSet.size === 0) this.eventToExtensions.delete(eventType);
      }

      // Per-tuple cleanup of the SSE-filter registry. Only touch
      // entries this extension actually owns (`<ownNamespace>:<ev>`),
      // never wholesale-by-namespace — if two extensions share
      // `manifest.name` (which the registry doesn't currently
      // enforce as unique), the wholesale path would wipe the
      // sibling's events. [F1 from the Phase A security review]
      if (ownNamespace) {
        const colon = eventType.indexOf(":");
        if (colon > 0 && colon < eventType.length - 1) {
          const ns = eventType.slice(0, colon);
          const ev = eventType.slice(colon + 1);
          if (ns === ownNamespace) {
            unregisterExtensionEvent(ns, ev);
          }
        }
      }
    }
    this.subscriptions.delete(extensionId);
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
      try {
        proc = this.registry.getProcessIfRunning(extId);
      } catch (err) {
        log.warn("getProcessIfRunning threw; skipping subscriber", {
          extensionId: extId,
          eventType,
          error: String(err),
        });
        continue;
      }
      if (!proc) continue;
      try {
        const allowFull = this.includeFullPayload.get(extId) === true;
        proc.sendNotification(
          `ezcorp/event/${eventType}`,
          sanitize(eventType, payload, allowFull),
        );
        // Phase 51.4 sampled audit. Reproducible 1-in-N inclusion
        // keyed on the {extensionId, eventType, ts} tuple — a test
        // can mock the timestamp and assert deterministic firing.
        this.maybeAuditDelivery(extId, eventType);
      } catch (err) {
        // sendNotification already swallows internally; belt-and-suspenders.
        log.debug("sendNotification threw despite internal swallow", {
          extensionId: extId,
          eventType,
          error: String(err),
        });
      }
    }
  }

  /** Phase 51.4 — sampled audit hook. Reproducible 1-in-N selector
   *  keyed on `{extensionId, eventType, ts}`. */
  private maybeAuditDelivery(extensionId: string, eventType: string): void {
    if (this.auditSampleN <= 1) {
      // Sample everything (test mode).
    } else {
      const tup = `${extensionId}|${eventType}|${Date.now()}`;
      let h = 0x811c9dc5;
      for (let i = 0; i < tup.length; i++) {
        h ^= tup.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      if ((h >>> 0) % this.auditSampleN !== 0) return;
    }
    insertAuditEntry(
      null,
      EXT_AUDIT_ACTIONS.SDK_EVENT_DELIVERED,
      extensionId,
      {
        capability: "events",
        oldValue: undefined,
        newValue: eventType,
        actor: "system",
        reason: `sampled-1-in-${this.auditSampleN}`,
      },
    ).catch(() => {});
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

// ── sanitize() seam (Phase 51.4 hardened) ───────────────────────────
//
// For `tool:start` and `tool:complete` we strip the heavy `input` /
// `output` blobs unless the extension's grant explicitly includes
// `includeFullPayload: true`. Other direct-carrier events are passed
// through unchanged.
//
// Phase 51.4 added `includeFullPayload` to the grant shape — extensions
// must opt in via the manifest object form
// `{events: [...], includeFullPayload: true}`. When the host clamps
// at install time, the flag flows through into `registerExtension`'s
// `payloadAllowlist` map; lookup is per-extension at sanitize time.
const HEAVY_PAYLOAD_EVENTS = new Set(["tool:start", "tool:complete"]);

function sanitize(
  eventType: string,
  payload: unknown,
  includeFullPayload: boolean,
): Record<string, unknown> {
  const obj = (payload ?? {}) as Record<string, unknown>;
  if (!HEAVY_PAYLOAD_EVENTS.has(eventType) || includeFullPayload) {
    return obj;
  }
  // Strip the heavy blobs but keep everything else (id, conversationId,
  // toolName, status, etc.).
  const { input, output, ...rest } = obj;
  void input; void output;
  return rest;
}
