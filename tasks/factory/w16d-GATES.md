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
- Part B (on integ 1a80d3977, after W09f's merge, because W09f changes
  `src/db/connection.ts`): a bounded closeDb that lists the connections still
  open, and the close of a replaced pool also bounded.
- Part C (with part A, coordinator ruling 2026-09-27): a per-teardown deadline
  in `shutdown.ts` with a named log line, so the forced exit names the culprit
  if it ever happens again (coordinator ruling item 3).

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
  NOTE: with G5 the pin is `FACTORY_WORKER_STOP_DEADLINE_MS < TEARDOWN_TIMEOUT_MS`; the shutdown suite pins the drain plus one teardown deadline under `HARD_TIMEOUT_MS`.

- [x] G4: Part B. All shutdown deadlines live in `src/shutdown-deadlines.ts` (FACTORY_WORKER_STOP_DEADLINE_MS 5 s, DB_POOL_CLOSE_DEADLINE_MS 3 s, DB_OPEN_CONNECTIONS_QUERY_DEADLINE_MS 2 s, TEARDOWN_TIMEOUT_MS 6 s) with one `withinDeadline` helper that the worker stop, the teardown loop and the pool closes share. `closeDb` gives the Bun.sql pool 3 s; past that it logs "Bun.sql pool close did not finish within its deadline; the pool is left to the process exit" with the connections still open (pid, state, wait event, query) read by one bounded side query on a fresh one-connection pool, then clears its state. A replaced pool's close is raced against the drain time plus 3 s; a close that never returns is reported and no longer blocks every later replacement.
  CHECK: `bun test ./src/shutdown-deadlines.test.ts ./src/db/swappable-bun-sql.test.ts ./src/__tests__/cov-fix-connection-postgres.test.ts`
  EXPECT: exit 0; on the merge-commit modules the two new tests hang to their timeouts (red first)
  EVIDENCE: `/tmp/factory-platform-evidence/w16d/receipts/red-first-closedb-base.log`, `red-first-replace-base.log`, `focused-b.log` (172/0), `web-b.log` (33/0), `typecheck-b.log`
  MERGE: integ 1a80d3977 merged as b9bbd1f12 under the coordinator's skip ruling (48 mapped suites, all green outside the hook: 45 plain 980/0, 3 PostgreSQL under the lock 12/0; `/tmp/factory-platform-evidence/w16d/merge-1a80d3977/`)
- [x] G5: Part C. Each shutdown teardown gets `TEARDOWN_TIMEOUT_MS` (6 s); one still running then is logged by name ("teardown timed out; continuing", `{ name, ms, timeoutMs }`) and shutdown moves on, so the database close still runs. The forced-exit line lists the unfinished teardowns by name (`pending: [...]`) instead of the registered count. `DRAIN_TIMEOUT_MS + TEARDOWN_TIMEOUT_MS < HARD_TIMEOUT_MS` is pinned.
  CHECK: `cd web && bunx vitest run src/__tests__/shutdown.server.test.ts src/__tests__/factory-boot.server.test.ts`
  EXPECT: exit 0 (28/0); on the base module the three new tests fail, and the deadline test hangs to its 5 s timeout (red first)
  EVIDENCE: `/tmp/factory-platform-evidence/w16d/receipts/red-first-shutdown-base.log`
- [x] G6: Hold: PostgreSQL (pool replacement, migrate lock), focused suites with lcov, web vitest with lcov, boundary suites, coverage against 1a80d3977 (100 percent on changed lines and new files), typecheck, lint, factory boundaries, gate integrity.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 5400 bash /tmp/factory-platform-evidence/w16/repro/leaf-hold.sh /tmp/factory-platform-evidence/w16d/hold-config.sh <label>`
  EXPECT: every leg exit 0
  EVIDENCE: hold d3 at 05f6fdc13 (17:01:38Z to 17:02:55Z), `/tmp/factory-platform-evidence/w16d/receipts/d3/`, failed=[]: pg 2/0/0 skip (2 files), focused 172/0 (8 files), web 33/0 (2 files), process boundaries 48/0 (2 files), merge-lcov 1313 files, new-file coverage PASSED (1 new file gated, 14 of 14 lines), patch coverage PASSED (8 files), typecheck, lint, factory boundaries and gate integrity 0; 14 gate readings: disk 120 GB, memory 16 to 17 GiB, swap free at least 6.9 GB. Earlier: d1 at 23dc9ef53 green (parts A and C); d2 at 9a5cad419 red on the new-file gate only (the threshold key, added at 05f6fdc13).

## Known limits (validator-2, low)

- Because `replacing` resets once the replaced pool's close passes its bound, a long run of driver desyncs can leave one abandoned pool behind every 33 s or more (30 s drain plus the 3 s close bound), each holding its connections until the process exits. `recoverFromDriverDesync`'s 10 s interval and the close bound limit it; no code change.
