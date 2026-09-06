# Extension lifecycle UI receipt

Source SHA: `260de9452822aab4d07dd7672ae53c4d2c322fe4`.

Command (serialized with the required shared lock):

```sh
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock zsh -lc 'export PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH; export PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4281 EZCORP_E2E_EVIDENCE=1; cd web && bunx playwright test --config playwright.real.config.ts e2e/real-auth/extension-lifecycle-flow.spec.ts'
```

Playwright reported `1 passed` in 57.1 seconds, and the wrapper recorded `COMMAND_EXIT=0`. The raw reporter output is [final log](raw/extension-lifecycle-flow-desktop-anchor-260de945.log). Client diagnostics are empty: no page errors, console errors, lifecycle API failures, or other application API failures.

The browser created a workspace, edited and built its source, refreshed the visible build state to `verified`, reviewed and approved the exact release, and activated it. Test-only setup created an owned conversation and selected the local `ezcorp-mock` LLM for the normal mention/send turn; the extension lifecycle and both tool calls used product UI and the real extension runtime. The normal mention/send path created conversation wiring. The visible Add form produced the exact transformed UUID output, first-use card, and re-enabled card. The test then hid the extension through the conversation tools UI, proved its mention suggestion was unavailable, reset selection, disabled it, completed fresh approval/re-activation, invoked it again, and uninstalled it. Server inspection records `uninstalled: true` after the UI uninstall.

Visual inspection found the desktop review and expanded output readable. At 390 px and 320 px, the toolbar wraps, the Tools trigger, title, checkbox, and reset control fit entirely inside the viewport, and the extension mention has readable light-theme contrast. The test asserts trigger and popover x/y/width/height bounds at both widths, then resizes the open panel to 1280 px and asserts the panel's left edge equals the trigger's left edge within one pixel. Screenshots: [review](screenshots/extension-lifecycle-review-desktop.png), [output](screenshots/extension-lifecycle-live-output.png), [390 px selection](screenshots/extension-lifecycle-tool-selection-mobile.png), [320 px selection](screenshots/extension-lifecycle-tool-selection-mobile-narrow.png), and [desktop after mobile](screenshots/extension-lifecycle-tool-selection-desktop-after-mobile.png).

The retained [ff41 390 px screenshot](screenshots/extension-lifecycle-tool-selection-mobile-clipped-ff41d7a3.png) records the original clipped panel. The first narrow replay caught the panel at right edge 349.97 px ([log](raw/extension-lifecycle-flow-mobile-e0dcdfde.log)); the next replay caught the Tools trigger at the same edge ([log](raw/extension-lifecycle-flow-mobile-5e02b75c.log)).

The current product has no supported per-conversation detach control. Tool selection hides the extension from the mention UI but does not delete the conversation extension wiring row; this is a scoped product gap, not a failed global disable or uninstall transition.

Pre-fix replay at `308262f9` reproduced two browser console 404s when an expanded live inline tool card requested an output row using its client invocation id. The UI now preserves the `inline` source marker through live updates and uses the already complete event output instead. Persisted cards still fetch their full output. See [reproduction](diagnostics/inline-output-404-reproduction.md).

Test design note: output-card labels are truncated and can collide across calls. Assertions first select the latest card by a unique visible output prefix, then expand it and assert the complete output inside the chat message container.

## Published snapshot labels

The server-state snapshot labels the non-secret `idempotencyKey` UUID as `operationDeduplicationUuid`. This only normalizes the evidence field name after the secret scanner flagged UUIDs as generic keys; the production API is unchanged. The original snapshot remains local, and no scanner exception was added.
