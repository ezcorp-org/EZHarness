// ── createCanvas — Phase A1 SDK helper for live-preview tool cards ──
//
// One-call surface for extensions that want a tool whose result renders
// as a custom UI card AND that bidirectionally exchange events with that
// card (knob changes, comments, button clicks, etc.).
//
// Today an extension wires three things bespoke:
//   1. Manifest: declare `cardType` on the tool and `eventSubscriptions`
//      on permissions.
//   2. Subprocess: `registerEventHandler("<ext>:<event>", ...)` for each
//      inbound event from the canvas.
//   3. Host: a custom POST endpoint (`/api/<ext>/<event>`) that the
//      Svelte card hits, plus an entry in `DIRECT_CARRIER_EVENT_TYPES`.
//
// `createCanvas` consolidates (2) into a single typed call. It still
// relies on the manifest declarations of (1) and the host primitives
// delivered alongside it (generic event route + pattern-matched
// allowlist) — see Phase A2 work.
//
// Example (claude-design):
//
//   const canvas = createCanvas({
//     cardType: "design-canvas",
//     namespace: "claude-design",         // must match manifest.name
//     events: {
//       "knob-change": async ({ payload, context }) => {
//         const { draftId, knobs } = payload as KnobPayload;
//         await tweakDesign({ draftId, knobs });
//         // Phase A.5/B will add `canvas.refresh(toolCallId, ...)`
//         // here to push the new revision back into the open card.
//       },
//     },
//   });
//
// The helper does NOT read the manifest — there's no way for an SDK
// running in the subprocess to introspect its own manifest. `cardType`
// and `namespace` are caller-supplied and must match the manifest. A
// mismatch fails closed: events the host would dispatch under
// `<namespace>:<event>` would never reach a handler at the wrong name.
//
// SDK→host push-back path (canvas refresh / close): intentionally NOT
// in Phase A. The wiring requires (i) a host subprocess-notification
// handler that validates cardType ownership, (ii) new direct-carrier
// bus events `canvas:refresh` / `canvas:close`, and (iii) browser
// SSE listening + iframe re-keying inside `ExtensionIframeCard`. We
// ship A2 with the inbound side wired and add the outbound side when
// Phase B's first consumer drives the design. Premature shipping of
// no-op `refresh()`/`close()` was rejected by review as "dead code
// that looks functional" — see the plan's open questions section.

import { getChannel } from "./channel";

// ── Types ───────────────────────────────────────────────────────────

/** Per-call metadata threaded by the host through the event payload. */
export interface CanvasContext {
  /** Unique id of the tool call whose card emitted this event. */
  toolCallId: string;
  /** Conversation the card lives in. Always present — events without
   *  a conversationId are dropped at the dispatcher (defense in depth
   *  against cross-conversation bleed). */
  conversationId: string;
}

/** Handler signature for a single canvas event.
 *
 * `payload` is the full host-sent frame — `toolCallId` and
 * `conversationId` are sibling fields of the user-defined event data
 * (matches the wire format used by every existing direct-carrier
 * event; see `docs/extensions/examples/ask-user/index.ts:204-211`
 * for the canonical reference). `context` is a typed convenience
 * extracted from those same fields, so consumers don't have to
 * re-validate them. */
export type CanvasEventHandler<TPayload = unknown> = (args: {
  payload: TPayload;
  context: CanvasContext;
}) => Promise<void> | void;

/** Default event-map type when consumers don't supply one. Matches the
 *  pre-Phase-C-fix behavior (every payload was `unknown`). */
export type DefaultCanvasEvents = Record<string, unknown>;

export interface CanvasOptions<TEvents extends DefaultCanvasEvents = DefaultCanvasEvents> {
  /** The `cardType` string declared on the manifest tool definition.
   *  The host's `getCardComponentName(cardType)` resolves this to a
   *  Svelte component. */
  cardType: string;
  /** Extension-name prefix for the event bus. MUST equal the
   *  extension's `manifest.name`. The host validates this server-side
   *  on the generic event route — a mismatch silently produces no
   *  delivery, which the SDK can't detect. */
  namespace: string;
  /** Map of event-name-suffix → typed handler. Supplying the
   *  `TEvents` generic narrows each handler's `payload` to the
   *  declared shape, eliminating the `as` cast both real-world
   *  consumers (claude-design, ask-user) had to use pre-Phase-C-fix.
   *
   *  Example:
   *    createCanvas<{ "knob-change": { draftId: string; knobs: Knobs } }>({
   *      …,
   *      events: { "knob-change": ({ payload }) => …payload.knobs… }
   *    });
   *
   *  Multiple `createCanvas` calls with the same `namespace:eventName`
   *  overwrite — channel.onRequest is a Map, last write wins. */
  events: { [K in keyof TEvents & string]: CanvasEventHandler<TEvents[K]> };
}

