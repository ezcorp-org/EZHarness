# Extension Hub Pages

> _Extensions (and core features) contribute tabs on the top-level Hub from a declarative, server-validated JSON component tree that the host renders to native Svelte — extension code never touches the DOM, so XSS is impossible by construction._

## Intent

The Hub (`/hub`) is EZCorp's surface for page-level extension UI: dashboards, run logs, vaults, settings panels — anything richer than a chat tool card or a bottom panel. An extension declares up to **3 pages** in its manifest and serves each as a `HubPageTree` (a JSON tree of typed nodes); the host validates, caches, and renders it. Because the extension only ships *data* — never markup or scripts — the renderer is a fixed Svelte vocabulary and there is no path for injected HTML/JS to reach the page. Core features (Daily Briefing today) use the **same** provider system, so first-party tabs get identical rendering, validation, and caching.

## How it works

There are two producers of a tree — **core providers** (`core:<id>`) and **enabled extensions** (`ext:<name>:<pageId>`) — but every tree, no matter the source, flows through one validator (`validatePageTree`) before it is cached or served. The "uniform contract" is the central design rule: a core-provider bug can no more ship an unvalidated node than a hostile extension can.

**Tab discovery (`GET /api/hub/pages`)**
- Core tabs come from `listHubPageProviders()` (`src/runtime/hub-pages.ts`), a boot-time registry of `HubPageProvider`s → surfaced as `core:<id>`.
- Extension tabs come from `listEnabledExtensionPages()` (`web/src/lib/server/hub-extension-pages.ts`), which reads `manifest.pages` off every **enabled** extension row → surfaced as `ext:<name>:<pageId>`.
- v1 RBAC: any authenticated user sees **every** tab. Per-user isolation happens inside `render(userId)`, never at list time. "Declaring a page IS the grant" — there is no separate permission key.

**Render (`GET /api/hub/pages/[id]`)** — `parseHubPageId` splits `core:<provider>` vs `ext:<name>:<pageId>` (malformed → 404):
- **Core**: call `provider.render({ userId })`, then `validatePageTree(tree, { allowedEvents: Object.keys(provider.actions) })`. A render throw or invalid tree returns HTTP 200 + `{ error }` (the client shows an error card with retry).
- **Extension**: delegate to `renderExtensionPage(...)` in `web/src/lib/server/hub-render-pull.ts`:
  1. Resolve the page on the enabled extension (`findEnabledExtensionPage`); unknown/disabled/undeclared → `notFound` → 404 (no enumeration oracle).
  2. **Cache check** (`ExtensionPageCache`, ~60s TTL, `src/extensions/page-cache.ts`): fresh → serve instantly; stale → serve with `stale: true` + fire-and-forget background refresh; miss → pull synchronously.
  3. **Pull**: lazy-spawn the subprocess (`registry.getProcess`, ~1–3s first open), wire reverse-RPC (`ToolExecutor.ensureSubprocessRpcWired`), then `proc.call("ezcorp/page.render", { pageId, _meta:{ ezCallId } })` raced against a **non-lethal 10s** timeout (`RENDER_PULL_TIMEOUT_MS`). The non-lethal race matters because `ExtensionProcess.call`'s built-in 30s timeout *kills* the subprocess — too aggressive for a render that shares the process with live tool calls.
  4. `validatePageTree` with `allowedEvents` = the extension's **granted** `eventSubscriptions` (the runtime grant, not the manifest request — kept aligned with the events route's POST-time `isRegisteredExtensionEvent` gate). Cache + return.

**Render provenance token.** A render is a host-issued forward call exactly like a tool call. `productionCallPage` mints a `kind: "render"` provenance token (`registerCallProvenance`, `src/extensions/call-provenance.ts`) scoped to the viewing `userId` + this extension, stamps it on `_meta.ezCallId`, and releases it in `finally`. The SDK channel binds it for the render handler's duration, so any reverse-RPC the page makes (e.g. reading its **own** extension data via `fs.read`) carries the token and is authorized. Without it, those reads fail the provenance gate as "unresolved" and the page silently renders empty.

