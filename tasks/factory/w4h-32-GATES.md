# W4H-32: a missing runner artifact is rehydrated from the product's own copy

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4h-32.md`. Owner w4h-32, branch `wp/w4h-32-runner-rehydrate` from integ/w00 `390c49a90`
(the accepted W4H-31 merge). Evidence root: `/tmp/factory-platform-evidence/w4h-32/` (report.txt). Origin: W4H-28 real-8 (a kept
installation whose runner store lost the only artifact of `@ezcorp/reference-code`).

Base additions: W4H-28's runner commits cherry-picked with -x (445c41a09 -> cff1ab863, 2a0c65e74 -> 16830d1ec, f21e7619a -> 2c394a681);
`src/providers/error-shape.ts` is not on this base and was dropped from the pick (integrator reconciles at merge, after W4H-28).

Rulings (team-lead, 2026-10-15): contract rows approved as proposed; no boot refusal for a temp store path; the warning carries
artifactDigest with a per-process count; scope widened to package-preparation hydrate ("a rebuild is never an error handler").

- [x] G0: contract rows first. CHECK: `git log --format=%s -- docs/plans/2026-09-12-composable-factory-platform-contracts.md` EXPECT: the C05 row "Rehydrate a missing runner artifact (W4H-32)" and the C10 amendment commit precede every code commit EVIDENCE: report.txt
- [x] G1: red first for every path. CHECK: the new tests at the rows commit EXPECT: missing artifact -> rehydrate -> start succeeds; blob missing -> artifact_unrecoverable blob_missing; digest mismatch -> refusal digest_mismatch; no release record -> release_unknown; concurrent starts -> one rehydration; restart on a kept installation -> lazy rehydration; hydrate refuses a non-missing read error by name and never rebuilds; all red EVIDENCE: red/*.log
- [x] G2: green and 100% of changed lines. CHECK: focused suites with --coverage, merged LCOV, `BASE_REF=390c49a90 bun scripts/check-new-file-coverage.ts && BASE_REF=390c49a90 bun scripts/check-patch-coverage.ts` EXPECT: 0 fail; new and changed lines 100% EVIDENCE: green/*.log, coverage/*
- [x] G3: two-boot integration on a kept store. CHECK: `packages/@ezcorp/extension-runner/tests/store-reuse.test.ts` (extended) EXPECT: boot 1 builds; the store loses the artifact; boot 2 on the kept installation rehydrates lazily from the blob copy and starts; the readiness warning names the digest with count 1 EVIDENCE: green/store-reuse.log
- [x] G4: mutants. CHECK: plant each, run the focused suites EXPECT: digest check removed -> red; retry unbounded -> red; warning dropped -> red; rehydration from an unverified source -> red; hydrate rebuild on any error -> red EVIDENCE: mutants/*.log
- [x] G5: static legs. CHECK: build:packages, typecheck, lint, check-boundaries, check-factory-boundaries, schema-drift, gate-integrity EXPECT: all exit 0 EVIDENCE: static/*.log
- [x] G6: heavy legs through gated-flock (GATED_FLOCK_YIELD_FILE=/tmp/factory-platform-evidence/w4h-28/proof/real-run.pending). CHECK: the affected factory package-preparation producers and the runner package suite EXPECT: 0 fail EVIDENCE: heavy/*.log
- [x] G7: freeze. CHECK: report.txt with every claim, red/green logs, two-boot evidence, lessons EXPECT: frozen head sent to team-lead EVIDENCE: report.txt

## Results (frozen head in report.txt)

- G0: rows 97d31af81, then 86b33b7ce (ruling: restore bound; build only on host_preparation_not_built) precede the code commits they govern.
- G1: red/ (runner 5, host 17, preparation 2, wiring 2 fail; red tree = 97d31af81 + red/red-tree.diff); red2/ (preparation 1, runner-service 1 fail;
  red tree = cba86c540 + red2/red-tree.diff); heavy/run1/heavy-podman-red.log 0 pass 1 fail. Every fail an assertion.
- G2: coverage/checks.log under bun_pin: runner 17/0, host 50/0, lifecycle 6/0, preparation 30/0, client 1/0; new-file exit 0 (2 files 100%); patch exit 0 (14 files).
- G3: runner-rehydration.test.ts "two boots on a kept installation" and store-reuse.test.ts; preparation-podman (real store restored, no build, warning count 1).
- G4: mutants/summary.txt 10/10 killed (8 planned + restore bound reverted + raw artifact_missing builds).
- G5: static/summary.txt all exit 0 under bun_pin (pin.txt: bun 1.4.2, sql flag 1).
- G6: heavy/run1 (runner-package 144/0, preparation-podman 1/0, host-preparation-client 6/0, trusted-local 3/0; podman-red expected red);
  heavy/heavy-batch.log postgres-preparation 30/0 after the bun_pin fix (run 1's PG leg ran no test: BunSqlPipeliningGuardError).
- G7: report.txt.
