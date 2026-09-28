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

- [x] G1: the acceptance regression is red on Bun 1.3.14 and green on Bun 1.4.2.
  CHECK: tests/postgres/bun-sql-request-queue.test.ts on real PostgreSQL, once with each Bun, same tree.
  EXPECT: 1.3.14 fails; 1.4.2 passes 3 of 3. EVIDENCE: w12e-2/logs/g1-*.log and commit-and-g1.run.log. RESULT at
  d503d22c8, 2026-09-28 18:37-18:39Z: 1.3.14 exit 1 (0 pass, 2 fail); 1.4.2 exit 0 three times (2 pass, 0 fail).
- [x] G2: the preview-server crash seen under 1.4.2 (ERR_STREAM_WRITE_AFTER_END, factory-live-console e2e) is
  reproduced end to end at the head and fixed at its root, or refuted with the runs that refute it.
  CHECK: the factory-live-console Playwright lane under 1.4.2 (bun and bunx asserted), repeated.
  EXPECT: no crash in every run after the fix (or in every run, if refuted). EVIDENCE: w12e-2/logs/g2-*.log. RESULT
  (see "G2" below): red at d503d22c8 (the pipelined client killed the real preview); at 99278bee9 the lane ran
  66/66 twice with 0 crashes, and the pipelined client got 20/20 answered with the server up
  (c3-commit-and-g2.run.log, g2-preview-head-guarded.log).
- [ ] G3: the full runner and the browser set are green under 1.4.2 at the head.
  CHECK: w00/combined-integration.py --repo <worktree> --prefix w12e-scratch --podman --auto-extra-base <base>
  --legs-manifest scripts/combined-runner-legs.json (LOCK_LANE=w15b-fix), plus the browser lanes after
  w18c/heavy/final-browser.sh. EXPECT: every leg green; every red root-caused and fixed red-first here.
  EVIDENCE: w12e-2/runner/, w12e-2/browser/
  INTERIM (lead ruling 2026-09-28): the scratch runner at db441b977 ended 19:48:01Z with rc 1. 25 legs exited 0;
  node-coverage exited 97 (zero count), so the runner blocked the coverage merge and gates by design. The cause is
  not W12e's: at base e92d34d45 the node/orchestrator coverage producer prints no totals to stdout (they go to
  test-progress.log), and W18c's f77a3c112 fixes the producer. W12e is not changed for it and it is not rerun here.
  The browser lanes at this head are held by a scheduling veto. The authoritative G3 runs once at the final head,
  rebased after W02d lands, which includes W18c (w12e-2/logs/g3-runner.run.log).
- [ ] G4: the coverage defect is re-probed under 1.4.2: the attested line of src/factory/task-stops.ts is still
  uncredited (a function's last statement is credited to the line before), and the attestation's Bun field is
  refreshed. CHECK: the W03g probe under 1.4.2. EXPECT: DA 0 on the attested line with the line proven executed.
  EVIDENCE: w12e-2/logs/g4-*.log
- [ ] G5: every pin consumer names 1.4.2. CHECK: `git grep -n 'e10577f0db68\|bun-1\.3\.14\|oven/bun:1\.3\.14'` on
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
