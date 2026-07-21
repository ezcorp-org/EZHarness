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

/**
 * Host-rendered single-field text prompt attached to an action. The
 * host owns the input widget; the extension supplies only display
 * strings. On submit the typed scalar is merged client-side into
 * `payload[field]` (default `"value"`) and the action dispatches through
 * its UNCHANGED, eventSubscriptions-gated path — `prompt` grants NO new
 * authority.
 *
 * Mirror of `PagePrompt` in `src/extensions/page-schema.ts` (the source
 * of truth + validation point) and `web/src/lib/hub.ts`. Keep the three
 * aligned. The host re-validates every field (slug-clamps `field`,
 * clamps `maxLength` to [1,500], `<>`-strips + truncates strings) — these
 * are author-side hints only.
 */
export interface PagePromptDescriptor {
  /** Dialog input label (required). */
  label: string;
  placeholder?: string;
  /** Payload key the typed value merges under; default "value". Must be
   *  a `/^[a-z0-9][a-z0-9_]{0,31}$/` slug or the host falls back. */
  field?: string;
  /** Input length hint; host clamps to [1,500], default 200. */
  maxLength?: number;
  submitLabel?: string;
  /** Opt into a richer host-rendered widget instead of the plain text
   *  box. `"file-path"` reuses the app's filesystem picker; see the host's
   *  `PROMPT_FORMATS` for the allowed scalar formats. An unknown value is
   *  dropped host-side and the dialog falls back to a text input. */
  format?: string;
}

export interface PageActionDescriptor {
  /** Namespaced event (`<ext>:<event>`) — must be declared in
   *  `permissions.eventSubscriptions`. */
  event: string;
  payload?: Record<string, string | number | boolean>;
  /** Host-rendered confirm dialog text. */
  confirm?: string;
  /** Optional host-rendered text prompt collected before dispatch. */
  prompt?: PagePromptDescriptor;
}

export interface PageStatItem {
  label: string;
  value: string;
  hint?: string;
}

/** A table cell's semantic tone. Mirror of page-schema's `CellTone`
 *  (source of truth + validation point). The host normalises `neutral`
 *  (and any unknown value) back to a plain string cell. */
export type PageCellTone = "success" | "danger" | "warning" | "neutral";

/** Object cell form — mirror of page-schema's `PageTableCell`. Lets a
 *  builder tone a single cell (e.g. a run-status column) without an
 *  index-aligned parallel array. */
export interface PageTableCellInput {
  text: string;
  tone?: PageCellTone;
}

/** A table cell input: a plain string (neutral) or a toned object. */
export type PageCellInput = string | PageTableCellInput;

export interface PageTableRowInput {
  cells: PageCellInput[];
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

/** One platform project, as the host passes it into a `perProject`
 *  page render. `path` is the project's checkout root on the host. */
export interface PageProjectRef {
  id: string;
  name: string;
  path: string;
}

/**
 * Context handed to `render` for pages declared `perProject: true` in
 * the manifest:
 *   - project hub (`/project/<id>/hub/...`) → `{ project }`
 *   - global hub (`/hub/...`)               → `{ projects }` (all of them)
 * Pages without the flag — or older hosts — render with NO context, so
 * a zero-arg `render` keeps working unchanged.
 */
export interface PageRenderContext {
  project?: PageProjectRef;
  projects?: PageProjectRef[];
}

export interface PageDefinition {
  /** Must match a `manifest.pages[].id`. */
  id: string;
  /** Produce the page tree. May return a `PageBuilder` (built
   *  automatically) or a finished `{title, nodes}` tree. `ctx` carries
   *  project context for `perProject` pages (see `PageRenderContext`). */
  render: (
    ctx?: PageRenderContext,
  ) => Promise<PageBuilder | HubPageTree> | PageBuilder | HubPageTree;
  /** Action handlers keyed by FULL namespaced event name
   *  (`<ext>:<event>`, as declared in eventSubscriptions). Handlers
   *  typically mutate state then `pushPage(...)` a fresh tree (or
   *  `invalidatePage(...)` for perProject pages). */
  actions?: Record<string, (event: PageActionEvent) => Promise<void> | void>;
}

const pages = new Map<string, PageDefinition>();
let renderHandlerInstalled = false;

function toTree(result: PageBuilder | HubPageTree): HubPageTree {
  return result instanceof PageBuilder ? result.build() : result;
}

/** Defensive reader for a host-supplied project ref. */
function readProjectRef(value: unknown): PageProjectRef | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== "string" || typeof p.name !== "string" || typeof p.path !== "string") {
    return null;
  }
  return { id: p.id, name: p.name, path: p.path };
}

/** Build the render context from the host's params — undefined when the
 *  host sent no (valid) project context, so plain pages see no change. */
function readRenderContext(params: Record<string, unknown>): PageRenderContext | undefined {
  const project = readProjectRef(params.project);
  if (project) return { project };
  if (Array.isArray(params.projects)) {
    const projects: PageProjectRef[] = [];
    for (const raw of params.projects) {
      const ref = readProjectRef(raw);
      if (ref) projects.push(ref);
    }
    // A truly empty list is a real "no projects registered" home render;
    // a non-empty list where EVERY ref was malformed is host-contract
    // drift — fall back to the no-context render instead of showing an
    // empty home over data that exists.
    if (projects.length === 0 && params.projects.length > 0) return undefined;
    return { projects };
  }
  return undefined;
}

function installRenderHandler(): void {
  if (renderHandlerInstalled) return;
  renderHandlerInstalled = true;
  getChannel().onRequest("ezcorp/page.render", async (params: unknown) => {
    const record =
      params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const pageId = record.pageId;
    const def = typeof pageId === "string" ? pages.get(pageId) : undefined;
    if (!def) {
      throw new JsonRpcError(-32602, `Unknown page: ${String(pageId)}`);
    }
    return toTree(await def.render(readRenderContext(record)));
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

/**
 * Invalidate a page WITHOUT pushing a tree: the host drops every cached
 * variant and broadcasts the content-free signal, so each open view
 * re-pulls with its own context. THE refresh pattern for `perProject`
 * pages — one pushed tree can't cover the global + per-project variants,
 * and the extension can't know which of them is on screen.
 */
export function invalidatePage(pageId: string): void {
  getChannel().notify("ezcorp/page-state", { pageId });
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
