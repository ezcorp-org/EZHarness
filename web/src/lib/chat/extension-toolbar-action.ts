/**
 * Pure helpers for the extension `messageToolbar[]` SDK surface.
 *
 * The host's runtime contribution flow is:
 *   1. ChatMessage fetches `/api/conversations/{id}/extension-toolbar`
 *      → array of `ExtensionToolbarItem` (one per `(extension, action)`).
 *   2. For each item whose `appliesTo` matches the row's role, build
 *      an `extensionActions` entry whose `onclick` captures the row's
 *      selection and POSTs to the extension event route.
 *
 * Step 2's logic is extracted here so unit tests can lock down:
 *   - selection clamping to the message DOM element
 *   - 4 000-char cap on the captured string (matches the kokoro-tts
 *     input cap declared in the plan)
 *   - appliesTo filtering
 *   - the exact JSON payload shape sent to `/api/extensions/{name}/events/{event}`
 *
 * No Svelte runes, no DOM imports outside of typing — keeps the helper
 * usable from `bun:test` without jsdom.
 */

/**
 * Render-side contract for an extension toolbar icon. The host turns
 * each `ExtensionToolbarItem` into one `ExtensionAction` per row by
 * binding an `onclick` that captures selection + POSTs the event.
 *
 * `onclick` may return a Promise so the toolbar can show an in-flight
 * spinner for the duration of the request. Without an awaitable
 * handler, the user gets zero synchronous feedback that the click
 * registered — the new excluded turn appears later, asynchronously,
 * after the subprocess responds.
 */
export interface ExtensionAction {
  extName: string;
  id: string;
  icon: string;
  tooltip: string;
  onclick: () => void | Promise<void>;
}

/** Wire format returned by `GET /api/conversations/{id}/extension-toolbar`. */
export interface ExtensionToolbarItem {
  extName: string;
  /** Stable id within the extension; combined with extName forms a globally-unique key. */
  id: string;
  icon: string;
  tooltip: string;
  /** "user" | "assistant" | "both"; defaults to "both" if omitted. */
  appliesTo?: "user" | "assistant" | "both";
  /**
   * "single" | "bulk" | "both"; defaults to "single" if omitted. Tells
   * the host whether this contribution should also appear in the
   * multi-select bulk action bar (`SelectModeActionBar.svelte`).
   * "single" → per-message hover toolbar only (the original behavior).
   * "bulk"   → multi-select bar only.
   * "both"   → both surfaces.
   */
  appliesToSelection?: "single" | "bulk" | "both";
  /** Event name the host posts to /api/extensions/{name}/events/{event}. */
  event: string;
}

/** Maximum length of the captured selection string. */
export const SELECTION_CAP = 4_000;

/**
 * Returns true if the contribution applies to a row of the given role.
 * Defaults to `"both"` when `appliesTo` is omitted.
 */
export function appliesToRole(
  appliesTo: ExtensionToolbarItem["appliesTo"] | undefined,
  role: "user" | "assistant",
): boolean {
  const applies = appliesTo ?? "both";
  return applies === "both" || applies === role;
}

/**
 * Capture the user's current text selection clamped to a message
 * element, applying the SELECTION_CAP. Returns null when no usable
 * selection is in play (collapsed, empty, or anchored outside the row).
 *
 * The "anchored outside the row" rule prevents one row's speaker click
 * from stealing a selection that lives in a different row — common
 * mishap when the user highlights one paragraph and clicks a button
 * three rows down.
 */
export function captureSelection(
  selection: Selection | null,
  messageEl: { contains: (node: Node | null) => boolean } | null,
): string | null {
  if (!selection || selection.isCollapsed) return null;
  if (!messageEl) return null;
  if (!messageEl.contains(selection.anchorNode)) return null;
  const text = selection.toString();
  if (!text) return null;
  return text.slice(0, SELECTION_CAP);
}

/** Body sent to `/api/extensions/{name}/events/{event}` for SINGLE-row clicks. */
export interface ExtensionEventPayload {
  messageId: string;
  conversationId: string;
  content: string;
  selection: string | null;
}

/**
 * Body sent to `/api/extensions/{name}/events/{event}` for BULK clicks
 * (multi-select bar). The route accepts `messageIds: string[]` as an
 * alternative to `messageId: string`. `selection` is intentionally
 * omitted — bulk actions have no single highlight.
 */
export interface ExtensionBulkEventPayload {
  messageIds: string[];
  conversationId: string;
  content: string;
}

/**
 * Build the POST body for a single-row extension toolbar event. Pure
 * and side-effect-free so the call site can serialize directly.
 */
