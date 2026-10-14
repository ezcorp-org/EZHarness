# W4H-27: the Compose installation comes up (build-time workflow bundle, honest fleet CLI exits, the startup release block, a stop command)

Brief: /tmp/factory-platform-evidence/w00/briefs/w4h-27.md. Branch `wp/w4h-27-compose-comes-up` from origin/main 1981febd2.
Worktree: /home/dev/work/EZCorp/EZHarness/.worktrees/w4h-27 (archy via --worktree config). Evidence:
/tmp/factory-platform-evidence/w4h-27/ (paths below are relative to it). Pins: bun and bunx 1.4.2, node 24.14.1.

## Cause

- D1: the orchestrator bundled its workflow code at RUN time (worker.ts:16, webpack plus swc-loader). @swc/core
  1.16.13's addon is a carrier that writes the real addon to a user cache and loads it from there. The shipped
  orchestrator runs keep-id as the host uid with a read-only root, a noexec /tmp and HOME=/tmp (deployment.ts), so
  the addon refused: "native addon user cache /tmp/.cache is mounted noexec" (logs/r1-swc-shipped-flags.log).
- W16 G7 passed on an image whose lock had @swc/core 1.16.2: a plain 33 MB ELF addon with no cache logic. The merge
  7247f7e9a (the W4H-10 main sync, 2026-10-05) re-resolved the lock to 1.16.13 (a 10.5 MB carrier). G7 rendered the
  shipped configuration (the product's own provisioner); nothing re-ran it after the lock changed, and no test or CI
  job started the image under the shipped flags.
- D2: fleet-cli put a per-tenant failure in the JSON and returned normally (exit 0).
- D3: the deployer never wrote the startup document's release block.
- D5: the fleet CLI had no stop command.

## Fix

- D1: `workflow-bundle.ts` (loader and writer) and `workflow-bundle-build.ts` (build-only entry). The factory
  Dockerfile runs the entry after `build:packages` under the digest-pinned Node; the image ships
  `dist/factory-workflow.bundle.js` and its SHA-256 record. The worker takes `workflowBundle`; the process loads it
  once, before any Temporal connection, and refuses a missing bundle, a malformed record, or a digest mismatch by
  name (`factory_workflow_bundle_digest_mismatch`), writing failed readiness with that code. Isolation unchanged.
- D2: a provision or observe with a failed tenant exits 1; stderr names each tenant, its failed step, code, reason.
- D3: with profiles declared, the deployer writes `release`: the installation's own S3 destination always
  (`installation-s3`: ordinary store, bucket and account = tenant, prefix `ordinary/releases`, the delivered
  ordinary-storage.json), a GitHub destination only when the fleet declares one (token file delivered to the harness,
  named by path). The local fleet declares one default S3 profile (reference.image.v1's S3 publication adapter).
- D5: `stop` (installations newest first, the host pool and supervisor, the platform; containers kept) and `up`
  (the reverse; each waited ready). Both idempotent.
- Fidelity: `scripts/check-factory-image-shipped-config.ts <image>` runs the image's workflow path under the flags read
  from installation.yml and the env from the deployer's `FACTORY_SERVICE_BASE_ENVIRONMENT`, replaying a committed
  history; a key it cannot apply is a refusal. ci.yml job `factory-image-shipped-isolation` builds the image and runs it.

## Leftovers

- The S3 release destination shares the installation's ordinary-store identity (prefix `ordinary/releases`). An
  independent archive domain with a distinct restore identity is W15's production item.
- The guard starts the orchestrator's workflow path only; the harness's own boot under the shipped isolation is proved
  by R3 (the installation reaches ready), not by a CI job.
- GitHub App token minting (W07) is not here: a GitHub destination reads a token file.
- The orchestrator should wait with bounded back-off for the harness private service at boot instead of exiting; a
  quiet boot makes a real crash loop visible (ruled leftover; today's boot bursts are recorded under G5).
- Restore the self-hosted proof harness INTO the repository with its helpers and a tenant offset; a proof that lives
  only under /tmp with a missing import is not a proof (ruled leftover; see G10).

## Gates

- [x] G1 (R1) reproduce E2E: kept image 1981febd2 (sha256:430e6c30), own fleet w4h27, port base 43000, the W4H-25
  commands. tenant-02: step 5 `deployment_not_ready` (22:30:26Z); orchestrator restarts 234, "Failed to load native
  binding" (process.ts:254); harness `factory_orchestration_unavailable`; CLI exit 0. EVIDENCE: logs/r1-*, journey.md.
- [x] G2 (R1) the W16 G7 question answered with evidence: 1.16.2 (33 MB plain ELF, no cache strings) at cb2680fbe;
  1.16.13 (carrier, `SWC_NATIVE_BINDING_CACHE` x2) from 7247f7e9a / integ 198f5fcac, 2026-10-05; the host cache
  ~/.cache/swc-native-1001 dates from 2026-10-05 03:34. ACCEPTED by team-lead.
- [x] G3 red-first, each on the base sources (logs in red-first/): D1 unit (module missing) then 15/15; D2 0/1 then
  10/10; D3 deployer, fleet, fleet-init red then 49/14/3; D5 fleet-cli 0/1, compose 52/2, platform 0/1, host 24/1
  then 11/54/27/25; CI registration 0/2 then 2/2; the guard on 1981febd2's image FAIL "Failed to load native
  binding", on the new image PASS "REPLAY OK: build-time bundle"; the read_only-drop mutant turns 3 guard tests red;
  the local release profile red (adapter has a sixth field) then green.
- [x] G4 (R3) the installation comes up through step 7 from the image at HEAD with the isolation unchanged:
  tenant-03 invitation_issued; orchestrator, harness, gateway user 1001:100, read-only root, /tmp noexec,
  no-new-privileges, caps dropped, HOME /tmp and /var/lib/ezcorp/home; exec from /tmp refused (126). EVIDENCE:
  logs/r3/provision.out, isolation.txt, orchestrator-inside.txt.
- [x] G5 (R3) orchestrator up >= 10 min with 0 restarts, MEASURED FROM READINESS (not from container start): one
  start time (00:01:25Z) across 10 one-minute samples, restart count unchanged at 3 (all before readiness),
  readiness `ready` before and after. Boot restarts (4 at the first start,
  3 at `up`, about 5 s each): ECONNRESET on the harness private service (43031) while the harness boots, the
  documented restart-as-supervisor design. EVIDENCE: logs/r3/hold-*.txt, orchestration-readiness*.json.
- [x] G6 (R3) a release declaration from the started installation resolves its destinations: in the harness
  container, the release reader over the delivered startup document resolves tenant-03's S3 account to
  S3FactoryManifestReleaseProvider and refuses a foreign account and an undeclared repository by name.
- [x] G7 (R3) `stop` stops all 10 containers of the fleet (twice, exit 0), `up` brings all back running and healthy
  (twice, exit 0); volumes kept.
- [x] G8 (R3) the fleet CLI exits non-zero on a forced provisioning failure: tenant-11 exit 1, stderr names step
  `storage`, code `storage_identity_unavailable`, reason; tenant-01 (torn down) exit 1 `provisioning_torn_down`.
- [x] G9 legs: typecheck via tc-gate 0; lint 0 (0 warnings); boundaries 0; deployment locks 0; gate-integrity main 0;
  guard set 530/0 (43 files); hook-mapped suites at every commit; orchestrator node 101/0, provisioning PostgreSQL
  63/0; changed executable lines 246/246 covered (logs/changed-lines.txt); CRAP --changed 0 above 30; actionlint 0
  new (12 = base 12); shellcheck only SC1091 info, as base.
- [x] G10 the new W16 G7 pass (ruled option c): G4 to G8 on the image at HEAD plus the shipped-isolation guard (G3,
  and the ci.yml job). The old harness (/tmp/factory-platform-evidence/w16/repro/prove-selfhosted.ts) cannot run
  unchanged: its ./temporal-http-checks.ts import exists nowhere on this box or in git, it hard-codes tenant-01,
  tenant-02 and tenant-10, and the tenant-01 bucket is still claimed by w4h25's fleet. The W16 G7 checkbox stays as
  history; restoring the harness in-repo is a leftover.