**Actions** — two entirely separate dispatch paths, by design:
- **Core page actions** → `POST /api/hub/pages/[id]/actions/[action]` (this is the *only* purpose of that route). Action-name regex (`/^[a-z0-9][a-z0-9-]{0,31}$/`), 404 for unknown page/action, 10 actions/min/user, body `{ payload? }` capped at 2KB with **scalar-only** values. The handler may return a fresh validated tree inline (`{ ok:true, page, renderedAt }`).
- **Extension page actions** → the generic extension events route `POST /api/extensions/[name]/events/[event]` with body `{ source: "hub", pageId, payload? }`. Routing them through the existing manifest-event ladder keeps all extension-event security in one place; the host then delivers an `ezcorp/event/<name>:<event>` notification that `definePage`'s `actions` map handles. `buildActionRequest` (`web/src/lib/hub.ts`) picks the right URL/body per page kind client-side.

**Live invalidation (content-free SSE).** When an extension calls `pushPage(...)`, the SDK fires an `ezcorp/page-state` notification. The state mediator (`src/extensions/state-mediator.ts#handlePageState`) gates on a **declared** page id, runs the full `validatePageTree` ladder, caches the validated tree, then emits an `ext:page-state` bus event carrying **only** `{ extensionId, extensionName, pageId }` — never the tree. The global SSE subscriber (`web/src/lib/stores.svelte.ts`) re-dispatches it as a `window` CustomEvent; the open Hub page (`web/src/routes/(app)/hub/[pageId]/+page.svelte`) listens, and if the signal names the page it's showing, re-pulls the session-authed render endpoint. The tree itself is therefore always fetched per-session — nothing leaks cross-user through the broadcast.

**Client render & dialogs.** `HubComponentRenderer.svelte` walks `tree.nodes` into native Svelte. `markdown` nodes are the only HTML-capable node, rendered through the shared `renderMarkdown` + DOMPurify pipeline. The shared page view (`HubPageView.svelte`) owns three host-rendered dialogs (extension content never reaches them beyond validated, `<>`-stripped, truncated display strings):
- **confirm** — shows `action.confirm` before dispatch.
- **prompt** — a single-field text dialog (`action.prompt`). The input widget is 100% host-owned; on submit the typed scalar is merged client-side into `payload[field]` (default `"value"`, slug-sanitized) and the action dispatches through its **unchanged, already-gated** event path. A `prompt.format` (e.g. `file-path`) opts into a shared widget from `formatComponentMap` — the `file-path` picker browses the **host** filesystem and is forced into absolute-path mode.
- **form** — a multi-field dialog (`action.form`: optional `title` + the same 1–10 field shape as the inline `form` node; supersedes `prompt` when both are present — the validator drops the prompt). Save merges **every** field into `payload[field]` (an empty string is a deliberate clear-to-empty) and dispatches through the unchanged gated path. The dialog renders plain text inputs only — it ignores the fields' `options`/`visibleWhen`/`multiline` and shows every field.

