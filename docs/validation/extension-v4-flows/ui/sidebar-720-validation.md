# Desktop sidebar at 1280 x 720

The desktop command-column navigation must keep a 30px clickable row and scroll
when its content is taller than the viewport. It must not shrink navigation rows
until they overlap.

## Red reproduction

- Base source: `b468397043cd3758b8eb4502e9ffa77439b38c59`.
- Regression assertion: the later `a786833f` test content with the base CSS.
- Result: exit 1. The visible `Agents` row measured 13px, below the 30px
  requirement. The raw log is [extension-lifecycle-sidebar-720-red.log](raw/extension-lifecycle-sidebar-720-red.log.gz).

## Fix and verification

Source commit: `5c8feefe27318942a646dc3c8de08bbcb6028a01`.

The CSS adds `flex-shrink: 0` to `.deck-row`. The real browser assertion then:

- verifies the visible Agents, Commands, Workflows, and Extensions rows are at
  least 30px tall and do not overlap;
- scrolls to and clicks Moderation; and
- returns to the extension author page before recording the screenshot.

The real-auth command exited 0 in 55.8 seconds:

```sh
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock bash -lc 'export PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH; export PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4283 EZCORP_E2E_EVIDENCE=1; cd web; bunx playwright test --config playwright.real.config.ts e2e/real-auth/extension-lifecycle-flow.spec.ts'
```

It used Bun `1.3.14` and the host Node `v24.14.1`; it does not claim a pinned
Node 22 run. The raw log is [extension-lifecycle-sidebar-720-5c8feefe-green.log](raw/extension-lifecycle-sidebar-720-5c8feefe-green.log.gz).

The captured [1280 x 720 screenshot](screenshots/extension-lifecycle-sidebar-720-5c8feefe.png) shows readable, distinct rows. The attached [client diagnostics](diagnostics/extension-lifecycle-sidebar-720-5c8feefe-client.json) have zero page errors, console errors, tracked failed API responses, and ignored API responses.
