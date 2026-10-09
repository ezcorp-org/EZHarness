# W4H-18 merge: hold plan (integrator-5, 2026-10-09; lock-free prep; nothing committed)

Merge: wp/w4h-18-runner-fd-settle 99c5bb9ab (FROZEN; dcc3212c4 fix + 99c5bb9ab gate file and todo; archy; on 6df16debf) onto integ/w00 95bc71b20.
Folder: /tmp/factory-platform-evidence/w00/w4h-merge/w4h-18-runner-fd-settle

## 1. Trial (prep.sh rc 0)
trial tree b6dee8e680bdd503a34fed3db02384bd45f993e8, clean; 5 files: scripts/lib/shipping-runtime-resource-accounting.ts (+51),
scripts/verify-shipping-runtime-resources.ts (+17 -25), scripts/verify-shipping-runtime-runner-fd-settle.test.ts (new, +115),
tasks/factory/w4h-18-GATES.md (+110), tasks/todo.md (+10). Hook maps 1: scripts/verify-shipping-runtime-runner-fd-settle.test.ts.
Importers (git grep at the trial tree) of the lib or the verify script: verify-shipping-runtime-resource-accounting.test.ts,
verify-shipping-runtime-resources.sh, verify-shipping-runtime-resources-soak.sh, verify-shipping-runtime-resources.ts, the new test.

## 2. Commit (on the ACCEPT and the merge order)
commit.sh under the lock (commit-locked.sh form, TC_IN_LOCK=1); the hook runs the 1 suite.

## 3. Hold: w4f-merge/hold-w4f.sh through gated-flock (exit file, timeout 7200, GATED_FLOCK_START_MEM_GIB=12)
(a) unit.txt d57836be705e8521, one lcov leg each: the hook-mapped scripts/verify-shipping-runtime-runner-fd-settle.test.ts and the lib's other test
    importer scripts/verify-shipping-runtime-resource-accounting.test.ts.
(b) extra-legs.sh ae7403b938aa1c04: the RESOURCES PROOF SHARD AS CI RUNS IT (ci.yml production-proof-shard, EZ_SHIPPING_SHARD=resources,
    scripts/verify-shipping-production-suite.sh with the job's env) in the runner-shaped Podman container of the W4H-11/W4H-18 harness, copied to
    harness/ (heavy.sh 28a138d4816f00c2, a copy of w4h-18/heavy.sh f9c07df311879266 with only E = harness/, R = the integ worktree, veto lane
    integrator-2 and own names i5-w4h18-* changed; job-setup.sh 380a8e88deb6bd08, job-proof.sh c9b8849dc0f0682e, image/Containerfile
    3da9819f1bba75ac and the three mounted conf/shim files byte-equal to the owner's): a clean git-archive snapshot of the merge, the CI
    job's setup steps and the production candidate image build inside the container (under the hold's lock), then the shard with a 5 s resource
    sampler. Binding: "shard=resources exit=0" (R4 passes, including the runner-FD settle). NOTEST=1 (the result is the shard's exit and receipts).
    No own PostgreSQL is needed: the shard runs its own stack inside the container. Disclosed shape differences (from W4H-11/W4H-18's gate files):
    rootless Podman in the container instead of rootful Docker (docker shim, --load drop, Docker Hub registries drop-in, log-driver drop-in), app
    ids 0:0. The runner image tag localhost/i5-w4h18-runner:24.04 is removed by name in a final leg; container, volume and snapshot by the harness.
(c) typecheck-all via tc_leg (in-lock 12 GiB).
(d) standard legs: prune scan, attestation, guard set, builds, web-server-lcov, coverage-merge, web build, graph mock pass, CRAP vs the first parent.
(e) merge-commit-gates vs 95bc71b20, BINDING (MCG_COVERAGE_INFORMATIONAL not set). scripts/ is outside SOURCE_GLOBS: new-file and patch read
    vacuous; the per-file lcov of scripts/lib/shipping-runtime-resource-accounting.ts and the changed lines (lcov-changed-lines.py over the hold's
    merged lcov) go into the receipts as the coverage proof. scripts/verify-shipping-runtime-resources.ts runs only inside the proof (no lcov).
(f) gate-integrity: base clean; origin/main@e3309906d = exactly the 8, else STOP.
Not run: the full combined run (lead's ruling). Risk named in the receipts: the change is two scripts and a unit test; the hold runs the unit
tests with lcov, the resources proof shard as CI runs it, and the gates; nothing else is re-measured since wave4i-3; the next hosted run is the
final proof (and it needs the Docker Hub pull budget, the user's decision).
