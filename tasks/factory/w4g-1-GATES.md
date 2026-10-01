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
