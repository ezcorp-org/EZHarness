# W4F: wave4f pre-flight fixes

Brief: /tmp/factory-platform-evidence/w00/briefs/w4f.md. Findings from the authoritative final gates at W12e's head 8676d8757
(/tmp/factory-platform-evidence/w12e-fix-final/gates.txt). One row per finding: red, green, commit. Each owner appends its own rows.

## W4F-1 (w12e-2, wp/w4f-1-w12e-coverage)

| Finding | Red | Green | Commit |
|---|---|---|---|
| F1 web/src/lib/build/preview-pipeline-guard.ts 0% (lines 12, 22, 25-28): the Node vitest leg is the only producer for web/src/lib | w12e-fix-final/per-file-thresholds.log and patch-*.log name the six lines | preview-pipeline-guard.unit.test.ts under vitest with V8 coverage: LF 6, LH 6 (w4f/w12e-2/f1/green-DA.txt); hook vitest 3/3 | 7656e98fa |
| F2 packages/@ezcorp/factory-transport/src/index.ts:163-164 | w12e-fix-final patch-*.log | closed in W12e (4d0c708c5, the orchestrator package's Node producer: DA 163 = 6, 164 = 1); landed with W12e | (W12e) |
| F3 the task-stops.ts:336 attestation is no longer needed | w12e-fix-final/patch-origin_main.log and patch-c1377122b.log: "attestation src/factory/task-stops.ts:336 is no longer needed: coverage now credits the line" (merged lcov DA 336 = 390) | scripts/coverage-attestations.json is []; the patch gate on both bases over the same merged lcov prints no attestation line and nothing for task-stops.ts (w4f/w12e-2/f3/patch-*.log); attestation-check.py --allow-removal passes. Decision: w00/w4f-merge/gate-change-decision.txt | this commit |

## W4F-2 (w16-2): four CRAP splits, branch `wp/w4f-2-crap-provisioning-kernel` off integ/w00 `0a6b3ef06`

Rule (`scripts/quality-gates.json`): every function the PR touched has CRAP <= 30. All four were at 100% coverage, so
CRAP equalled cyclomatic complexity. Each split is behaviour-preserving: the same checks in the same order, the same
messages and results; the existing suites are unchanged and green.

Red: `/tmp/factory-platform-evidence/w12e-fix-final/crap-changed-origin_main.log` (copied to
`w4f/w16-2/red-crap-lines.txt`). Green: `w4f/w16-2/green-58377535d/` — fresh coverage of the four files from their own
producers (the provisioning PostgreSQL producer under the heavy lock, the provisioning unit suites, the SDK suite) in
place of their records in the authoritative merged lcov; then `crap-score.ts --changed` against origin/main and
against the branch base, and the patch gate against the branch base.

| Finding | Red | Green (largest function the split left) | Commit |
| --- | --- | --- | --- |
| `src/factory/provisioning/fleet-cli.ts:49` runFactoryFleetCommand | 44 | 9 (`fleetProvision`); the dispatcher 2; a table of named command handlers, prototype names still unknown commands | `6fbb4e597` |
| `src/factory/provisioning/fleet.ts:73` parseFactoryFleetSettings | 38 | 6 (`storageDomainValid`); the parser 5; ordered named field checks, the same invalid-field message | `fca9c1809` |
| `src/factory/provisioning/control-plane.ts:112` <anonymous@112> | 32 | 12 (`controlPlaneRoute`); the handler 6; named routes in the same order, the same error mapping | `3dd67203f` |
| `packages/@ezcorp/factory-sdk/src/kernel.ts:500` applyStopped | 34 | 12 (`assertStoppedEventShape`); applyStopped 11; named helpers for the shape checks and both settle branches | `58377535d` |

- Coverage of the four files in the fresh lcov: 162/162, 165/165, 90/90, 1307/1307 lines. Patch gate against
  0a6b3ef06: PASSED (4 files). Against origin/main the only functions over 30 are W4F-3's two
  (`buildFactoryUsageSettlement` 39, `validateInboxEvent` 35).
- Suites: fleet-cli 8/0, fleet 13/0 (21/0 together), control-plane 22/0, the SDK kernel suites 122/0, the SDK suite 246/0,
  the provisioning PostgreSQL producer 64/0. Typecheck and lint 0 at each commit.
