# Canvas dock pending-hydration receipt

The hosted CI failure had a later tool-history refresh after live completion.
Its mock returned a static, non-persisting empty tool list. That is a fixture
defect. The controlled test below instead starts the held tool-history request
before the live SSE events, which is the product race the revision boundary
must handle.

Product source is `a4a4a9e1e60dc6456c7ab3267766121c7b24f340`. The refreshed
test is `327977966b4f1ee928216f3a03661e6f00c1bcb5`.

- Source SHA-256:
  `dd16237d3195d4ccfda5cc14484e29c9bc34ecf0d56d45a0ef0be204176add82`.
- Test SHA-256:
  `c6a8be51d65c0c078597bf7e3acd5ecede8dbb0c7a9db45f338287db55bb7899`.
- Bun `1.3.14`; Node `v22.22.2`; all runs used the shared heavy lock.

## Controlled sequence

The first `messages?withToolCalls=true` response is held before live
`tool:start` and `tool:complete`. After the response is released, the test
first requires its visible `hydration-sentinel-initial`, the dock controls,
and desktop 640px padding. Every later response is held behind a second gate
until those fault-sensitive assertions finish. It then returns the matching
persisted `tc-dock-live` row and stable `hydration-sentinel-persisted` marker.
This makes unrelated later refreshes harmless and unable to mask the initial
replacement defect.

## Green

```sh
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock /tmp/terra-ui-canvas-refresh-green.sh
```

The Bash script ran:

```sh
bunx playwright test --config playwright.config.ts --project=chromium e2e/canvas-dock-open-close.spec.ts --grep 'live SSE tool completion'
```

It saved `PLAYWRIGHT_EXIT=0` and `OUTER_EXIT=0`; one test passed in 37.6
seconds. [Green raw log](raw/canvas-pending-hydration-green-32797796.log.gz),
SHA-256 `40412ac2cc68090a7ed946b3ce2485b74d43c5fe74fe59e9822dcbece1ce6950`.

## Fault sensitivity

The locked Bash script replaced only `newerLiveCalls` retention in
`hydrateToolCalls` with `[]`; loader and E2E code stayed unchanged. It used
the immediately prior barrier test `9e1ea3ed` (SHA-256
`2909e647a58c962c514e5e47b5e957e599c9c39666ebc1ac8f7ce5d57482d3b9`).
The final test only captures its initial-route boolean before awaits and reuses
the marker string; it does not change the barrier ordering. Faulted source
SHA-256 was
`914c7ee8a4b945988ee6517bacc3264c778e9495b4649e34ca645c90ad9c02a4`.

```sh
flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock /tmp/terra-ui-canvas-retention-fault.sh
```

That barrier test saved `PLAYWRIGHT_EXIT=1` and `OUTER_EXIT=1`. After the initial
sentinel proved hydration applied, `Preview controls` was absent. The exit
trap restored the source to the original source SHA-256 before the command
ended. [Fault raw log](raw/canvas-pending-hydration-fault-9e1ea3ed.log.gz),
SHA-256 `6a464ac510570c425aff6d5dd1a79a9486fea9e3edf2a2bbaaa4e58c2d04f353`.

The compressed logs contain no browser trace, session data, request bodies,
authorization headers, cookies, passwords, bearer tokens, or API-key labels.
