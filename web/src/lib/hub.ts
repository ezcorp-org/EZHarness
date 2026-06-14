/**
 * Extension Pages Hub — pure frontend/shared logic (no Svelte, no
 * server deps). Imported by the Hub routes (server side: id parsing)
 * AND the Hub pages/renderer (client side: action routing, href
 * re-check). Unit-tested with vitest.
 *
 * Types mirror `src/extensions/page-schema.ts` — the frontend can't
 * import from `src/` (same inline-mirror approach as
 * `ExtensionPanel.svelte`). Keep the two files aligned.
 *
 * The `PagePrompt` shape is one of THREE aligned mirrors:
 *   - `src/extensions/page-schema.ts` (`PagePrompt`) = source of truth +
 *     the single validation enforcement point (`validateAction`),
 *   - this file (frontend renderer / page-route prompt dialog),
 *   - `packages/@ezcorp/sdk/src/runtime/page.ts` (`PagePromptDescriptor`).
 *   Keep all three in sync.
 */

// ── Mirrored page vocabulary types ─────────────────────────────────

export type BadgeColor = "blue" | "green" | "red" | "yellow" | "purple" | "gray";
export type StatusState = "idle" | "running" | "success" | "error" | "warning";
export type ListItemStatus = "pending" | "active" | "completed" | "failed";
export type TextVariant = "muted" | "default" | "emphasis";

export interface PanelHeaderNode { type: "header"; title: string; subtitle?: string }
export interface PanelTextNode { type: "text"; content: string; variant?: TextVariant }
export interface PanelBadgeNode { type: "badge"; label: string; color?: BadgeColor }
export interface PanelProgressNode { type: "progress"; value: number; label?: string }
export interface PanelStatusNode { type: "status"; label: string; state: StatusState }
export interface PanelListItem { label: string; status?: ListItemStatus; detail?: string; badge?: string; badgeColor?: BadgeColor }
export interface PanelListNode { type: "list"; items: PanelListItem[] }
export interface PanelKVNode { type: "kv"; pairs: { key: string; value: string }[] }
export interface PanelCounterNode { type: "counter"; label: string; value: number; total?: number }
export interface PanelDividerNode { type: "divider" }

/** Host-rendered single-field text prompt. Mirror of page-schema's
 *  `PagePrompt` (source of truth) — keep aligned. */
export interface PagePrompt {
  label: string;
  placeholder?: string;
  /** Payload key the typed value merges under; default "value". */
  field?: string;
  /** Host clamps the input length; default 200, hard cap 500. */
  maxLength?: number;
  submitLabel?: string;
}
export interface PageAction {
  event: string;
  payload?: Record<string, string | number | boolean>;
  confirm?: string;
  /** Optional host-rendered text prompt collected before dispatch. */
  prompt?: PagePrompt;
}
export interface PageSectionNode { type: "section"; title?: string; nodes: PageNode[] }
export interface PageHeadingNode { type: "heading"; level: 1 | 2 | 3; text: string }
export interface PageMarkdownNode { type: "markdown"; content: string }
export interface PageStatsNode { type: "stats"; items: { label: string; value: string; hint?: string }[] }
export interface PageTableRow { cells: string[]; action?: PageAction; href?: string }
export interface PageTableNode { type: "table"; columns: string[]; rows: PageTableRow[] }
export interface PageButtonNode { type: "button"; label: string; action: PageAction; style?: "primary" | "secondary" | "danger" }
export interface PageLinkNode { type: "link"; label: string; href: string }
export interface PageEmptyStateNode { type: "empty-state"; title: string; detail?: string }

export type PageNode =
  | PanelHeaderNode
  | PanelTextNode
  | PanelBadgeNode
  | PanelProgressNode
  | PanelStatusNode
  | PanelListNode
  | PanelKVNode
  | PanelCounterNode
  | PanelDividerNode
  | PageSectionNode
  | PageHeadingNode
  | PageMarkdownNode
  | PageStatsNode
  | PageTableNode
  | PageButtonNode
  | PageLinkNode
  | PageEmptyStateNode;

export interface HubPageTree {
  title: string;
  nodes: PageNode[];
}

/** GET /api/hub/pages list entry. */
export interface HubPageListing {
  id: string;
  title: string;
  icon?: string;
  description?: string;
  kind: "core" | "ext";
}

// ── Page id parsing ────────────────────────────────────────────────

/** Mirrors `HUB_PROVIDER_ID_REGEX` (src/runtime/hub-pages.ts) — also
 *  the manifest `pages[].id` shape. */
const PAGE_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Mirrors the manifest-name regex (src/extensions/manifest.ts). */
const EXT_NAME_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

export type ParsedHubPageId =
  | { kind: "core"; providerId: string }
  | { kind: "ext"; extension: string; pageId: string };

/**
 * Parse a Hub page id (`core:<provider>` or `ext:<extension>:<pageId>`).
 * Returns null for anything malformed — callers 404.
 */
export function parseHubPageId(raw: string): ParsedHubPageId | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 130) return null;
  const parts = raw.split(":");
  if (parts[0] === "core" && parts.length === 2) {
    const providerId = parts[1]!;
    if (!PAGE_SLUG_REGEX.test(providerId)) return null;
    return { kind: "core", providerId };
  }
  if (parts[0] === "ext" && parts.length === 3) {
    const extension = parts[1]!;
    const pageId = parts[2]!;
    if (!EXT_NAME_REGEX.test(extension) || extension.includes("..")) return null;
    if (!PAGE_SLUG_REGEX.test(pageId)) return null;
    return { kind: "ext", extension, pageId };
  }
  return null;
}

// ── Action routing ─────────────────────────────────────────────────

export interface ActionRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Route a page action to its POST endpoint:
 *   - core pages → the Hub actions route (action name = event).
 *   - extension pages → the generic extension events route with the
 *     hub-source body shape. The action event is namespaced
 *     `<ext>:<event>`; the URL carries only the event suffix.
 *
 * Returns null when the action event doesn't fit the page's kind
 * (e.g. an unprefixed event on an extension page) — callers drop the
 * dispatch client-side; the server would reject it anyway.
 */
export function buildActionRequest(
  pageId: ParsedHubPageId,
  action: PageAction,
): ActionRequest | null {
  if (pageId.kind === "core") {
    if (!PAGE_SLUG_REGEX.test(action.event)) return null;
    return {
      url: `/api/hub/pages/${encodeURIComponent(`core:${pageId.providerId}`)}/actions/${encodeURIComponent(action.event)}`,
      body: action.payload ? { payload: action.payload } : {},
    };
  }
  const prefix = `${pageId.extension}:`;
  if (!action.event.startsWith(prefix)) return null;
  const event = action.event.slice(prefix.length);
  if (event.length === 0 || event.includes(":")) return null;
  return {
    url: `/api/extensions/${encodeURIComponent(pageId.extension)}/events/${encodeURIComponent(event)}`,
    body: {
      source: "hub",
      pageId: pageId.pageId,
      ...(action.payload ? { payload: action.payload } : {}),
    },
  };
}

// ── Client-side href re-check ──────────────────────────────────────

/**
 * Mirror of the server's `isSafeInternalHref` (page-schema.ts):
 * relative-only internal links. The server already enforced this at
 * validation time — the client re-checks as defense-in-depth before
 * `goto`/anchor render.
 */
export function isSafeInternalHref(href: unknown): href is string {
  if (typeof href !== "string") return false;
  if (!href.startsWith("/")) return false;
  if (href.startsWith("//")) return false;
  if (href.includes("\\")) return false;
  return true;
}
