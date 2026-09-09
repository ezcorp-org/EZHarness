# Auth response boundary

This bundle records the repair for a mock-preview SSR request that threw a
401 `Response` from `GET /api/extensions`. SvelteKit treated that throw as a
500. The chat UI caught its failed preload and still rendered, which hid the
server error from the browser assertion.

## Evidence

- `logs/e2e-baseline-red-excerpt.txt`: fresh served chat UI case passed while
  the server recorded `GET /api/extensions` status 500.
- `logs/route-red-excerpt.txt`: old route-level tests failed because GET and
  POST threw their 401 responses instead of returning them.
- `logs/final-*`: final frozen-source proof: auth helper 48 pass, route Vitest
  15 pass, extensions API Bun 45 pass, and the served chat case 1 pass (`final-targeted-exit.txt` is `0`). The
  browser test asserts a returned 401; its controller fails if a hooks.server
  record appears.
- `profiles/mock-gate-*`: exact CI `mock-gate` selector lists 268 cases,
  matching 255 passes plus 13 intended skips. The complete selected run passed
  255/13 and emitted zero structured hooks.server errors.
- `profiles/visual-mock-*`: the visual mock selection passed 191. It emitted
  zero 500 records and one linked 404 record for the deliberate hydration
  error-page test that navigates `/this-route-does-not-exist`.
- `invalid-run/`: one stopped default-project command selected 2,108 cases.
  It is explicitly not lane evidence. The recorded process groups were owned
  and removed.

## Inputs and scope

`inputs/` stores the six final changed source files as inert `.txt` files.
`source-sha256.txt` maps their final bytes. The temporary hooks diagnostic was
restored to base SHA-256 `4d0b25799bf6a1a7f41e68f3038a50aa608ae9435ce6c223823f84baca751606`;
it is not a changed source input.

`cleanup/` records removal of this isolated worktree's generated Playwright
outputs and an ancestor-filtered process check with no remaining owned browser
process. `profiles/parent-profile-log-review.json` is the parent’s independent
review of the profile logs. `profiles/profile-runtime-dependency-provenance.tsv`
links the profile input receipts to the route and its static `checkAuth` import.

No raw browser blob, trace, archive, cookie, or authentication-state artifact
is included. Log excerpts retain no headers, request bodies, query strings, or
tokens. `artifact-mapping.tsv` records each copied or derived output with its
private input path, byte count, SHA-256, output byte count, output SHA-256, and
deterministic selection rule. `sanitization.tsv` is the short transform index.
