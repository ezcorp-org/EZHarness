# Extension v4 validation

## Result

The rewrite runs in a separate worktree on `feat/extension-v4`. The original working directory is unchanged. Validation is still in progress: the complete backend and authenticated browser lanes found further failures after the earlier checkpoints below. This is not a claim that the system has no possible defects.

The gate-integrity check still requires maintainer review. Its 84 findings concern retired, moved, or rewritten legacy tests and one removed threshold for deleted code. Every finding has a numbered disposition in [the migration mapping](../src/__tests__/extension-v4-migration-coverage.md). No maintainer label was applied by the implementation agent. The PR must remain a draft until the required review and CI checks pass.

## What changed

- One versioned contract serves the SDK, harness tools, HTTP routes, and UI.
- Mutable installation and host-side source evaluation are replaced by versioned workspaces, isolated builds, immutable releases, and exact human approval.
- The rootless runner enforces resource, filesystem, process, and network boundaries. Missing runner controls fail closed.
- Capability calls bind the principal, installation, release, scope, and deadline. Revocation and cancellation are checked again before effects.
- Database effects use transactions and generation fences. Durable request and delivery records distinguish completed, cancelled, failed, and unknown outcomes.
- Browser extensions use opaque frames and a private SDK channel. The host owns session access, conversation selection, and camera consent.

## Executed checks

Commands use the repository's Bun 1.3.14 environment. Backend tests run through the isolated wrapper, not a pooled `bun test` at the repository root.

| Check | Result | Local evidence |
| --- | --- | --- |
| `bun run typecheck` | Backend, web, backend-test and E2E-test checks pass | `/tmp/ez-types45.log` |
| `bun run --cwd web check` | Zero errors; 13 warnings in five files | `/tmp/ez-svelte-final2.log` |
| `bun run lint` | Zero errors; 105 warnings and 11 informational findings | `/tmp/ez-lint20.log` |
| `bun run test` | 24,398 tests in 1,546 files pass | `/tmp/ez-extension-v4-backend13.log` |
| `bash scripts/test-web.sh` | 4,125 tests in 222 files pass | `/tmp/ez-extension-v4-web10.log` |
| `bun run --cwd web test:component` | 7,024 tests in 543 files pass | `/tmp/ez-extension-v4-vitest11.log` |
| `bun run build` | Production build passes, including final preview CSS | `/tmp/ez-v4-build-final5.log` |
| `bun run test:coverage` | 25,657 tests pass; zero failures; 1,239 enforced files pass | `/tmp/ez-coverage-parent-final3.log` |
| `bun scripts/check-new-file-coverage.ts` | All 126 new source files are gated | `/tmp/ez-new-file-coverage-final3.log` |
| `bun scripts/check-patch-coverage.ts` | All changed executable lines in 338 files are covered | `/tmp/ez-patch-coverage-final3.log` |
| Mock browser CI lane | 210 pass; 12 pre-existing skips | `/tmp/ez-mock-gate-final2.log` |
| Actual authenticated extension browser lane | All nine specifications pass together | `/tmp/ez-extension-v4-real-final10.log` |
| Source lock verification | Pass | `/tmp/ez-source-lock-final.log` |

The coverage run includes the newly wired tests in the required pass/fail set; the shared file list prevents a coverage-only test from losing its pass/fail gate.

The SDK passes 1,023 tests with 2,332 assertions. The contract package passes 22 tests with 278 assertions. Both build successfully. The runner passes 36 tests with 266 assertions; the final stricter host-path probe also passes separately.

All 50 first-party candidates pass isolated build, tests, and discovery at tree `6e634060ed624549d1d11c17325678860740596c`. The three later changed example snapshots pass a separate sealed verification at tree `a185a95591c799404d9521fe8a258df22cd1f9c7`. This is a baseline plus delta proof, not a claim that a new all-50 sweep ran after the delta. Per-release reports preserve `unexercised` capability and `not_declared` smoke-test states.

## Actual security and failure checks

- Real HTTP and SQL reproduced file-organizer actions after project authority was removed. The shared authorization checks now refuse those actions; valid owner actions still work. Nine cases and an independent rerun pass.
- Real browser requests proved that an HTTP disconnect alone did not cancel the worker. Explicit durable cancellation now prevents the held effect after acknowledgement. The test uses a causal latch, not a fixed sleep.
- Concurrent rootless workers prove that cancelling one invocation does not stop another worker or later independent calls.
- PostgreSQL 16 checks use separate connections to verify claim serialization, lock ordering, cancellation, and transactional effect fences.
- Browser tests verify parent and session isolation, exact release revocation, camera Start/Stop, and bounded JPEG delivery. Desktop and mobile screenshots were opened and reviewed.
- Mobile testing uses an explicit headless-shell process and real touch scrolling. It waits for `scrollend` before tapping. The test does not use forced clicks, script clicks, relaxed iframe flags, or coordinate corrections. This is browser emulation, not a physical-phone certification.