export function buildExtensionEventPayload(args: {
  messageId: string;
  conversationId: string;
  content: string;
  selection: string | null;
}): ExtensionEventPayload {
  return {
    messageId: args.messageId,
    conversationId: args.conversationId,
    content: args.content,
    selection: args.selection,
  };
}

/**
 * Build the POST body for a bulk (multi-select) extension toolbar
 * event. `content` is the concatenated body of every selected turn —
 * the host route uses it as the synthesized text for kokoro-tts-style
 * extensions, capped to the route's existing 100_000-char limit.
 *
 * The bulk handler attaches the new extension turn to the LAST message
 * in `messageIds` (most-recent reply is the natural anchor). Order
 * within the array is significant only for that anchor decision —
 * content concatenation is also done in the order passed, which lets
 * the call site preserve chronological order.
 */
export function buildExtensionBulkEventPayload(args: {
  messageIds: string[];
  conversationId: string;
  content: string;
}): ExtensionBulkEventPayload {
  return {
    messageIds: args.messageIds,
    conversationId: args.conversationId,
    content: args.content,
  };
}

/**
 * Build the POST URL for an extension toolbar event.
 *
 * The manifest stores fully-qualified event names like
 * `kokoro-tts:speak` (the bus-event-namespace key). The route at
 * `/api/extensions/[name]/events/[event]/+server.ts` reconstructs that
 * full name from `${name}:${event}` server-side, so the URL path
 * carries only the bare suffix. If we forwarded the full name as the
 * `[event]` segment, the route's `PARAM_REGEX` (no colons allowed)
 * would reject it with a 404 — that was the production bug fixed in
 * 2026-05-05.
 *
 * Strip a leading `<extName>:` prefix from `event` if present, then
 * encode both segments. The encoder is still defense-in-depth — the
 * validator restricts both fields to filesystem-safe charsets.
 */
export function buildExtensionEventUrl(extName: string, event: string): string {
  const prefix = `${extName}:`;
  const suffix = event.startsWith(prefix) ? event.slice(prefix.length) : event;
  return `/api/extensions/${encodeURIComponent(extName)}/events/${encodeURIComponent(suffix)}`;
}

/**
 * Drive the POST and surface failures via the supplied toast adder.
 *
 * The click handler in `ChatMessage.svelte` calls this with `userFetch`
 * + `addToast`. Pulled out as a tiny helper so the toast-on-failure
 * branch is unit-testable without mounting the chat tree.
 *
 * Two failure modes both surface:
 *   - non-2xx response (e.g. the 404 the route returns when the
 *     event isn't registered) → toast with the status code.
 *   - thrown fetch error (network down, CORS) → toast with the
 *     thrown message.
 *
 * Success path: silent. The user already sees the new excluded turn
 * appear in the chat — adding a "TTS started" toast on top would be
 * noise.
 */
export interface ToolbarPostDeps {
  fetcher: (url: string, init: RequestInit) => Promise<Response>;
  addToast: (toast: { type: "error" | "warning"; message: string }) => void;
}

export async function postExtensionEvent(
  url: string,
  payload: ExtensionEventPayload | ExtensionBulkEventPayload,
  tooltip: string,
  deps: ToolbarPostDeps,
): Promise<void> {
  try {
    const res = await deps.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      deps.addToast({
        type: "error",
        message: `${tooltip} failed: HTTP ${res.status}`,
      });
    }
  } catch (err) {
    deps.addToast({
      type: "error",
      message: `${tooltip} failed: ${err instanceof Error ? err.message : "network error"}`,
    });
  }
}

/**
 * Filter and shape contributions for a single message row.
 * Pure: takes the items + role, returns the subset that applies.
 *
 * Items in "bulk"-only mode (`appliesToSelection === "bulk"`) are
 * EXCLUDED from per-message rows — they only render in the
 * multi-select bar.
 */
export function selectApplicableContributions(
  items: ExtensionToolbarItem[],
  role: "user" | "assistant",
): ExtensionToolbarItem[] {
  return items.filter((it) => {
    if (!appliesToRole(it.appliesTo, role)) return false;
    const sel = it.appliesToSelection ?? "single";
    return sel === "single" || sel === "both";
  });
}

/**
 * Filter contributions for the multi-select bulk action bar. Returns
 * items whose `appliesToSelection` is `"bulk"` or `"both"`. The
 * per-message `appliesTo` axis is NOT applied here — bulk selections
 * can mix user and assistant rows, and asking the extension to
 * disambiguate at click-time would defeat the purpose of the icon.
 */
export function selectBulkApplicableContributions(
  items: ExtensionToolbarItem[],
): ExtensionToolbarItem[] {
  return items.filter((it) => {
    const sel = it.appliesToSelection ?? "single";
    return sel === "bulk" || sel === "both";
  });
}
