# Gates: W18a-app — complexity of the application half of the feature diff

Scope: the twelve application functions the coordinator measured above CRAP 30
on the feature diff, the compiled-workspace-output ruling, and an honest
measurement of the global line floor. Nothing here claims hosted enforcement.

At 100% line coverage CRAP equals cyclomatic complexity, so every `cc` below is
the number `scripts/crap-score.ts` reads once a function's lines are covered.
A limit of 30 therefore makes complexity above 30 unpassable at any coverage.

Receipts live under `/tmp/factory-platform-evidence/w18a-app/`. The working
tree was clean at every producer run. Files owned by the in-flight W09b package
(`/tmp/w09b-files.txt`) were not touched; their functions stay on the
coordinator's list and are named under G10 below.

## Gates

- [x] G1: Every one of the twelve functions is at or below CRAP 30, with no function in those files above 30.
  CHECK: `bun /tmp/factory-platform-evidence/w18a-app/complexity.ts <repo> <the twelve files>`
  EXPECT: worst cc <= 30 across all twelve files
  EVIDENCE: worst is now `runWorkflow` at cc 29 in `src/runtime/workflow-executor.ts`, a function this package did not touch. The twelve are listed with before/after numbers below.

- [x] G2: No function this branch touched exceeds CRAP 30 in any of the twelve files.
  CHECK: `BASE_REF=origin/main bun scripts/crap-score.ts --changed` over the merged lcov
  EXPECT: none of the twelve files appears in the violation list
  EVIDENCE: `crap-changed.log`. 57 violations remain on the feature diff and NONE is in a file this package owns. 25 are complexity-only (cov 100%): 19 in `packages/@ezcorp/{factory-sdk,factory-orchestrator,extension-runner}` (W18a-sdk) and 6 in W09b's files. The other 32 are measurement gaps (cov 0–38%) whose complexity is 7–25, so each scores at or below 25 once covered — a leg-list gap, not a code defect. No violation with cov below 100% has cc above 30.

- [x] G3: The splits change no behaviour; the EXISTING tests prove it, unmodified.
  CHECK: the per-file suites listed below
  EXPECT: 0 fail, no existing test file edited
  EVIDENCE: `w18a-app-final-results.json`. No test file was modified by this package. One test file was ADDED, for branches the split gave names to; see G7.

- [x] G4: Each of the twelve files holds the line coverage its threshold requires.
  CHECK: per-file percentages over the merged lcov
  EXPECT: 100% for the ten files keyed at 100
  EVIDENCE: `gates2-driver.log` section 8. Ten of the twelve read exactly 100%. `src/runtime/workflow-executor.ts` reads 99.17% and `web/src/hooks.server.ts` 94.57% on this LOCAL merge; the uncovered lines in both are pre-existing and untouched (`interactiveScopeStub` and an iteration-persist warning in the executor), which the patch gate confirms independently under G6.

- [x] G5: No `SF:` line in the merged lcov names compiled workspace output, and the SDK's sources are still measured.
  CHECK: `grep -c '^SF:.*/dist/' coverage/lcov.info`
  EXPECT: 0, with `packages/@ezcorp/factory-sdk/src/**` still present
  EVIDENCE: `dist-filter-proof.txt`. The Bun SDK leg emitted 15 `packages/@ezcorp/factory-sdk/dist/*.js` records, because `packages/@ezcorp/factory-sdk/src/guest-model-exports.test.ts:18` imports the BUILT barrel on purpose. Merging the same nine leg inputs with `scripts/merge-lcov.ts` at `e993eb2aa~1` and at HEAD differs by EXACTLY those fifteen records and nothing else. Final merge: 0 dist records, 16 SDK source records, 1306 sources.

- [x] G6: Every changed executable line is covered, and the branch adds no unmeasured source file.
  CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
  EXPECT: exit 0
  EVIDENCE: `new-file-coverage.log` ("no new source files in this diff"), `patch-coverage.log` ("all changed executable lines covered (12 file(s))").

- [x] G7: The one added test covers branches that were already untested, and says so.
  CHECK: `cd web && npx vitest run src/__tests__/hooks-server-legacy-cookie-and-failsafes.server.test.ts`
  EXPECT: 6 pass, 0 fail
  EVIDENCE: The patch gate flagged 13 lines in `web/src/hooks.server.ts`. Measured against `integ/w00`'s own web lcov, the SAME lines were already at zero hits (base lines 582–595, 630, 672, 701, 933), so the refactor moved pre-existing untested code rather than losing coverage. The added suite covers the legacy `pi_session` migration on both sides of its sec-M4 expiry, the fail-closed 503, the unjudgeable-cookie pass-through, the peer-address fallback, and HSTS. The expiry is pinned with `vi.setSystemTime`, never read off the wall clock.

