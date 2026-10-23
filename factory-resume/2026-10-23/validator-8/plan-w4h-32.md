# validator-8: W4H-32 validation plan — runner store resilience (prepared from the brief; extended when the owner reports)
Brief w00/briefs/w4h-32.md 3a4da0e6b2608bb5. Branch wp/w4h-32-runner-rehydrate from 390c49a90. Standing rules:
plan-common-w4h-32-36.md 147bb9ec215b3a14 (S1-S10).

V1 Reproduction first: on 390c49a90 (+ the W4H-28 runner commits 2a0c65e74/445c41a09 if cherry-picked; the report must say
   so), an activation whose release artifact is absent from the runner store fails with artifact_missing {Error, ENOENT}
   (my two-boot reproduction: boot 1 builds and activates; I remove the artifact file from MY copy of the store by name;
   boot 2 activation). [H] if the runner runs in a Podman guest.
V2 Rows first (S2): the C10/C05 amendment names the rehydration operation, artifact_unrecoverable {expectedDigest,
   reason code}, the readiness warnings entry {code, releaseDigest} and the record count, before the code.
V3 Rehydration path: missing artifact -> the host plane copies the product's blob copy into the runner store, recomputes the
   digest named by extension_release_records BEFORE use, retries the operation ONCE, activation succeeds. Cases by name:
   missing blob copy -> artifact_unrecoverable; digest mismatch (a tampered blob in my copy) -> refusal, nothing written to
   the store; a second rehydration of the same release = no-op (store unchanged, no copy); concurrent activations of one
   release -> exactly one rehydration (a counting spy; join on the release key as the W4H-26 build operation does).
V4 Durable store path: the runner store path is installation configuration (not a temp dir); a product restart on the same
   installation keeps the store; a fresh store on a kept installation is detected and rehydrated lazily (the real-8 case).
V5 Readiness: a rehydration adds one non-blocking warnings entry {code, releaseDigest}, never a message (marker string
   test); the record keeps the count; no warning when nothing was rehydrated.
V6 Two-boot test (real processes, one persistent installation): boot 1 build; delete the artifact; boot 2 activation
   succeeds through rehydration; control: boot 2 with the blob copy also removed -> artifact_unrecoverable by name. [H]
