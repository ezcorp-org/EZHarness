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

- [ ] G1: the acceptance regression is red on Bun 1.3.14 and green on Bun 1.4.2.
  CHECK: tests/postgres/bun-sql-request-queue.test.ts on real PostgreSQL, once with each Bun, same tree.
  EXPECT: 1.3.14 fails; 1.4.2 passes 3 of 3. EVIDENCE: w12e-2/logs/g1-*.log, w12e-2/receipts/g1.json
- [ ] G2: the preview-server crash seen under 1.4.2 (ERR_STREAM_WRITE_AFTER_END, factory-live-console e2e) is
  reproduced end to end at the head and fixed at its root, or refuted with the runs that refute it.
  CHECK: the factory-live-console Playwright lane under 1.4.2 (bun and bunx asserted), repeated.
  EXPECT: no crash in every run after the fix (or in every run, if refuted). EVIDENCE: w12e-2/logs/g2-*.log
- [ ] G3: the full runner and the browser set are green under 1.4.2 at the head.
  CHECK: w00/combined-integration.py --repo <worktree> --prefix w12e-scratch --podman --auto-extra-base <base>
  --legs-manifest scripts/combined-runner-legs.json (LOCK_LANE=w15b-fix), plus the browser lanes after
  w18c/heavy/final-browser.sh. EXPECT: every leg green; every red root-caused and fixed red-first here.
  EVIDENCE: w12e-2/runner/, w12e-2/browser/
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
| scripts/lib/pinned-bun.sh (tool directory from .bun-version, bunx link, both asserted; refuses a missing source path) | 2 |
| scripts/build-factory-image-guest.sh, scripts/factory-graph-proof/run.sh, scripts/run-factory-postgres-suite.sh | 2 |
| tests/postgres/factory-pool-mtls.test.ts, factory-pool-process.test.ts (tests/postgres/helpers/pinned-bun.ts) | 2 |
| README.md, docs/factory-deployment.md, docs/factory-graph-proof.md, docs/factory-pool-process.md, docs/features/platform/dev-lifecycle-and-gates.md, docs/macos-local-dev.md | 2 |
| .github/dependabot.yml and .github/workflows/ci.yml pin comments | 2 |

Outside the tree: /tmp/factory-tools/bun-1.4.2/bun-linux-x64 (bun sha256 checked against SHASUMS256.txt; bunx link),
docker.io/oven/bun@sha256:9114c058…6895 pulled on this host, and the w00 rule that derives every lane's PATH from
.bun-version.

Kept on purpose: comments and gate records that say what was measured on 1.3.14 (they are history, not pins).

## Findings

- F1 (fixed in commit 2, red first): scripts/lib/pinned-bun.sh took the repository root from BASH_SOURCE. Sourced
  from zsh (or eval'd), that is empty or "bash", so the root became "$PWD/../..": from a worktree under .worktrees/
  that is the main checkout, whose .bun-version (1.3.14) then passed the assertion. The install that ran this way
  was void and was rerun under bash. The helper now refuses without its own path. Red 6/1, green 7/0
  (w12e-2/logs/pinned-bun-red.log, pinned-bun-green.log).
