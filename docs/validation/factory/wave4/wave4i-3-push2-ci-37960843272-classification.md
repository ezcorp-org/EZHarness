# Hosted CI 37960843272 on 3897fe923 (feat/composable-factory-platform; PR 318) — integrator-5, 2026-10-09T17:2xZ

Run: ci 37960843272, started 16:40:47Z, completed (failure); 58 jobs; deps-audit 37960842459 success.
- vs 37743486763 (1b96d2730): red 3 -> 2 (+1 cancelled); failure -> cancelled 1 (Gate integrity); same 55; still red 2; green->red 0.
- vs 37138524741 (52d8ba079): red 20 -> 2 (+1 cancelled); fixed 17; same 38; still red 2.
Classes (as in the 2026-10-05 and 2026-10-08 comparisons): A expected external condition; B aggregator/cascade; C repository defect; D hosted-environment-only; E flake/race.

| Job | 37743486763 | 37960843272 | Class | Cause |
| --- | --- | --- | --- | --- |
| Factory runner readiness precheck | failure | failure | A | FACTORY_RUNNER_READ_TOKEN unset (expected) |
| Gate integrity | failure | CANCELLED | D (or E) | the job ran 16:40:51-16:50:51Z against its timeout-minutes: 5 and was cancelled inside step 6 "Gate-integrity meta-check"; GitHub holds NO log for it ("log not found"; the log blob is absent), i.e. the runner never uploaded one. The same step at 3897fe923 locally (BASE_REF=origin/main, NODE_PATH as in ci.yml): exit 1 after 5 s with exactly the 8 standing findings (push2/gi-local.log). origin/main unchanged (e3309906d). |
| Per-file coverage gate | failure | failure | E (race), latent behind W4H-15 | W4H-15 WORKS: every producer's records arrive (no "no lcov data" / "lcov contains NONE" line). The gate now fails on ONE line: "Coverage gate FAILED (1 file(s) below threshold): web/src/lib/factory/FactoryConsole.svelte: 99.70% < 100% — missed lines: 199". Line 199 is `await loadDrafts(projectId);` in importDraft's success path. This run's browser-route-coverage lcov: DA:197,2 DA:198,2 DA:199,0 DA:202,1 DA:204,1 — the import ran twice, its `finally` (204) only once, so one import never settled before the lane's coverage snapshot. Run 37743486763's browser lcov had DA:199,1 (the success path hit). The local wave4i-3 final gates (with the local browser lcov) passed per-file for this file. |

Files: ci-37960843272-jobs.json; ci-37960843272-vs-37743486763.md; ci-37960843272-vs-37138524741.md; ci-37960843272/per-file-coverage-gate-job.log;
ci-37960843272/all-failed.log; hosted-baseline-37743486763.tsv (made from the 37743486763 jobs json); gi-local.sh/.log; browser lcov at
/tmp/integrator-5-ci-artifacts/run-37960843272-browser/lcov.info.
