/**
 * preview-detection-bridge.ts — push a detected/exposed preview onto the
 * LIVE conversation SSE stream (Secure User-Site Preview / Port Exposure,
 * Phase 3a — see tasks/preview-port-exposure.md §3.3 + "Phase 3 REDESIGN"
 * item 6).
 *
 * Phase 2 left the "surface the consent card / URL onto the conversation
 * stream" step as a seam: `decideOnDetection` returns a DetectionDecision
 * (auto-exposed | consent-card | skipped) but nothing rendered it. This
 * bridge closes that seam by translating a decision into an `AgentEvents`
 * `tool:complete` event carrying the consent `cardType` — the SAME SSE
 * carrier the propose/ask_user cards ride (so it routes through
 * `shouldDeliverEvent` to ONLY the originating user's conversation tab).
 *
 * It is PURE over an injected `EventBus` so it is fully unit-testable
 * without the live web bus. The wiring point (`onPreviewDetected` in the
 * watcher's `onDetected`, fed `getBus()` from $lib/server/context) is the
 * documented integration seam — the backend watcher can't import the web
 * bus directly, so the bus is injected at the call site.
 *
 * Card render note (prior incident): a card without `cardType` won't render
 * (EzToolResultCard / ToolCardRouter). We set PREVIEW_CONSENT_CARD_TYPE so
 * the existing card pipeline picks it up. Dedup-by-id is the streaming
 * tool-call path's concern; this is a one-shot `tool:complete`, not a
 * `tool:start`, so it renders once.
 */

import type { EventBus } from "../events";
import type { AgentEvents } from "../../types";
import { logger } from "../../logger";
import {
  decideOnDetection,
  PREVIEW_CONSENT_CARD_TYPE,
  type DetectionDecision,
} from "./preview-consent";
import type { PreviewDetectedEvent } from "./preview-port-watcher";

const log = logger.child("preview.detection-bridge");

/** The synthetic extension id the preview cards are attributed to on the
 *  bus (mirrors how ask_user attributes its cards to a host extension). */
export const PREVIEW_HOST_EXTENSION_ID = "ezcorp-preview";

/**
 * Build the full `<id>.preview.<appHost>` URL the browser opens to redeem
 * the one-time code: `https://<label>.preview.<appHost>/__open?c=<code>`.
 * Returns null when no app host is configured (preview origin disabled) —
 * the caller then surfaces a code-less card or skips, never a broken URL.
 */
export function buildPreviewOpenUrl(
  subdomainLabel: string,
  code: string,
  appHost: string | null,
  secure: boolean,
): string | null {
  if (!appHost || appHost.trim().length === 0) return null;
  const scheme = secure ? "https" : "http";
  return `${scheme}://${subdomainLabel}.preview.${appHost.trim()}/__open?c=${encodeURIComponent(code)}`;
}

/**
 * Emit a decision onto the conversation's live SSE stream via the bus.
 * Pure over `bus` + `appHost`. Returns the event payload it emitted (or
 * null for a skipped/no-op decision) so tests can assert without spying on
 * the bus internals.
 */
export function emitDetectionDecision(
  bus: EventBus<AgentEvents>,
  decision: DetectionDecision,
  event: PreviewDetectedEvent,
  opts: { appHost: string | null; secure: boolean } = { appHost: null, secure: false },
): AgentEvents["tool:complete"] | null {
  if (decision.kind === "skipped") {
    log.info("preview detection skipped — nothing surfaced", {
      conversationId: event.conversationId,
      reason: decision.reason,
    });
    return null;
  }

  let output: unknown;
  if (decision.kind === "auto-exposed") {
    const url = buildPreviewOpenUrl(decision.subdomainLabel, decision.code, opts.appHost, opts.secure);
    output = {
      kind: "auto-exposed",
      previewId: decision.previewId,
      port: decision.port,
      url, // null when no app host is configured (preview origin disabled)
    };
  } else {
    // consent-card
    output = { kind: "consent-card", port: decision.port, card: decision.card };
  }

  const payload: AgentEvents["tool:complete"] = {
    conversationId: event.conversationId,
    extensionId: PREVIEW_HOST_EXTENSION_ID,
    toolName: "preview_detected",
    output,
    duration: 0,
    success: true,
    source: "inline",
    cardType: PREVIEW_CONSENT_CARD_TYPE,
  };
  bus.emit("tool:complete", payload);
  log.info("preview detection surfaced to conversation stream", {
    conversationId: event.conversationId,
    port: event.port,
    kind: decision.kind,
  });
  return payload;
}

/**
 * The watcher's `onDetected` handler, complete: run the consent decision
 * (always-expose → auto-expose, else a consent card) and push it onto the
 * live conversation stream via the injected bus.
 *
 * The bus is injected (not imported) because the live SSE bus lives in the
 * web layer ($lib/server/context's getBus()), which the backend watcher
 * cannot import. The startup wiring passes a `() => EventBus` getter; until
 * that getter is available (e.g. a backend-only boot), it is a logged
 * no-op rather than a crash — fail-safe, mirroring the watcher's other
 * swallowed-failure contracts.
 */
export async function onPreviewDetected(
  event: PreviewDetectedEvent,
  deps: {
    getBus: () => EventBus<AgentEvents> | null;
    appHost: () => string | null;
    secure?: () => boolean;
    decide?: (e: PreviewDetectedEvent) => Promise<DetectionDecision>;
  },
): Promise<void> {
  const decide = deps.decide ?? decideOnDetection;
  let decision: DetectionDecision;
  try {
    decision = await decide(event);
  } catch (err) {
    log.warn("preview detection routing failed", {
      conversationId: event.conversationId,
      error: String((err as Error)?.message ?? err),
    });
    return;
  }

  const bus = deps.getBus();
  if (!bus) {
    log.warn("preview detected but no live bus available — card not surfaced", {
      conversationId: event.conversationId,
      decision: decision.kind,
    });
    return;
  }
  emitDetectionDecision(bus, decision, event, {
    appHost: deps.appHost(),
    secure: deps.secure?.() ?? false,
  });
}
