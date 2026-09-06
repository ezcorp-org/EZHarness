# Browser and validation skip inventory

## Executed browser lanes

- The exact 30-spec mock gate collected 222 tests: 210 passed, 12 skipped, 0 failed, and 0 retried. The 12 names below are the complete actual skip set from member `mock-gate-final.log` in `artifacts/browser-raw-logs.tar.gz`.
- The complete 29-spec real-auth configuration passed 54 tests with no skips, failures, or retries (member `real-auth-full-final.log` in `artifacts/browser-raw-logs.tar.gz`).
- The required visual selection contained 29 spec files. Its mock group passed 42 evidence tests and its real-auth group passed 7; neither group skipped a test (member `visual-selected-final4-green.log` and `artifacts/final3-blob/`).

## Exact 12 mock-gate skips

All are from `web/e2e/file-organizer-real.spec.ts`. Its enclosing `test.skip(!DOCKER_TEST)` is active because the mock gate intentionally does not set `DOCKER_TEST`.

1. `add-folder: a TYPED ABSOLUTE path is accepted by the REAL validator and persisted`
2. `add-folder: a RELATIVE path is refused by the REAL validator with the exact message`
3. `add-folder: an UNREACHABLE absolute path is refused with the container-visibility message`
4. `add-folder: a DESCENDANT of an already-watched folder is refused as already-covered`
5. `add-rule: a malformed DSL rule is refused by the REAL parser with the exact parse error`
6. `config mutations (set-mode/toggle-preset/add-ignore/set-backlog-policy/add-rule/remove-folder) persist to the REAL config`
7. `proposal lifecycle: daemon proposes and accepts a REAL move on disk`
8. `picker: Browse → real GET /api/fs/list?dir=/ is 403 (sandbox-jailed, documents the limitation)`
9. `UI: a refused add surfaces a real error toast in the browser`
10. `add-folder: the added folder APPEARS in the Hub render (data dirs aligned)`
11. `config mutation REFLECTS in the Folders Hub render (data dirs aligned)`
12. `Review Hub render loads against the live backend (data dirs aligned)`

The source used to conditionally skip test 7 when the daemon produced no applicable proposal. The repaired production fixture supplies a controlled eligible input and requires the proposal. The exact Docker replacement passed all 12 tests with no skips.

## Production replacement for the 12 mock skips

The exact final Docker-format production-image run passed 12 tests, failed 0, and skipped 0 at source `ea445e9e` using immutable image ID `abc36444…`. It used a fresh owned database and filesystem, imported and built the bundled File Organizer source through the external rootless runner, recorded human-session approval and activation, and bound the exact release to the owned project. Activation started the daemon without an app restart. The proposal case enabled `include-existing`, created a controlled old `.tmp` input, observed the daemon-written proposal, and accepted it through the real event route. `artifacts/file-organizer-real-production.zip` contains the list-reporter raw log, sanitized fixture, image identity, test exit, and cleanup exit; this lane did not enable the blob reporter.

## Declared browser lanes outside the required runs

`web/e2e/lanes.json` assigns every spec once. The seven Docker-lane paths are in `artifacts/docker-specs.txt`; the 228 unwired paths are in `artifacts/unwired-specs.txt`. They were outside the required mock, real-auth, and selected visual commands, so they are excluded by configuration rather than reported as runtime skips. The unwired inventory is an explicit backlog, not evidence of covered behavior. The extension-specific replacements used by this audit are the real-auth approval/release/project/scanner specs, the selected visual specs, and the owned `file-organizer-real` Docker run.

Within the required mock and real-auth source set, the only active conditional test gates are the two file-organizer gates above and `hub.spec.ts`'s mobile-only exclusion. The required mock command selects Chromium, so the Hub desktop assertion ran rather than skipped.

## Runtime, SDK, and platform conditions

- The SDK default run passed 1,028 tests and reported one skip: `MCP executable discovers and invokes in a networkless rootless container`, gated by `EZCORP_RUN_PODMAN_TESTS=1`. Its replacement opt-in run passed all 7 tests and 32 assertions, including the named rootless case.
- `src/__tests__/marketplace-release-isolation.integration.test.ts` has the same Podman opt-in gate. Runtime's owned opt-in evidence covers immutable marketplace publish and rebuild.
- `src/extensions/runtime-locks-postgres.test.ts` and `scripts/verify-extension-postgres.ts` throw when `EXTENSION_TEST_POSTGRES_URL` is absent; they do not skip. Runtime ran them with an owned disposable PostgreSQL service.
- `scripts/verify-first-party-lifecycle-v4.ts` does not skip. The frozen-tree full inventory passed 50, failed 0, and left 0 untested. Of those extensions, 4 declare smoke tests and 46 do not; the absence of a declared smoke is recorded separately from a skipped test. The capability inventory records 1 of 117 declared capability rows with direct feature proof and does not mislabel the remaining rows as tested.
- The authoritative backend wrapper passed 24,586 tests in 1,561 files with no reported skip/todo match. Source-level kernel/network/Postgres conditionals remain platform gates and are itemized by the runtime capability inventory rather than added to browser counts.

The broad source search is retained in `artifacts/source-skip-search.txt`. It includes comments and tests outside final lane selection; it is evidence for review, not an inflated runtime-skip total.

## Preview Docker opt-in replacement

The host pool conditionally skips seven distinct live preview assertions unless
`DOCKER_TEST=1`. They are not covered by the File Organizer replacement:

1. `setuid helper present + 4755 root-owned in the image`
2. `preview uid CANNOT read .ezcorp/data (chmod 0700) — keystone`
3. `helper refuses an out-of-range uid even invoked directly`
4. `ProcPortSource attributes a live listener by its preview uid`
5. `spawn as preview uid → ProcPortSource detects → loopback fetch 200`
6. `reapPreviewConversation: REAL helper --kill actually reaps the tree + confirms`
7. `WS upstream (ws://127.0.0.1:<port>) connects + echoes a frame`

The explicit opt-in replacement ran both existing files in the immutable final
production image with the repository mounted read-only and all writable state in
an owned tmpfs. Pinned Bun 1.3.14 passed all 7 tests with 21 expectations and no
skips in 11.31 seconds; the command exited 0. Docker `--rm` removed the named
audit container, and the command created no volume or writable host mount. See
`artifacts/preview-docker-optins-command.txt` and
`artifacts/preview-docker-optins-final.log.gz`.

## Bwrap tmpfs and PID opt-in replacement

The host pool skips three `bwrap tmpfs isolation` assertions because NixOS has
no `/usr/bin/bwrap`. The unmodified tests also cannot run as the production
container's `bun` user because Docker blocks nested unprivileged user
namespaces. A disposable test-only container enabled `SYS_ADMIN` and disabled
its seccomp profile so the existing user/mount namespace setup could run.

The first exact run proved the PID assertion but exposed a container fixture
conflict in the two tmpfs assertions: device nodes made by bwrap's `--dev`
mount returned `EACCES`, including `/dev/zero`. This occurred even in an owned
privileged container. The test now generates deterministic userspace bytes
with an unbounded `yes` stream and `iflag=fullblock`, avoiding that unrelated
device permission. The tested byte counts, private tmpfs, 64 MiB cap, ENOSPC
result, and PID relationship are unchanged. The green run mounted the committed
repository read-only without a fixture overlay.

Pinned Bun 1.3.14 passed all 3 named tests with 7 expectations, 0 failures, and
6 filtered tests. The command exited 0. This is kernel behavior evidence from a
test-only container envelope; the normal production image continues to select
Landlock under Docker. See `artifacts/mcp-bwrap-optins-command.txt` and the
red/green gzip logs.
