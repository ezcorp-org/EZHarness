# Hub Pages

Extensions can contribute a tab on the Hub page (`/hub`) through a validated declarative component tree. The host renders native Svelte rather than executing page-supplied HTML or JavaScript. Schema validation and browser security checks remain required; this is not an absolute XSS guarantee.

Use these contribution fragments inside a v4 worker registered with `createRuntimeExtension`. Follow [Authoring](AUTHORING.md) for build and human approval. A worker-only `ezcorp.config.ts` is not host-executable configuration.

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
- Render results are cached per principal, complete scope, and live release authority (~60s TTL). Authority is checked before cache lookup and after rendering. Stale entries can refresh in the background; a revoked grant cannot reuse the old result.
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
| `form` | `.form(fields, action, submitLabel?)` | 1–10 fields | Inline on-page form — see §5b. `submitLabel` defaults to "Save". |

## 4. Push live updates with `pushPage`

```typescript
import { pushPage } from "@ezcorp/sdk/runtime";

pushPage("dashboard", new PageBuilder("Cron Dashboard")./* … */);
```

The host validates the push and broadcasts a content-free invalidation (`ext:page-state`). It does not put pushed private content into a shared page cache. Open Hub tabs call the authenticated render endpoint again. Implement `definePage.render`; a push alone is not the page's persistent source. Pushes retain the mediator's rate and payload limits.

## 4b. Per-project pages (`perProject: true`)

One flag turns a page into a **project-aware** surface — the same page id renders differently depending on where it's viewed:

```typescript
// ezcorp.config.ts
pages: [{ id: "dashboard", title: "My Dashboard", perProject: true }],
```

```typescript
definePage({
  id: "dashboard",
  render: async (ctx) => {
    if (ctx?.project) return buildProjectView(ctx.project);   // /project/<id>/hub/...
    if (ctx?.projects) return buildHomeView(ctx.projects);    // /hub/... (all projects)
    return buildFallbackView();                               // host without perProject support
  },
});
```

- **Project hub** (`/project/<id>/hub/ext:<name>:<page>`): `render` receives the approved project's ID and name. Its `path` is the virtual `/project`, never the host checkout path.
- **Global hub** (`/hub/ext:<name>:<page>`): `render` receives only projects visible to the current user. Use project IDs, not paths, for identity and links.
- **Without the flag**: project selection does not grant project context. Host capability checks still apply.
- **Caching**: concurrent requests share work only when principal, live authority, and full render scope match. Two users never share a private result.
- **Refresh**: use `invalidatePage("dashboard")` — it drops every cached variant and broadcasts the content-free signal, so each open view (home or any project) re-pulls its own context. On a `perProject` page a `pushPage` tree is ENFORCED as invalidate-only (the tree is discarded): a tree built in one context can't cover the global + per-project variants, so the host never caches it as the home view:

```typescript
import { invalidatePage } from "@ezcorp/sdk/runtime";

invalidatePage("dashboard"); // all variants re-pull with their own context
```

## 5. Action contract

Buttons and table rows carry `{ event, payload?, confirm?, prompt?, form? }`:

- `event` must be `<your-extension-name>:<event>` AND listed in `permissions.eventSubscriptions` — double-gated: the tree validator drops undeclared action nodes at render time, and the events route 404s undeclared events at POST time.
- The Hub POSTs to `/api/extensions/<name>/events/<event>` with body `{ source: "hub", pageId, payload? }` (POSTed payload ≤ 8KB — sized for a worst-case 10×500-char form submit; the static `payload` declared in the tree stays ≤ 2KB). Rate limit: 10 actions/min/user.
- Your subprocess receives the standard `ezcorp/event/<name>:<event>` notification with `{ source: "hub", pageId, userId, payload? }` — `definePage`'s `actions` map handles it (same wire format as `registerEventHandler`).
- `confirm` strings are rendered by the HOST in a native confirm dialog before dispatch.
- `payload` carries small structured values for the action. Free-form user input is collected through a `prompt` (one text value, below), a `form` dialog (`action.form`, multiple values), or the inline `form` node (§5b).
- **`payload` is attacker-controlled.** The host caps its size and shape, but any authenticated user can POST any payload to your declared events directly — never trust field values. Validate every field in your handler before acting on it (treat it exactly like untrusted HTTP input).

### `prompt` — collect one text value before dispatch

An action may attach an optional `prompt` so the **host** opens a single-field text dialog before dispatching:

```ts
page.button("Rename", {
  event: "cron-dashboard:rename",
  prompt: { label: "New name", placeholder: "Nightly", field: "name", maxLength: 80 },
});
```

`PagePrompt` = `{ label, placeholder?, field?, maxLength?, submitLabel?, format? }`. On Submit the host merges the typed string into `payload[field]` (default `"value"`) and dispatches the action through its **unchanged, already-gated** event path. Enter submits; Esc/Cancel closes with no POST; Submit is disabled while the trimmed value is empty.

