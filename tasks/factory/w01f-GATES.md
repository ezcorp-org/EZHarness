# Gates: W01f event-stream detach leak

Scope: one product defect in `packages/@ezcorp/extension-runner/src/service.ts`, reported by
W18a-sdk as OPEN 2. Branch `wp/w01f-detach`, cut from `wp/w18a-sdk` at `9e7866e2b`; that branch has
since merged, so `integ/w00` at `850ffaa54` was merged in at `52bd86ddd` and **every gate below was
re-run on that merge**, with both coverage gates moved to `BASE_REF=integ/w00`. Receipts under
`/tmp/factory-platform-evidence/w01f/`; probe and reproduction sources are kept as `.ts.txt` under
`probes/`, raw logs under `logs/`. Pre-merge receipts keep their `final-*` names; post-merge ones
are prefixed `postmerge-`.

Against the new base the whole diff is five files: `service.ts`, the one new test file, and the
three task documents (`logs/postmerge-diff-stat.txt`). No pre-existing test file is touched
(`logs/postmerge-test-diff.txt`).

## The defect, reproduced before anything was changed

A host that drops its `/v4/events` stream never releases the worker's attachment, so no
replacement host can ever attach. Reproduced at `9e7866e2b` against the real service — real
`peer-gateway.py`, real Unix socket, real `node:http` client — for all four client close forms.
Receipt: `logs/repro-detach-leak.json`, script `probes/repro-detach-leak.ts.txt`.

| client close form  | attachment released? | observed |
|---|---|---|
| `request.abort()`   | no | still held at 26 042 ms |
| `request.destroy()` | no | still held at 26 042 ms |
| `socket.end()`      | no | still held at 26 035 ms |
| `socket.destroy()`  | no | still held at 26 037 ms |

Every `/v4/attach` from a replacement host answered `Worker is unavailable or already attached`,
including after the 20 s long poll had expired and answered. The attachment is held for the life of
the session.

## Root cause, measured on Bun 1.3.14

The six-line `detach` handler was unreachable because **Bun's `node:http` server delivers no
disconnect signal at all.** Measured, not assumed, with every candidate listener attached to the
same parked exchange:

| candidate | delivered? | receipt |
|---|---|---|
| `response.on("close")`, `request.on("aborted")`, `request.on("close")`, `request.on("error")`, `response.on("error")` | **none fire**, any close form | `logs/probe-node-http-signals.json` |
| `request.socket` / `response.socket` events, and `server.on("connection")` socket events | **none fire** | `logs/probe-node-http-signals.json`, `logs/probe-bun-serve-signals.json` |
| a write failure on the next event or heartbeat write | **never fails** — `response.write()` returned `true` five times for 320 KiB after the client was gone, headers flushed and body streaming | `logs/probe-node-http-streaming.json` |
| `Bun.serve` `Request.signal` | **fires**, ~10 ms | `logs/probe-bun-serve-signals.json`, `logs/probe-dead-host-process.json` |
| `Bun.serve` streaming `ReadableStream.cancel` | **fires**, same cases as the signal | `logs/probe-bun-serve-signals.json` |

Under `node:http`, `request.socket` is Bun's synthesized `Symbol(fakeSocket)` with no `_handle`,
which is why nothing at the socket layer is observable either (`logs/probe-node-http-internals.json`).

`Request.signal` on `Bun.serve` aborts for `request.abort()`, `request.destroy()`,
`socket.destroy()`, a **SIGKILLed host process** (12 ms) and a host that half-closes then exits
(9 ms). It does **not** abort for a pure half-close where the client stays alive and keeps reading —
which is not a disconnect: that client can still receive its answer. That one case, and any host
that simply stops collecting its stream, is what the attachment lease bounds. Measured through the
real peer gateway too: `logs/probe-serve-through-gateway.json`, `logs/probe-dead-host-process.json`.

## The fix

Serve the runner's private Unix socket with `Bun.serve` instead of `node:http`, and release the
attachment from `Request.signal` — the mechanism this runtime actually delivers. Add an attachment
lease for the one form the runtime reports nothing for. Both the poll window and the lease are
declared options with defaults and named refusals, and the lease must outlast one poll or a healthy
host would be evicted mid-poll. Nothing polls for a disconnect and no timer guesses at one.

**What renews the lease.** Every request from the host that holds the attachment: `/v4/events`,
`/v4/request` and `/v4/reply`. And while the host still owes a reply to a queued reverse call the
lease re-arms instead of releasing, because that call already carries its own timeout and deletes
itself when it expires. Without that, a host legitimately spending longer than one lease inside a
reverse call would have been evicted mid-work — the first version of this fix did exactly that, and
the controlled revert in G7 is what pins it.

