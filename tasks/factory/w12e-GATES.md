# W12e — upgrade the pinned Bun from 1.3.14 to 1.4.2

Owner: w12e-2 (from w15b-fix). User decision 2026-09-28 ~15:00Z: "upgrade it and continue the rest of the work with
opus 5.5 sub agents". W12e lands last in the wave 4 queue, after W02d and before the wave4f combined run.
Evidence: /tmp/factory-platform-evidence/w12e-2/ (the earlier attempts: w12e/, w12e-rebased/).

## Branch

Scratch branch wp/w12e-scratch off integ/w00 e92d34d45. After "W02d landed" the two commits move to the final integ
head with the same patch-ids.

1. The resolved cherry-pick of 2aa24b5b3 (the pin and the Bun.sql request-queue acceptance test). Two conflicts, no
   code conflict: .github/workflows/db-postgres.yml keeps both new steps (W09f's pool replacement first, then the
   request-queue step), and compose.factory-platform.local.yml stays deleted (7f20fcc27 moved its services to
   deploy/factory/compose/platform.yml, which gets the same authorizer digest change).
2. The pinned-toolchain helper and every pin consumer the first commit missed (G5).

## Gates

- [x] G1: the acceptance regression is red on Bun 1.3.14 and green on Bun 1.4.2 in the product's configuration
  (auto-pipelining off at process start; see "Bun.SQL on 1.4.2" below). REOPENED 2026-09-30: with pipelining on,
  1.4.2 still fails about 1 trial in 300; the first result below was 3 of 3 runs, too few to see it.
  CHECK: tests/postgres/bun-sql-request-queue.test.ts on real PostgreSQL, once with each Bun, same tree.
  EXPECT: 1.3.14 fails; 1.4.2 passes 3 of 3. EVIDENCE: w12e-2/logs/g1-*.log and commit-and-g1.run.log. RESULT at
  d503d22c8, 2026-09-28 18:37-18:39Z: 1.3.14 exit 1 (0 pass, 2 fail); 1.4.2 exit 0 three times (2 pass, 0 fail).
  PROVEN (2026-10-01): red on Bun 1.3.14 by the defect itself (validator-6's hold at 8676d8757, standing for 4d0c708c5:
  both trials "stall", 2 fail) and green on 1.4.2 in the product's configuration: the wave4f pgStep
  bun-sql-request-queue green with flag=1 at baeade976 (receipts 700e54461).
- [x] G2: the preview-server crash seen under 1.4.2 (ERR_STREAM_WRITE_AFTER_END, factory-live-console e2e) is
  reproduced end to end at the head and fixed at its root, or refuted with the runs that refute it.
  CHECK: the factory-live-console Playwright lane under 1.4.2 (bun and bunx asserted), repeated.
  EXPECT: no crash in every run after the fix (or in every run, if refuted). EVIDENCE: w12e-2/logs/g2-*.log. RESULT
  (see "G2" below): red at d503d22c8 (the pipelined client killed the real preview); at 99278bee9 the lane ran
  66/66 twice with 0 crashes, and the pipelined client got 20/20 answered with the server up
  (c3-commit-and-g2.run.log, g2-preview-head-guarded.log).
- [x] G3: the full runner and the browser set are green under 1.4.2 at the head.
  CHECK: w00/combined-integration.py --repo <worktree> --prefix w12e-scratch --podman --auto-extra-base <base>
  --legs-manifest scripts/combined-runner-legs.json (LOCK_LANE=w15b-fix), plus the browser lanes after
  w18c/heavy/final-browser.sh. EXPECT: every leg green; every red root-caused and fixed red-first here.
  EVIDENCE: w12e-2/runner/, w12e-2/browser/
  INTERIM (lead ruling 2026-09-28): the scratch runner at db441b977 ended 19:48:01Z with rc 1. 25 legs exited 0;
  node-coverage exited 97 (zero count), so the runner blocked the coverage merge and gates by design. The cause is
  not W12e's: at base e92d34d45 the node/orchestrator coverage producer prints no totals to stdout (they go to
  test-progress.log), and W18c's f77a3c112 fixes the producer. W12e is not changed for it and it is not rerun here.
  AUTHORITATIVE (2026-10-01): wave4f at baeade976, the final head after W12e and W4F landed: the runner's 37 legs clean
  and the browser lanes green (1449/393/7/107/13), then the final gates green (receipts 700e54461).
