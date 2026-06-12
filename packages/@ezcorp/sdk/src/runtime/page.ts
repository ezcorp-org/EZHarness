// ── Hub pages — PageBuilder + definePage + pushPage ─────────────
//
// Extension Pages Hub (Phase 2). An extension that declares
// `manifest.pages` serves each page over the EXISTING JSON-RPC
// channel — zero new transport:
//
//   - Host → extension render-pull: `ezcorp/page.render` request
//     (generic `HostChannel.onRequest`, same plumbing as tools/call).
//   - Page actions: the Hub POSTs to the generic extension events
//     route; the host delivers `ezcorp/event/<ext>:<event>`
//     notifications — the SAME wire format `registerEventHandler` /
//     `createCanvas` use. `definePage` registers the handlers directly
//     on the channel because action event names are extension-
//     namespaced strings, not members of the typed
//     `SubscribableEventMap` union.
//   - Push-refresh: `pushPage` fires the `ezcorp/page-state`
//     notification (sibling of the panel's `ezcorp/state`); the host
//     re-validates, caches, and broadcasts a content-free invalidation
//     signal to Hub viewers.
//
// Trees are host-validated (`src/extensions/page-schema.ts`): 64KB,
// 500 nodes, depth 6, tables ≤ 100×12, relative-only hrefs, action
// events gated on `permissions.eventSubscriptions`.

import { getChannel, JsonRpcError } from "./channel";
import { ComponentListBuilder } from "./component-builder";
import type { PanelColor } from "./component-builder";

// ── Page-only wire shapes ───────────────────────────────────────

export interface PageActionDescriptor {
  /** Namespaced event (`<ext>:<event>`) — must be declared in
   *  `permissions.eventSubscriptions`. */
  event: string;
  payload?: Record<string, string | number | boolean>;
  /** Host-rendered confirm dialog text. */
  confirm?: string;
}

export interface PageStatItem {
  label: string;
  value: string;
  hint?: string;
}

export interface PageTableRowInput {
  cells: string[];
  action?: PageActionDescriptor;
  /** Relative internal link (must start with a single `/`). */
  href?: string;
}

export type PageButtonStyle = "primary" | "secondary" | "danger";

export interface HubPageTree {
  title: string;
  nodes: unknown[];
}

// ── PageBuilder ─────────────────────────────────────────────────

export class PageBuilder extends ComponentListBuilder {
  heading(level: 1 | 2 | 3, text: string): this {
    this.components.push({ type: "heading", level, text });
    return this;
  }

  /** Page-level markdown node (DOMPurify-sanitized host-side render).
   *  Distinct from the inherited `.markdown()`, which pushes the
   *  panel-vocabulary plain-text node. */
  markdownBlock(content: string): this {
    this.components.push({ type: "markdown", content });
    return this;
  }

  stats(items: PageStatItem[]): this {
    this.components.push({ type: "stats", items });
    return this;
  }

  table(columns: string[], rows: PageTableRowInput[]): this {
    this.components.push({ type: "table", columns, rows });
    return this;
  }

  button(label: string, action: PageActionDescriptor, style?: PageButtonStyle): this {
    this.components.push(
      style !== undefined
        ? { type: "button", label, action, style }
        : { type: "button", label, action },
    );
    return this;
  }

  link(label: string, href: string): this {
    this.components.push({ type: "link", label, href });
    return this;
  }

  emptyState(title: string, detail?: string): this {
    this.components.push(
      detail !== undefined
        ? { type: "empty-state", title, detail }
        : { type: "empty-state", title },
    );
    return this;
  }

  /** Nested section. The callback receives a child builder; its
   *  accumulated nodes become the section's children. */
  section(title: string | undefined, build: (section: PageBuilder) => void): this {
    const child = new PageBuilder();
    build(child);
    this.components.push(
      title !== undefined
        ? { type: "section", title, nodes: child.components }
        : { type: "section", nodes: child.components },
    );
    return this;
  }

  /**
   * Terminal: assemble the page tree. Throws if no title was set via
   * either the constructor or a prior `.title(...)` call.
   */
  build(): HubPageTree {
    const title = this.resolveTitle();
    if (title === undefined) {
      throw new Error(
        "[@ezcorp/sdk] PageBuilder.build(): missing title — call .title(...) first or pass a title to the constructor",
      );
    }
    return { title, nodes: this.components };
  }
}

// ── definePage ──────────────────────────────────────────────────

/** Payload delivered to a page-action handler. Mirrors the host's
 *  events-route hub branch notification. */
export interface PageActionEvent {
  source: "hub";
  pageId: string;
  userId: string;
  payload?: Record<string, unknown>;
}

export interface PageDefinition {
  /** Must match a `manifest.pages[].id`. */
  id: string;
  /** Produce the page tree. May return a `PageBuilder` (built
   *  automatically) or a finished `{title, nodes}` tree. */
  render: () => Promise<PageBuilder | HubPageTree> | PageBuilder | HubPageTree;
  /** Action handlers keyed by FULL namespaced event name
   *  (`<ext>:<event>`, as declared in eventSubscriptions). Handlers
   *  typically mutate state then `pushPage(...)` a fresh tree. */
  actions?: Record<string, (event: PageActionEvent) => Promise<void> | void>;
}

const pages = new Map<string, PageDefinition>();
let renderHandlerInstalled = false;

function toTree(result: PageBuilder | HubPageTree): HubPageTree {
  return result instanceof PageBuilder ? result.build() : result;
}

function installRenderHandler(): void {
  if (renderHandlerInstalled) return;
  renderHandlerInstalled = true;
  getChannel().onRequest("ezcorp/page.render", async (params: unknown) => {
    const pageId =
      params && typeof params === "object"
        ? (params as Record<string, unknown>).pageId
        : undefined;
    const def = typeof pageId === "string" ? pages.get(pageId) : undefined;
    if (!def) {
      throw new JsonRpcError(-32602, `Unknown page: ${String(pageId)}`);
    }
    return toTree(await def.render());
  });
}

/**
 * Register a Hub page. The first call installs the shared
 * `ezcorp/page.render` request handler (dispatching on `pageId`);
 * action handlers are registered on the channel's `ezcorp/event/*`
 * surface — the same wire format the EventSubscriptionDispatcher and
 * the events route deliver.
 */
export function definePage(def: PageDefinition): void {
  pages.set(def.id, def);
  installRenderHandler();
  const ch = getChannel();
  for (const [event, handler] of Object.entries(def.actions ?? {})) {
    ch.onRequest(`ezcorp/event/${event}`, async (params: unknown) => {
      await handler(params as PageActionEvent);
      return undefined;
    });
  }
}

/**
 * Push a fresh tree for a page (e.g. after a cron fire or an action).
 * The host validates + caches it and broadcasts a content-free
 * invalidation signal so open Hub tabs re-pull.
 */
export function pushPage(pageId: string, tree: PageBuilder | HubPageTree): void {
  getChannel().notify("ezcorp/page-state", { pageId, page: toTree(tree) });
}

/** @internal — test-only: clear registered pages + the render handler
 *  installed flag (pair with `__resetChannelForTests`). */
export function __resetPagesForTests(): void {
  pages.clear();
  renderHandlerInstalled = false;
}

// Convenience re-export so page modules can type badge colors without
// importing from panel.
export type { PanelColor };
