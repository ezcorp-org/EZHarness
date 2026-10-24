# Incus continuation — 2 October 2026

The inspection failure is not yet resolved on the live server. This continuation adds safe diagnostics and fixes the saved browser test failure. Network access and socket creation are unavailable in this session, so live state, browser execution, hosted CI, and PR publication remain unverified.

## Saved live state

The last confirmed live result is from 25 September, not a new server observation:

- App bundle `8213297a0` passed detached-database startup and guarded installation.
- CREATE `ca4d3c6b-de37-4d2a-ba00-8a243fe3124d` and START `9b7b0246-e9ef-4b6d-b899-78f9d975c39a` both reached `SUCCEEDED` without duplicate requests.
- Guest `ezh-3706fb480a240548bcf13974451b200d` was running. The app reported desired and observed state `RUNNING/RUNNING`.
- The next owned-smoke `inspect` returned HTTP 409 `smoke_unavailable`. No marker or Compose command followed it.

Recheck these identities and current state before any further live action. Do not create a replacement guest or repeat START to clear the inspection error.

## Changes and review

Commit `b26c13a28` scopes the two lifecycle status assertions to the disposal and fixture-cleanup messages. The capacity panel legitimately has another status element. The assertions still require the intended result to be visible.

Commit `7d9cb50a2` keeps the smoke route's HTTP 409 and adds fixed `failureStage` and `failureReason` values. Recognized reasons require a host-owned `IncusLiveWitnessError` and an exact allowlisted message. Other exceptions return `unknown`. Raw error messages, commands, credentials, and backend responses are not returned. The witness checks and authorization rules are unchanged.

Review covered the typed producer/consumer boundary, a plain error impersonating an allowlisted message, unknown errors containing a secret canary, missing fixture status, and stopped-workspace refusal. These diagnostics identify the failed check on the next live request; they do not establish the current live root cause.

## Local validation

JavaScript checks used `/home/dev/.bun/bin/bun`, version **1.3.14**. Ambient Bun 1.4.2 results are not pinned-version evidence.

| Check | Result |
| --- | --- |
| Smoke route tests | 10 passed; 60 assertions |
| Focused real witness error test | 1 passed; 4 assertions; 13 unrelated tests filtered |
| Full witness suite in the worker | 12 passed; 2 blocked at Unix-socket creation with `EPERM` |
| Bundle Python suite | 13 passed; 2 blocked at socket creation with `EPERM` |
| Repository lint | Passed; 4,894 files |
| Full typecheck, including test types | Passed |
| Production build | Passed |
| Management Playwright collection | 6 tests collected; execution not run |
| Diff whitespace check | Passed |

Commands: `bun run lint`, `bun run typecheck`, `bun run build`; from `web/`, `bun test ./src/routes/api/infrastructure/incus/smoke/smoke.test.ts`; from the repository root, `bun test ./src/infrastructure/incus-host-live-witness.test.ts --test-name-pattern 'inspection rejects a backend state'` and `python3 scripts/incus/stage-release-bundle.test.py`.

The full suites with socket errors did **not** pass. Their tests and gates were not removed or weakened. The worker bypassed its advisory commit test hook after recording the socket restriction; this is not a full-check result. The integrated source passed the separate checks above.

## Recovered browser evidence

The saved capture used commit `5841cd1e1`, tree `1f6a43b9bc2f858514568e9b05d218f7fcc9ef28`:

| Lane | Saved result |
| --- | --- |
| Mock gate | 259 passed |
| Mock product | 1,441 passed |
| Visual evidence | 393 passed |
| Fresh setup | 7 passed |
| Real authentication | 116 passed; 1 failed |

The failure at `web/e2e/real-auth/incus-management.spec.ts:190` matched two status elements. Its selector is corrected in `b26c13a28`, but the browser rerun is pending.

Saved log: `/tmp/ezh-incus-browser-coverage.kGkcMS/run.log`, SHA-256 `820aa27f5e67dc0e43008829410fae7727553d51841b89e8ba9068ebc1f32f57`. Saved browser LCOV: `/tmp/ezh-incus-browser-coverage.kGkcMS/receipts/merged/lcov.info`, SHA-256 `657303c6c9a97d7083e41642fc54bd453968eb36e80e06805ad9d4f01c8d254c`.

This failed-lane capture is historical evidence, not a passing current-head coverage receipt. It measured the management page at 226/263 hit lines, the capacity panel at 77/87, and the project sandbox panel at 39/40. The management page's 37 missing lines are:

`105, 131, 150–151, 170–171, 184, 192, 197–198, 200, 204–208, 225, 249, 268, 274–275, 277, 279, 284–286, 291–292, 321–322, 324, 421, 468, 484, 494, 496, 519`.

Canonical coverage assigns this scripted route to browser coverage. Component tests cannot fill those page gaps under the current gate. Capacity/component coverage can merge through its normal lane. API routes require their separate backend coverage; their absence from browser LCOV is expected.

## Next work

1. Restore an execution environment with server/GitHub access and local TCP/Unix sockets. Recheck the active app, approved provider, saved operations, and guest. No new Incus setup or provider release is required solely for these host-side diagnostics.
2. Build and verify the updated app bundle, preserve its database and existing guest, and install it through the guarded app procedure. Do not reuse old process IDs or stale preflight observations.
3. Read the same fixture's status and inspection result. Use the fixed diagnostic fields to reproduce and fix the actual cause before marker, Compose, stop/resume, and disposal.
4. Finish live qualification, project tool routing, retention/cleanup, security checks, and repeated feature lifecycles. Keep the [live gates](../../gates/incus-live-pr303.md) open until their evidence exists.
5. Cover the remaining browser recovery paths, rerun all five lanes and the full exact-head coverage gates, then push and verify PR #303. Do not mark the draft ready from local unit tests alone.