Production image `815764c0a0adc87d7206f1fe8cf0ae2ac7a85791700488d1e2fd88f5b7cd271b` passes actual boot, file-based runner credentials, isolated build, human approval, activation, tool invocation, disable denial, and retained history. It includes the final authorization and preview-layout fixes. Evidence: `/tmp/ez-container-final-verify3.log`.

## Limits and review decisions

- Rootless containers share the host kernel. A hostile host administrator is outside this boundary.
- Cancellation does not undo an admitted or committed effect. Unknown external outcomes are not automatically replayed.
- Multiple hosts require shared PostgreSQL. Separate embedded databases cannot coordinate the same installation.
- Explicit raw-secret and native-network grants carry broader authority. The system cannot promise to prevent disclosure after the user grants access to that data.
- Browser cancellation can fail while offline; the UI reports an unconfirmed cancellation and the invocation deadline remains the final bound.
- Receipt cleanup is bounded and runs during preparation. Twenty-four hours is cleanup eligibility, not a scheduled deletion guarantee.
- Uninstall retains data. Interrupted in-memory prompts and transient UI notifications do not acquire an automatic recovery guarantee. Built-in file-organizer actions have the new authorization checks but are not generic extension action receipts.
- Automatic development watching, inline grant controls, configurable per-capability expiry issuance, destructive purge, generic Git/automatic updates, and unsupported host-executed metadata have no equivalent compatibility claim. The migration mapping identifies these choices for maintainer review.

Do not merge on the strength of local results alone. Required CI checks, the test-migration approval, and a non-author review must pass first.

## Initial hosted CI and follow-up

Draft PR 246 at `5cdf49fe` exposed failures that local checks had missed:

- The Ubuntu installer could not change static systemd delegation with `set-property`. A scoped runtime unit drop-in replaces that command; controller and actual rootless kernel checks remain mandatory. Hosted execution of the replacement is still pending.
- Four high-severity fast-uri advisories required version 3.1.6. The lockfile now selects that release. A forced frozen install and an AJV-resolved parser regression guard against stale nested copies. The unchanged audit passes with three existing allowlisted findings and six below its high-severity floor; it is not a zero-advisory result.
- Bun and Node supply different default JSON content types. Tests now check exact preservation of both explicit values and still reject all sensitive response headers. All 7,025 web tests pass under the same Bun runtime as CI.
- The real Hub worker test was in an unprepared browser-test lane. A private empty Podman store reproduces the missing-image failure. The unchanged test now belongs to both prepared host test sets, with a membership regression; five actual SQL/worker tests pass independently.
- The visual gate needed specific screenshot mappings. Real list/uninstall evidence and a controlled-backend Hub error scene now pass that gate. Reviewing those images exposed stale installation and modification controls; their correction and final screenshots remain in progress.

The patched-parser all-50 sweep passes without interruption at commit `3ee4f8cf`, tree `c2eb306b627df08ce696dbf7dc3e76a2854d4a8e` (`/tmp/ez-all50-fast-uri-patched.jsonl`, empty stderr). This supersedes the earlier baseline-plus-delta candidate proof for the parser change. Contract tests pass 23/291 assertions; SDK tests pass 1,023/2,332 assertions with actual Podman tests enabled. Backend run 14 passes 24,406 tests in 1,547 files before the Hub lane addition; its five tests pass separately. Plain-web run 11 passes 4,120 tests in 221 files after that move. Gate integrity still reports the same 84 migration findings; no approval label has been applied.

These are follow-up local results, not a claim that the next hosted CI run passes. The PR remains a draft.

## Final follow-up local checks

Product source is fixed at `362a0aec` (tree `e05dc0a3b7a4b32b346a041401ec21a5a5ddf2b9`). Later commits update browser tests and evidence only. Source imports now lead to candidate review instead of retired direct-install endpoints. Owners can prepare v4 revisions without an obsolete modification flag; the native-tool sentinel is not presented as an uninstallable extension. Updated screenshots were opened and reviewed.

