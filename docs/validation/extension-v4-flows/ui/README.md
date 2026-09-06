# Extension lifecycle UI receipt

Source SHA: `ff41d7a35906de40692f70b9e4fbf0b5e29097d7`.

Command (serialized with the required shared lock):

```sh
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock zsh -lc 'export PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH; export PI_E2E_REAL=1 PI_E2E_REAL_BASE_URL=http://localhost:4281 EZCORP_E2E_EVIDENCE=1; cd web && bunx playwright test --config playwright.real.config.ts e2e/real-auth/extension-lifecycle-flow.spec.ts'
```

Playwright reported `1 passed` in 1.0 minute. The wrapper did not emit its shell exit marker because it assigned zsh's read-only `status` parameter after the green reporter output; this receipt does not claim a shell exit code. The raw reporter output is [final log](raw/extension-lifecycle-flow-final-ff41d7a3.log). The client diagnostic attachment is empty: no page errors, console errors, lifecycle API failures, or other application API failures.

The browser created a workspace, edited and built its source, refreshed the visible build state to `verified`, reviewed and approved the exact release, and activated it. Test-only setup created an owned conversation and selected the local `ezcorp-mock` LLM for the normal mention/send turn; the extension lifecycle and both tool calls used product UI and the real extension runtime. The normal mention/send path created conversation wiring. The visible Add form produced the exact transformed UUID output, first-use card, and re-enabled card. The test then hid the extension through the conversation tools UI, proved its mention suggestion was unavailable, reset selection, disabled it, completed fresh approval/re-activation, invoked it again, and uninstalled it. Server inspection records `uninstalled: true` after the UI uninstall.

Visual inspection found the desktop review, expanded output, and 390 px tool selection layout readable with no horizontal overflow. Screenshots: [review](screenshots/extension-lifecycle-review-desktop.png), [output](screenshots/extension-lifecycle-live-output.png), and [mobile selection](screenshots/extension-lifecycle-tool-selection-mobile.png).

The current product has no supported per-conversation detach control. Tool selection hides the extension from the mention UI but does not delete the conversation extension wiring row; this is a scoped product gap, not a failed global disable or uninstall transition.

Pre-fix replay at `308262f9` reproduced two browser console 404s when an expanded live inline tool card requested an output row using its client invocation id. The UI now preserves the `inline` source marker through live updates and uses the already complete event output instead. Persisted cards still fetch their full output. See [reproduction](diagnostics/inline-output-404-reproduction.md).

Test design note: output-card labels are truncated and can collide across calls. Assertions first select the latest card by a unique visible output prefix, then expand it and assert the complete output inside the chat message container.