Precedence is **form → prompt → confirm → dispatch** (a form's Save is the consent act — confirm is never stacked after it). A fetch-race guard (`loadSeq` monotonic token) ensures a slow earlier render can't overwrite a newer one on rapid tab switches.

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/hub/pages` | `read` | List the user's Hub tabs (core + enabled-extension pages). |
| `GET /api/hub/pages/[id]` | `read` | Render one page (`core:<id>` or `ext:<name>:<pageId>`). 200+`{error}` on render failure; 404 unknown id; 429 over 12/min/user/page. |
| `POST /api/hub/pages/[id]/actions/[action]` | `chat` | Dispatch a named action on a **core** page. Body `{ payload? }` ≤ 2KB, scalar-only. 10/min/user. **Extension actions do NOT use this route.** |
| `POST /api/extensions/[name]/events/[event]` | — | Extension page-action sink, body `{ source:"hub", pageId, payload? }`. Gated by `eventSubscriptions` + 10/min/user. |

### UI entry point

- `/hub` and `/hub/<pageId>` — the page route (`web/src/routes/(app)/hub/[pageId]/+page.svelte`, a thin wrapper over the shared `HubPageView.svelte`) loads the tab list once, renders the active tree, and wires confirm/prompt/form dialogs + the Refresh button + live `ext:page-state` re-pull. The Daily Briefing tab is `/hub/core:briefing`.

### SDK (`@ezcorp/sdk/runtime`)

```ts
import { definePage, PageBuilder, pushPage, getChannel } from "@ezcorp/sdk/runtime";

definePage({
  id: "dashboard",                    // must match a manifest.pages[].id
  render: async () =>
    new PageBuilder("My Dashboard")
      .stats([{ label: "Tracked", value: "12" }])
      .table(["When", "Cron"], [{ cells: ["07:05", "*/5 * * * *"] }])
      .button("Clear log", { event: "my-ext:clear-log", confirm: "Clear all?" }, "danger"),
  actions: {
    "my-ext:clear-log": async ({ userId, pageId, payload }) => {
      // mutate state, then push a fresh tree:
      pushPage("dashboard", new PageBuilder("My Dashboard")/* … */);
    },
  },
});
getChannel().start();
```

- `render` may return a `PageBuilder` (built automatically) or a raw `{ title, nodes }` tree.
- The first `definePage` installs the shared `ezcorp/page.render` request handler (dispatched on `pageId`); action handlers register on the channel's `ezcorp/event/*` surface.
- `pushPage(pageId, tree)` fires the content-free invalidation (shares the panel mediator's budget: 10 updates/sec/extension, 64KB/tree).

### Manifest declaration

```ts
pages: [{ id: "dashboard", title: "My Dashboard", icon: "Clock", description: "…" }],
permissions: { eventSubscriptions: ["my-ext:clear-log"] },  // action events double-gated here
```

`validatePagesArray` (`src/extensions/manifest.ts`) enforces **≤ 3 pages** per extension at install.

### Component vocabulary

`PageBuilder` inherits the full **panel** vocabulary (`header`/`text`/`badge`/`progress`/`status`/`list`/`kv`/`counter`/`divider` — wire shapes identical to the bottom panel) and adds page-only nodes: `section` (the only nesting node, depth ≤ 6), `heading` (level 1–3), `markdown` (≤ 10k chars, DOMPurify-rendered), `stats` (≤ 12 items), `table` (≤ 100×12; rows carry `action?`/`href?`), `button` (`primary`/`secondary`/`danger`), `link` (internal `href` only), `empty-state`, `form` (inline on-page form: an `action` + 1–10 fields + `submitLabel`, default "Save").

The `form` node's fields share the dialog form's shape (`field` slug key — a non-slug field is DROPPED, no `"value"` fall-back; required `label`; `value` prefill; `maxLength` clamped to [1, 500], default 200) plus three inline-only features: `multiline` (textarea), `options` (a select of 2–12 options; fewer than 2 valid options falls back to a text input; an out-of-set `value` prefill clamps to the first option), and `visibleWhen` (`{field, equals}` — `equals` a string or a 1–12-entry array, entries ≤ 64 chars). Visibility **cascades**: a field is effectively visible only while its controlling field is itself effectively visible AND matches; a condition referencing an unknown or self field is pruned form-level at validation, and a reference cycle fails open to visible. A hidden field is **omitted** from the submitted payload (absent key = "don't touch" — composes with present-string-clears handler semantics) and keeps its local value across show/hide flips. On submit every effectively-visible field merges into `action.payload[field]`; validation **strips** `prompt`/`form` off the node's action (`confirm` survives), so a submit dispatches directly, never via a second collection dialog.

## Key files

- `web/src/routes/api/hub/pages/+server.ts` — `GET` tab list (core providers + enabled-extension pages).
- `web/src/routes/api/hub/pages/[id]/+server.ts` — `GET` render one page; core inline-render vs extension render-pull; 12/min/user/page limiter.
- `web/src/routes/api/hub/pages/[id]/actions/[action]/+server.ts` — `POST` core-page action; scalar-only 2KB payload gate; 10/min/user.
- `web/src/lib/components/hub/HubPageView.svelte` — the shared Hub view (global + project routes): tab bar, render fetch + fetch-race guard, confirm/prompt/form dialogs, live `ext:page-state` re-pull. `web/src/routes/(app)/hub/[pageId]/+page.svelte` is a thin wrapper over it.
- `web/src/lib/components/hub/HubInlineForm.svelte` — the inline `form` node renderer: cascading `visibleWhen`, omit-hidden submit, select/textarea/text inputs.
- `src/extensions/page-schema.ts` — `validatePageTree` + the full node vocabulary, limits, `isSafeInternalHref`, and `validatePrompt`/`validateForm`/`validateFormNode`/`validateAction`. **Source of truth** for the tree/prompt/form shapes.
- `web/src/lib/hub.ts` — pure shared logic: `parseHubPageId`, `buildActionRequest`, client `isSafeInternalHref`, and the mirrored page types.
- `web/src/lib/server/hub-render-pull.ts` — `renderExtensionPage`: cache check, subprocess spawn/wire, non-lethal 10s pull, render-provenance token mint, validate + cache; generation-keyed single-flight dedup + the bus-armed `ext:page-state` → cache invalidation.
- `web/src/lib/server/hub-extension-pages.ts` — `readManifestPages`, `listEnabledExtensionPages`, `findEnabledExtensionPage` (no-enumeration-oracle lookup).
- `src/runtime/hub-pages.ts` — core `HubPageProvider` registry (`registerHubPageProvider`/`getHubPageProvider`/`listHubPageProviders`) + `HubPageActionError`.
- `src/extensions/page-cache.ts` — `ExtensionPageCache` (60s TTL; `get`/`set`/`invalidate`/`invalidateExtension`; per-page invalidation generations discard overtaken render-pull writes).
- `src/extensions/state-mediator.ts` — `handlePageState`: validates `ezcorp/page-state` pushes, caches, emits content-free `ext:page-state`; token-bucket rate limit (10/s).
- `src/extensions/call-provenance.ts` — per-call reverse-RPC provenance registry; `kind: "render"` tokens authorize a page's own-data reads during render.
- `packages/@ezcorp/sdk/src/runtime/page.ts` — `PageBuilder`, `definePage`, `pushPage`, and the author-side descriptor types.
- `web/src/lib/components/hub/HubComponentRenderer.svelte` — declarative tree → native Svelte; `markdown` via `renderMarkdown` + DOMPurify.
- `web/src/lib/components/ui/format-map.ts` — `formatComponentMap`/`getFormatComponent`; maps a prompt `format` to a shared widget (`file-path` → `SharedFilePicker`).
- `web/src/lib/stores.svelte.ts` — global SSE subscriber that re-dispatches `ext:page-state` as a `window` CustomEvent.
- `src/extensions/manifest.ts` — `validatePagesArray` (≤ 3 pages, install-time enforcement).
- `docs/extensions/pages.md` — the author-facing how-to (worked `cron-dashboard` reference).

## Features it touches

- [[runtime-and-rpc]] — page renders/actions/pushes ride the existing JSON-RPC channel (`ezcorp/page.render`, `ezcorp/event/*`, `ezcorp/page-state`); zero new transport.
- [[permissions-and-grants]] — action events are double-gated on the extension's **granted** `eventSubscriptions`; declaring a page IS the grant.
- [[sandbox-and-isolation]] — extension renders run in the lazy-spawned isolated subprocess; the render provenance token authorizes its own-data reads.
- [[overview-and-authoring]] — `manifest.pages[]` is the declaration surface; `validatePagesArray` is part of manifest validation.
- [[daily-briefing]] — the first core `HubPageProvider`, surfaced as the `core:briefing` Hub tab.
- [[canvas-cards]] — sibling extension UI surface (chat-embedded `createCanvas`) sharing the same panel component vocabulary.
- [[message-toolbar]] — the other extension UI surface; its events route is the same one extension page actions POST to.
- [[builtin-file-tools]] — the `file-path` prompt format reuses the app's filesystem picker (browses the host fs in absolute-path mode).
- [[scheduling-and-loops]] — extensions like the cron dashboard push fresh trees from a cron fire via `pushPage`.
- [[bundled-catalog]] — bundled extensions that declare pages (e.g. file-organizer, ez-code) get tabs automatically when enabled. (`cron-dashboard` is an example-only worked reference, not a boot-bundled extension.)

## Related docs

- [extensions/pages.md](../../extensions/pages.md) — author-facing how-to (manifest, `definePage`, vocabulary, action contract, prompt formats, security rules).
- [extensions/data-storage.md](../../extensions/data-storage.md) — where a page's own per-extension data lives (read during render via the provenance token).

## Notes & gotchas

- **Two action routes, one for each kind.** Core actions hit `/api/hub/pages/[id]/actions/[action]`; extension actions hit `/api/extensions/[name]/events/[event]` with the `{source:"hub"}` body. Do not look for an extension-action handler on the Hub actions route — it 404s anything that isn't `core:`.
- **Page trees are SHARED across all users.** Renders and `pushPage` trees are cached per `(extension, page)` — **not** per user — and served to every signed-in user. Never push or render user-specific data into the tree. Per-user data belongs in **action responses**, keyed by the host-stamped `userId` the handler receives (clients cannot spoof it).
- **`payload` is attacker-controlled.** The host caps its size (2KB on the core actions route; 8KB — `HUB_PAYLOAD_MAX_BYTES`, sized for a worst-case 10×500-char form submit — on the extension events sink) and shape (scalar-only at the core route), but any authenticated user can POST any payload to a declared event directly. A form field's `options` set and `visibleWhen` condition constrain the **UI**, never the wire. Validate every field in the handler — treat it as untrusted HTTP input.
- **`prompt` grants zero new authority.** It is only a host-mediated way for a user to type one string into an action that is *already* declared and gated. The widget is 100% host-rendered; the extension supplies only `<>`-stripped, truncated display strings; `field` is slug-sanitized so it can't spoof a reserved key; a malformed prompt is silently dropped (the action degrades to a plain dispatch).
- **Echo-back is re-sanitized.** If a handler echoes a typed value into a re-rendered tree, that tree passes back through `validatePageTree` — every display string is `<>`-stripped, so a `<script>`-laden value can never reach the DOM. `markdown.content` is the lone exception (not `<>`-stripped) and relies on the host DOMPurify pipeline instead.
- **Non-lethal 10s render race vs. built-in 30s.** The render-pull races a *non-lethal* 10s timer; `ExtensionProcess.call`'s own 30s race *kills* the subprocess, which would be wrong for a render sharing the process with live tool calls. The 30s built-in stays only as a backstop.
- **`allowedEvents` is the GRANTED set, not the manifest request.** Render-time action gating reads `extension.grantedPermissions.eventSubscriptions`, matching the events route's grant-fed POST-time gate. A page node naming an undeclared/ungranted event is dropped at validation; an undeclared event 404s at POST.
- **Cache invalidation on disable/uninstall.** `invalidateExtension` is wired into the admin extension `PATCH`/`DELETE` handlers (`web/src/routes/api/extensions/[id]/+server.ts`) so a disabled/uninstalled extension's cached tree doesn't linger. The cache is extension-only: **core** pages aren't cached (they render fresh every request), so the core Hub-actions route does no invalidation. The per-page `invalidate` runs on the **extension** page-action sink (`/api/extensions/[name]/events/[event]`) — it drops the cached tree after dispatching the action so the client's follow-up re-pull (or the extension's own `pushPage`) serves fresh content.
- **Invalidation is generation-stamped.** `invalidate`/`invalidateExtension` also bump a per-page **generation**; a render pull captures the generation when it starts and hands it to `set`, and a write whose generation is stale is **discarded** — closing the write-after-invalidate race where a pull that an invalidation overtook would cache pre-change content as fresh for the full TTL. The render-pull module keys its single-flight dedup by the same generation (a post-invalidation re-pull never joins a doomed pre-invalidation pull) and arms a bus-driven `ext:page-state` → `invalidate` subscription on its own cache instance (`ensurePageStateInvalidation`), so invalidation reaches the cache renders are actually served from even when dev module graphs duplicate the singleton.
- **`href` is internal-relative only.** Must start with a single `/` (rejects `//`, `\`, `javascript:`, absolute URLs) — open-redirect defense, enforced server-side and re-checked client-side.
- **Manifest-pages reader is defensive.** `readManifestPages` tolerates rows installed before the `pages` field existed (and hand-edited blobs) so the tab-list route can never throw.
- **`bun test` resets.** `_resetHubPageProvidersForTests`, `__resetPagesForTests`, and `_resetCallProvenanceForTests` exist because the registries are module singletons that otherwise leak across suites.
