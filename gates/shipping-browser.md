# Gates: shipping browser recovery

Scope: stale tabs, pending-build reload, visible build-error repair, and supported browser engines.

Final checkout `d2222840` passes all three lifecycle cases with zero retries in Chromium, Firefox and WebKit. Product image source is `9ca27583`. WebKit uses the owned Playwright container. Exact source and image attribution is retained in `docs/validation/extension-v4-shipping/parent/independent-d2222840/` and `engines-d2222840/`. The earlier strict diagnostic fault proof and causal repair are retained in `webkit-reload-causal-e65a18a4/`.

- [x] B1: Two same-session real browser pages reject stale approval/activation after newer activation and after uninstall.
  EVIDENCE: The third full-engine case passes in all three engines. Exact rejected responses and unavailable retained-release UI are asserted.
- [x] B2: Reload during an observed pending build recovers one operation and completes review/activation/real invocation.
  EVIDENCE: The same observed operation ID and operation count survive reload; verification, human approval, activation and transformed output pass. The controlled read uses exact request identity and installation-only input. Removing its cancellation classification produces the intended strict failure; restoring source passes.
- [x] B3: Real editor build failure shows diagnostics, retains old output, and can be repaired through the editor to a new working release.
  EVIDENCE: The second full-engine case passes. Refresh waits for its actual successful response and UI completion before reading terminal state or navigating. Distinct later requests remain strict; a proposed duplicate-event exception was rejected from trace evidence.
- [x] B4: Existing lifecycle runs on Chromium, Firefox, and WebKit where runnable; exact unsupported platform inputs stay explicit.
  EVIDENCE: Full-engine exits are Chromium0, Firefox0, WebKit0, each3/3. Only the controlled reload case blocks service workers so its one-use route can observe the held read; the other two cases retain normal service-worker behavior.
- [x] B5: Tests run in canonical CI discovery, retain real flow and strict assertions, and include reviewed screenshots/error diagnostics.
  EVIDENCE: Parent reads the source and terminal results, decodes all 36 PNG attachments independently, compares their bytes with both the extracted and curated copies, and opens every image. No clipping or unreadable control is identified. Firefox screenshot 04 follows programmatic composer fill with the selector still open; keyboard focus dismissal is not covered. Exact source inputs and three passed/error-free test records per engine are retained. Complete static and broad browser regression results are tracked separately in the shipping report.

Follow-up at `825dc780`: full b5 mock, authenticated, and visual lanes pass after review-fixture and cleanup repairs. A separate type-only correction passes all four static sections and all three Firefox/WebKit lifecycle cases per engine. Parent verifies all 308 b5 PNG bytes and all 24 current engine PNG bytes, opens ten selected current engine images, and confirms no new fixture roots or runner auth state remains. Exact checkpoint scopes and the original b5 typecheck failure remain in the shipping report.