/** Empty handle returned by `createCanvas`. Reserved for forward-
 *  compatibility — Phase A.5/B will add `refresh(toolCallId, ...)`
 *  and `close(toolCallId)` once the host-side bus events + browser
 *  iframe re-keying are wired. Today the inbound event flow is
 *  complete; outbound push-back from the extension to its open card
 *  is intentionally deferred to avoid shipping no-op methods. */
export type Canvas = Record<string, never>;

// ── Constants ───────────────────────────────────────────────────────

/** Method name pattern for inbound canvas events from the host. Mirrors
 *  the existing `ezcorp/event/<eventType>` convention used by
 *  registerEventHandler — keeps host dispatcher code simple. */
const EVENT_METHOD_PREFIX = "ezcorp/event/";

/** Validation: namespace must be a non-empty extension name. Mirrors
 *  the manifest `name` regex — see `src/extensions/manifest.ts`. */
const NAMESPACE_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

// ── Implementation ──────────────────────────────────────────────────

/**
 * Register a tool card's event handlers and return a handle for pushing
 * updates back to any open card with this cardType.
 *
 * The returned `Canvas` is stateless — internally it just constructs
 * the right JSON-RPC notify frames. Multiple `createCanvas` calls on
 * the same channel are independent; they only collide if they share
 * an event name (last-write-wins, Map semantics on `channel.onRequest`).
 *
 * Throws synchronously for invalid options. Failures during dispatch
 * (host doesn't have the cardType registered, no card is open, etc.)
 * are silent — fire-and-forget matches the rest of the SDK.
 */
export function createCanvas<TEvents extends DefaultCanvasEvents = DefaultCanvasEvents>(
  opts: CanvasOptions<TEvents>,
): Canvas {
  if (typeof opts.cardType !== "string" || opts.cardType.length === 0) {
    throw new Error("[@ezcorp/sdk] createCanvas: cardType must be a non-empty string");
  }
  if (typeof opts.namespace !== "string" || !NAMESPACE_REGEX.test(opts.namespace)) {
    throw new Error(
      "[@ezcorp/sdk] createCanvas: namespace must match extension name regex " +
        "(/^[a-z0-9][a-z0-9-_.]{0,63}$/)",
    );
  }
  if (!opts.events || typeof opts.events !== "object") {
    throw new Error("[@ezcorp/sdk] createCanvas: events must be an object map");
  }

  const ch = getChannel();

  for (const [eventName, handler] of Object.entries(opts.events)) {
    if (typeof handler !== "function") {
      throw new Error(
        `[@ezcorp/sdk] createCanvas: handler for "${eventName}" must be a function`,
      );
    }
    const fullName = `${opts.namespace}:${eventName}`;
    ch.onRequest(`${EVENT_METHOD_PREFIX}${fullName}`, async (params: unknown) => {
      // Wire format. Two shapes are supported:
      //   (a) canvas-card events:    { toolCallId, conversationId, …userData }
      //   (b) messageToolbar events: { messageId,  conversationId, …userData }
      //
      // `conversationId` is the only field common to both — it's the
      // dispatcher's scope key and is guaranteed-present by the route.
      // `toolCallId` is empty for messageToolbar events; consumers that
      // need it should pull from `payload` and noop when absent.
      //
      // We pass the whole frame as `payload` so handlers can destructure
      // whatever their event uses (toolCallId / messageId / custom
      // fields). The typed `context` keeps existing canvas-card consumers
      // working — they read `context.toolCallId` and get an empty string
      // for messageToolbar shape, which their existing
      // "if (toolCallId)" guards already short-circuit on.
      const frame = (params ?? {}) as Record<string, unknown>;
      const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
      const conversationId =
        typeof frame.conversationId === "string" ? frame.conversationId : "";
      if (!conversationId) {
        // Drop silently — the dispatcher already gates on conversationId
        // before delivery, so the only way to hit this is a host bug or
        // a hand-crafted frame. Throwing here would bubble into the
        // channel error envelope and confuse the caller (notifications
        // don't even read the response).
        return undefined;
      }
      await handler({
        payload: frame as never,
        context: { toolCallId, conversationId },
      });
      return undefined;
    });
  }

  return {};
}