A released attachment now answers nothing and keeps its whole queue, so a replacement host resumes
the reverse calls **and** the notifications. The previous code fell through after `detach` and
spliced the notifications out to a client that had already gone.

The v4 wire protocol is byte-identical: same paths, same bodies, same status codes, same error
codes and messages. Freeze section 6 (host launch, attach, stop) is untouched.

**Declared settings.** `eventPollTimeoutMs` default 20 000, range 100 ms – 5 min, refused by name
as `event_poll_window`. `attachmentLeaseMs` default 30 000, must exceed the poll window and stay
at or under 600 000, refused by name as `attachment_lease`.

**One control moved rather than lost.** `node:http`'s `maxHeaderSize: 4096` becomes an explicit
policy check in `handle`, because `Bun.serve` carries no header option; `maxConnections = 32`,
`headersTimeout` and `requestTimeout` were duplicates of bounds `peer-gateway.py` already enforces
on the only path an untrusted peer can reach (a 32-permit semaphore and a 360 s relay timeout), and
the private socket stays 0600 inside an owner-only `mkdtemp` directory. Bun's unix listener accepts
no `idleTimeout`; its type rejects the option.

## Gates

- [x] G1: The defect is reproduced end to end against the real service before any code changed.
  CHECK: `bun ./probes/repro-detach-leak.ts` at `9e7866e2b`
  EXPECT: every one of the four client close forms leaves `/v4/attach` refused past the long poll
  EVIDENCE: `logs/repro-detach-leak.json`, `logs/repro-detach-leak.meta.txt` (commit
  `9e7866e2bb4abd92bcda3fbf788a07b43219bb3a`, clean tree). All four still held at ~26 s.

- [x] G2: The signal the runtime delivers is measured, not assumed, and recorded with its Bun version.
  CHECK: the five probes under `probes/`
  EXPECT: a named mechanism, with the negative results for every candidate that does not work
  EVIDENCE: the five `logs/probe-*.json` receipts and the table above, all on `bun 1.3.14`.

- [x] G3: Each of the four host disconnect forms releases the attachment.
  CHECK: `bun test --timeout 30000 ./packages/@ezcorp/extension-runner/tests/service-detach.test.ts`
  EXPECT: exit 0; `attachments()` reaches empty for every form
  EVIDENCE: 9 pass / 0 fail, 92 assertions (`logs/final-service-suites.log`). Also end to end
  against the real service and gateway: `logs/verify-detach-release.json` — `request.abort` 251 ms,
  `request.destroy` 251 ms, `socket.destroy` 250 ms (the 250 ms sample interval is the floor, the
  signal itself fires in ~10 ms), `socket.end` 29 570 ms, inside the 30 s default lease.

- [x] G4: A replacement host attaches again after every release, and the queue survives.
  CHECK: same suite
  EXPECT: `/v4/attach` returns 200 after each release; a reverse call queued while detached is
  delivered to the replacement with its notification, and its reply settles the worker's promise
  EVIDENCE: `logs/final-service-suites.log`; `logs/verify-detach-release.json` reports
  `replacementReattached: true` for all four forms.

- [x] G5: A still-attached host is never released by another host's disconnect.
  CHECK: same suite, case "one host's disconnect never releases another worker's attachment"
  EXPECT: the surviving attachment stays, its stream completes, and it still carries events
  EVIDENCE: `logs/final-service-suites.log`. Run with a five-minute lease so the lease cannot be
  the cause of any release observed.

- [x] G6: A process whose hosts all disconnect holds no attachment afterwards.
  CHECK: same suite, case "a process whose hosts all disconnect holds no attachment afterwards"
  EXPECT: four workers, one of each close form, `attachments()` empty, all four reattach
  EVIDENCE: `logs/final-service-suites.log`.

- [x] G7: The release comes from the runtime's signal, not from the lease; the lease covers only
  what the runtime does not report; and the lease never evicts a busy host.
  CHECK: same suite, cases "…from the runtime's own signal, never from the lease" and "…half-closes
  and stops collecting is released within one attachment lease"
  EXPECT: with a five-minute lease the drop still releases inside the test budget; with a 600 ms
  lease the half-close releases and the worker itself is untouched; a host holding a reverse call
  across two lease periods keeps its attachment, its reply is accepted, and its next poll is served
  EVIDENCE: `logs/final-service-suites.log`. Controlled revert: removing the re-arm and running
  `-t "busy with a reverse call"` fails the case (`logs/controlled-revert-lease-rearm.log`), and
  the file was restored byte-identical.

