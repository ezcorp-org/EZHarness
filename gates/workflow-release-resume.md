# Workflow release resume authority

- [x] Reproduce manual and daemon execution without an extension release binding using real PGlite run claims.
- [x] Capture one cache entry and execute only its definition.
- [x] Check current release, owner and project authority after reading the claimed run.
- [x] Keep denied runs parked and release their claim. Do not report a denied approval continuation as success.
- [x] Test approved continuation, replacement, revocation, missing provenance and project access.
- [x] Run focused resume and approval suites, type checks and changed-line coverage.

Initial red proof: `/tmp/ez-workflow-resume-release-red.log`, two failures.
Initial green proof: `/tmp/ez-workflow-resume-release-green.log`, 68 tests and 245 assertions.

Extension runs now store an execution fingerprint in the existing `definitionHash` field: SHA-256 of the stable graph hash and the exact extension release descriptor. This includes installation, owner, scope and release binding. A new generation with the same graph cannot resume an old run. Old extension rows with null or graph-only hashes fail closed. Host and DB workflows retain their graph-only hash and version behavior.

Initial extension persistence is strict. Start and direct resume check live authority again after durable reads. Manual resume, the daemon and approval continuation capture the same cache entry before asynchronous work; denied claims return to suspended. Timeout policy lookup checks the stored execution fingerprint and live authority before applying the policy. It leaves unavailable decisions pending.

Real executor restart proof: `/tmp/ez-workflow-release-restart-green.log`, 20 assertions. Same release continues; a replaced generation, old null hash and old graph-only hash do not. Additional SQL-backed access and late-revocation proof: `/tmp/ez-workflow-release-resume-authority3.log`, 13 tests and 108 assertions. These tests do not claim rollback of effects already admitted before revocation.

Final focused coverage run: `/tmp/ez-workflow-resume-coverage-final.log`, 169 tests and 665 assertions; eight files pass. LCOV is in `/tmp/ez-workflow-resume-coverage-final/lcov.info`; all instrumented added runtime lines are covered. Full typecheck passes (`/tmp/ez-workflow-resume-types3.log`); scoped Biome checks ten files without changes (`/tmp/ez-workflow-resume-lint.log`).
