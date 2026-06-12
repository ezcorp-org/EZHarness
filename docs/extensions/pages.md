# Hub Pages

Extensions can contribute **page-level UI**: a tab on the top-level **Hub** page (`/hub`), rendered from a declarative JSON component tree. Your code sends *data*; the host renders native Svelte. Extension HTML/JS never touches the DOM — XSS is impossible by construction.

Core features use the same system (the Daily Briefing tab at `/hub/core:briefing` is a core provider), so your page gets the exact same renderer, validation, and caching as first-party UI.

**Worked reference:** [`examples/cron-dashboard/`](examples/cron-dashboard/) — a dashboard that self-tracks its scheduled runs, with stats, a run table, a confirm-gated "Clear log" action, and live `pushPage` refresh.

---

## 1. Declare the page in your manifest

```typescript
// ezcorp.config.ts
pages: [
  {
    id: "dashboard",            // /^[a-z0-9][a-z0-9-]{0,31}$/, unique within the extension
    title: "Cron Dashboard",    // tab label, ≤ 50 chars
    icon: "Clock",              // optional lucide name (unknown → fallback icon)
    description: "Scheduled-run history.", // optional, ≤ 200 chars
  },
],
permissions: {
  // Page ACTIONS reuse the eventSubscriptions allowlist — any action
  // node naming an event NOT listed here is silently dropped by the
  // host's tree validator.
  eventSubscriptions: ["cron-dashboard:clear-log"],
},
```

- Max **3 pages** per extension (`validatePagesArray`, enforced at install).
- **Declaring a page IS the grant** — there is no separate permission key. The page is listed on the extension detail UI like other components; enabling the extension enables the tab.
- The tab appears at `/hub/ext:<extension-name>:<page-id>` once the extension is enabled.

## 2. Serve renders with `definePage`

```typescript
import { definePage, PageBuilder, getChannel } from "@ezcorp/sdk/runtime";

definePage({
  id: "dashboard",
  render: async () =>
    new PageBuilder("Cron Dashboard")
      .stats([{ label: "Tracked runs", value: "12" }])
      .table(["Fired at", "Cron"], [{ cells: ["2026-06-12 07:05", "*/5 * * * *"] }])
      .button("Clear log", {
        event: "cron-dashboard:clear-log",
        confirm: "Clear the entire run log?",
      }, "danger"),
  actions: {
    // Keyed by the FULL namespaced event name.
    "cron-dashboard:clear-log": async ({ userId, pageId, payload }) => {
      // ...mutate state, then push a fresh tree (step 4).
    },
  },
});

getChannel().start();
```

- The host pulls renders over the existing JSON-RPC channel (`ezcorp/page.render`, dispatched on `pageId`). First open lazy-spawns your subprocess (~1–3s; the Hub shows a skeleton). Renders are raced against a **10s** timeout.
- Render results are cached host-side (~60s TTL). Stale entries are served instantly with a background refresh.
- `render` may return a `PageBuilder` (built automatically) or a raw `{ title, nodes }` tree.

## 3. Component vocabulary

`PageBuilder` inherits the full **panel** vocabulary (`title`, `markdown` → text, `list`, `badge`, `counter`, `kv`, `progress`, `status`, `divider` — wire shapes identical to the bottom panel) and adds page-only nodes:

| Node | Builder method | Fields | Notes |
|------|----------------|--------|-------|
| `section` | `.section(title?, b => …)` | nested `nodes` | The ONLY nesting node. Depth ≤ 6. |
| `heading` | `.heading(level, text)` | `level` 1–3, `text` | |
| `markdown` | `.markdownBlock(content)` | `content` ≤ 10k chars | Rendered through the host's DOMPurify pipeline. |
| `stats` | `.stats(items)` | `[{label, value, hint?}]` ≤ 12 | Stat-card grid. |
| `table` | `.table(columns, rows)` | columns ≤ 12, rows ≤ 100; row `action?`/`href?` | `href` rows deep-link; `action` rows dispatch on click. |
| `button` | `.button(label, action, style?)` | `style`: `primary`/`secondary`/`danger` | |
| `link` | `.link(label, href)` | internal `href` only | |
| `empty-state` | `.emptyState(title, detail?)` | | |

## 4. Push live updates with `pushPage`

```typescript
import { pushPage } from "@ezcorp/sdk/runtime";

pushPage("dashboard", new PageBuilder("Cron Dashboard")./* … */);
```

The host validates the tree, caches it, and broadcasts a **content-free invalidation signal** (`ext:page-state` — only `{extensionId, extensionName, pageId}`, never tree content). Open Hub tabs re-pull the session-authed render endpoint. Pushes share the panel's mediator budget: **10 updates/second** per extension, 64KB per tree.

## 5. Action contract

Buttons and table rows carry `{ event, payload?, confirm? }`:

- `event` must be `<your-extension-name>:<event>` AND listed in `permissions.eventSubscriptions` — double-gated: the tree validator drops undeclared action nodes at render time, and the events route 404s undeclared events at POST time.
- The Hub POSTs to `/api/extensions/<name>/events/<event>` with body `{ source: "hub", pageId, payload? }` (payload ≤ 2KB). Rate limit: 10 actions/min/user.
- Your subprocess receives the standard `ezcorp/event/<name>:<event>` notification with `{ source: "hub", pageId, userId, payload? }` — `definePage`'s `actions` map handles it (same wire format as `registerEventHandler`).
- `confirm` strings are rendered by the HOST in a native confirm dialog before dispatch.
- No free-form inputs in v1 — named actions with small structured payloads only.
- **`payload` is attacker-controlled.** The host caps its size and shape, but any authenticated user can POST any payload to your declared events directly — never trust field values. Validate every field in your handler before acting on it (treat it exactly like untrusted HTTP input).

## 6. Limits & security rules (server-enforced)

- Tree ≤ **64KB**, ≤ **500 nodes**, depth ≤ **6**, tables ≤ **100×12**, action payloads ≤ **2KB**; per-string truncation everywhere.
- Every tree — pulled, pushed, or core-provided — passes the same `validatePageTree` before it is cached or served. Invalid nodes are dropped (forward-compat); invalid envelopes produce an error card with retry.
- `href` values must be **relative internal paths** (start with a single `/`; `//`, `\`, and absolute URLs are rejected server-side AND re-checked client-side).
- The only HTML-capable node is `markdown`, sanitized by the host's shared DOMPurify config. Styles are enum variants only — no class/style passthrough.
- Icons resolve through the host's lucide allowlist with a safe fallback.
- Renders are per-session (12/min/user/page); the SSE invalidation signal never carries content, so nothing leaks cross-user.
- **Page trees are SHARED across all users.** Renders and `pushPage` trees are cached per (extension, page) — not per user — and served to every signed-in user. Never `pushPage` (or render) user-specific data into the tree. Per-user data belongs in ACTION responses, keyed by the host-stamped `userId` your handler receives (the host stamps it; clients cannot spoof it).

## See also

- [Manifest Schema → `pages[]`](manifest-schema.md#pages----extensionpagedeclaration)
- [Settings](settings.md), [Message Toolbar](message-toolbar.md), [Canvas Cards](canvas-cards.md) — the other UI surfaces
- [`examples/cron-dashboard/`](examples/cron-dashboard/) — worked reference