- [x] G8: The six previously unreachable detach lines are covered and the changed file is 100%.
  CHECK: `bun test --coverage --coverage-reporter=lcov …/service.test.ts …/service-detach.test.ts`
  EXPECT: `service.ts` reports no missing line
  EVIDENCE: `logs/final-service-coverage.txt` — `service.ts lines: 220 hit: 220 missing: []` on
  the merged LCOV, and 183/183 from the two service suites alone.
  W18a-sdk measured the same file at 164/170 with exactly the six detach lines uncovered.

- [x] G9: Every existing assertion still holds and no wire behaviour changed.
  CHECK: the 16 light `extension-runner` and `extension-contract` suites, each in its own process
  EXPECT: all exit 0, including the five pre-existing `service.test.ts` cases unchanged
  EVIDENCE: `logs/final-light-suites.log` at `869ab1542`, and `logs/postmerge-light-suites.log`
  on the merge with `integ/w00`; every file exit 0 in both. No existing test file was modified: `logs/test-diff.txt`.

- [x] G10: Static gates.
  CHECK: `bun run typecheck`; `bun run lint`; `bun scripts/check-factory-boundaries.ts`;
  `bun scripts/gate-integrity.ts`
  EXPECT: all exit 0
  EVIDENCE: pre-merge `logs/final-typecheck.log`, `logs/final-lint.log`,
  `logs/final-boundaries.log`, `logs/final-gate-integrity.log`; on the merge with `integ/w00`,
  `logs/postmerge-typecheck.log` and `logs/postmerge-all.log` (lint, boundaries, gate integrity all
  exit 0). The four workspace packages were rebuilt after the merge before the typecheck, because
  consumers resolve their built `dist` types.

- [x] G11: The real-Podman producers that load this service still pass.
  CHECK: under `flock /tmp/ezcorp-validation-heavy.lock timeout 3600 …` —
  `./packages/@ezcorp/extension-runner/tests/podman.integration.test.ts`,
  `./packages/@ezcorp/extension-runner/tests/main.integration.test.ts`,
  `./src/factory/runner/supervisor.podman.integration.test.ts`,
  `./src/factory/package-preparation.podman.integration.test.ts`; second batch for the remaining
  runner integration suites
  EXPECT: every exit 0
  EVIDENCE: on the merge with `integ/w00`, all TEN producers in one lock acquisition under
  `flock --close`, lock held 00:14:19Z to 00:17:00Z, every exit 0, `SUMMARY postmerge_heavy_fail=0`
  (`logs/postmerge-heavy.log`, script `postmerge-all.sh.txt`): podman.integration 19 pass,
  main.integration 1 pass, supervisor.podman 2 pass, package-preparation.podman 1 pass,
  channel-identity 3 pass, provision 3 pass, binary-assets 1 pass, browser 1 pass,
  native-network 1 pass, podman-devices 6 pass, all 0 fail. The pre-merge runs are retained below.
  `logs/heavy-run-1.log`, `logs/heavy-run-2.log`, scripts kept as `heavy-run-*.sh.txt`.
  Batch 1 at `57a43bd54`, lock held 23:26:24Z to 23:28:19Z, every exit 0:
  `podman.integration` 19 pass / 0 fail / 103 assertions, `main.integration` 1 pass / 0 fail,
  `supervisor.podman.integration` 2 pass / 0 fail, `package-preparation.podman.integration`
  1 pass / 0 fail. `main.integration.test.ts` is the end-to-end proof: it boots the production
  `main.ts` service and drives the whole build and invoke API through the real client, covering
  171 of 186 lines of `service.ts` from that one leg; the supervisor leg covers 167.
  Three files were dirty during batch 1 — the two gitignored task documents and the test file whose
  timing fix landed at `869ab1542` — and none of the four producers loads any of them;
  `service.ts` was committed and clean. Hashes: `logs/heavy-run-1-tree-state.txt`.

  Batch 2 at the final head `10a1170b3`, clean tree, lock held 23:48:22Z to 23:49:09Z, every exit 0:
  `channel-identity` 3 pass, `provision.integration` 3 pass, `binary-assets.integration` 1 pass,
  `browser.integration` 1 pass, `native-network.integration` 1 pass,
  `podman-devices.integration` 6 pass, all 0 fail.

  Batch 2 waited sixteen minutes because the lock was held by an ORPHAN rather than a producer:
  `/proc/locks` named PID 3470529 as the holder, that PID no longer existed, and PID 3530151, an
  orphaned `temporal-test-server` reparented to PID 1 with the w00-integration
  factory-orchestrator open, still held its inherited descriptor. It belonged to another worker, so
  it was reported to the coordinator rather than killed (`logs/stuck-lock-report.txt`); the
  coordinator cleared it and added `flock --close` to the common brief so a spawned child can never
  inherit the lock again. Neither of my two batches orphaned anything: both released the lock at the
  timestamps above and the queue moved on. The archived `heavy-run-*.sh.txt` are the scripts as
  executed, so they still read plain `flock`; any later run of them should carry `--close`.