- [x] G8: The compiled-output rule is pinned in both directions by a unit test.
  CHECK: `bun test --timeout 30000 ./src/__tests__/merge-lcov-compiled-output.test.ts`
  EXPECT: 6 pass, 0 fail
  EVIDENCE: dist dropped, the package's own `src` record kept with its hits, a mixed multi-leg merge keeps every other source, and a merge whose only input was dist still fails closed instead of writing an empty lcov. `merge-lcov-shard-vote.test.ts` is unchanged and still passes (18 tests).

- [x] G9: No gate was weakened, and the static checks stay green.
  CHECK: `bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/check-boundaries.ts && bun scripts/gate-integrity.ts`
  EXPECT: exit 0 for each
  EVIDENCE: `w18a-app-final-results.json` (types, lint, gate-integrity, boundaries all exit 0) and `gates-driver.log` section 8. No threshold lowered, no `EXCLUDES` entry, no skip, no biome opt-out.

- [ ] G10: Functions left on the coordinator's list because another package owns them.
  CHECK: ownership against `/tmp/w09b-files.txt` and the W18a-sdk package
  EXPECT: named, not fixed here
  EVIDENCE: W09b owns `src/factory/orchestration-process.ts:68`, `src/factory/pool/process.ts:70`, `src/factory/private-service.ts:59`, `src/factory/task-stops.ts:452`, and `web/src/routes/api/factories/_shared.ts:189` and `:432`. W18a-sdk owns the nineteen in `packages/@ezcorp/**`. This package touched none of them.

- [ ] G11: The global line floor, measured honestly and reported rather than fixed.
  CHECK: `bun scripts/check-global-coverage.ts`
  EXPECT: recorded verbatim
  EVIDENCE: `global-coverage.log`. 67.37% (74496/110570 lines across 1299 files) against a 90% floor, on the fullest LOCAL merge the combined runner's leg list can build. This is not the CI number: the leg list has no producer for `src/extensions/**`, `src/runtime/**`, `src/db/**` or `packages/@ezcorp/sdk/**` (their producer is the sharded backend pool, which `tasks/lessons.md` records as CI-only), and the browser-route receipt cannot be produced locally at all. Every one of the fifteen files owing the most lines is pre-existing main code this branch does not touch, led by `src/extensions/manifest.ts` (860), `src/runtime/stream-chat/setup-tools.ts` (628), and `src/runtime/goal-host.ts` (509).

- [ ] G12: The mutation gate's status, recorded verbatim.
  CHECK: `BASE_REF=origin/main bun scripts/mutation.ts --changed`
  EXPECT: recorded, report-only
  EVIDENCE: `mutation.log`. Its scope is `web/src/lib/**` against `origin/main`, which selects five files from the wider feature diff and none this package touched.

## The twelve functions

| file:line | function | before | after | proof suite |
|---|---|---:|---:|---|
| src/factory/reference-image/lock.ts:126 | assertReferenceImageLock | 92 | 5 | reference-image/lock.test.ts |
| src/factory/releases.ts:882 | listDeliveredNotifications transaction | 80 | 8 | release suites + factory-run-lifecycle + tests/postgres/factory-releases |
| web/src/hooks.server.ts:418 | handleApp | 80 | 14 | the twelve hooks.server vitest suites |
| src/runtime/workflow-executor.ts:1361 | executeFrom | 47 | 23 | the five legacy suites + workflow-capability-hash + tests/postgres/factory-legacy-workflow |
| src/factory/reference-data/reconcile.ts:177 | reconcileReferenceData | 46 | 13 | reference-data/reconcile.test.ts |
| src/factory/execution-gateway.ts:77 | handle | 43 | 17 | tests/postgres/factory-execution-gateway + factory-artifact-materials |
| src/factory/release-github.ts:183 | assertFactoryGitHubPublicationRequest | 43 | 1 | release-github.test.ts + the release-authority suite |
| src/factory/provisioning/local.ts:66 | provision transaction | 42 | 14 | scripts/factory-provisioning-coverage.sh |
| src/factory/artifacts.ts:58 | stageInTransaction | 38 | 8 | artifacts.integration.test.ts + tests/postgres/factory-artifacts |
| src/factory/reference-data/manifest.ts:135 | assertReferenceDataManifest | 36 | 7 | reference-data/manifest.test.ts |
| src/factory/pool/service-routes.ts:89 | createPoolAdmissionRouteHandler handler | 31 | 7 | pool/service-routes.test.ts + pool/client.test.ts |
| src/factory/transition-artifacts.ts:78 | finalizeTransitionArtifact | 31 | 6 | artifacts.integration.test.ts |