An optional `format` opts the dialog into a **shared host widget** instead of the plain text box — e.g. `format: "file-path"` reuses the app's filesystem picker (autocomplete + browse), so a folder-path prompt feels the same as the file picker elsewhere in EZCorp:

```ts
page.button("Add watched folder", {
  event: "file-organizer:add-folder",
  prompt: { label: "Folder path", placeholder: "/watched/Downloads", field: "path", format: "file-path" },
});
```

Allowed formats are the scalar-string producers in the host's `PROMPT_FORMATS` (`file-path`, `combo-box`, `search`, `date`, `datetime`). An unknown/excluded value is dropped host-side and the dialog falls back to the plain text input — the typed result is still merged into `payload[field]` exactly as a text prompt would be. When `format` is set the widget owns its own keyboard handling, so the host doesn't bind Enter-to-submit; the user clicks Submit.

**`prompt` grants your extension ZERO new authority** — it is only a host-mediated way for the *user* to type a string into an action you **already** declared and that is **already** gated:

- The input widget is **100% host-rendered**. You supply only display strings (`label`/`placeholder`/`submitLabel`) — never DOM, never HTML, never a URL. The host `<>`-strips + truncates them; a malformed prompt is silently dropped and the action degrades to a plain dispatch (it is never fatal).
- **No new dispatch path.** A prompt action still routes through the same `eventSubscriptions` allowlist + page-declared check + 10/min/user limiter + 8KB POST payload cap. You cannot conjure a new event via `prompt`.
- **The typed value is untrusted and stays a scalar.** It is merged into `payload[field]` as a single string. `field` is slug-sanitized (`/^[a-z0-9][a-z0-9_]{0,31}$/`, default `"value"`) so it cannot spoof a reserved payload key. Validate it in your handler like any other untrusted input.
- **Echo-back is re-sanitized.** If your handler echoes the value into a re-rendered tree, that tree passes back through `validatePageTree` — every display string is `<>`-stripped, so a `<script>`-laden value can never reach the DOM.
- `maxLength` is an author hint only; the host clamps it to `[1, 500]` (default 200) and re-validates server-side regardless.

## 5b. Forms — multi-field input

Two multi-field surfaces share one field shape (`{ field, label, value?, placeholder?, maxLength?, multiline?, options?, visibleWhen? }`):

- **Dialog form** — `action.form: { title?, fields }`. The host opens a modal before dispatch (supersedes `prompt` when both are present — the prompt is dropped). The dialog renders plain text inputs only: it ignores `options`/`visibleWhen`/`multiline` and shows every field. On Save **every** field merges into `payload[field]` — an empty string is a deliberate clear-to-empty.
- **Inline `form` node** — `.form(fields, action, submitLabel?)`: the fields live directly in the page flow with one submit button (no modal), and the inline renderer honours all three richer field features:

```ts
page.form(
  [
    { field: "trigger_kind", label: "Trigger", value: "push",
      options: [{ value: "push" }, { value: "schedule", label: "schedule — on a cadence" }] },
    { field: "cadence", label: "Cadence", value: "daily",
      options: [{ value: "hourly" }, { value: "daily" }],
      visibleWhen: { field: "trigger_kind", equals: "schedule" } },
    { field: "notes", label: "Notes", multiline: true, maxLength: 500 },
  ],
  { event: "my-ext:save", payload: { id: "job-1" } },
  "Save",
);
```

Field rules (host-validated; author values are hints):

- 1–10 fields survive validation; a zero-field form is dropped. `field` MUST be a `/^[a-z0-9][a-z0-9_]{0,31}$/` slug — a non-slug field is **dropped outright** (no `"value"` fall-back, which would clobber a sibling). `maxLength` clamps to `[1, 500]` (default 200); the `value` prefill is truncated to it.
- `options` renders a **select**: 2–12 valid options survive, else the whole list is dropped and the field falls back to a text input. A `value` prefill outside the option set clamps to the first option.
- `visibleWhen: { field, equals }` shows the field only while the named sibling's **current** value matches `equals` (a string, or a 1–12-entry array of ≤ 64-char strings). Visibility **cascades**: a field is effectively visible only while its controller is itself effectively visible AND matches. A condition naming an unknown or self field is pruned (fails open to always-visible); a reference cycle also fails open to visible.
- A **hidden field is omitted from the submitted payload** — absent key, never an empty string — so conditional fields compose with present-string-clears handler semantics ("hidden" means "don't touch"). A visible-but-blank field submits `""` (clear-to-empty). Hidden fields keep their local value, so flipping the controller back restores what was typed.
- On submit the action dispatches through its **unchanged, already-gated** event path. The host **strips** `prompt`/`form` off the inline node's action (the inline fields ARE the input surface — a submit never opens a second collection dialog); `confirm` survives and still gates the dispatch.
- **Selects and visibility constrain the UI, never the wire.** Any authenticated user can POST any payload to your declared event directly — an out-of-set "select" value or a "hidden" field's key can absolutely arrive. Validate every field in your handler, exactly like the `prompt` value.

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
