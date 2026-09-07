# Browser validation receipts

Candidate after browser repairs: `0b0a8293ac3bb35b4344f316a0f4b36f64790f30`; final canvas spacing: `8d7a530dcd41f92763ca5923386fce65de8e85d1`. The final selected visual run used `19d9da92f771a5771d491234c9cff75eb104660b` (tree `5bf40268df5184c05cbdc1298e16fefc5fd33883`). The final production File Organizer run used `ea445e9e48bbaffa337452d2254a6b2b2d1dc778` (tree `801704279706828fa0b9f958ae4446237f38e451`). Both are based on `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`. Pinned Bun: 1.3.14. Selected visual runner: Node 22.22.2.

All heavy commands were serialized with `flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock`.

[private browser archive]: ../../extension-v4-shipping/parent/evidence-quarantine-d2222840/private-artifact-inventory.json

Raw members remain in the private browser archive identified by [private browser archive]. The inventory records the archived file identity, not individual member content.

- Mock CI gate: canonical arguments from `bun scripts/e2e-lane-args.ts mock-gate`; exit 0; 210 passed, 12 skipped, 222 collected. Raw member: `mock-gate-final.log` in the private browser archive.
- Full real-auth: `PI_E2E_REAL=1 bunx playwright test --config playwright.real.config.ts`; exit 0; 54 passed. Raw member: `real-auth-full-final.log` in the private browser archive. This run used Node 24.14.1 and remains applicable to the later mock-only UI change; the changed real-auth evidence subset ran again below.
- Selected visual: `CI=1 bun scripts/run-visual-evidence.ts artifacts/evidence-specs-final.txt`; exit 0; mock 42 passed and real-auth 7 passed. The selector listed exactly 29 spec files. The canonical result is `artifacts/final3-blob/`; raw member `visual-selected-final4-green.log` in the private browser archive records `COMMAND_EXIT=0`.
- Canvas object-output regression: deep `$state` guard exit 1 with `effect_update_depth_exceeded`; `$state.raw` guard 25/25 passed. Raw members `design-canvas-object-output-red.log` and `design-canvas-object-output-green.log` are in the private browser archive.
- Long Nix `TMPDIR` runner regression: actual Node 22 environment failed with `ECONNRESET`; the short owned socket root passed and the production-launch regression passed 3/3. Raw members `runner-playwright-env-probe.log`, `runner-nix-long-tmpdir-green.log`, and `runner-socket-path-green.log` are in the private browser archive.
- Final canvas label/theme scope: component 25/25 and live SSE plus saved hydration 2/2; raw member `canvas-label-spacing-green.log` is in the private browser archive, with screenshots in `artifacts/canvas-label-blob/`.
- Production File Organizer closure: Docker-format image `localhost/ezcorp-extension-v4:audit-final-ea445e9e`, immutable ID `sha256:abc3644405188068cb2b0397f85199799b76d51336cb8d17e0a0d83492189962`, ran with a fresh owned database, human-session approval, project binding, and the external rootless runner. `DOCKER_TEST=1 ... playwright test e2e/file-organizer-real.spec.ts --project=chromium` exited 0 with 12 passed and 0 skipped in 3.3 minutes. Activation started the daemon without an app restart. The controlled old `.tmp` input produced a real daemon proposal, which the event route accepted. Owned Compose cleanup exited 0. `artifacts/file-organizer-real-production.zip` contains the list-reporter raw log, application and cleanup logs, sanitized command/configuration, source tree, image identity, test exit, and cleanup exit. This lane did not enable the blob reporter. `artifacts/file-organizer-real-production-3ec53-historical.zip` retains the previous canonical receipt for image `8f722e76…`; `artifacts/file-organizer-real-production-19d9-historical.zip` retains the earlier clean receipt for image `2d069c…`.
- Final broad browser reruns after the stale disabled-page repair: the canonical mock gate passed 210 with the expected 12 Docker-suite skips; full real-auth passed 54 with no skips. Raw members `mock-gate-final.log` and `real-auth-full-final.log` are in the private browser archive.
- Final selected visual rerun used `CI=1`, Node 22.22.2, and Bun 1.3.14; the mock group passed 42 and the real-auth group passed 7. `artifacts/final3-blob/` retains the 67-shot manifest, all 67 extracted PNGs, and hashes. Raw reports were removed from the current published tree and are private; see [private browser archive]. Earlier repository history is not erased.
- Bwrap opt-in closure used the same final image with a read-only repository,
  owned tmpfs, and a disposable test-only namespace envelope. The initial run
  passed the PID case and failed both `/dev/zero` cases with `EACCES`. A
  committed test changed only the byte source, then the same three named
  assertions passed 3/3 with 7 expectations and exit 0. See
  `artifacts/mcp-bwrap-optins-command.txt` and the associated red/green logs.

`artifacts/final3-blob/` preserves the canonical clean two-group manifest, extracted PNGs, and hashes. Raw reports were removed from the current published tree and are private; see [private browser archive]. Earlier repository history is not erased. `screenshots/final3/` is copied from that final run. The older `final-blob/`, `final2-blob/`, and `screenshots/final/` sets are historical.

The raw browser-log bundle was removed from the current published tree and is private; its original path, hash, and byte count are in [private browser archive]. Earlier repository history is not erased. `artifacts/file-organizer-real-production.zip` is the deterministic 12-case receipt bundle. `artifacts/RAW-ARCHIVE-SHA256SUMS` indexes the remaining published archives.

The first final-tree visual attempt omitted `CI=1`. Its mock web server did not
bind before the 180-second startup limit while its real-auth group passed 7/7;
the overall exit was 1. No cause is assigned to that unsupported local
configuration. The raw failure and both group reports were removed from the current published tree and are private; see
[private browser archive]. Earlier repository history is not erased. The exact CI-configured rerun above passed.
