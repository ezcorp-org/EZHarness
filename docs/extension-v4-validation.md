# Extension v4 validation

## Result

The rewrite runs in a separate worktree on `feat/extension-v4`. The original working directory is unchanged. Runtime checks pass. This is not a claim that the system has no possible defects.

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
| `bun run --cwd web test:component` | 7,024 tests in 543 files pass | `/tmp/ez-extension-v4-vitest11.log` |
| `bun run build` | Production build passes, including final preview CSS | `/tmp/ez-v4-build-final5.log` |
| `bun run test:coverage` | 25,657 tests pass; zero failures; 1,239 enforced files pass | `/tmp/ez-coverage-parent-final3.log` |
| `bun scripts/check-new-file-coverage.ts` | All 126 new source files are gated | `/tmp/ez-new-file-coverage-final3.log` |
| `bun scripts/check-patch-coverage.ts` | All changed executable lines in 338 files are covered | `/tmp/ez-patch-coverage-final3.log` |
| Mock browser CI lane | 210 pass; 12 pre-existing skips | `/tmp/ez-mock-gate-final2.log` |
| Actual authenticated extension browser lane | All nine specifications pass together | `/tmp/ez-extension-v4-real-final10.log` |
| Source lock verification | Pass | `/tmp/ez-source-lock-final.log` |

The full backend and plain-web wrapper results are recorded in `gates/final-validation.md`. The coverage run includes the newly wired tests in the required pass/fail set; the shared file list prevents a coverage-only test from losing its pass/fail gate.

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
