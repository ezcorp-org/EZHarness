# Schema validation cache

- [x] Cache only successful compilation, by canonical schema content and byte limit, with a 64-entry least-recently-used bound.
  EVIDENCE: exact-content reuse, key-order equivalence, changed-schema isolation, byte-limit separation, invalid-schema denial, and eviction tests pass in `/tmp/ez-schema-cache-test2.log`.
- [x] Detach the compiled schema from caller-owned objects.
  EVIDENCE: mutating a nested constant reproduced a stale-validator change in `/tmp/ez-schema-cache-test1.log`; detached compilation preserves both old and new validators in test2.
- [x] Prove the actual concurrent first-party pipeline stays within its unchanged worker deadline.
  CHECK: bun test ./src/extensions/first-party-integration/auto-note/e2e-server-pipeline.test.ts
  EVIDENCE: `/tmp/ez-auto-note-cached-final.log`: seven tests, 50 assertions pass. The concurrent case completes in 1.51 seconds; the prior failure exceeded 30 seconds. Worker and lock deadlines are unchanged. This includes bounded contention backoff.
- [x] Pass contract build and full contract tests.
  EVIDENCE: `/tmp/ez-cache-contract-build2.log`, `/tmp/ez-contract-cache-full.log`: 22 tests, 278 assertions pass.
- [x] Pass final integrated coverage.
  EVIDENCE: `/tmp/ez-coverage-parent-final3.log` passes all 1,239 enforced files; `/tmp/ez-patch-coverage-final3.log` passes all changed executable lines in 338 files. Cache source is unchanged since its focused proof.

This cache does not store permissions, principals, active releases, or host capability decisions. Every effect retains fresh release and grant checks.
