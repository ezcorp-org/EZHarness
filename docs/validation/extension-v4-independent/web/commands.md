# Browser validation receipts

Candidate after browser repairs: `0b0a8293ac3bb35b4344f316a0f4b36f64790f30`; final canvas spacing: `8d7a530dcd41f92763ca5923386fce65de8e85d1`. The final selected visual and File Organizer runs used `19d9da92f771a5771d491234c9cff75eb104660b` (tree `5bf40268df5184c05cbdc1298e16fefc5fd33883`), based on `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`. Pinned Bun: 1.3.14. Selected visual runner: Node 22.22.2.

All heavy commands were serialized with `flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock`.

- Mock CI gate: canonical arguments from `bun scripts/e2e-lane-args.ts mock-gate`; exit 0; 210 passed, 12 skipped, 222 collected. Raw member: `mock-gate-final.log` in `artifacts/browser-raw-logs.tar.gz`.
- Full real-auth: `PI_E2E_REAL=1 bunx playwright test --config playwright.real.config.ts`; exit 0; 54 passed. Raw member: `real-auth-full-final.log` in `artifacts/browser-raw-logs.tar.gz`. This run used Node 24.14.1 and remains applicable to the later mock-only UI change; the changed real-auth evidence subset ran again below.
- Selected visual: `CI=1 bun scripts/run-visual-evidence.ts artifacts/evidence-specs-final.txt`; exit 0; mock 42 passed and real-auth 7 passed. The selector listed exactly 29 spec files. The canonical result is `artifacts/final3-blob/`; raw member `visual-selected-final4-green.log` in `artifacts/browser-raw-logs.tar.gz` records `COMMAND_EXIT=0`.
- Canvas object-output regression: deep `$state` guard exit 1 with `effect_update_depth_exceeded`; `$state.raw` guard 25/25 passed. Raw members `design-canvas-object-output-red.log` and `design-canvas-object-output-green.log` are in `artifacts/browser-raw-logs.tar.gz`.
- Long Nix `TMPDIR` runner regression: actual Node 22 environment failed with `ECONNRESET`; the short owned socket root passed and the production-launch regression passed 3/3. Raw members `runner-playwright-env-probe.log`, `runner-nix-long-tmpdir-green.log`, and `runner-socket-path-green.log` are in `artifacts/browser-raw-logs.tar.gz`.
- Final canvas label/theme scope: component 25/25 and live SSE plus saved hydration 2/2; raw member `canvas-label-spacing-green.log` is in `artifacts/browser-raw-logs.tar.gz`, with screenshots in `artifacts/canvas-label-blob/`.
- Production File Organizer closure: Docker-format image `localhost/ezcorp-extension-v4:audit-final-19d9da92-docker`, immutable ID `sha256:2d069cc64bc0bf06d5216517b0ee6724a865fe88ead28850f31219c2e2ade4de`, ran with a fresh owned database, human-session approval, project binding, and the external rootless runner. `DOCKER_TEST=1 ... playwright test e2e/file-organizer-real.spec.ts --project=chromium` exited 0 with 12 passed and 0 skipped in 3.3 minutes. Activation started the daemon without an app restart. The controlled old `.tmp` input produced a real daemon proposal, which the event route accepted. Owned Compose cleanup exited 0. `artifacts/file-organizer-real-production.zip` contains the list-reporter raw log, application and cleanup logs, sanitized command/configuration, source tree, image identity, test exit, and cleanup exit. This lane did not enable the blob reporter.
- Final broad browser reruns after the stale disabled-page repair: the canonical mock gate passed 210 with the expected 12 Docker-suite skips; full real-auth passed 54 with no skips. Raw members `mock-gate-final.log` and `real-auth-full-final.log` are in `artifacts/browser-raw-logs.tar.gz`.
- Final selected visual rerun used `CI=1`, Node 22.22.2, and Bun 1.3.14; the mock group passed 42 and the real-auth group passed 7. `artifacts/final3-blob/` retains both zips, a 67-shot manifest, all 67 extracted PNGs, and hashes.

`artifacts/final3-blob/` preserves the canonical clean two-group reports, its 67-shot manifest, extracted PNGs, and hashes. `screenshots/final3/` is copied from that final run. The older `final-blob/`, `final2-blob/`, and `screenshots/final/` sets are historical.

`artifacts/browser-raw-logs.tar.gz` is the deterministic bundle of ignored raw logs and the sanitized disposable Compose command/configuration. `artifacts/file-organizer-real-production.zip` is the deterministic 12-case receipt bundle. `artifacts/RAW-ARCHIVE-SHA256SUMS` authenticates both archives.

The first final-tree visual attempt omitted `CI=1`. Its mock web server did not
bind before the 180-second startup limit while its real-auth group passed 7/7;
the overall exit was 1. No cause is assigned to that unsupported local
configuration. The raw failure and both group reports remain in
`artifacts/browser-raw-logs.tar.gz`. The exact CI-configured rerun above passed.