- [x] G4: the coverage defect is re-probed under 1.4.2: the attested line of src/factory/task-stops.ts is still
  uncredited (a function's last statement is credited to the line before), and the attestation's Bun field is
  refreshed. CHECK: the W03g probe under 1.4.2. EXPECT: DA 0 on the attested line with the line proven executed.
  EVIDENCE: w12e-2/logs/g4-*.log, w12e-2/g4/logs/head-f089f0e1c/. Approved path: w00/w12e-merge/gate-change-decision.txt (amended, sha256 2edacc8f78a35287…).
  RESULT at the rebased head f089f0e1c (base integ 0c66519a0; task-stops.ts sha256 1b54655f…, unchanged, line 336):
  - Red: the gate's attestation evaluation fails "stale attestation src/factory/task-stops.ts:336: proved on Bun
    1.3.14, but .bun-version is 1.4.2" (logs/g4-red-stale-check.log). attestation-check.py fails only on bunVersion
    (logs/g4-red-attestation-check.log).
  - Re-probe under Bun 1.4.2 (bun and bunx asserted): the stop suite reads DA 335 = 176, DA 336 = 0 on PGlite and
    on PostgreSQL, 52/0 each. The throw planted on line 336 fails 37 of 52 on both. So 1.4.2 still executes the
    line without crediting it; the entry stays, refreshed (bunVersion 1.4.2, reason, proof paths).
  - Green: the same evaluation shows no finding (logs/g4-green-stale-check.log). The patch-gate red/green pair and
    attestation-check.py run at the final head with the merged lcov.
- [x] G5: every pin consumer names 1.4.2. CHECK: `git grep -n 'e10577f0db68\|bun-1\.3\.14\|oven/bun:1\.3\.14'` on — verified at integ 1992630f3: the CHECK's git grep finds 10 lines, all history kept on purpose (comments and gate records of what ran on 1.3.14, e.g. podman.ts:22, deploy/extension-runner/README.md:49); every live pin names 1.4.2; W12e merge e6cdcf02a; wave4h run 3 on Bun 1.4.2 (verified 2026-10-03, leftover audit).
  live files (docs of past measurements excluded by name). EXPECT: no live consumer left. EVIDENCE: the list below.

## G5: pin consumers

| Consumer | Commit |
|---|---|
| .bun-version (read by setup-bun in every workflow through bun-version-file) | 1 |
| Dockerfile (builder, slim runtime, both by index digest), Dockerfile.dev, Dockerfile.test | 1 |
| packages/@ezcorp/extension-runner/src/podman.ts DEFAULT_IMAGE (1.4.2 index) | 1 |
| deploy/extension-runner/README.md pre-pull digest | 1 |
| deploy/factory/compose/platform.yml authorizer image (was the deleted compose file) | 1 |
| @types/bun in packages/@ezcorp/factory-sdk/package.json and bun.lock | 1 |
| .github/workflows/db-postgres.yml request-queue step | 1 |
| deploy/factory/Dockerfile BUN_IMAGE and BUN_RUNTIME_IMAGE (linux/amd64 manifests of 1.4.2 and 1.4.2-slim) | 2 |
| packages/@ezcorp/sdk/src/v4/mcp.test.ts runner digest | 2 |
| scripts/lib/pinned-bun.sh (tool directory from .bun-version, bun and bunx both asserted; refuses a missing source path; refuses a missing bunx, commit 4) | 2, 4 |
| scripts/build-factory-image-guest.sh, scripts/factory-graph-proof/run.sh, scripts/run-factory-postgres-suite.sh | 2 |
| tests/postgres/factory-pool-mtls.test.ts, factory-pool-process.test.ts (tests/postgres/helpers/pinned-bun.ts) | 2 |
| README.md, docs/factory-deployment.md, docs/factory-graph-proof.md, docs/factory-pool-process.md, docs/features/platform/dev-lifecycle-and-gates.md, docs/macos-local-dev.md | 2 |
| .github/dependabot.yml and .github/workflows/ci.yml pin comments | 2 |

Outside the tree: /tmp/factory-tools/bun-1.4.2/bun-linux-x64 (bun sha256 checked against SHASUMS256.txt; bunx link
provisioned, see "Provisioning the pinned Bun" below),
docker.io/oven/bun@sha256:9114c058…6895 pulled on this host, and the w00 rule that derives every lane's PATH from
.bun-version.

Kept on purpose: comments and gate records that say what was measured on 1.3.14 (they are history, not pins).

## Provisioning the pinned Bun (once per host, before any repository script)

1. Download bun-v<.bun-version>/bun-linux-x64.zip and SHASUMS256.txt from the Bun release. Check the zip's sha256
   against SHASUMS256.txt, then unpack it into /tmp/factory-tools/bun-<.bun-version>/.
2. Add the link Bun's installer would add: `ln -s bun /tmp/factory-tools/bun-<.bun-version>/bun-linux-x64/bunx`.
3. Check: `bun --version` and `bunx --version` from that directory both print the pin.

scripts/lib/pinned-bun.sh never writes into this shared, hash-verified directory. A missing bunx is refused by
name ("pinned bunx missing at <path>; provision it"), and the lane stops. The same steps are in
docs/factory-graph-proof.md ("Before you start").

## Findings

- F1 (fixed in commit 2, red first): scripts/lib/pinned-bun.sh took the repository root from BASH_SOURCE. Sourced
  from zsh (or eval'd), that is empty or "bash", so the root became "$PWD/../..": from a worktree under .worktrees/
  that is the main checkout, whose .bun-version (1.3.14) then passed the assertion. The install that ran this way
  was void and was rerun under bash. The helper now refuses without its own path. Red 6/1, green 7/0
  (w12e-2/logs/pinned-bun-red.log, pinned-bun-green.log).

## G2: the preview-server crash under Bun 1.4.2 (upstream defect, proven workaround)

- Defect: oven-sh/bun#40350, a regression that began in Bun 1.4.0. Bun's node:http queues a pipelined response behind the one
  in flight. When that one finishes, advanceResponsePipeline replays the queued writes through the public
  `res.write` / `res.end`. vite preview's compression middleware (@polka/compression, bundled in vite 8.3.0) has
  patched those to feed a gzip stream that already ended. The replay throws ERR_STREAM_WRITE_AFTER_END
  uncaught and the server exits, or the queued response never finishes. The upstream fix, oven-sh/bun#43557
  (5d5f03ff4), merged 2026-09-26, 418 commits after bun-v1.4.2. No release carries it.
- Reproduction (Bun 1.4.2, no Playwright): our real vite preview (web build under 1.4.2) died on the first
  pipelined round with W09e's stack. Receipts: w12e-2/logs/g2-preview-explore-142-server.log. Bun's own
  regression script crashed 2 of 3 times on 1.4.2; the third run hung. It never crashed on 1.3.14
  (w12e-2/logs/g2-upstream-*.log). At the clean pin head d503d22c8 the same client killed the real preview again
  (w12e-2/logs/g2-preview-head-d503d22c8-noguard.log and its server log). The factory-live-console Playwright lane
  at d503d22c8 did NOT crash in 2 rounds of 66 (w12e-2/logs/g2-head142-round*.log). The browser only hits the
  race sometimes; W09e saw it in 2 of 4 runs. So the deterministic red is the pipelined client, not the lane.
- Workaround: web/src/lib/build/preview-pipeline-guard.ts, a vite plugin in web/vite.config.ts. Only on the Bun
  releases in PIPELINE_REPLAY_DEFECT_BUNS, exactly 1.4.0, 1.4.1 and 1.4.2, it removes Accept-Encoding before
  vite's compression middleware sees the request. Vite runs a plugin's configurePreviewServer body before it
  installs compression, so the guard runs first. Compression then leaves res.write / res.end unpatched.
- Inert outside Bun 1.4.0-1.4.2: the test "it installs its middleware only on an affected Bun, and the middleware
  drops Accept-Encoding" (preview-pipeline-guard.test.ts) installs nothing for 1.3.14, 1.4.3 and '' (Node).
  "the default version is the running Bun" ties the default to the running Bun. The guard is removed once the
  pin moves past a Bun release that carries oven-sh/bun#43557 (see the follow-up below).
- Why preview-only: production never serves through vite. The app image runs `bun run web/build/index.js`
  (Dockerfile CMD) and the factory image `bun web/build/index.js` (deploy/factory/Dockerfile CMD). That file is
  svelte-adapter-bun's server (web/svelte.config.js), which calls `Bun.serve` (build/index.js line 22), not
  node:http. Measured: the same 20 pipelined gzip pairs against web/build/index.js under 1.4.2 were all answered
  with the right bytes and the server stayed up (w12e-2/logs/g2-production-pipeline.log).
- Red/green: preview-pipeline-guard.test.ts runs the real vite preview in a child Bun and sends two pipelined gzip
  requests at once, over fresh connections. With the guard disabled (an empty release list) it is red 1/3
  and shows W09e's stack (w12e-2/logs/g2-guard-red-noop.log). With the guard it is green 4/0, 6 times in a row
  (w12e-2/logs/g2-guard-green-dev.log). The commit hook's run is the committed green.

## Follow-up

- [ ] Remove the Bun.SQL pipelining guard when a Bun release carries oven-sh/bun#32088 and #43187 (see "Bun.SQL on
  1.4.2"): record the release in provenClean after its 3000-trial pass, then delete the guard, its list, its tests and
  every flag setting together.

- [ ] Remove the preview pipeline guard when a Bun release carries oven-sh/bun#43557. On the bump that moves
  .bun-version to that release, preview-pipeline-guard.test.ts ("without it, this Bun leaves a pipelined pair
  unanswered exactly when the guard's release list names it") shows whether that release still fails. If it
  answers every pair, the guard is obsolete; delete the plugin, its vite.config.ts entry, its test, its
  test-file-sets entry and its threshold key together. If it still fails, the test goes red until the release
  is added to PIPELINE_REPLAY_DEFECT_BUNS.

## G4a: a minimal probe of the coverage defect (not reproduced)

A six-line probe (w12e-2/g4-probe/: an executed async method whose last statement is followed by a method that
never runs) did NOT reproduce the defect on either Bun. Both 1.3.14 and 1.4.2 credit its last statement
(w12e-2/logs/g4-probe-1.3.14.log, g4-probe-1.4.2.log). So this probe proves nothing about the defect. G4 rests on
re-probing the attested line of src/factory/task-stops.ts at the final base, once W03g and W03f are on integ.
- F2 (validator-6, fixed in commit 4, red first): scripts/lib/pinned-bun.sh created the bunx link inside the shared
  tool directory when it was missing. A repository script must not write into the shared, hash-verified
  toolchain. It now refuses by name, creates nothing, and provisioning adds the link (above). Red: with only bun
  present, the helper made the link and returned 0 (6/1, w12e-2/logs/pinned-bun-bunx-red.log). Green 7/0
  (pinned-bun-bunx-green.log).

## Bun 1.4.2 behaviour changes found at the final head (2026-09-30)

The per-head hold at 849e7e5d2 (w12e-2/final/hold.log) and a neighbouring suite found four. Each has a minimal
reproduction under 1.4.2 against 1.3.14 and a fix red first.

1. Postgres request queue (acceptance test red). On 1.4.2 with auto-pipelining on, a pipelined reply can reach the
   wrong request (a SELECT rejected with a concurrent INSERT's duplicate-key error), a connection can fail with
   "Failed to read data", or a trial can stall. Fixed by the guard below. Deciding run (w12e-2/rq-decide/, same
   database, harness v2, pool 8, 24 workers):

   | Configuration | Trials | Trials with errors | Stalls |
   |---|---|---|---|
   | (D) Bun 1.3.14 | 13 (the harness's time limit) | 0 | 13, none drains: deadlock |
   | (A) Bun 1.4.2 | 300 | 1 (response mix-up) | 0 |
   | (B) Bun 1.4.2, pipelining off at start | 300, then 3000 | 0 | 0 |
   | (C) Bun canary 1.4.3-canary.1+bf42a525d | 300 | 0 | 0 |

   (D) is why the bump is not optional: 1.3.14 deadlocks under this load. (A) is the defect the guard removes.
   (C) carries the upstream fixes oven-sh/bun#32088 (partial-write data loss and duplication) and #43187 (a
   decode failure no longer fails the whole connection); no release carries them yet. Cost of pipelining off
   (w12e-2/option3/cost-table.txt): W02d's 9 PostgreSQL suites 51.82 s on, 52.24 s off (1.01x); the harness's mean
   trial 60.4 ms on, 62.3 ms off.
2. Pinned fetch TLS name (real-auth lane). Bun 1.4 checks a fetch's certificate against the URL host, not the Host
   header; the pinned GitHub fetch failed ERR_TLS_CERT_ALTNAME_INVALID. Fixed in 9db142cbf.
3. IP literal as TLS server name (factory-services lane). Bun 1.4, like Node, refuses it with ERR_INVALID_ARG_VALUE;
   the gateway probe failed. Fixed in 47f47eccb.
4. The runtime now detaches its own abort listener for the node:https `signal` option (1.3.14 leaked it); the settle
   test's `removed === 3` encoded the leak. Fixed in afdd9cd0c (net zero, plus a mid-request abort case).

Found by the full backend pool at 5670a39c6 (below), each root-caused with a minimal repro on both Buns:

5. A paused socket surfaces a peer's FIN only once read (as in Node 24). setup-podman.test.ts's silent runner socket
   never read, so server.close() never finished (60 s timeout). Test fix 435410dfc (drain, write nothing; destroy
   accepted sockets). Likely oven-sh/bun#33974, found by title, not bisected (w12e-2/sub/setup-podman/).
6. Bun.listen now enforces rejectUnauthorized: an untrusted client certificate fails the TLS handshake, and the
   client reads zero bytes; 1.3.14 completed the handshake and the product answered 401 {"error":"unauthorized"}.
   ERROR-SURFACE CHANGE: the private service's refusal of an untrusted client certificate moves from an HTTP 401 to a
   handshake failure. No section of the interface freeze (docs/plans/2026-09-13-composable-factory-platform-interfaces.md)
   covers the private service's error surface. Acceptance is unchanged: the trusted certificate reaches the handler on
   both Buns (w12e-2/mtls/probe.out). Tests and product comment 0eb10d8f4; the handshake callback stays as defence in
   depth. The upstream change was not identified.
7. terminate() on a TLS socket sends a bare reset (oven-sh/bun#39632), reported as ECONNRESET (#39600). Test 0eb10d8f4
   accepts either close signal; zero bytes, the bound and one handler call are still asserted.
8. end() on a Bun.listen TLS socket closes only the sending side (oven-sh/bun#31155). PRODUCT fix 96eaaa3c3: the
   private listener's timer stays armed after the response, so a peer that keeps writing is cut after requestTimeoutMs.
9. Bun.Glob(...).scan()'s ENOENT message on a missing cwd no longer embeds a NUL byte (1.3.14: "...'<path>\0'", hex
   tail 74 00 27; 1.4.2: "...'<path>'", hex tail 74 27; w12e-2/nul/probe.out). Found by the whole-pool shard at
   a888a85f8: two cases of workflow-extension-loader.test.ts asserted the NUL (the Bun bug they pinned). Test-only fix:
   the cases assert the clean message (ENOENT, the path intact, no NUL) on the pinned Bun, and the product's handling of
   a missing installPath stays tested end to end (nothing discovered; the warning logged; no raw NUL on the wire; the
   exact message after JSON.parse). Green on 1.4.2 (25/0); red on 1.3.14, which still embeds the NUL.

Also found by the full pool, not Bun changes:
- Pre-existing integ red: add-factory-usage-settlements.test.ts lacked restore_digest, added by 60cf34635 (landed with
  W03f); red on 1.3.14 too. Fixed in e8018c3a1.
- Test premise: e2e-lanes.test.ts's stand-in for "another Bun" was 1.4.2, now the pin. Fixed in 4024d938e.
- Environment: this worktree lacked `bun install --cwd .github/gate-integrity-deps --frozen-lockfile --ignore-scripts`,
  so scripts/gate-integrity-rule11.test.ts could not parse; installed, rerun at the final head.

## Bun.SQL on 1.4.2: the pipelining guard

- Mechanism, measured on the wire (w12e-2/option3/probe-*.json; a proxy counts outstanding Syncs for 20 concurrent
  queries on one connection): default pipelines (20 outstanding); the flag set at process start does not (1); the
  flag written into process.env inside the process is ignored (20); the Bun.SQL option prepare: false does not (1).
  Bun 1.4.2 reads BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING once, from the start environment
  (PostgresSQLConnection::can_pipeline, bun_core env_var feature_flag cache).
- The guard (src/db/bun-sql-pipelining.ts, list in src/db/bun-sql-pipelining-defect.json): on exactly 1.4.0, 1.4.1 and
  1.4.2, Bun.SQL is refused by name unless the flag was on in the start environment (Linux: /proc/self/environ, so a
  late process.env write satisfies neither Bun nor the guard; elsewhere process.env). Every product and script
  client opens through openBunSql, or guardedBunSqlClass in src/db/connection.ts; a test fails on any other
  construction. The test preload runs the guard whenever a real PostgreSQL URL is configured.
- Where the flag is set: Dockerfile, Dockerfile.dev, Dockerfile.test and deploy/factory/Dockerfile (ENV); the
  workflows ci, db-postgres, deps-audit, mutation-nightly, release-image and release-sdk (env); scripts/lib/pinned-bun.sh
  use_pinned_bun (exports it for a listed pin, unsets it otherwise); the shared w00/bun-pin.sh does the same.
- The acceptance test is unchanged; it runs green in the product's configuration, with the flag at start.
- The list is closed upward (lead, 2026-09-30): src/db/bun-sql-pipelining-defect.json carries `affected`
  (1.4.0, 1.4.1, 1.4.2) and `provenClean` (empty today; the canary 1.4.3-canary.1+bf42a525d is evidence, not a
  version). A provenClean entry is {release, bun (version+build), record, trials, errors, stalls}; the record is the
  harness JSONL under docs/validation/factory/, and the test refuses a name alone, a missing record, fewer than 3000
  trials, any error or stall, or a record not run with pipelining on (2c5f3903e). Below 1.4.0 is outside the defect's known range. A pin at or above 1.4.0 in neither list fails
  src/db/bun-sql-pipelining.test.ts by name: "Bun <v> is neither affected nor proven clean for the request-queue defect
  (oven-sh/bun#32088, #43187): run the 3000-trial harness and record the result".
- The proof a release needs before it enters provenClean: the harness at 3000 trials, WITHOUT the flag, on the proof
  database, 0 trials with errors and 0 stalls:
  `FACTORY_TEST_POSTGRES_URL=<proof database, exported inside a script> TREE=<worktree> TRIALS=3000 bun rq-harness.ts`
  (the harness: /tmp/factory-platform-evidence/w12e-2/bin/rq-harness.ts, sha256 ee1ee930e0c52561…; the same case as the
  acceptance test's second, with error codes and a drain watch). Record it as tasks/factory/w12e-GATES.md
  "provenClean records": the release, the JSONL path, the summary line.
- Removal rule: the guard, its list, its tests and every flag setting are removed together at the first Bun release
  that carries both #32088 and #43187 and is proven clean.
- Non-Linux: the start environment cannot be verified there (no /proc/self/environ), so process.env is read; every
  production entrypoint runs on Linux. No override of any kind. A test asserts the /proc path is taken when it exists.
- Test processes: the preload (when a real PostgreSQL URL is set) and the shared PostgreSQL helpers
  (setupFactoryPostgres, setupFactoryPoolPostgres, the recovery-database helper) call the guard first.

## TLS client sweep (after fixes 2 and 3)

| Site | Verdict |
|---|---|
| packages/@ezcorp/factory-transport createGatewayTransport | fixed (47f47eccb); every private client uses it: host launch, host stop, pool admission, the gateway probe, the orchestrator gateway activities |
| src/search/egress.ts connectPinned | fixed (9db142cbf) |
| src/factory/provisioning/ingress.ts factoryHttpsIngressProbe | servername is the installation's DNS hostname, which its certificate must name: safe |
| src/factory/key-composition.ts transit KMS | fetch to its configured endpoint with a CA; no pinned IP, no Host header: safe |
| Temporal gRPC client, mcp-proxy CONNECT tunnel | not Bun TLS clients: not affected |

## Full backend pool under 1.4.2 at 5670a39c6 (2026-09-30, interim)

integrator-3's invocation (w00/full-pool-run.sh w12e-full w15b-fix; the wave4f runner: 37 checks, manifest cov-shard =
the whole backend pool, 311 auto-extra files in 8 chunks). Receipts: /tmp/factory-platform-evidence/w12e-full-*.

- Green (26): sdk-build, transport-build, sdk-tests, focused, web-bun-coverage, postgres and its four steps (the
  acceptance test included), types, lint, boundaries, orchestrator-build, node, pool, compute, provisioning and python
  coverage, auto-extra-2, -6, -7, the four podman legs. The guard set, run separately: 60/0.
- Red, fixed above: auto-extra-0 (gate-integrity-rule11, environment), -1 (e2e-lanes), -3 (setup-podman), -4 (the
  migration test), -5 (private-https). gate-integrity exit 1 is judged by its expected set in the final gates.
- VOID, not run (the runner's gate, 15 GiB available and 2 GiB swap, timed out after 1200 s each; the host held
  10-14 GiB): web-coverage, manifest-cov-shard, manifest-cov-extras, manifest-web-security-coverage,
  manifest-factory-reference-data. Rerun at the final head; none counts as passed.
- WITHDRAWN (lead order, 19:47:13Z): the browser part, idle at its resource gate since 19:22:35Z (swap 0.35 GB free).

The authoritative set runs at the final head: the void legs, the chunks holding changed suites (private-https and its
importers), the guard set, the browser part and the final gates.

## Shared-file ownership note

9db142cbf (292e83e68 after the rebase) added an optional `serverAltNames` to src/__tests__/helpers/factory-certificates.ts,
which the interface freeze (section 12) assigns to the coordinator (W09). The default is unchanged; every existing
caller behaves as before. Approved by the coordinator 2026-09-30, after the fact; the lesson stands: ask the owner
before touching a frozen file.

## W-L1 (validator-6): the listener's own certificate check was untested on Bun 1.4

The private HTTPS listener's handshake callback takes a peer identity only from a verified certificate
(src/factory/private-https.ts). Bun 1.4 refuses an unverified certificate in the handshake first, so the integration
suite never reached that check: removing it passed 15/0 (w12e-2/wl1/mutant-private-https.integration.test.log). The new
src/factory/private-https.test.ts captures the listener's callbacks from Bun.listen (no port opened) and drives them
with a stand-in socket: a failed verification or a failed handshake gives no identity, and a request on that
connection is refused 401 before the handler; a verified certificate gives its subject. With the check removed it is
red, 1/1 (wl1/mutant-private-https.test.log); with it, 2/0 on 1.4.2 and 1.3.14.

## W-D1 (validator-6): two .mjs scripts opened Bun.SQL around the guard

scripts/refresh-factory-temporal-credentials.mjs (writes Temporal credentials read from the control database) and
scripts/prove-factory-local-provisioning.mjs constructed Bun.SQL directly; the direct-construction test scanned .ts
only. The test now scans every .ts, .mts, .cts, .js, .mjs and .cjs under src, scripts, packages and web/src; red named
exactly these two files (w12e-2/wd1/red.log). Both now open through openBunSql with the same options. Run by hand
under 1.4.2 without the flag, each prints the guard's refusal before any connection (w12e-2/wd1/hand-*.log).

## F2 (wave-level, moved into W12e by the coordinator 2026-10-01): tlsServerName's lines credited by their producer

The authoritative final gates at 8676d8757 found packages/@ezcorp/factory-transport/src/index.ts:163-164 (the mismatch
throw and the endpoint-IP branch) uncovered (per-file 98.95%; patch on both bases). That file is a canonical Node/V8
source (scripts/coverage-config.ts V8_CANONICAL_SOURCES): the merge accepts its lines only from the Node producer, the
orchestrator package's node --test suite (scripts/factory-orchestrator-coverage.sh), and drops every Bun input; the Bun
suites that exercise both branches therefore never counted. The new case in
packages/@ezcorp/factory-orchestrator/test/gateway-activities.test.ts drives both through the transport source: the
endpoint's own IP sends no server name and is refused by the certificate check (the certificate names only
DNS:localhost), and a different IP name fails by name. Red in the producer: DA 163 = 0, DA 164 = 0
(w12e-2/f2/node-red.lcov); green: DA 163 = 6, DA 164 = 1, the suite 12/0 under Node 24.14.1 (f2/node-green.lcov).
F2 is closed in W12e; W4F-1 keeps F1 (the preview guard under vitest) and F3 (the task-stops attestation entry).
