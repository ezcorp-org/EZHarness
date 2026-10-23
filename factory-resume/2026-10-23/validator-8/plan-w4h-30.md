# validator-8: W4H-30 validation plan (prepare only; wait for the owner's R1)

Package: the intermittent "Production proof (resources)" red — scripts/verify-shipping-runtime-resources.ts:305 "Cycle 9 app
socket descriptors grew above the first lifecycle sample" (PR 341 attempt 2, ci 38525604869, job 115726707532). Team-lead's
class: C-candidate pending root cause; first suspect W4H-26's boot-time background work (built-in staging; the
package-preparation role's poll and connections). No re-run of the hosted job until the root cause is named.

## Fact for the design (read 2026-10-14)
- The same check failed WITHOUT any W4H-26 code: ci 38069395442 (dependabot/bun/earendil-works/pi-agent-core-0.99.2,
  272e768aa, 2026-10-10): "Cycle 10 app socket descriptors grew above the first lifecycle sample". 272e768aa does not contain
  W4H-26's 34d592140 and has no runner-install.ts. Also 37986983940 a1 and a2 (2026-10-09): "Cycle 1 runner FDs 26 did not return
  to baseline 25" (a sibling check). Over the last 40 ci runs: 4 failures in 41 completed attempts of this job.
- integrator-5's attempt-2 samples: app sockets 431 at cycles 4-8, 432 at cycle 9; against the warm sample two sockets were
  replaced by reconnects and one added; established TCP stayed 1.
So the reproduction must show the rate WITH and WITHOUT W4H-26 before W4H-26 is named the cause.

## Legs (runner-shaped container per my W4H-18/W4H-22 harness copies; podman only; own storage/PostgreSQL if the shard needs
them; heavy under gated-flock)
V1 Two-arm reproduction, my own runs: the resources shard as ci.yml runs it, on main 1981febd2 (no W4H-26) and on the PR
   head d2add3048, N runs each (N set from the rate: at ~10 % per run, 20 runs per arm give a useful difference), each run its
   full cycle count, every sample kept. Record the failure count per arm.
V2 Socket ownership per sample: for each app socket at each cycle, its owner (the fd's socket inode mapped to its peer and
   to the code path: database pool, Temporal client, the package-preparation poll, staging, the host-launch client, HTTP
   keep-alive). The growing sockets at the failing cycle are named by owner, and judged leak (monotonic, never returned)
   or legitimate transient (a reconnect that replaces one, or a bounded pool filling).
V3 Root cause and fix at the root: the owner's named cause matches V2's owner evidence. A fix in the product code (close,
   reuse, or bound the owner's sockets); then the head arm's failure count over the same N runs must drop to 0 (or below
   the main arm's, with the cause of any remainder named).
V4 No widening of the check: scripts/verify-shipping-runtime-resources.ts thresholds, sample points and cycle count unchanged
   (diff check). A change to the check only with team-lead's ruling, its reason stated, and a test that a real leak (a
   socket opened per cycle and never closed) still fails it.
V5 A deterministic test for the fix (not a timing test): red with the fix reverted, green with it. Mutant on the fix: the
   socket owner's close/reuse removed -> the deterministic test red, and the resources shard red within N runs.
V6 Gates: identity first; red-first by assertion; gate-integrity main = exactly 0; lint; typecheck by the tc rule; the hook-mapped
   suites with lcov and 100 percent of changed lines; the invariant-test list (w00/invariant-tests.txt); CRAP.

## Verdict
ACCEPT when the cause is named from owner evidence, the fix removes it at the root (head arm 0 failures over N runs, or a
named remainder), the check is not widened, and the deterministic test and mutant hold. If V1 shows the same rate on main
without W4H-26, the cause is not W4H-26's and the scope needs team-lead's ruling before any fix.

## Addendum A (2026-10-14): team-lead's ruling — class E, pre-existing; W4H-30 is the root-cause fix of the check, not a PR 341 gate
- PR 341 may merge on a green attempt 3 with the user's word; W4H-30 lands in a later PR.
- Fix options allowed: fix the app's connection lifecycle (the owner of the growing sockets), OR sample after quiescence, with
  the evidence. Never a bare tolerance. V4 reads accordingly:
  - A sampling change is allowed only with owner evidence that the extra sockets are legitimate transients (reconnects that
    replace sockets, a pool filling to its bound) and with a quiescence condition that is itself checked (for example: no
    socket in a transient state, or the owner's pool at rest), not a sleep or a count margin.
  - A test proves the check still fails a real leak after the change: a socket opened per cycle and never closed fails it
    within the cycle count, on the new sampling.
  - Mutant: the quiescence condition removed (or the lifecycle fix reverted) -> the deterministic test red.
- V1 keeps both arms (main 1981febd2 and a head with W4H-26) to measure the rate before and after the fix; the fix is judged on
  the head arm going to 0 failures over N runs, with the main arm as the before-rate.

## Addendum B (2026-10-14): R1 accepted — a legitimate transient; W4H-26 excluded; R2 = lifecycle fixes, no check change
Owner evidence (W4H-18 harness, 3 passes x 10 cycles at d2add3048; /proc/<pid>/net per sample): the app's sockets are the
port-3000 listener, 1-2 unix connections of RunnerClient's node:http keep-alive pool (new inodes each cycle; the runner's
listener has no idle timeout), the proof's own inbound keep-alive, and a boot-only HTTPS keep-alive to api.kilo.ai from
warmKiloCatalog. Hosted cycle 1 = listener + inbound + 1 runner connection; cycle 9 = + a second pooled connection.
R2 checks:
- (a) RunnerClient `agent: false`: a fresh unix connection per call, closed at response end. Red-first: a deterministic test
  "no client socket stays open after calls settle" (red with the pool, green with agent: false). Mutant: the pool restored ->
  that test red. Latency before/after measured by the owner AND by me (the RunnerClient call path, same runs, median and p95);
  I judge whether the per-call connect cost is material for the product's call rate.
- (b) warmKiloCatalog keepalive: false with a test (red with keep-alive). Mutant: keep-alive restored -> red. The boot must not
  call api.kilo.ai in CI tests beyond what it did before (no new network dependency).
- (c) The check (scripts/verify-shipping-runtime-resources.ts) and the proof unchanged (diff check), unless a transient remains,
  then only by Addendum A's rules.
- V1/V2: my own two-arm runs (main 1981febd2 and the fixed head), ~20 runs each, sockets by owner per sample. Expected: both
  arms show the same runner keep-alive transient before the fix (main included: the pool is older than W4H-26), and the head
  after the fix shows a constant socket set across all cycles and 0 failures.