V7 Mutants (brief + mine): digest check removed; retry unbounded (a second artifact_missing must NOT loop: bound = 1);
   warning dropped; rehydration from an unverified source (the runner's own path instead of the product blob); join
   removed (two copies under concurrency); rehydration result not re-checked before activation.
V8 Scope: no change under proof/ or scripts/factory-graph-proof (harness belongs to W4H-28; any change = finding); DRY: the
   error shape and artifact_missing reused from the W4H-28 commits (git grep for a second implementation).
V9 S3-S7 legs; the extension-runner suites (119+), the contract package suites, the app suites that use the runner client.
Verdict per S10. REJECT on: an unverified copy used; an unbounded retry; a message in readiness; a second error-shape
implementation; a harness change.

## Addendum A (2026-10-16, validator-8): owner report 1 (cherry-picks, inventory, rows, team-lead's rulings)
Facts: cherry-picks with -x: 445c41a09 -> cff1ab863, 2a0c65e74 -> 16830d1ec, f21e7619a -> 2c394a681; hand resolutions:
service.test.ts both tests kept; extension-contract index.ts both exports kept; coverage-thresholds.json base + the contract
error-shape key only; src/providers/error-shape.ts DROPPED on this base (nothing imports it; integrator reconciles after
W4H-28). Rows: C05 "Rehydrate a missing runner artifact": artifact_unrecoverable {expectedDigest, reason in release_unknown |
blob_missing | digest_mismatch | runner_unsupported}; warning runner_artifact_rehydrated {artifactDigest, count}; store
durable: trusted-local under .ezcorp, isolated at EZ_EXTENSION_RUNNER_STORE; one C10 line. Rulings: no boot refusal for a
temp store (lazy rehydration); the warning count is per process (no migration); ADDED to scope: package-preparation.ts:259
hydrate stops rebuilding on every collectArtifacts error ("a rebuild is never an error handler": artifact_missing ->
rehydrate; any other error -> refusal by name).
Checks added:
- A1 cherry-picks: each commit carries "(cherry picked from commit <sha>)"; the content equals the source commit except the
  named hand resolutions (git range-diff); error-shape.ts drop: git grep at the branch head finds no importer; a merge note
  in the report for the integrator.
- A2 runner restoreArtifact (podman.ts, service.ts /v4/artifacts/restore, client.ts one attempt): the runner recomputes the
  digest before it stores (mutant: digest check removed -> red); already present -> no-op (the store file's inode and mtime
  unchanged); a runner without restoreArtifact (optional in types.d.ts) -> artifact_unrecoverable reason runner_unsupported.
- A3 startExecution order change (reads the artifact BEFORE it registers the worker): test by name: a start that fails on a
  missing artifact records no workerId, and a retry after rehydration starts (no duplicate_worker); mutant: register first
  again -> the retry test red. This is a behaviour change outside rehydration: I check every other startExecution caller's
  tests still pass.
- A4 host plane runner-rehydration.ts: join per artifact digest (two concurrent activations -> one restore; counting spy);
  the release record must name the digest (release_unknown otherwise); the blob read via getFiles verifies the digest
  (blob_missing / digest_mismatch by name); exactly one retry (a second artifact_missing after restore -> refusal, no loop).
  extension-lifecycle-service.ts:151 wraps the single runner once: I list every start path (git grep for runner method
  calls) and check each goes through the wrapper.
- A5 package-preparation.ts:259 (added scope): artifact_missing -> rehydrate (no rebuild); any other collectArtifacts error ->
  refusal by name, no rebuild; red first by assertion on 390c49a90 (today it rebuilds); mutant (team-lead): hydrate rebuilds
  on a non-missing error again -> red. The row "a rebuild is never an error handler" precedes the code.
- A6 store path: EZ_EXTENSION_RUNNER_STORE set to a durable path in the shipped installation config (installation.yml /
  compose files), and trusted-local under .ezcorp; a temp store is accepted at boot and rehydrated lazily (no boot refusal,
  per ruling); I read the shipped config for the value.
- A7 warning runner_artifact_rehydrated {artifactDigest, count}: count since process start (ruled); no message (marker
  test); absent when nothing was rehydrated.

## Addendum B (2026-10-16, validator-8): owner report 2 (commits, evidence) and team-lead's rulings
Commits (head cba86c540 after the 3 cherry-picks): 97d31af81 rows (C05 rehydrate; C10 "a rebuild is never an error
handler"); 91998a0d7 runner restoreArtifact (contract, PodmanRunner, route /v4/artifacts/restore, client; a start missing its
artifact registers no worker); 770693dd2 host runner-rehydration.ts wrapping the ONE product runner (lifecycle service + the
factory's default preparation builder), readiness warnings, release-record lookup; 23b3924bc lifecycle fixture cleanup;
24cb2ab0f hydrate builds only on the named "no build yet" answers, other read errors -> factory_package_artifact_unavailable
{code, reason, class}; 5fd029f33 + d0c3a868e tests. Owner evidence (w4h-32/): red 26 assertion fails (runner 5, host 17,
preparation 2, wiring 2; red tree = 97d31af81 + red-tree.diff), green 103/0, new-file 100 percent (runner-rehydration.ts,
contract error-shape.ts), patch gate 14 files, mutants 8/8 killed, static 7 legs rc 0 at d0c3a868e; heavy job queued.
Accepted side effect: a runner error on the artifact read is a "fault", not "transient". Known bound: the service caps a
request at 128 MiB while collectArtifacts allows 160 MiB.
Rulings: hydrate builds ONLY on host_preparation_not_built; the raw-runner artifact_missing trigger is removed, and the Podman
"rebuild into a fresh runner" test becomes a restore through the wrapper (red first); any unwrapped product runner is a
finding; the restore route's limit is aligned to the 160 MiB artifact bound with a two-size test.
Checks added:
- B1 red: I rebuild the red tree myself (97d31af81 + red-tree.diff applied in MY snapshot; the diff holds tests only: I list
  its files) and confirm 26 failures by assertion (per suite); green 103/0 at the head.
- B2 mutants: the owner's 8 re-run by me; plus team-lead's: the raw artifact_missing trigger re-added to hydrate -> red; plus
  mine: a restore that skips the wrapper (the runner used directly at one start site) -> the wiring test red.
- B3 one wrapper: git grep for every place a product runner is constructed or a runner method is called outside tests; each
  goes through runner-rehydration.ts (lifecycle service and the default preparation builder); an unwrapped site = finding.
- B4 hydrate (ruling): only host_preparation_not_built builds; artifact_missing from the raw runner no longer builds; every
  other read error -> factory_package_artifact_unavailable {code, reason, class}, no message (marker test). The Podman test
  is a restore through the wrapper, red first by assertion. [H]
- B5 size bound (ruling): the restore route accepts an artifact set up to 160 MiB and refuses above it by name; a two-size
  test (one between 128 and 160 MiB to prove the old 128 MiB cap is gone, one above 160 MiB); the memory bound stated where
  the constant is; mutant: the old 128 MiB cap back -> the middle-size test red. Other routes keep their bounds (diff).
- B6 the fault/transient change: every consumer of that classification (git grep) still behaves as tested; a fault is not
  retried where a transient was.
- B7 heavy suites in the lock: the full runner suite, package-preparation.podman.integration, host-preparation-client,
  trusted-local in-process, tests/postgres/factory-package-preparation. [H]

## Addendum C (2026-10-16, validator-8): the heavy run's PostgreSQL leg never ran a test; heavy.sh fixed
Facts: heavy run 1 exit 1 came from the PostgreSQL leg, which never started a test ("Unhandled error between tests:
BunSqlPipeliningGuardError"), because heavy.sh set PATH by hand instead of sourcing w00/bun-pin.sh (bun_pin exports
BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 for Bun 1.4.0-1.4.2). Fixed: heavy.sh sources the helper; its header records the
flag; an ONLY filter re-runs one leg; the PG leg re-queued alone. Other legs at 22cacea4c: podman-red 0/1 (expected: the old
hydrate built on a raw artifact_missing), runner-package 144/0 (real Podman), preparation-podman 1/0, host-preparation-client
6/0, trusted-local 3/0.
Read now: w4h-32/heavy/heavy.sh c0eb162c8b6f59aa sources bun-pin.sh and calls bun_pin (line 11); its own PATH line adds only
Node (line 10). FINDING (minor): w4h-32/static/run-static.sh 1d7ccafd584698f1 sets Bun's PATH by hand (line 6) and never calls
bun_pin, so its legs run without the SQL pipelining flag (and without the pin's other settings); fix: source bun-pin.sh there too.
Checks added:
- C1 the PG leg green: tests/postgres/factory-package-preparation.test.ts shows tests run and passed (pass and fail counts read
  in its log; "0 pass" with an unhandled error is a red), with the flag recorded in the heavy header.
- C2 no leg script bypasses bun_pin: grep over every script the package uses (heavy, static, any other): each Bun-running script
  sources w00/bun-pin.sh; run-static.sh fixed.
- C3 the ONLY filter re-runs exactly the named leg (its log has one leg) and does not mark others as passed.
- C4 the podman-red 0/1 is the red-first record for B4 (the old hydrate on a raw artifact_missing), not a failure of the head.
Note (2026-10-16): W4H-28's ruling A+B re-locks the S3 adapter artifact digest and the provided-SDK bundle digest (plan-w4h-28 Addendum AR). After A lands on integ, I re-check every W4H-32 fixture or test that names an artifact or SDK digest (git grep for sha256 literals in its tests) against the new lock.
AR-7 for W4H-32 checked (2026-10-16, validator-8): the diff 390c49a90..22cacea4c adds no 64-hex literal; its digest placeholders are generated ("0"/"a"/"b"/"d"/"f".repeat(64)) and cannot equal a built digest; 0 overlap with the 73 artifact/SDK digest literals in lock.json files, factory-sdk src and reference-code at 390c49a90 and df1ff3373. W4H-28's re-lock (A) does not touch W4H-32's fixtures. Built-artifact digests in W4H-32 are computed at test time (owner: filesDigest, putFiles, the Podman publisher's real build).
C2 CLOSED (2026-10-16, validator-8): every W4H-32 script sources w00/bun-pin.sh and none sets Bun's PATH by hand: heavy/heavy.sh c0eb162c8b6f59aa, static/run-static.sh dca587423430c30e, coverage/run-coverage.sh 98098b5ffe27b530, mutants/run-mutants.py 3bfd2f9fc4f2cffd. Owner re-runs under the pin at 22cacea4c (static all 0; coverage suites green; new-file 0; patch 0, 14 files; mutants 10/10) are re-checked from their raw outputs at the freeze. The PG leg (ONLY=postgres-preparation) is still queued.

## Addendum D (2026-10-16, validator-8): FROZEN at 9418f9d5b (report.txt ee7026dcda580907); read-only freeze checks
Holds: validator-8/hold-w4h-32-light.sh 4fa76a6b0b2d6240 (lock-free; out w4h-32) and hold-w4h-32-heavy.sh 2a60ec5064ef8241
(gated-flock; out w4h-32-heavy); mutant list validator-8/w4h-32-mutants.sh 2e29b574b5e70f23 (generated from the owner's
mutants/run-mutants.py: its 10 exact texts, judged by my red rule) + my 2 (product runner unwrapped; restore no-op removed).
Read-only results:
- A1 cherry-picks: cff1ab863, 16830d1ec, 2c394a681 each carry "(cherry picked from commit 445c41a09... / 2a0c65e74... /
  f21e7619a...)". range-diff: 2c394a681 differs in metadata only; cff1ab863 and 16830d1ec show hunks only in
  service.ts (context around startRun on the #339 base) and in extension-contract index.ts (the named resolution: both
  exports); the two new files error-shape.ts and store-reuse.test.ts are byte-identical to the sources (direct blob diff
  empty). src/providers/error-shape.ts dropped (named in report.txt for the integrator).
- A6 store path: the isolated runner reads EZ_EXTENSION_RUNNER_STORE (packages/@ezcorp/extension-runner/src/main.ts:8), set by
  the operator in runner.env (deploy/extension-runner/extension-runner.service EnvironmentFile); no shipped file sets a
  value; the README (cba86c540) now requires durable storage ("never a temporary directory or tmpfs"). The trusted-local
  store is <projectRoot>/.ezcorp/extension-trusted-local (trusted-local-runner.ts:42-44; override EZCORP_TRUSTED_LOCAL_ROOT,
  absolute), durable with the project. Per ruling Q1 a temp store is not refused at boot (lazy rehydration).
- Leftovers named by the owner (recorded): the factory host supervisor's own leased store is not rehydrated; CLI publish not
  wrapped (no release record); the 1 MiB JSON envelope note for a near-160 MiB artifact.

## Addendum E (2026-10-16, validator-8): the rebase trial onto W4H-28's 8d9234f24 (a re-verdict at the real rebased head)
Trial (owner): `git rebase --onto 8d9234f24 2c394a681` drops the three cherry-picks by range; 12 commits, <USER> identity; trial ref
proof/w4h-32-rebase-trial (the owner's; removed after the real rebase); conflicts at 5 stops in 4 files, each resolved by a saved
script in w4h-32/rebase/ (resolve-contracts.py: W4H-28's text + its own row/amendment, no duplicate; resolve-appended-tests.py +
check-titles.sh: 12 titles in service.test.ts, none extra; resolve-thresholds.py: key merge; host-preparation-client.ts imports
only, both kept); no conflict in podman.ts, store-reuse.test.ts, core.ts, service.ts; expected at the real rebase: a tasks/todo.md
append conflict (keep both). Trial checks: diff-equality.py 27/28 files with +/- lines unchanged (the one difference: a trailing
comma in coverage-thresholds.json); install/typecheck/lint 0; runner 18/0, host 51/0, lifecycle 6/0, preparation 30/0.
My checks at the real rebased head (the verdict on 9418f9d5b carries over only for content that is unchanged):
- R1 the 12 commits after 8d9234f24 are the 12 W4H-32 commits (range-diff against 2c394a681..9418f9d5b: same subjects; content
  equal except the named resolutions); identity; the three cherry-picks absent (the W4H-28 originals are the base).
- R2 per file, the +/- lines against the new base equal those of 9418f9d5b against its base, except the four resolved files
  (my own line-set diff, as for W4H-28's rebase in Addendum AO); the scripts' outputs re-run by me on a copy reproduce the
  resolved files byte for byte.
- R3 contracts.md: W4H-28's rows intact (no line of W4H-28 removed) and W4H-32's C05 row + C10 amendment present once each.
- R4 service.test.ts: titles = W4H-28's set + W4H-32's set, none extra, none missing; coverage-thresholds.json: every key of both
  sides, valid JSON.
- R5 the light and heavy legs that touch the resolved files re-run at the rebased head (runner, host, lifecycle, preparation,
  the runner Podman suite); the mutants that target code in a resolved file re-run.
Heavy hold DONE (2026-10-16T05:04Z, out w4h-32-heavy, hold.exit 0, failed=[]): runner-package-podman 144/0 (real Podman); preparation-podman 1/0; preparation-podman-red-old-hydrate RED by assertion (22cacea4c's package-preparation.ts hunks reversed at the head: 0 pass 1 fail, '(fail) a fresh real Podman runner store is restored from the product's blob copy, never rebuilt, and the preparation keeps a durable receipt'); host-preparation-client 6/0; trusted-local-in-process 3/0; no runner container left; snapshot removed; config baseline at start and end.

## Addendum F (2026-10-16, validator-8): light hold at 9418f9d5b DONE (raw logs read); one finding; follow-up for coverage
Hold hold-w4h-32-light.sh 4fa76a6b0b2d6240 (out w4h-32; exit 1; ended 06:02:58Z; snapshot removed; config = baseline).
Green: rows-first; tested-head-equals; unit-coverage 76/0; sdk-coverage 248/0; contract suite 34/0; runner unit suite 109/0; 42
invariant legs all 0; my PG run of tests/postgres/factory-package-preparation.test.ts 30/0 (own PostgreSQL, removed);
gate-integrity default/main/base 0; check-boundaries, factory boundaries, schema-drift 0; typecheck (tc rule) 0.
Mutants: all 12 RED by assertion (the owner's m1-m10 and my two), each with the named test (failNames read):
m1 digest_mismatch; m2 artifact_corrupt; m3 the retry is exactly one; m4 the warning (2 tests incl. the two-boot test); m5 4
tests incl. release_unknown; m6 and m10 the rebuild-never-an-error-handler test; m7 no worker registered; m8 join; m9 restore
bound 129/161 MiB; my-product-runner-unwrapped (two-boot + trusted-local); my-restore-noop-removed.
Legs that exited 1, judged:
- identity: my strict name check flags 2c394a681, 16830d1ec, cff1ab863 (author name "<USER>", address = the <USER> noreply
  address; the three are W4H-28's 7c4e6163d, 648016a50, 305a0b8e8 cherry-picked; all 37 W4H-28 commits carry that name). The
  team rule (identity-check.sh v3) checks the address: `identity-check.sh commits 390c49a90 9418f9d5b` = 15 commits, clean.
  Not a finding. (The rebase R1-R5 drops the three by range anyway.)
- evidence-secret-sweep: 1 file, w4h-32/heavy/heavy.sh:31, a URL template `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@`
  (variable names; masked length 20 = the length of "${POSTGRES_PASSWORD}"). No value. Not a finding; my sweep pattern now
  needs to skip `${` templates (my tool's limit).
- changed-lines: 7 lines missed in src/factory/package-preparation.ts (95, 99-103, 292: builderHasNoBuild, artifactUnavailable,
  hydrate). Cause: my coverage set left out src/factory/package-preparation.integration.test.ts (no hook mapping reaches it).
  Follow-up (hold-followup.sh 2df42dd0fd59423f + followup-w4h-32.legs f8f042e1aef8e87f, out w4h-32-fu): that suite 30/0 with
  lcov; the union: 198 executable changed lines, 0 missed. The tool's exit 1 there is for two files with no lcov and no
  executable line (extension-contract types.d.ts; the test helper factory-package-preparation-suite.ts): not a miss.
  The owner's lcov (coverage/preparation) agrees: lines 95-103 and 292 hit.
- FINDING W4H-32-L1 (minor, owner fix): `bun run lint` reports 1 warning: src/factory/package-preparation.podman.integration
  .test.ts:19 lint/style/useImportType (FactoryPackagePreparationError is used only as a type), added by 22cacea4c. The
  standing rule is lint 0 errors and 0 warnings. Fix: `import { type FactoryPackagePreparationError, ... }`; it can land in
  the rebased head (R1-R5) and I re-run lint there.
Verdict status: W4H-32 at 9418f9d5b is ACCEPTABLE except L1; the binding verdict waits for the rebased head (R1-R5), where I
run lint (L1 gone), the PG and integration suites with lcov in the same hold, and the mutants again.

## Ruling (team-lead, 2026-10-16 ~10:55Z): gate-integrity for W4H-32's real job
- Binding: gate-integrity against the integ head for W4H-32's own range must PASS.
- Informational: the origin/main run must show exactly W4H-33's two ruled deletions (src/__tests__/task-stack-sdk-integration.test.ts,
  src/__tests__/todo-tracker-sdk-integration.test.ts) and nothing else; any other entry is a finding.

## Addendum G (2026-10-16 ~17:05Z): the real rebase onto b0b7bedf1 (W4H-28 follow-up 38ec686d8 landed) — delta checks at the new head
Launched on team-lead's word (gated, rebase-in-lock). Base b0b7bedf1 (integ/w00 after W4H-36, the W4H-28 follow-up and the tasks commits).
- G1 the rebase record: `-c rerere.enabled=false`; the stops are the five known ones (Addendum E) or fewer, each resolved by its saved script;
  any other stop aborted; no "previous resolution" line; the old head kept by ref (proof/w4h-32-frozen-9418f9d5b).
- G2 R1-R4 of Addendum E against the NEW base: the 12 W4H-32 commits by range-diff (2c394a681..9418f9d5b vs b0b7bedf1..<new head>), per-file
  +/- equal except the resolved files, contracts rows of W4H-28/W4H-36 intact plus W4H-32's rows once, test titles and coverage keys unions.
- G3 L1 (lint warning) gone: `bun run lint` 0 at the new head.
- G4 identity-check commits b0b7bedf1..<new head> clean; the typecheck 0 (in the lock or >= 16 GiB).
- G5 gate-integrity: against b0b7bedf1 for W4H-32's own range BINDING (PASS, or exactly the ruled set); origin/main informational and it
  must show exactly W4H-33's two ruled deletions — NOTE: W4H-33 has not landed yet (order changed), so origin/main must now show exactly
  W4H-28's merge-lcov.ts finding (landed with the follow-up) and nothing of W4H-33; any other entry is a finding.
- G6 R5: the light and heavy legs touching the resolved files re-run at the new head, PG and integration with lcov; the planted mutants
  (digest check removed, retry unbounded, warning dropped, unverified source) RED again.
- G5 confirmed (team-lead, ~17:10Z): origin/main leg informational = exactly {scripts/merge-lcov.ts}; base leg vs b0b7bedf1 binding = EMPTY.
  The merge folder: expected-main-findings.txt = scripts/merge-lcov.ts, expected-integ-findings-vs-base.txt empty. The running
  rebase-in-lock.sh expects 0 on its informational leg: a red there on exactly scripts/merge-lcov.ts is the expected result and does not
  void the rebase; if it aborted the rebase, the rerun is ruled with the expected set corrected, red first on the script change.
- Merge prep judged on content (2026-10-16 ~17:45Z), folder w4h-32-runner-rehydrate-f1efc9289-on-b0b7bedf1: trial tree 2112bb4b9 = head tree;
  expected main {scripts/merge-lcov.ts}, base empty; hook 10 (incl. host-preparation-client.test.ts); unit 129 holds all 51 invariants; pg 15;
  trio = the follow-up's with folder/labels/comments only. Derived red-on-base (integrator) VALID: 28 names, each at f1efc9289, absent at
  b0b7bedf1, failing in the owner's red logs (6 carry apostrophes). 057f08100's name (host-preparation-client.test.ts) is a test-only pin of
  existing behaviour (report.txt :32), green on base by design, run in the unit and hook legs: accepted outside warn-cases.
  NOT YET extra-legs.sh: P-1 Podman loop `[ -f ] && leg` silently skips a missing file (use file_leg); P-2 extension-runner package test
  marked NOTEST=1 (zero-test check off on a test leg).
- Prep hashes (integrator list) all equal the disk: config e3fa2f2ddc2a001a, hook 75dbe8e99bf99a14, unit 558b8be4c4716be1, pg d3cf439905f2b2c1,
  warn-cases fb65fa8bfc84feab, red-on-base 3068aa4426a6546b, expected main 99c49be48fbf9679 / base e3b0c44298fc1c14, trio f60cda8b2205a2e1 /
  dd11d0234f048a2d / 463ba0ff513c69e9, commit-msg 6e46ced38a3e1ba7 (identity clean): OK. extra-legs.sh 9953a7e22df9566a NOT YET (P-1, P-2).
- Prep OK (2026-10-16 ~18:10Z), the commit trigger: folder w4h-32-runner-rehydrate-f1efc9289-on-b0b7bedf1, TREE 2112bb4b9; extra-legs.sh.new
  e84b629b7f16317f (diff from 9953a7e22df9566a = P-1 file_leg for the Podman legs, P-2 the runner package test without NOTEST, whose script
  is `bun test`; + comments). Other files at their OK'd hashes.
- Commit OK (2026-10-16 ~17:50Z), the hold trigger: merge c28a965ce7397d9c0fe10aaa6618eac4ea50bb06; tree 2112bb4b9; parents b0b7bedf1, f1efc9289;
  hook 10 files 86/0; rerere off, 0 previous-resolution; identity 13 clean; message = commit-msg.txt; integ/w00 b0b7bedf1.
- followup5d 1e8cc01660a43c21 pre-read OK (17:51:55Z): item 1 = the C05 row at f1efc9289 in substance; merge facts true; tokens PENDING-HOLD x2,
  PENDING-PUBLISH, HOSTED-COMPARISON-4; identity clean. Named for the push only after the PENDING fills, on a FINAL line.
- Owner report append-only PROVEN (2026-10-16 ~17:55Z): report.txt 0df71fb19c5e0c20; reconstructed ee7026dcda580907 (10429 B), 6d9882afd386e65e
  (12895 B), 028d936ff6f00791 (13852 B) each hash to their recorded value AND are byte prefixes of the current file (cmp -n).

## Addendum H (2026-10-16 ~19:30Z): ruled fix B (team-lead) — checks at W4H-32's fixed head
Owner w4h-32, one commit, row first, red tests first; the wiring change in W4H-28's guest-package.ts granted to w4h-32, reviewed by w4h-28b.
- H1 row first (C05/C10 wording for the harness's builder contract, if any row changes) before code.
- H2 T1: the harness release stores the artifact copy under the build's digest; T2: the mirrored install on a fresh real store through
  productExtensionRunner restores and prepares, warning count 1; a raw builder is refused by name. Both RED at the parent by assertion.
- H3 mutants RED: rebuild-on-artifact_missing re-added; artifact copy not stored; raw builder accepted.
- H4 under the lock: graph mock pass RED at the parent, GREEN at the fix (the team rule: build/install/first-boot rule changes need the
  graph mock pass in the owner's freeze legs); typecheck 0; coverage gates (patch, new-file) 0; identity; gate-integrity as ruled.
- H5 w4h-28b's review of the guest-package.ts diff on record; the diff is the one wiring change.
Then a new merge prep, commit, hold (the graph mock pass must be green there).

## Addendum I (2026-10-16 ~22:05Z): ruled (team-lead) after the 788a514c8 ACCEPT
- The surviving mutant (the putFiles stored-copy digest check removed; T1 stays green) is a recorded leftover, closed at the re-rebase onto
  W4H-33's tasks head: one commit BEFORE the rebase job adds one T1 case (a blob store whose put returns a digest unequal to the collected
  files' digest is refused by name, factory_guest_package_artifact_mismatch). I judge it with the rebase delta: red at 788a514c8 by my
  mutant (case fails when the check is removed), green at the new head.
- w4h-28b's wording note (the dropped 'second and third references reuse the first one's verified artifacts') is a leftover.
- W4H-32's prep waits for W4H-33's publish.
- Time correction (validator-8, 2026-10-16T21:25Z by date -u): my '~HH:MMZ' labels written after about 20:50Z today were estimates and run ahead of the clock (for example '~21:45Z' to '~23:55Z'); the true UTC times of those sections are about 20:50Z to 21:20Z. Order and content are unchanged; logs with clock stamps are the time source.
- Rebase-2 input pre-check, read-only (2026-10-16T22:13:08Z): PASS. rebase-in-lock.sh a3d5c1e702e655c9 and mock-lib.sh 92de313a1423ca40 equal the owner's preflight-rebase2.txt (22:12:24Z) and dry run 20:51:26Z (files written 20:50-20:51Z; the first rebase used rebase-in-lock 140bf2eba0d34e6c, so this version is new to me: it takes REBASE_EXPECT_MAIN as a file, as the earlier LEFTOVER asked; judged with the job). expect-main-w4h33-base.txt 6e315f8400142f3f = exactly 3 lines: scripts/merge-lcov.ts (M) + task-stack- and todo-tracker-sdk-integration.test.ts DELETED. T1c draft 01a3b4379c6ddf6f is one test case; commit-t1c.sh 95b3d7a5109051d7 adds only src/factory/guest-package-build.test.ts. preview-8fb4474e9.txt 63406650676d5184: rerere off merge-tree of 8fb4474e9 and 788a514c8 on base b0b7bedf1, exit 0, tree c209cc4ee, the two deletions at base. Count: b0b7bedf1..788a514c8 = 14 now; 15 with the T1c commit (REBASE_NCOMMITS=15).
- T1c commit read OK (2026-10-16T22:19:27Z): 9f636011fb8a15cac72738b82c8d76689f66322a, parent 788a514c8, <USER> noreply, only src/factory/guest-package-build.test.ts +9 -0; hook lint 1 file, mapped 8/0, 19 expect() calls (commit.log b162b7d095ba457c, word1.log 644b4339b5542c54). My checks on /tmp/v5-snaps/validator-8-w32 at 9f636011f (clean before and after): T1 8/0; my surviving mutant (the stored-copy putFiles digest check removed) now FAILS 7/1 on the new case: leftover 4 / ledger 70n closed by this commit.
- rebase-in-lock.sh 6c0708a0d6fe474a (stop policy) read: diff vs a3d5c1e702e655c9 (backup before-stop-policy) = REBASE_STOPS=resolve|report (bad value exit 2), 'stops=' in the start log line, and in report mode: stop-N.txt (conflicted paths + git diff) written, the conflicted list captured BEFORE 'git rebase --abort', then fail; nothing else. The intermediate 7c2db1d225bf170e listed the paths after the abort (empty list); fixed. launch-rebase2.sh a54b0df83360a7ef: EXPECT_JOB required and compared to the rebase script hash; REBASE_STOPS=report passed; rest unchanged (NCOMMITS=15, UPSTREAM b0b7bedf1, EXPECT_MAIN file). The full job judgment follows the job.
- Rebase-2 pre-check (2026-10-16T22:31:26Z; verdict waits for the mock pass): head c586125ab4e18732efa22d89b7d2280ecc879386 on 8fb4474e9, 15 commits; proof/w4h-32-frozen-9f636011f = 9f636011f; run-20261016T221955Z hashes.txt 18 lines all equal; identity noreply on all commits; diff-equality 32 files, 0 different; gate-integrity range (binding, 8fb4474e9) PASSED; main leg = exactly the 3 lines of expect-main-w4h33-base.txt. Graph mock pass NOT run: run.sh refused 'EZCORP_FACTORY_STORAGE_SECRETS_DIR is unset or not a directory' (driver env gap; a mock-only job waits for team-lead's word). Required before my verdict: the mock pass PASSED at c586125ab in one gated job, with the driver fix shown (the env export only).
- Mock-only job inputs read (2026-10-16T22:32:25Z): mock-lib.sh afd7f9a2c3cb9505, diff vs 92de313a1423ca40 (backup before-secrets-dir) = 3 lines: a comment + 'if the variable is not a directory, set it to the first /run/user/1001/ezcorp-factory-storage.* and export'. No match: the variable is empty and run.sh refuses as before (safe). Note, not blocking: with several matches it takes the first by name; there is exactly 1 now (count by name only; contents not read). mock-head-in-lock.sh 4222c9ad7d5cff2a: refuses unless the w4h-32 worktree is at the named head and clean; one leg mock_pass_leg; status 0 only on 'passed'. Waiting: its record at c586125ab.
- Prep-input pre-check plan (2026-10-16T22:34:55Z, team-lead): when integrator-5 reports the staged W4H-32 prep inputs (folder w4h-32-runner-rehydrate-c586125ab-on-8fb4474e9), check read-only: expected-main-findings.txt = the 3 lines of expect-main-w4h33-base.txt 6e315f8400142f3f; expected-integ-findings-vs-base.txt empty unless a ruled finding; the prep.sh line PREP_BASE=8fb4474e993a381ee9bc68b70cd16e4d95586550, HEADSHA=c586125ab4e18732efa22d89b7d2280ecc879386; hook-mapped list = the files the head changes vs base, mapped as the hook maps; commit message identity-clean; the tasks script for blocks 6+7 vs tasks-locked.sh 04c4e6cc863919cf = folder, blocks, message only; its dry run = my two-block dry run (one 42-line insert before Owners; run 2 refuses). If the mock is not 'passed', the pre-check stands only for files that do not name the head.
- Prep pre-check gate (2026-10-16T22:39:16Z, team-lead): my pre-check OK of the prep inputs (sent to integrator-5 and team-lead with its record hash) plus the end of W4H-35's run pre-authorize the merge commit; the hold waits for team-lead's word. Added checks: the trial TREE equals c586125ab's tree 577909d0cc5a (the head descends from 8fb4474e9, so the merge is a fast-forward tree); the hook-mapped list covers every file changed in 8fb4474e9..c586125ab.
- Round-2 prep pre-check: OK (2026-10-16T22:51:26Z), folder w00/w4h-merge/w4h-32-runner-rehydrate-c586125ab-on-8fb4474e9. TREE 577909d0cc5a67d24351a94eb6c7dea22857a5ff = c586125ab^{tree}; config BASE 8fb4474e9, HEADSHA c586125ab, SKIP=0 GATE_APPROVED=0 PG_HOOK=0; expected-main ea41e0e9a9bb5462 = W4H-33's OK'd file (the 3 paths); base empty (0 bytes); hook-mapped 18061787cb2a51f4 (13 lines) maps all 11 changed test files plus tests of changed sources: 13 > cap 12 needs team-lead's list-bound word (EZ_PRECOMMIT_TEST_MAX=13); red-on-base 3068aa4426a6546b and warn-cases fb65fa8bfc84feab = round 1; commit-locked.sh fa5e0c998cfc9b86, launch.sh 077622234240cbb4, hold-own-pg.sh 463ba0ff513c69e9: diffs vs round 1 = folder and comments only; extra-legs.sh 37b3a2edad9d5eda = round 1 + comments + the storage-secrets-dir leg (asserts heavy-lib's export, line 12 of heavy-lib e9ab2c05a91d7a45); hold-launch-line e628771b16a7e561. Tasks b67: tasks-locked.sh 8c40c2aeeaf89be0 diff vs 04c4e6cc863919cf = header, folder, EXPECT_HEAD placeholder (refuses), V10_HASH b13932a2fe026edf; launch-tasks.sh 1186e98681685f09 = folder and label; dry lessons.md 8f52d5705f1685a0 = my own two-block dry run (byte-equal). Named: v10 b13932a2fe026edf, extract-blocks.py 89e0cc52a22a7bc2 (my part-7 OK). Open: the hosted-lane forms (my new lesson): the hold has no isolated bundle-build leg; W4H-32 changes the runner restore path the production proofs exercise; this is team-lead's pending ruling on hold additions.
- Round-2 COMMIT OK (2026-10-16T22:59:09Z): 7de009ec4ec25794b5ee93b45710eb79bc4b2614, detached, worktree clean, integ/w00 still 8fb4474e9 (labelled reads). Parents 8fb4474e9 + c586125ab; tree 577909d0cc5a = the prep TREE; <USER> noreply; raw message 10104ff4520fd189 = commit-msg.txt; hook-mapped-staged.txt 18061787cb2a51f4 = the 13-line list (cmp); hook 13 bun files 97 pass 0 fail (EZ_PRECOMMIT_TEST_MAX=13, team-lead's word); FAST DONE status=0; commit.exit 0; all 10 integrator hashes equal. This OK names the merge 7de009ec4 and triggers the hold, which launches on team-lead's word.
- Ruled (2026-10-16T22:59:37Z, team-lead): the W4H-32 hold waits for hold leg (a), the isolated bundle build with package tests as the hosted ai-kit job runs it, built by the integrator red first (red at 8fb4474e9 on W4H-33's deployed-preconditions test; a deleted package test as the mutant), my OK by hash, then added to this folder's extra-legs.sh (its hash then changes from 37b3a2edad9d5eda: re-check). Lock order: W4H-35 run 4 (driver eafef8b4112bdc8d, preflight re-run with own-pg installed) before the hold. My check of leg (a): it reproduces the hosted job's build form (the job's own script and environment), red at 8fb4474e9 with the hosted diagnostic, the mutant caught, and green expectation stated for 7de009ec4 (which still carries W4H-33's D1: the leg will be RED at the W4H-32 hold unless W4H-33b lands first or the leg is ruled informational for this hold).
- Ruled (2026-10-16T23:02:34Z, team-lead): leg (a) at the W4H-32 hold = option 1, binding, with an exact expected-red set expected-bundle-findings.txt naming only ai-kit build_failed with the D1 diagnostic; every other bundle green; any other failure red; the leg's red-first proof plus an exact-match case (expected present and matched -> leg passes; expected missing -> red; another failure -> red). My OK by hash of the leg and the expected file, plus the end of W4H-35 run 4, pre-authorize the hold. After the W4H-32 publish: W4H-34's rebase job (EXPECT_JOB=6e79832ceb38860a) first, then W4H-33b's lock legs.
- followup5f pre-read OK (2026-10-16T23:03:06Z; not a naming: tokens open): w00/wave4i/followup5f-pr-body-draft.md dfff56932ca81e7d from followup5e df3112999b290212 (40 diff lines). Tokens: <PENDING-HOLD> x2, <PENDING-PUBLISH>, <PENDING-RECEIPTS>, <PENDING-TASKS>, <HOSTED-COMPARISON-6>; '@' 0; identity clean; secret sweep 0. W4H-32 facts equal my records (ACCEPT 6213480c1c43dbfb; 15 commits; T1c patch-id equal 14bf5dbe46efc28a, kills the mutant 7/1; 0 stops report mode; 15/0; 32/0; binding PASSED; mock pass PASSED 7 steps; merge 7de009ec4, tree 577909d0c, 32 files, hook 13; tools 3ec27ab6246a68c7, e3919a185e9386f0, 1aef0877016775f0, 6c0708a0d6fe474a). Naming comes on the FINAL line after the fills.
- Publish chain rule (2026-10-16T23:03:22Z, team-lead): my hold judgment OK naming 7de009ec4ec25794b5ee93b45710eb79bc4b2614 (plain green, or green with only leg (a)'s ruled expected-red set matched) pre-authorizes publish 8fb4474e9 -> 7de009ec4, receipts, tasks blocks 6+7; I send it to integrator-5 and team-lead with the verdict file and hash. Anything else (a union, another expected red) and the chain waits for team-lead's word. Then my three reads and the followup5f naming before push16.
- Leg (a) OK (2026-10-17T01:09:29Z): bundle-build-leg.ts.new c42d415c90f85b4f, bundle-build-leg.test.sh.new 5b81c13a2587a05d, the W4H-32 folder's expected-bundle-findings.txt.new aa5fbef2a563aa66, proof scripts proof-judge.sh 24d5caa92bb83ad4, proof-judge.test.sh 04c4fea813587cb2, proof.sh b50586f8c646e27f, proof2.sh 8552e50de50dde2a, launch-proof2.sh 383c7981babe86cf. Proof: p1 d52fa78a1a4a8252 (ai-kit RED, hosted text, matched), p2b 9a2917cbc3115bb5 (390c49a90 prepared with pinned Bun: install rc 0, build:packages rc 0, sdk dist present; ai-kit succeeded, 0 red), p3b 9d60b2c6d28f8ca8 (tests removed: ai-kit FAILED code tests_missing, stage test), p4 cd1eebf2b4e871ac (28 = hosted list, 27 built, ai-kit matched, 0 red); proof-judge.out c7b0bd27fc11f515 '4 of 4 PASS'; proof2.exit holds 0 (9a271f2a916b0b6e), equal to the judge's result; scratch removed. Install: the leg and its test by mv to w00/bundle-build-leg.ts and .test.sh; the expected file by mv to expected-bundle-findings.txt in the W4H-32 folder; the W4H-32 folder's extra-legs.sh (37b3a2edad9d5eda) may change ONLY by a named copy plus the one leg line 'NOTEST=1 file_leg bundle-build src/__tests__/helpers/first-party-release.ts bun evidence/w00/bundle-build-leg.ts --expected "$D/expected-bundle-findings.txt"' and comments; the integrator reports the installed hashes and that diff at the hold launch.
- Hold launched and inputs verified (2026-10-17T01:11:39Z): w00/bundle-build-leg.ts c42d415c90f85b4f, .test.sh 5b81c13a2587a05d (no .new left); expected-bundle-findings.txt aa5fbef2a563aa66; extra-legs.sh 3c31cb24cbedf47c = v1 37b3a2edad9d5eda + 2 comment lines + the exact OK'd leg line (diff read); gated-flock w4h-32-hold running (pid <PID>), launched 01:10:53Z at 7de009ec4. Hold judgment checks: the tool header (own-pg 1aef0877016775f0, bundle-build-leg c42d415c90f85b4f, hold-w4f d3dacb9697e7bb0d, case-web-junit 247e29a17ea48697), storage-secrets-dir leg, graph mock pass PASSED, bundle-build = ai-kit EXPECTED matched + 27 built + 0 red, expected sets, web-bunleg-changed none (no web bun-pool file changed).
- Push ruling (2026-10-17T01:15:59Z, team-lead): push16 to PR 341 only after the W4H-33b publish chain (merge, receipts, tasks) is on integ/w00, carrying W4H-32 and W4H-33b together. followup5f gets two pre-authorized fill versions (W4H-32 tokens after its chain; W4H-33b tokens after its chain; hosted tokens stay open), each with a FINAL line; I name the FINAL version before push16 (re-hashed at naming); my reads of both publish chains come as each lands. No push word before that.
- Route A form verified (2026-10-17T01:47:40Z; fieldcov/field4.test.ts with the pinned Bun 1.4.2, coverageSkipTestFiles=false): 'declare builds?: number;' (not instrumented) and the count set in the overridden build(): every instrumented line hit, no DA 0. If team-lead rules A, the owner's new head must keep the assertion of 0 builds on the restore path and add none of the derived-class initializer or constructor code.
- d480718342a8d56dba72482ccd6351c35f98ef38 reviewed (2026-10-17T01:53:14Z): one commit on 13c439661 (route A: 'declare builds?: number', the count set in build(), asserts on '?? 0'); fix52/declare-hashes.txt 7 lines equal. NOT taken: route A is not needed (fieldcov/field5: the guard case already credits line 52), and its new code comment states my disproven claim as fact ('Bun 1.4.2 does not attribute those in a class that extends an imported base'). The named head stays 13c439661d3d1a414b0669943f29fa151267838f (ACCEPT, verdict-w4h-32.txt 2a01aa6138258b52). If team-lead prefers the declare form, the comment must be corrected (the line is credited once a method runs) at a new head.
- Head confirmed by team-lead (2026-10-17T01:55:15Z): 13c439661d3d1a414b0669943f29fa151267838f (my re-ACCEPT 2a01aa6138258b52 already sent). The branch ref wp/w4h-32-runner-rehydrate = d480718342a8d56dba72482ccd6351c35f98ef38 (route A on top); prep.sh merges wp/... unless PREP_REF is set: the re-merge prep must use PREP_REF=13c439661... and its config HEADSHA must equal it (refuse otherwise). Team-lead's narrow lesson recorded: a DA 0 on a test-class member line means no method of the class ran; the fix is a case that exercises the class; read the hold's lcov line first.

== 2026-10-17T03:53:05Z W4H-32 re-merge PREP INPUTS OK by hash (folder w4h-32-runner-rehydrate-13c439661-on-e8d996d72); the commit waits for the list-bound word, and the hold waits for its inputs and v6
- config.sh c8301c7a80c53202: BRANCH = HEADSHA = 13c439661d3d1a414b0669943f29fa151267838f (my ACCEPT), BASE e8d996d72, TREE 2a450a18496e553862dec1e07df0310abd4abdfd = my own git merge-tree (32 files, +1065 -59). The merge-base is 8fb4474e9.
- Identity: commits 8fb4474e9..13c439661 17 clean (154fe6d74dddba89). Team-lead guard: MY run of identity-check files over the 32 staged files (the diff e8d996d72..TREE, the blobs from TREE): "32 file(s), clean". The 3 D5 files in TREE are equal to the e8d996d72 blobs. The try1 records are kept (e09f80ca8bf42060, a37f10a394b8fbfd).
- Lists byte-equal to the c586125ab folder: unit e2e57bc54a3d3c56, pg d3cf439905f2b2c1, red-first b3765fc511e452a9, warn-cases fb65fa8bfc84feab, whole/case-extra 175361586868a087, focused, hook-mapped 18061787cb2a51f4 (13 lines > cap 12: STOP; the commit waits for the team-lead list-bound word).
- Inputs: commit-msg 0528edd3fc3fc583, launch c955232d5fcc3e85, commit-locked 7b07aa54025c2431, hold-own-pg 463ba0ff513c69e9, expected-main ea41e0e9a9bb5462, expected-base (expected-integ-findings-vs-base.txt) EMPTY, red-on-base 3068aa4426a6546b, importers 80b8ff29c7b7e640, reprep.out 88b1ac5388e6e028, prep-line c6c8639b6d35d24b, summary 6b5bf711e1cefce2.
- NOT YET OK (team-lead ruled the new form): expected-bundle-findings.txt aa5fbef2a563aa66 (must be EMPTY; the old one kept as a named copy) and extra-legs.sh 3c31cb24cbedf47c (must be (a) on the EMPTY set + (c) + (d) in the W4H-33b v4 form, with no price-chart line). Leg (b) runs through hold-w4f.sh with v6 installed and checked by me.

== 2026-10-17T03:54:06Z team-lead list-bound word for the W4H-32 re-merge commit: the full-run hook form with EZ_PRECOMMIT_TEST_MAX=13, bound to hook-mapped-13c439661.txt 18061787cb2a51f4, PG_HOOK as needed, in the lock. My read of the commit: the hook runs all 13 mapped files and passes (count the ran files in the commit log against the list); the merge is 13c439661 onto e8d996d72; the tree is 2a450a18496e553862dec1e07df0310abd4abdfd; rerere is off; <USER> noreply; the parents are e8d996d72 and 13c439661. The hold inputs (the EMPTY bundle set; extra-legs (a) on EMPTY + (c) + (d), no price-chart) come as named copies for my OK by hash. The hold also waits for my v6 install check.

== 2026-10-17T03:57:51Z W4H-32 HOLD INPUTS OK by hash: expected-bundle-findings.txt e3b0c44298fc1c14 (EMPTY; copy .v1-aikit-d1 aa5fbef2a563aa66) and extra-legs.sh f313843699e4c2fb (copy .v1-a-only 3c31cb24cbedf47c = byte-equal to the c586125ab folder extra-legs.sh). The code diff against v1 = exactly the (c) mutation-lane line and the D4 block (PIMG, preview-image, preview-isolation-proof, preview-hosted-conmon, preview-image-rm). The 7 (a)/(c)/(d) leg lines are byte-equal to the W4H-33b v4 f8dd7edf208a938e. No price-chart text; bash -n is clean. Non-blocking: the header comment says "15 commits incl. the mock-pass fix 788a514c8" (the c586125ab-round wording, pre-rebase sha); the head 13c439661 has 17 commits and Fix B is 21643286f. Comment only; fix it when the file next changes.
Commit try1 REFUSED at the commit.sh identity (content e8d996d72..13c439661 reads the head side of the 3 D5 files: W4H-32 never changed them, but the range diff includes them because W4H-33b changed them on the base). I confirm: the range diff names 2 of the 3 D5 paths. My staged-files check (32 files, clean) is the right side. The route belongs to team-lead.

== 2026-10-17T03:58:59Z team-lead ruling: the commit.sh identity base is the merge-base (shared tool fix; I judge the red first and the install by hash)
- The fix: IDBASE=$(git merge-base "$BASE" "$HEADSHA") for both identity checks (lines 25 and 27); no config knob; nothing else changes. The staged-tree check stays in the prep (mine: 32 clean).
- Red first in a hermetic scratch repo: (a) a branch forked before a base fixture fix, not touching that file, re-merged onto the moved base: the old form refuses and the new form passes; (b) a branch that adds a non-reserved address: both forms refuse; (c) the W-SYNC shape (base = integ, head = main) still checks the main commits since the last sync. Mutant IDBASE->BASE is caught by (a). The test defaults to the INSTALLED file.
- Install: commit.sh.new, mv only on my OK of the exact hash, named backup of the current commit.sh (now 22db59d4e7eb94e0). Then commit try2 under the same list-bound word (13, 18061787cb2a51f4). The try1 records go to .try1 by mv with hashes reported before the move (I check the move record). My commit read adds: the identity records name base 8fb4474e9.
- Order on the lock: legs-b6-proof first. The commit.sh fix report deadline is 04:45Z; v6 is 05:00Z.

== 2026-10-17T04:01:31Z team-lead FULL ruling R1 (replaces the merge-base-only ruling; R2 closed): the merge identity gate
1. Package mode: identity-check.sh commits over merge-base(BASE,HEADSHA)..HEADSHA (author and committer). Both modes: identity-check.sh files over the STAGED files of the merge, blobs from TREE (the authoritative gate). The content-over-range check goes.
2. The mode comes from the explicit config IDENTITY_MODE=package|sync, written by the prep (package for a wp head or a PREP_REF sha; sync for W-SYNC), default package. The BRANCH-string heuristic goes.
3. One implementation: a sourced lib under detached-merge/, called by commit.sh and reprep.sh. identity-check.sh is unchanged (the config baseline stays).
4. I judge: red first (a) moved base, an untouched old file in the range: old refuses, new passes; (b) a branch brings an old fixture line back into a staged file: refused; (c) package mode, a non-noreply author or committer: refused; (d) sync mode: no per-commit check, and the staged check runs. Mutants: range check restored (caught by a), staged check dropped (b), commits check dropped (c). The tests default to the INSTALLED files. Install only on my OK of the exact hashes, with named backups (the commit.sh backup carries 22db59d4e7eb94e0; also back up reprep.sh, hashed before).
My extra checks: the staged list = git diff --name-only --diff-filter=d BASE TREE (the deletions are excluded, as in my check); the blobs come from TREE, not from the worktree; IDENTITY_MODE is unset gives package and an unknown value gives a refusal by name; the lib leaves no temp dir; the lib writes records only under D.
5. After the install: the prep identity records are regenerated in the new form for my re-read; then commit try2 (13-line bound); my commit read checks the fork point 8fb4474e9 in the commits record, plus the staged-files record.
Deadline: the install report by 04:45Z.
== 2026-10-17T04:01:48Z Baseline hashes before the identity-gate fix: detached-merge/commit.sh 22db59d4e7eb94e0; integrator-5/reprep.sh 33cc8d99e2ff9a93 (reprep lives in integrator-5/, not in detached-merge/). A staged detached-merge/commit.sh.new 37ebe922c3ab6751 already exists (likely the merge-base-only form): it must not be installed; the R1 set names its own .new hash.

== 2026-10-17T04:02:36Z commit.sh fix set (commit.sh.new 37ebe922c3ab6751, test eda8e1151bb36b73): REFUSED as superseded. It is the merge-base-only form (IDBASE in the old commits/content calls, BRANCH heuristic kept, no staged-files check, no IDENTITY_MODE, no shared lib, reprep.sh untouched). The R1 ruling replaced that form before this set was sent; the messages crossed. Reusable parts: the hermetic test harness (a scratch repo, the fixture built at run time, the installed default with a "commit.sh <path> <hash>" line) and case (a).

== 2026-10-17T04:07:13Z R1 identity set CODE + INSTALL OK by hash: merge-identity-lib.sh.new 8751666e5039ccd8, commit.sh.new 4ddb024d26d26585, reprep.sh.new 096be4dfedd41cc1, merge-identity.test.sh.new 43cddfd734d8414e; identity-check.sh ef09124c9d7360ed unchanged.
Read: lib (commits from git merge-base BASE HEADSHA, the record names the fork point; staged list = diff --name-only --diff-filter=d BASE TREE, blobs by git show TREE:path into mktemp -d, rm -rf before return; mode package|sync, unset = package, other = REFUSED rc 2; records only under D with a prefix). commit.sh: the BRANCH heuristic is replaced by one marked call; the staged tree is later proven equal to TREE (line 46), so the TREE blobs are what lands. reprep.sh: step 1 commits from the fork point; after prep, IDENTITY_MODE=package appended and the staged check on the trial T (STOP on a finding).
My runs: staged set (paths explicit) 18/0; defaults name the INSTALLED files and give 3/15 (the correct red; the lib is not installed yet); 0 /tmp/merge-identity.* left. Mutants 4/4 caught (range-restored 15/3, staged-dropped 14/4, commits-dropped 14/4, mode-unvalidated 17/1).
Install: mv the lib .new to merge-identity-lib.sh (new file); commit.sh.new to commit.sh after a named backup (22db59d4e7eb94e0); reprep.sh.new to reprep.sh after a named backup (33cc8d99e2ff9a93); test.new to test. My install check: the hashes, no .new, the default test run 18/0.
For team-lead (not W4H-32): sync mode uses identity-check files without the SYNC_BASE_MAIN skip; the next W-SYNC whose merge carries main-own non-reserved fixture lines would be refused. This needs a ruling before the next W-SYNC.

== 2026-10-17T04:08:16Z R1 INSTALL CHECK OK: merge-identity-lib.sh 8751666e5039ccd8, merge-identity.test.sh 43cddfd734d8414e, commit.sh 4ddb024d26d26585 (backup .bak-20261017-pre-r1-22db59d4 = 22db59d4e7eb94e0), integrator-5/reprep.sh 096be4dfedd41cc1 (backup .bak-20261017-pre-r1-33cc8d99 = 33cc8d99e2ff9a93); no .new left; my no-argument run names the installed files and gives 18/0; no /tmp/merge-identity.* left.
TIMING FACT: team-lead added the sync-mode MAIN-OWN ruling ("so the tool changes once") after my install OK (about 04:06Z) and after the install itself (found installed at 04:07:50Z). So MAIN-OWN is a SECOND change. It touches the sync path only; W4H-32 is package mode, and the installed R1 is correct for it. My proposal: a lib-and-test-only change, with the package path byte-identical (diff check), case (e), mutant (4), before the next W-SYNC. That is for the team-lead decision.

== 2026-10-17T04:08:50Z R1 INSTALL hashes confirmed again (the integrator list = my check). PREP RE-READ OK + COMMIT TRY2 OK by hash (folder w4h-32-runner-rehydrate-13c439661-on-e8d996d72):
config.sh 10fedfb311de98f3 = the OKed c8301c7a80c53202 + exactly "IDENTITY_MODE=package"; prep-identity-base.txt dad8931798c13aec names fork 8fb4474e993a381ee9bc68b70cd16e4d95586550; prep-identity-commits.txt 154fe6d74dddba89 "17 commit(s) checked, clean"; prep-identity-staged-list.txt 4545aed76f9f5dc3 = my own git diff --name-only --diff-filter=d e8d996d72 TREE (32); prep-identity-staged.txt ef71ba0b410bc523 "32 file(s), clean"; regen log 9be4bc67031b99db. The try1 records under .try1 equal the hashes sent before the move (commit.try1.exit 4355a46b19d348dc, .out 098aa1ef217c0093, gate 748d412abb493942, identity 777aebc0d90a332d, lock 03c20dff42a49844). Unchanged inputs: commit-locked.sh 7b07aa54025c2431 (EZ_PRECOMMIT_TEST_MAX = the count of LIST), launch c955232d5fcc3e85, commit-msg 0528edd3fc3fc583, hook list 18061787cb2a51f4 (13), PG_HOOK=0. integ/w00 = e8d996d72, clean. No /tmp/merge-identity.* left.
Commit read (after try2): parents e8d996d72 + 13c439661; tree 2a450a18496e553862dec1e07df0310abd4abdfd; <USER> noreply; rerere off; the hook ran all 13 mapped files and passed; commit-identity-base.txt names 8fb4474e9; commit-identity-commits 17 clean; commit-identity-staged 32 clean; commit.exit 0.

== 2026-10-17T04:15:32Z W4H-32 COMMIT READ OK: merge ba9acd166ed4711b9c2523fc6071485ebcdcbe78; tree 2a450a18496e553862dec1e07df0310abd4abdfd = TREE; parents e8d996d72 + 13c439661; author and committer <USER> noreply; rerere off (commit.sh line 38); HEAD = detached ba9acd166, clean; integ/w00 still e8d996d72. Hook: EZ_PRECOMMIT_TEST_MAX=13; hook-mapped-staged = the list 18061787cb2a51f4 (13 lines); commit.log has 13 bun runs, 0 fail (12,6,1,10,9,15,15,8,3,1,1,6,11 pass); fast.exit 0; commit.exit 0. R1 identity: identity-check.txt cbef7091b9b1a173 "merge-identity (package): commits clean, staged files clean"; commit-identity-base dad8931798c13aec names fork 8fb4474e9; commits 154fe6d74dddba89 17 clean; staged list 4545aed76f9f5dc3 (= staged-files.txt) and staged ef71ba0b410bc523 32 clean, byte-equal to the prep records. All 15 record hashes match. The W4H-32 hold may launch: inputs OK (expected-bundle EMPTY, extra-legs f313843699e4c2fb, expected-main ea41e0e9a9bb5462, base EMPTY), with leg (b) v6 through hold-w4f.sh c0edd64bd3b7da9c.

== 2026-10-17T05:00:58Z READ 1 (W4H-32 publish) OK: integ/w00 = HEAD = ba9acd166ed4711b9c2523fc6071485ebcdcbe78 (was e8d996d72), on branch integ/w00, clean; origin/main 934531e2e = expected; 18 new commits, author and committer all <USER> noreply (36/36); publish.out 917d0d0c803bce3c, identity-publish.txt 34a700ac33203883 ("18 commit(s) checked, clean"); merge.json d4c32eb43c825b16 (valid JSON; names my hold OK and verdict b135ee6d9c1b22c0). Receipts inputs noted: sources a05263bd12c2aed0 (279), identity 8d1f8c573b3888c9 (279 clean), msg 6904fee75ef5b715, launcher aad0b74a70778d1c. Read 2 follows the receipts commit.

== 2026-10-17T05:03:56Z READ 2 (W4H-32 receipts) OK: integ/w00 = HEAD = ba592b4ec99963c036943d25ab3b766dcfaab43e, parent ba9acd166, <USER> noreply, clean; 279 A + 1 M (SHA256SUMS +279, 0 removed); each of the 279 committed files is byte-equal to its source in a05263bd12c2aed0, and its sha256 is in SHA256SUMS; receipts.exit 9a271f2a916b0b6e = 0; the 7 records as sent.
TASKS (block 7) DRY RUN + scripts OK by hash: docs-draft-v10.at-dry.md e35d757e5703075b = the named v10; dry: lessons +19 after line 2445 of ba592b4ec, 0 removed, the added text = block 7 f3a6886b168fc032 (except blank lines); todo 1713fe975c3c3aff = integ; dry2 refuses "already applied". Facts at ba592b4ec: 21643286f and 8fb4474e9 are ancestors. tasks-locked.sh a95bf0dde8aa36a4 (diff 0d5cbacd347cef54: header, path, EXPECT_HEAD ba592b4ec, V10_HASH e35d757e5703075b, dry dir), launch-tasks.sh 541bf61bf151a6ed (diff b3bbd65751f9d6f4: label and path), tasks-msg.txt 7e1e8151c3b5bc2a (Fix B 21643286f, 788a514c8 only as "before the rebase"; v1/v2 kept).

== 2026-10-17T05:05:52Z READ 3 (W4H-32 tasks, block 7) OK: integ/w00 = HEAD = 39baed85a154e8934848ff56afd53a486b98b127, parent ba592b4ec, <USER> noreply, clean; tasks/lessons.md +19 and 0 removed, nothing else; lessons and todo byte-equal to dry/ (b98f3824ebc17862, 1713fe975c3c3aff); before-lessons 1aa3c3ec34e922af = the ba592b4ec lessons; the message equals tasks-msg.txt 7e1e8151c3b5bc2a apart from blank lines; tasks.exit 0; 8 records as sent. THE W4H-32 CHAIN IS COMPLETE: merge ba9acd166, publish 04:59:28Z, receipts ba592b4ec, tasks 39baed85a. Next: the followup5f version with the W4H-32 tokens filled (my naming), then the push16 staging (my OK by hash).
