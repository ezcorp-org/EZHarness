# W4G-13: the dev-image ownership test regressed by W4G-1

Owner w4f-3, branch `wp/w4g-13` off integ/w00 `341a6876d`. Evidence root: `/tmp/factory-platform-evidence/w4g-13/`.
Found in the wave4h pool; integrator-3's lock-free proof: 1/0 at fda4108e8, 0/1 at 4ae2f1658 (`wave4h-auto-extra-1.log`).

Cause: W4G-1 (73840c57c) replaced Dockerfile.dev's `RUN bun run --cwd packages/@ezcorp/sdk build ...` with `RUN bun run build:packages`.
src/__tests__/dev-image-ownership.test.ts counted RUN steps matching `/(bun install|bun run --cwd)/` and expected 3, so the package build
dropped out of its set (received 2). The Dockerfile is right; the test's matcher was tied to one spelling of the build command.

Fix (the test, not the Dockerfile): the writable steps are every RUN that runs `bun install` or `bun run`, and the test names them by
role in order instead of a count: the root install, the web install, the workspace package build. Each must still run after
`USER 1000:1000` and before the runtime `USER root`; both installs keep the uid-1000 cache mount.

Why no earlier leg caught it: the pre-commit hook maps no test to `Dockerfile*` (staged_test_targets maps only .ts/.tsx/.svelte sources and
test files), and the standing guard set (w00/guard-suites.sh) did not include the tests that read container files, so W4G-1's per-head runs,
validator-6's hold and the merge batch never ran this suite; only the wave4h pool did. integrator-3 adds these 12 tests to
w00/guard-suites.sh: scripts/check-factory-deployment-locks, scripts/container-workspace-registration, and src/__tests__/{compose-podman-masks,
compose-podman-prod, compose-projects-root, dev-image-ownership, dockerignore-heavy-excludes, file-organizer-applier-reserved-dirs,
fs-reserved-carveout-not-a-violation, gh-cli-in-images, installer-core, macos-local-dev}.test.ts.

| Requirement | Red | Green | Commit |
|---|---|---|---|
| R1 the ownership test sees every install and build step, by role | red-dev-image-ownership.log at 341a6876d: expected length 3, received 2 (0 pass 1 fail) | the test 1/1, 37 expect() calls; hook 1/1 (commit1-hook.log) | 524133225 |
| R2 the 12 container-file tests, one per process | red-container-tests-341a6876d.log: dev-image-ownership 0/1, the other 11 green | green-container-tests.log at 524133225: 11, 29, 13, 6, 14, 1, 7, 5, 16, 9, 53, 11 pass, 0 fail (all 12) | 524133225 |

Hook list per commit: 1 (the test), 0 (this docs commit).
