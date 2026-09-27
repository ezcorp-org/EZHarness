# W16d — bounded shutdown

Owner: w16-continue (coordinator ruling 2026-09-27: a new leaf for the two
harness shutdown hangs found in W16's lifecycle holds; not W16c). Branch
`wp/w16d-bounded-shutdown` from `integ/w00` at `146a94829`. Evidence:
`/tmp/factory-platform-evidence/w16d/`.

## Defect

W16's hold r3 streamed every harness with `podman logs -f -t`
(`/tmp/factory-platform-evidence/w16/diagnostics-at-failure/streams-2026-09-27T085148.075Z/`).
Of 23 harness stops, 9 did not finish their teardowns and were force-exited
(exit 1) by the harness's own 25 s hard timeout (`HARD_TIMEOUT_MS` in
`web/src/lib/server/shutdown.ts`). Before the stop grace was raised to 30 s,
the container runtime killed the same stops with exit 137: 5 in hold f6 and 8
in hold f7.

- Pattern A (6 of 9): `factory-runtime` never logs "teardown ok".
  `runtime.stop` awaits every worker's in-flight step with no bound
  (`src/factory/background-workers.ts`), so one step that ignores its abort
  signal holds the process until the forced exit.
- Pattern B (3 of 9): every teardown finishes, then `pglite-close` (closeDb,
  the Bun SQL pool close) never returns.

In both, the forced-exit line reports `pending=14` (the number of registered
teardowns), so it does not name the teardown that hung.

## Scope

- Part A (this round): a bounded per-worker stop that records each role's stop
  time and names a stuck role.
- Part B (after W09f merges, on top of its pool replacement, because W09f
  changes `src/db/connection.ts`): a bounded closeDb that logs its still-busy
  backends, and the drain of a replaced pool also bounded.
- Part C (with part B): a per-teardown deadline in `shutdown.ts` with a named
  log line, so the forced exit names the culprit if it ever happens again
  (coordinator ruling item 3).

## Gates

- [x] G1: A worker whose step ignores its abort signal cannot hold its stop past a deadline (`FACTORY_WORKER_STOP_DEADLINE_MS`, 5 s). The stop resolves with `{ name, ms, settled: false }`; the worker stays `running` and `stopping` until the step returns, then releases itself; a second loop cannot start beside it.
  CHECK: `bun test ./src/factory/background-workers.test.ts`
  EXPECT: exit 0; on the base module the two stuck-step tests time out (red first)
  EVIDENCE: `/tmp/factory-platform-evidence/w16d/receipts/red-first-workers-base.log` (3 fail at 146a94829's module: two time out at 5 s, one fails on the record shape)

- [x] G2: The worker set stops in reverse registration order under one shared deadline and resolves with one record per role. One stuck role is named and does not hold up the others. At shutdown, the parent signal has already aborted every worker, so waiting for them one at a time would only add the deadlines together.
  CHECK: `bun test ./src/factory/background-workers.test.ts ./src/factory/runtime-composition.test.ts`
  EXPECT: exit 0

- [x] G3: The harness's `factory-runtime` teardown logs one line with each role's stop time ("[factory] roles stopped", `{ ms }`), or an error line naming the stuck roles ("... left running past the stop deadline", `{ stuck, ms }`). A test pins `DRAIN_TIMEOUT_MS + FACTORY_WORKER_STOP_DEADLINE_MS < HARD_TIMEOUT_MS`.
  CHECK: `cd web && bunx vitest run src/__tests__/factory-boot.server.test.ts src/__tests__/shutdown.server.test.ts`
  EXPECT: exit 0

- [ ] G4: Part B, the bounded closeDb with busy-backend logging, after W09f merges.
- [ ] G5: Part C, the per-teardown deadline with a named log line in `shutdown.ts`.
- [ ] G6: Hold: focused suites with lcov, web vitest with lcov, coverage against 146a94829 (100 percent on changed lines), typecheck, lint, boundaries, gate integrity. Runs on the coordinator's go.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 5400 bash /tmp/factory-platform-evidence/w16/repro/leaf-hold.sh /tmp/factory-platform-evidence/w16d/hold-config.sh <label>`
  EXPECT: every leg exit 0
