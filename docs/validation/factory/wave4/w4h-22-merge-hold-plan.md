# W4H-22 merge: hold plan (integrator-5, 2026-10-10; lock-free prep; nothing committed)

Merge: wp/w4h-22-toast-outcome b5bd72672 (one archy commit on fe445d241) onto integ/w00 fdc1a2de9. A docs-only gate-file commit follows: re-prep then.
Folder: /tmp/factory-platform-evidence/w00/w4h-merge/w4h-22-toast-outcome

## 1. Trial (prep.sh rc 0)
trial tree e7649c7db6925e9ef6acab6ee6bc323b6bca3ffb, clean; 1 file: web/e2e/file-organizer-real.spec.ts (+27 -5). Hook maps 0.
Readers of the spec (git grep at the trial tree, besides historical receipts): src/__tests__/e2e-lanes.test.ts and web/e2e/lanes.json.

## 2. Commit (on the ACCEPT and the merge order)
commit.sh under the lock (commit-locked.sh form, TC_IN_LOCK=1); the hook maps 0.

## 3. Hold: w4f-merge/hold-w4f.sh through gated-flock (exit file, timeout 7200, GATED_FLOCK_START_MEM_GIB=12)
(a) unit.txt f489287fa52d6b8e: src/__tests__/e2e-lanes.test.ts with lcov (it reads the lane lists that name the spec).
(b) extra-legs.sh 08ab6ebd9e31e082: the CONTENT PROOF SHARD AS CI RUNS IT (ci.yml production-proof-shard, EZ_SHIPPING_SHARD=content,
    scripts/verify-shipping-production-suite.sh with the job's env: the file-organizer real-backend browser spec and legacy adoption) in the
    runner-shaped Podman container, through integrator-5/harness/heavy.sh 5084c442be659fa3: a copy of w4h-11/heavy.sh ad785a7709865c10, the FULL
    harness (it fetches the legacy 537f074e and previous 3ec53eaa commits into the snapshot from the local repository, so legacy adoption needs no
    network fetch; W4H-18's reduced copy cannot run content), with only E (integrator-5/harness), R (the integ worktree), the veto lane
    (integrator-2) and own names (i5-<label>, i5-storage-<label>, /tmp/i5-home-snap-<label>, localhost/i5-runner:24.04) changed; job-setup.sh,
    job-proof.sh, job-diag.sh, unit.sh, docker-load-shim.sh, the two conf files and the Containerfile byte-equal to W4H-11's. The candidate image
    build runs inside the container under the hold's lock. BINDING (content-proof-result): "shard=content exit=0", "13 passed" for the
    file-organizer spec (including :516 "UI: a refused add surfaces a real error toast in the browser") and LEGACY_MAIN_TO_V4_ADOPTION_VERIFIED.
    No own PostgreSQL: the shard runs its own stack in the container. Shape differences (W4H-11's, disclosed): rootless Podman in the container
    for rootful Docker (docker shim with the --load drop, Docker Hub registries drop-in, log-driver drop-in), app ids 0:0. The harness removes its
    container, volume and snapshot; a final leg removes the runner image tag by name. Never a prune.
(c) typecheck-all (it includes the web-e2e program) and web-check (svelte-check --tsgo), each via tc_leg (in-lock 12 GiB, the fixed tc-gate.sh
    7678da69afb1c809).
(d) standard legs: prune scan, attestation, guard set, builds, web-server-lcov, coverage-merge, web build, graph mock pass, CRAP vs the first parent.
(e) merge-commit-gates vs fdc1a2de9, BINDING (MCG_COVERAGE_INFORMATIONAL not set). web/e2e is outside SOURCE_GLOBS: new-file and patch read
    vacuous for the spec; the content shard's pass is the proof.
(f) gate-integrity: base clean; origin/main@e3309906d = exactly the 8, else STOP.
Not run: the full combined run (lead's ruling). Risk named in the receipts: one Playwright spec; the hold runs it as CI does (the content shard,
13 cases plus legacy adoption), the lane-list reader, the typecheck programs and the gates; nothing else is re-measured since wave4i-3; the next
hosted run is the final proof (and needs the Docker Hub pull budget).
