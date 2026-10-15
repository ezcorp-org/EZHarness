# W4G-1: container files prune the workspaces

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4g.md` (section W4G-1). Owner w4f-3, branch `wp/w4g-1` off integ/w00 `842ad9fe1`.
Evidence root: `/tmp/factory-platform-evidence/w4g-1/` (report.txt). Hosted logs: `w00/wave4g/ci-logs/110560704160.log` (Production
candidate image) and `110560704219.log` (Dev image provenance).

Cause: bun.lock names eight workspaces; Dockerfile (builder and runtime), Dockerfile.dev and Dockerfile.test copied five manifests
before `bun install --frozen-lockfile`, so the install failed on @ezcorp/factory-sdk, factory-transport (and harness-client's
dependency on factory-sdk). With those copied, every web frozen install failed next on `web/patches/` (web/package.json
`patchedDependencies`), which no container file copied either. deploy/factory/Dockerfile copies the whole context and was never affected.

| Requirement | Red | Green | Commit |
|---|---|---|---|
| R1 red: both image builds fail at the frozen install at 842ad9fe1 | red-builder.log, red-full.log, red-dev.log, red-test.log: "listed in bun.lock but not on disk" for factory-sdk, factory-transport, harness-client -> factory-sdk (the hosted message) | n/a | n/a |
| R2 fix: every bun.lock workspace manifest (and the web patch files) copied before each frozen install | fix1-full.log, fix1-dev.log, fix1-test.log: next failure "Couldn't find patch file: patches/@stryker-mutator%2Fvitest-runner@10.0.0.patch" | green-full.log, green-dev.log, green-test.log | 94d23c2a7 |
| R3 guard test scripts/container-workspace-registration.test.ts (guard set) derives inputs from each bun.lock and package.json and checks every tracked container file | red-guard-final-842ad9fe1.log: 11 pass 3 fail (Dockerfile, Dockerfile.dev, Dockerfile.test) | green-guard-detail.log; hook 14/14 (commit1-hook.log) | 94d23c2a7 |
| R4 both images build to the end with podman, digests logged; the server boots | n/a | green-full.log (whole Dockerfile; digest sha256:0cef67ba...), green-dev.log (sha256:2b1d0a80...), green-test.log (sha256:00c8b315...); green-provenance.log (the dev job's own check: verified, engine podman); green-boot.log (/api/health 200); green-fullnocache.log (the whole Dockerfile without cache, queued) | 94d23c2a7 |
| R5 the podman leg of the combined run still passes | n/a | green-podman-*.log, the four suites combined-integration.py runs with --podman: 19, 7, 2, 1 pass, 0 fail | 94d23c2a7 |

Notes:
- The runtime stage of Dockerfile ships no factory package sources. The server bundle holds no external import of a factory
  package, and the image's unbundled entry points (deploy/extension-runner/app-entrypoint.sh, src/auth/oauth-callback-worker.ts)
  do not reach one (fix2-inspect-bundle.log, bun build with every package external). The image boots with /api/health 200, so
  no runtime COPY was added.
- Guard set: 13 files, 74 pass (green-guard-detail.log). Hook list per commit: 1 (the new test), 0 (this docs commit).

## Round 2: validator-6 REJECT at db95d6a3e, and the clean-snapshot standard

validator-6 built each image from a `git archive` snapshot of db95d6a3e (what the hosted checkout has): Dockerfile and Dockerfile.test
failed in the web build (Rolldown cannot resolve "@ezcorp/factory-transport" / "@ezcorp/extension-contract/files"). The web bundler follows
each workspace's `import` export to dist/, which is never tracked; the builder built only sdk and harness-client, and Dockerfile.test built
nothing. My earlier green builds used the worktree as context, whose ignored dist/ folders were copied in: the R4 digests above are VOID.

Fix (team-lead's design): `scripts/build-workspace-packages.ts`, run by the root `build:packages` script, builds every workspace with a
build script, ordered by the workspace dependency graph from bun.lock (dependencies, devDependencies, peerDependencies; ties by path; a
cycle is refused). Order here: extension-contract, sdk, factory-sdk, factory-transport, factory-orchestrator, harness-client. The root
postinstall, Dockerfile, Dockerfile.dev, Dockerfile.test and deploy/factory/Dockerfile call it instead of hand-written lists.
.dockerignore and Dockerfile.test.dockerignore exclude `packages/@ezcorp/*/dist` and `packages/@ezcorp/*/*.tsbuildinfo`.
The guard checks: build:packages is the root script and postinstall uses it; no root script or container file builds one package by
hand; every web build follows build:packages in its stage; every image that runs build:packages has both ignore rules.
(Single-package build steps remain in .github/workflows/ci.yml (registered lanes, enforced by scripts/check-factory-lanes.ts) and
release-sdk.yml (the SDK publish); none of them keeps an order.)

Every build below uses a clean context: `git archive <rev> | tar -x` into an empty directory (builds2.sh; the log states the commit and
"dist dirs: 0"). Podman 5.8.7 (the host was upgraded during the 2026-10-02 pause; round-1 logs show 5.8.2).

| Requirement | Red | Green | Commit |
|---|---|---|---|
| R6 every workspace build through one derived script; contexts exclude build outputs | red3-guard-db95d6a3e.log: 19 pass 7 fail (root script, the four images, the ignore rule) | guard 29/29 at 31d87fb1e; build-workspace-packages.test.ts 6/6, the script at 100% lines; hooks commit4-hook.log, commit5-hook.log | 73840c57c, 31d87fb1e |
| R7 all images built to the end from a clean snapshot; the app boots | red3-full.log (db95d6a3e): Rolldown "@ezcorp/factory-transport"; red3-test.log: "@ezcorp/extension-contract/files" | 31d87fb1e: production sha256:182231f4ced1f4da993d14b8371fb597feafcaf3c0174e3fe2fe459450e29e1c; production --no-cache (0 cached layers) sha256:61da8e0688cf5eb9fe1a6bcf05275f04336fb9551a288183c0fe3edf26eac3ad; dev sha256:7ef31c1b3590488b0d17af54553a7d1c7b1131815510f77c3cb1a23b80a0ae73 (provenance verified); test sha256:d72e7fa490f1f30bb8ba3174f409d05360d9a515169e244209b7473e0ec2b532; deploy/factory sha256:7f66b8e80210496abf8563b786fe6ec0e413be85ce765006b67e26a08e9a3fcd; boot /api/health 200 (green3-*.log) | 31d87fb1e |
| R5 (rerun) the podman leg of the combined run | n/a | green3-podman-*.log: 19, 7, 2, 1 pass, 0 fail; guard set 89/89 | 31d87fb1e |

The interim commit 42f58e696 (a hand list in three files) is superseded by 73840c57c. Image tags are removed by name after each run
(builds2.sh); the earlier builds.sh ran a global `podman image prune -f` (83 removals, all its own build layers; prune-accounting.txt).