- [x] G12: Coverage of every new file and every changed executable line, against this branch's base.
  CHECK: `BASE_REF=wp/w18a-sdk bun scripts/check-new-file-coverage.ts`;
  `BASE_REF=wp/w18a-sdk bun scripts/check-patch-coverage.ts`
  EXPECT: both exit 0
  EVIDENCE: on the merge with `integ/w00`, `logs/postmerge-new-file-coverage.log` ("no new source
  files in this diff") and `logs/postmerge-patch-coverage.log` ("all changed executable lines
  covered (1 file(s))"), both with `BASE_REF=integ/w00`, over the merged LCOV in
  `logs/postmerge-merged-lcov.info` (26 legs, 597 source files,
  sha256 `a1a7752c86e9817710da113065b9e57487b21ba5a20f0ac027d03763248fa1be`), on which `service.ts`
  reads 188/188 lines with none missing (`logs/postmerge-service-coverage.txt`). The pre-merge run
  against `BASE_REF=wp/w18a-sdk` is retained at `logs/final-*-coverage.log`. No threshold lowered, no `EXCLUDES` entry, no
  `.skip/.only/.todo`, no `biome.json` opt-out. The one changed source file is already covered by
  the wildcard key `packages/@ezcorp/extension-runner/src/**: 100`, and the one new file is a test
  file, which both gates classify as non-source, so no threshold key was added.

## One failure observed, and what was done about it

**No test was removed.** No case and no assertion was deleted in this package. One assertion moved
between two cases, and the three checks below settle it in ten seconds:
`git show 1fff3badf:<test file> | grep -oE '^test\("[^"]+'` lists eight case names and the same
grep at HEAD lists nine — all eight originals verbatim, plus the busy-host case that `57a43bd54`
added with the product correction it guards; `grep -c 'expect(' <test file>` returns 43 at
`57a43bd54`, 43 at `869ab1542` and 43 at HEAD; and the runtime banner's drop from 95 to 92 is
fully explained by the move, because the assertion used to run once per drop form inside a
four-iteration loop and now runs once (4 − 1 = 3, 95 − 3 = 92). Report section 8 has the one-line
diff and the full account.

The light sweep at `57a43bd54` recorded `8 pass / 1 fail` in `service-detach.test.ts` while the
same file passed seconds earlier and in twelve re-runs afterwards, six of them concurrent. The
sweep script did not retain the failing file's output; that is a defect in my harness and it is
fixed in the same change, so a future failure is diagnosable.

It was not treated as flakiness. The run's own counter says the failing case executed exactly four
fewer `expect()` calls than a full pass, and the per-case counts (measured, `logs/expect-counts.txt`)
narrow that to a case that stopped at its fourth assertion. Two of the nine cases have an assertion
in that position, and both were assertions that hold only while a short attachment lease has not
yet expired — the duplicate-`/v4/attach` probe in the disconnect table, and the "still attached"
assertion in the busy-host case. A lease that can expire while the test is still setting up is a
test measuring the host, which `tasks/lessons.md` forbids.

So the dependence was removed rather than the symptom retried. Every case that is not about the
lease now runs with a five-minute lease that cannot fire; the four that must observe a lease expiry
use 3000 ms, which no setup of a dozen Unix round trips can exhaust; and the exclusivity probe
moved out of the disconnect table into a case whose lease cannot fire at all. No assertion was
weakened, removed, retried or given a longer timeout. Ten concurrent copies of the file then passed
(`logs/concurrent-stability.log`). The original failure is retained at
`logs/observed-flake-light-suites.log` with this diagnosis.

## What this does not change

- No `/api/*` route, no migration, no schema, no shared store.
- No file outside `packages/@ezcorp/extension-runner/` was edited.
- `RunnerClient` is untouched: it already reopens a connection per call and already treats a failed
  poll as a closed attachment, which is exactly what a released attachment now produces.
