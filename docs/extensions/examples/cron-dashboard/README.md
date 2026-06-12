# cron-dashboard

Reference extension for **[Hub Pages](../../pages.md)** — the declarative, server-validated page surface at `/hub`.

What it demonstrates:

- **`manifest.pages`** — declares one tab (`/hub/ext:cron-dashboard:dashboard`). Declaring the page IS the grant; no separate permission key.
- **`definePage`** — serves `ezcorp/page.render` pulls with a `PageBuilder` tree (markdown intro, stats grid, runs table, confirm-gated danger button).
- **Page actions** — the "Clear log" button targets `cron-dashboard:clear-log`, which must be listed in `permissions.eventSubscriptions`. The Hub POSTs `{source:"hub", pageId}` to the generic events route; the handler arrives via `definePage`'s `actions` map.
- **`pushPage`** — every cron fire (and the clear action) pushes a fresh tree; the host validates + caches it and broadcasts a content-free invalidation signal so open tabs re-pull.
- **Self-tracked run history** — extensions can't read `extension_schedules` through the SDK (v1 gap), so the dashboard appends each `Schedule.on` fire to a `Storage`-backed log (newest first, capped at 50).

Run the tests:

```bash
bun test ./docs/extensions/examples/cron-dashboard/index.test.ts
```

The page flow (tab render, action POST, SSE-driven re-fetch) is additionally covered by the web Playwright spec `web/e2e/hub.spec.ts` — no standalone reverse-RPC harness here by design.
