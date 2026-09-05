# Independent browser validation

## Revision

- Combined candidate: `3093a3a5e327b5ca6fb585b9f1271817553804e8`
- Combined candidate tree: `e7d774a0d81983060dc60c2b92b9393ba464b05c`
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
The proposal test has an additional conditional skip when a live daemon has no
applicable pending proposal.

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
and propagates either failure. Focused runner tests pass 41 tests with 125
assertions. A targeted opaque iframe capture passed and was inspected directly.

## Pending artifacts

- `commands.log`: sanitized commands, versions, exits, and final counts.
- `skips.md`: complete final-run and source/config skip inventory.
- Desktop and mobile PNG evidence, inspected directly.
