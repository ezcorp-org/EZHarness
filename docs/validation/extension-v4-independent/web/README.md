# Independent browser validation

## Revision

- Final browser-run checkpoint: `4b41933d` (tree `581e1ef7bc868e2042e5956d64d2879729497f5a`)
- Browser runner and evidence repair: `0b0a8293ac3bb35b4344f316a0f4b36f64790f30`
- Final canvas label spacing: `8d7a530dcd41f92763ca5923386fce65de8e85d1`
- Updated base and merge base: `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`
- Original PR head: `2c73e6bac85cd8f288056250ff032f613bfc15cd`
- Required Bun: `1.3.14` from `.bun-version`

## Current lane inventory

`web/e2e/lanes.json` is the source of truth. At this revision it contains 30
mock-gate specs, 29 real-auth specs, 74 evidence-soft specs, 7 Docker specs,
and 228 unwired specs. These are spec counts. Final Playwright test counts must
come from the clean runs.

The exact mock CI command is:

```sh
bash -c 'mapfile -t ARGS < <(bun scripts/e2e-lane-args.ts mock-gate)
         [ "${#ARGS[@]}" -gt 0 ] || exit 1
         cd web && bunx playwright test --project=chromium "${ARGS[@]}"'
```

The full real-auth command is:

```sh
bash scripts/setup-extension-runner-ci.sh --probe
cd web && PI_E2E_REAL=1 bunx playwright test --config playwright.real.config.ts
```

The real-auth configuration uses one worker, zero retries, a fresh PGlite
directory, full Chromium, and an isolated rootless runner. The scanner spec
also starts a separate Pixel 5 headless-shell session for the real mobile tap.

## Known mock-lane skips before execution

The mock gate includes `file-organizer-real.spec.ts`. With `DOCKER_TEST`
unset, its enclosing suite skips 12 real-backend tests. They cover real path
validation and persistence, config mutations, a daemon-created proposal,
filesystem picker confinement, browser error display, and Hub state. The mock
gate's other 29 specs do not contain an active skip on the Chromium project.
The production replacement now creates an owned applicable input and requires
the daemon to produce a proposal. It does not conditionally skip that behavior.

Replacement proof is split: `file-organizer-hub.spec.ts` covers mocked browser
wiring, while the Docker lane and first-party lifecycle verification must cover
the real backend. Final evidence must state whether the daemon proposal case
actually ran.

## Hosted visual artifact defect

Hosted run `33986413598` uploaded a manifest with zero screenshots. Its blob
report ended with status `failed` during test collection:

```text
SyntaxError: The requested module '@zxing/library' does not provide an export named 'BarcodeFormat'
```

The changed scanner evidence spec imported the barcode-render test helper,
which used named ESM imports from the CommonJS ZXing package. Node 22 reproduced
the exact collection error. A default import now makes the same collection pass.

The CI fallback also had a fail-open defect. `select-specs.ts` emits `__ALL__`
when a changed visual surface lacks a covering map entry or the map cannot load.
The repaired workflow credits every non-empty selection, routes mock and
real-auth specs through their own configurations, retains separate blob reports,
and propagates either failure. The focused visual-runner regression passed 7
tests with 23 assertions; the parent's wider regression group passed 159 tests.
A targeted opaque iframe capture passed and was inspected directly.

## Final browser results

- The exact mock gate collected 222 tests: 210 passed and 12 Docker-gated
  file-organizer tests skipped. The complete real-auth configuration passed 54.
- The isolated production-image File Organizer replacement passed all 12 tests
  with no skips, including a real daemon proposal and accepted file move.
- The selected visual runner passed 42 mock and 7 real-auth tests in one clean
  two-group invocation. It retained both report zips and extracted 67 PNGs.
- The final rerun after the disabled-page repair produced the same clean counts.
  Its 67-shot manifest and reports are in `artifacts/final2-blob/`.
- Direct screenshot inspection covered desktop and mobile approval, release,
  uninstall retention, project authority, scanner isolation, failed actions,
  disabled state, and canvas light/dark/mobile layouts. The final canvas controls
  use the active theme tokens, show seeded values, and do not overflow.
- `commands.md` records commands, versions, exits, and applicability.
  `skips.md` records the exact runtime skip names and configuration exclusions.
  `artifacts/final2-blob/` and `screenshots/final/` contain reports, PNGs, manifests,
  and SHA-256 indexes.
- `artifacts/browser-raw-logs.tar.gz` contains the sanitized red and green raw
  logs. `artifacts/file-organizer-real-production.zip` contains the exact
  12-case receipt plus its disposable Compose configuration and command.
