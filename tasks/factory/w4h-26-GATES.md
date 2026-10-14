# W4H-26: the started application can run a reference-code task (runner packages installed, prepared, dispatched)

Brief: /tmp/factory-platform-evidence/w00/briefs/w4h-26.md (b72ca3bf44fe4140). Branch `wp/w4h-26-runner-wiring` from
origin/main 1981febd2. Worktree /home/dev/work/EZCorp/EZHarness/.worktrees/w4h-26 (archy via --worktree config). Evidence:
/tmp/factory-platform-evidence/w4h-26/ (paths below are relative to it). Pins: bun and bunx 1.4.2, node 24.14.1. No model call.

## Cause

R1 reproduced the defect through the composed application (the W19a stack: built web server, pool, host supervisor, its own
Temporal, the shared PostgreSQL and S3) over public HTTP:
- an operator's startup document that declares the reference-code task runners is refused at boot
  (startup-config.ts:500, a configuration digest without a model; :801, one profile per resource class; r1/pass1/);
- with a stock document, POST /packages answers 404 `factory_package_release_unavailable` (package-preparation.ts:219), and
  a started reference.code.v1 run fails at its first dispatch `factory_native_package_untrusted` (native-runner-policy.ts:141)
  (r1/pass2c/r1-stock.json 7b099153ba289ee4).
The brief's fix 1a (register REFERENCE_CODE_IMPLEMENTATIONS in the composition root) is not product-true: the product has no
host-side registry and C05 runs package code outside the host plane, first-party or not (RULED by the lead: accepted). Gaps:
no runner package implements the exports; no public route creates a project-scoped installation; nothing in the product
prepares a package; no product path puts a prepared artifact in the supervisor's store.

## Fix (rulings 1-4 accepted; D1-D7)

- D1 startup profiles: an unpinned profile may carry a configuration digest; a resource class is shared only with equal
  allocations; a runner declared twice is refused (the runner policy refuses it at composition). The local fleet declares the
  two guest-executable reference-code runners, tokens 50,000, in one cpu allocation (d9417ae3a).
- D2 one guest-package builder (src/factory/guest-package-build.ts) shared by the graph proof, the factory-services guest and
  the reference-code guests (their staged bytes unchanged: graph 8979e000…, factory-services 05e47834…, validator guest
  33d3b4dd…). The two reference-code runner packages declare every REFERENCE_CODE_IMPLEMENTATIONS export as a tool;
  snapshotRepository runs in the guest from a recorded tree (the reader port's "recorded listing"; the guest recomputes the
  tree id) and answers its port as an artifact reference to the sealed snapshot; a live connection and the other four exports
  refuse by name until the later package (34d592140, 0beb0c613).
- C05 contract rows first (66fc1acf7): "Install built-in runner packages", "Prepare a bound package for dispatch", and the
  project-scope rule.
- D3 boot install: a factory-enabled boot stages both packages through the v4 lifecycle, the same staging path as bundled
  sources (owned by the first administrator, global, disabled, built in the v4 build container); idempotent by source digest;
  changed bytes make a new pending release; no authority conferred (2e38e3aef, ea95d7fe6).
- D4 a global installation serves a project only while extension_project_bindings names that project, the active release and
  its generation (737ad9151).
- D5 the package-preparation role (before attempt dispatch; holds without a host launch endpoint); per-package backoff 1 s
  doubling to 60 s (f574b6c49, b9ce7a932).
- D6 the supervisor prepares: POST /v1/host/preparations on the W01b mutual-TLS host-launch service, same peer-tenant
  binding; 409 `source_digest_mismatch` before any build; built under the host's own limits within 240 s; answers the build
  with its artifacts; the product keeps them only when they digest to the named artifact and writes the receipt only when
  that equals the binding's (6ba267aea, 621e919eb, 2d6fd50ce).
- Defects the composed-application runs exposed, each fixed with a test: guest sources resolved from the web bundle dir
  (ea95d7fe6); preparation read the release source from the factory S3 store instead of the v4 lifecycle's (f168d7475); the
  host runner had no toolchain, a reused build identity failed forever, a failed build said only "mismatch" (a32e94aa0); the
  C13 inventory rows and the host runner's class binding (610ca637d).

## Gates

- [x] G1 (R1): reproduced over public HTTP; refusals with file:line above. EVIDENCE: r1/, journey.md.
- [x] G2: red first. All 15 new or changed test files are red on 1981febd2 with the base sources (red/red-on-base.txt; the
  base worktree .worktrees/w4h-26-base was restored after the run).
- [x] G3: midpoint, a bound package reaches "prepared" on the composed application through the supervisor: receipt
  trust_revision 1, artifact c50a97ad… = the binding's (proof/midpoint-6.json 942bf5f59e114314).
- [x] G4 (D7): the composed application admits, prepares, dispatches and executes snapshot-repository in the pinned guest
  (docker.io/oven/bun@sha256:9114c058…) on the shipped fixture repository: attempt completed, queue delivered; the sealed
  snapshot sha256:e020cd24… equals the digest recomputed from the fixture, and the port output equals the recomputed port;
  the run then fails at generate-private-candidate `factory_native_package_untrusted` (the later package). At the final head:
  proof/final.json (698c29aa00328084).
- [x] G5: D6 mutants, each dropping one digest comparison: 4 of 4 killed (host source check; client artifact check; product
  build-vs-binding; product verifyArtifacts). EVIDENCE: mutants/d6-mutants.txt.
- [x] G6: legs at 610ca637d: focused coverage of 50 test files, patch coverage PASS (23 files), new-file PASS (5 files, keys
  added), CRAP no touched function over 30; guard set 42 files, 522 pass, 0 fail; typecheck 0 (tc-gate, after
  `bun run build:packages`); lint 0; gate-integrity PASS on both legs (default, BASE_REF=origin/main: 0 findings);
  check-boundaries, factory boundaries, lanes clean; prune scan clean. EVIDENCE: legs/.
- [ ] G7: the proof on a started Compose installation, after W4H-27 merges (the Compose installation does not start today).

## Leftovers and disclosures

- The later package (ruled): the guest model adapter for generateCandidate and supervisedReview, the repository-read broker
  operation for live GitHub connections, and the toolchain claims lane. G8d stays blocked (`catalog_driver_not_implemented`).
- reference.code.v1's generateCandidate pins configurationDigest `sha256:bbbb…`, which no real configuration digests to, so
  no startup profile can pin it as the definition stands; the later package must change the definition or the pin.
- The local fleet's cpu class allocation rises from 1,000 to 50,000 tokens for the w09b guest too (one allocation per class).
- The provisioned Compose installation gives the application no extension runner, so a boot build there fails
  runner_unconfigured; that composition is W4H-27's step.
- The host service answers at most 4 MiB, so a package whose artifacts exceed it cannot be prepared (these are about 0.8 MB).
- The Podman-guest job guard reads `extends PodmanRunner` as a test that starts a guest; the supervisor built the same runner
  through its loader before, so the loaded class is bound as HostRunner. The guard's heuristic still does not see a loader.