- Full coverage run 4: 25,671 passing tests, zero failures, 1,535 shards; all 1,239 enforced source files pass (`/tmp/ez-ci-coverage-final4.log`).
- New-file and patch checks: all 126 new source files gated; changed executable lines in all 338 source files covered (`/tmp/ez-ci-new-file-coverage4.log`, `/tmp/ez-ci-patch-coverage4.log`).
- Same-runtime web suite: 7,029 tests in 543 files pass (`/tmp/ez-ci-bun-vitest-full2.log`).
- Updated browser cohorts: all 58 extension and notification tests pass together. The required mock lane also passes 210 tests with its 12 pre-existing skips (`/tmp/ez-ci-extensions-combined.log`, `/tmp/ez-ci-mock-gate-final3.log`).
- All nine actual authenticated/rootless extension specifications pass together after the UI changes, including the revised owner-edit path, explicit cancellation and protected scanner (`/tmp/ez-ci-real-final11.log`, 2.7 minutes).
- Types 47, Svelte check 3, lint 22, build 6, visual evidence and manifest-lock checks pass. Svelte still reports 13 warnings; lint still reports 105 warnings and 11 informational findings.
- Final production image `55ebd3389dbd68439956fd747fb7e3ba1f317d5ff8dd4f6ae2fbc5a1c9acb266` passes all eight actual checks (`/tmp/ez-container-ui-final-verify.log`).

The browser migration preserves test counts and current safety assertions. It does not restore destructive purge, mutable inline grants, generic Git installation, or the retired blanket credential-name rule. The migration document records those distinctions for human review.

## Full CI lane follow-up

The nine extension specifications above are a feature subset, not the complete authenticated CI lane. Running the exact complete lane collected 53 tests: 45 passed, four failed, and four did not run after serial failures (`/tmp/ez-ci-real-entire1.log`). This invalidates any claim that the complete browser lane was already green.

- Search and task-panel tests now explicitly import, build, review and activate their bundled sources. Each real three-test cohort passes. Search still proves provider results and SSRF denial. Task-panel still proves all five writes with real concurrent pairs below the unchanged worker cap.
- Caller-tool setup now uses a separate real member owner per case. The prior shared owner exhausted the unchanged per-user setup rate limit on fast local runs. Seven real cases and 38 route tests pass without sleeps or weaker limits.
- The factory form now waits for the actual save response before navigation. That exposed a real HTTP 404 after activation: event discovery was registered only at server boot. The production fix and the full factory flow remain pending.
- The new fixture's forbidden direct assertion import is corrected. The unchanged hydration gate passes six tests and 17 assertions. Unused optional Landlock probe helpers are removed; missing rootless isolation cannot become a conditional browser skip.
- The Ubuntu memory diagnostic failure is reproduced with Podman 4.9.3 and conmon 2.1.10. Changing only conmon to the verified upstream 2.2.1 binary makes the unchanged kernel test pass. The CI installer now pins its checksum and selected path. Hosted verification remains pending; see `gates/runner-ci-oom-monitor.md`.
- Two additional isolated browser repeats timed out before the preview server listened. Their earlier passing cases do not prove repeatability. Startup diagnosis and a complete final-lane rerun remain required.

Types 48 pass all four lanes. Lint 23 has no errors, 105 warnings and 11 informational findings. These checks precede the pending event-registration fix. PR 246 remains a draft; no failing gate is waived.

## Production runtime and workflow follow-up

The authenticated browser lane now launches the built production adapter, not Vite preview. An actual startup comparison recorded 53 successful Vite boots and two listener hangs; the exact unresolved promise was not identified. The production adapter passed 48 fresh boots. This is a runtime-fidelity change, not a claim to have fixed Vite.

The first complete production-adapter lane had 48 passing tests and five failures. Three native form flows encountered the adapter's default HTTPS origin while the test browser used HTTP. The test server now pins its trusted origin to the configured browser URL. An actual browser regression proves that a foreign-origin form remains denied and the matching-origin form redirects before the original cancellation assertions run. Production CSRF checks are unchanged. Two other failures exhausted the invitation acceptance limit during test account setup; fixture isolation remains under review, without changing that security limit.

At `740ee3aa`, the production image passed all eight real runner lifecycle checks, and disposable external PostgreSQL passed lifecycle, cancellation, effect-ordering and lock checks. At the `9bc2c893` tree, all 50 first-party candidates passed isolated build, tests and discovery again. These reports retain `unexercised` capability labels; they do not establish every live feature.

The latest complete backend run reports 24,381 passing tests and 30 failures in ten files. Review found outdated provenance fixtures and a real pure-workflow evaluation regression. Those failures must be resolved before final validation or another push. The web checks at `ecb2c178` pass: 7,041 Vitest tests in 543 files, and 4,120 plain web tests in 221 files. Svelte reports zero errors and 13 warnings. Full coverage and the corrected complete browser lane remain pending.
