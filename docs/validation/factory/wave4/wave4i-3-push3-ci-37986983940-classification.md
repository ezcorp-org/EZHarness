# Hosted CI 37986983940 on 6df16debf (feat/composable-factory-platform; PR 318) — integrator-5, 2026-10-09T21:0xZ

Run: ci 37986983940, started 20:26:20Z, completed (failure); 58 jobs; deps-audit 37986983267 success.
- vs 37960843272 (3897fe923; its jobs json was saved before the Gate integrity re-run, so that row reads "cancelled"): the tool counts
  NEW RED 6, fixed 1, same 50, still red 1; red 2 -> 7. vs 37138524741: fixed 13, same 38, still red 7 (20 -> 7).
Classes: A expected external condition; B aggregator/cascade; C repository defect; D hosted-environment-only; E flake/race.

| Job | 37960843272 | 37986983940 | Class | Cause (log under push3/ci-37986983940/) |
| --- | --- | --- | --- | --- |
| Per-file coverage gate | failure | SUCCESS | fixed | W4H-15 + W4H-16 + W4H-17: every producer's records arrive and FactoryConsole.svelte:199 is now hit |
| Factory runner readiness precheck | failure | failure | A | FACTORY_RUNNER_READ_TOKEN unset (expected) |
| Gate integrity | cancelled (att. 1; att. 2 = the 8) | failure | A | "Gate integrity FAILED (8 finding(s))"; findings-match vs the expected list PASS (expected; the label) |
| Production proof (content) | success | failure | D | the candidate build's `FROM oven/bun:1.3.14-slim`: "unexpected status from HEAD request to https://registry-1.docker.io/v2/oven/bun/manifests/1.3.14-slim: 429 Too Many Requests" (Docker Hub rate limit) |
| Production proof (recovery) | success | failure | D | pulling docker://oven/bun@sha256:50317d83...: "Failed, retrying ... reading manifest"; 3 lines of 429 / Too Many Requests in the job log (Docker Hub rate limit) |
| Production proof (resources) | success | failure | E | bootstrap passed; R4 "Cycle 1 runner FDs 26 did not return to baseline 25." (verify-shipping-runtime-resources.ts:351). #329's settle (line 344) waits for the APP's port-3000 connections only; the RUNNER FD check right after is strict equality with no settle. Same symptom as W4H-11's local R5 at 88de7acce (runner FDs 24 vs 23). Latent; no commit since 37960843272 touches this script or the runner. |
| Production image extension lifecycle | success | failure | B | "Candidate image or production proof runners did not all succeed" (aggregates the three proofs) |
| E2E (mock, no Docker) | success | failure | B | "A required browser lane, route coverage, production-image verification, or extension browser engine validation failed" (aggregates the production-image job) |

Files: ci-37986983940-jobs.json; ci-37986983940-vs-37960843272.md; ci-37986983940-vs-37138524741.md; hosted-baseline-37960843272.tsv (made from its
pre-rerun jobs json); ci-37986983940/{production-proof-resources,production-proof-content,production-proof-recovery,production-image-extension-lifecycle,e2e-mock-aggregate,gate-integrity}-job.log;
ci-37986983940/all-failed.log.
