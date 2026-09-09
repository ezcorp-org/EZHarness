# Mock extension Review navigation

This directory retains safe proof for the mocked extension-detail Review path.
The raw Playwright blob report remains private because it can contain browser
runtime data. `screenshots/` contains all nine `image/png` attachments decoded
from that exact archive. `screenshots/manifest.json` binds each PNG to its
archive SHA-256, Playwright test ID, title, attachment label, and PNG hash.

## What the receipts prove

- `receipts/red-targeted.*` is the pre-repair red run. It includes the added
  rendered-author-heading assertion that failed after clicking Review. That
  old run also exposed a stale removed capability selector, so it is evidence
  of the missing rendered author data, not a clean one-failure baseline.
- `receipts/four-owned-evidence-r2.*` is the final Chromium run at
  `2d7e2e87`: 10 passed. It exercises all four owned specs with evidence
  enabled, including Review click, exact author `__data.json` target, 200
  response, disabled generation-0 author state, and destination screenshots.
- `receipts/shared-install-gate.*` and `shared-github-review.*` are the two
  shared-fixture callers: 2 passed and 1 passed.
- `receipts/shared-callers-startup.*` is retained as a non-test result. The
  prior combined caller command timed out waiting for Playwright `webServer`;
  no test started. The two separate caller receipts above are the final test
  results.
- `receipts/root-typecheck.*`, `biome.*`, and `e2e-lanes.*` passed. The lane
  receipt verifies the four files moved from `evidence-soft` to `mock-gate`.
  `mock-gate.args` lists their exact anchored selectors used by CI.

## Scope

The fixture fulfills only the exact same-origin author-page data request for
the requested installation/workspace. It proves mock Review navigation and
rendering do not mutate authority. It does not replace the real-auth approval
and activation flows.

`inputs/` holds inert committed source snapshots. The five fixture/spec files
are reconstructed from `2d7e2e87`; `lanes.json.txt` is reconstructed from the
integrated `b5d2d691` source. These are `.txt` files so repository typechecks
do not compile curation inputs.
