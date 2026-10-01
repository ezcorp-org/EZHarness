# W4F: wave4f pre-flight fixes

Brief: /tmp/factory-platform-evidence/w00/briefs/w4f.md. Findings from the authoritative final gates at W12e's head 8676d8757
(/tmp/factory-platform-evidence/w12e-fix-final/gates.txt). One row per finding: red, green, commit. Each owner appends its own rows.

## W4F-1 (w12e-2, wp/w4f-1-w12e-coverage)

| Finding | Red | Green | Commit |
|---|---|---|---|
| F1 web/src/lib/build/preview-pipeline-guard.ts 0% (lines 12, 22, 25-28): the Node vitest leg is the only producer for web/src/lib | w12e-fix-final/per-file-thresholds.log and patch-*.log name the six lines | preview-pipeline-guard.unit.test.ts under vitest with V8 coverage: LF 6, LH 6 (w4f/w12e-2/f1/green-DA.txt); hook vitest 3/3 | 7656e98fa |
| F2 packages/@ezcorp/factory-transport/src/index.ts:163-164 | w12e-fix-final patch-*.log | closed in W12e (4d0c708c5, the orchestrator package's Node producer: DA 163 = 6, 164 = 1); landed with W12e | (W12e) |
| F3 the task-stops.ts:336 attestation is no longer needed | w12e-fix-final/patch-origin_main.log and patch-c1377122b.log: "attestation src/factory/task-stops.ts:336 is no longer needed: coverage now credits the line" (merged lcov DA 336 = 390) | scripts/coverage-attestations.json is []; the patch gate on both bases over the same merged lcov prints no attestation line and nothing for task-stops.ts (w4f/w12e-2/f3/patch-*.log); attestation-check.py --allow-removal passes. Decision: w00/w4f-merge/gate-change-decision.txt | this commit |
