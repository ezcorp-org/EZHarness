# Hosted CI 37743486763 on 1b96d2730 (feat/composable-factory-platform; PR 318) — integrator-5, 2026-10-08T08:05Z

Run: ci 37743486763, queued 07:26:57Z, completed (failure); 58 jobs; deps-audit 37743489742 success.
Compare tool: w00/wave4i-2/hosted-compare.py; tables in ci-37743486763-vs-37383355593.md and ci-37743486763-vs-37138524741.md.
- vs 37383355593 (1bc5f63c7, last push): red 9 -> 3; fixed 6; same 49; still red 3; green->red 0; no new or missing job.
- vs 37138524741 (52d8ba079, the original 20-red run): red 20 -> 3; fixed 17; same 38; still red 3; green->red 0.

Classes as used in the 2026-10-05 comparison: A = expected external condition (label, secret), B = aggregator/cascade of another red,
C = defect in the repository (code or CI wiring), D = hosted-environment-only cause, E = flake.

## Changed jobs vs 37383355593 (with the package)
| Job | 37383355593 | 37743486763 | Package |
| --- | --- | --- | --- |
| Production proof (content) | failure | success | W4H-11 (bootstrap progress deadline) |
| Production proof (resources) | failure | success | W4H-11 |
| external-postgres / External Postgres (Bun.sql) | failure | success | W4H-12 (runner setup; image_unavailable) |
| Production image extension lifecycle | failure | success | cascade of W4H-11 (B in the last run) |
| Backend tests | failure | success | aggregator of W4H-11/W4H-12 lanes |
| E2E (mock, no Docker) | failure | success | aggregator (its production part = W4H-11) |

## Still red (3)
| Job | Class | Cause (log line in ci-37743486763/all-failed.log) |
| --- | --- | --- |
| Gate integrity | A | "Gate integrity FAILED (8 finding(s))" — the 8 standing findings; needs the gate-change-approved label (the user's) |
| Factory runner readiness precheck | A | "FACTORY_RUNNER_READ_TOKEN is required" — the repository secret is not set (the user's); its dependents skipped |
| Per-file coverage gate | C — NEW CAUSE | was B in 37383355593 (stopped at "Require coverage producers to have succeeded"); now every producer succeeded and step 11 "Merge lcov + enforce thresholds" fails: "listed in thresholds but no lcov data" / "wildcard threshold ... lcov contains NONE of them" for packages/@ezcorp/factory-orchestrator/src/**, factory-transport/src/**, src/factory/runner/python/**, src/factory/reference-image/python/**, plus partial files (reference-data/pack.ts 50.44%, restore.ts 25.68%) |

## Per-file coverage gate: root cause (verified on the run's artifacts)
- ci.yml:1317-1321 downloads `pattern: lcov-cov-*` into ONE directory with `merge-multiple: true`; step 11 merges "coverage-artifacts/*.info".
- Seven producer artifacts each hold a file named `lcov.info` at their root (lcov-cov-factory-assurance-release, -compute-admissions,
  -orchestrator, -pool, -provisioning, -python, -storage; e.g. ci.yml:157-158 `name: lcov-cov-factory-orchestrator`, `path: coverage-shard/lcov.info`).
  Under merge-multiple they overwrite each other: one lcov.info survives, six producers' records are dropped. Shards (lcov_shard_N.info),
  extras (lcov_x_*.info), security (lcov_security.info) and web-vitest (lcov_web_vitest_N.info) have unique names and survive.
- The orchestrator artifact itself is correct: 17 SF records with repo-relative paths (downloaded to /tmp/integrator-5-ci-artifacts/).
- Latent, not caused by this push: ci.yml is unchanged 1bc5f63c7..1b96d2730; the producers come from this branch (7dc977525 onward; origin/main
  has none); in 37383355593 and 37138524741 the job never reached the merge because producers failed. W4H-11/W4H-12 turning every producer green
  unmasked it. The local combined run (wave4i-3) is green because its runner keeps each producer's lcov under its own path.
- Fix direction (for a package; not done here): give each producer's uploaded file a unique name (e.g. lcov_<producer>.info), or download without
  merge-multiple and merge "coverage-artifacts/**/*.info"; plus a registration test that no two lcov-cov-* artifacts upload the same file name.
