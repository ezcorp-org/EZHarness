# Hosted selected-browser setup evidence

Commit `d4ec18c40d253a409454391f703a0fd25a8dfa8a` removes the Chromium launch from real-auth global setup. Setup now uses Playwright `request.newContext()`, which retains the cookie jar and writes the same storage-state file without requiring a browser executable.

The hosted Firefox and WebKit jobs failed before any lifecycle case because global setup launched Chromium while each matrix job installed only its selected engine. The exact hosted raw logs remain private at `.../.cache/terra-shipping/parent/final-publication-825dc780/firefox-failure/firefox-job.log` (line 1039) and `webkit-job.log` (line 1832).

Two restricted-cache reruns exercised the existing three-case authenticated lifecycle matrix. Firefox used an owned cache containing Firefox and ffmpeg only. WebKit used an owned disposable Playwright server container whose browser path contained WebKit and ffmpeg only; it was removed after the test. `restricted-results.json` contains only selected test titles, counts, durations, exit status, cache inventory, and private raw-log paths. No raw reports, traces, authentication state, tokens, or screenshots are copied here. Neither successful run produced a PNG attachment.

A standalone pre-commit four-section typecheck receipt was not retained. The parent will retain the integrated typecheck with the authenticated Chromium and visual consumers.
