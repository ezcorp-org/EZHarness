# W4H-9: the extension runner stays compatible with hosts from before the attach handshake

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4h-9.md`. Owner w4h-1, branch `wp/w4h-9` off integ/w00 `104cb2237` (integ moved from
a5b0866e0; the runner and the upgrade scripts are identical between the two). Evidence root: `/tmp/factory-platform-evidence/w4h-9/`
(report.txt). Origin: W4H-1 side finding 2 (hosted run 37138524741, Production proof (recovery), historical-upgrade).

Cause: 11b9f72b9 "feat(factory): recover surviving runner effects" changed the runner protocol in two ways that break every host from
before it (the 3ec53eaa app image that the historical-upgrade proof seeds). The old app reports any runner error as
`operation_failed` (3ec53eaa src/extensions/v4/lifecycle.ts:180-181), so the hosted log showed no cause.
1. A started session was unattached (service.ts:168) and `/v4/events` refused it until `/v4/attach` (service.ts:197, :234-238). The old
   client never attaches: its first poll got `unknown_worker`, it cancelled its worker, its request failed "Worker closed".
2. An unanswered reverse call was returned on EVERY poll until its reply (kept for a replacement host). The old client answers each
   delivery without awaiting and polls again at once, so it answered one call several times; the second reply got `unknown_request`
   ("Host reply ID is stale or invalid") and the old client cancelled its worker. Break 2 was hidden behind break 1 and showed only in
   the logged rerun after fix 1.

Breaks introduced, one line each (both by 11b9f72b9, confirmed with `git log -S` on the two code lines; no later commit added one):
- Break 1: /v4/events refused until /v4/attach. Pinned by "a host that never calls /v4/attach still polls its events and completes a
  forward request" and "the 3ec53eaa RunnerClient completes a forward request it sends after its first event poll". Fixed by 0498c0a52.
- Break 2: an unanswered reverse call returned on every poll. Pinned by "the 3ec53eaa RunnerClient answers each reverse call once and
  keeps its worker". Fixed by 02c53fb7a.

The start claim in two sentences: the host that starts a worker is attached by the start itself, and that attachment stays unclaimed
until the starter's first /v4/attach (accepted, not refused) or /v4/events. Once claimed, or once released, the old single-holder rule
applies unchanged: a second attach is refused and a released or woken worker needs an explicit /v4/attach.

Fix (both in packages/@ezcorp/extension-runner/src/service.ts):
1. 0498c0a52: start attaches the session for its starter, as an unclaimed start claim. The starter's first `/v4/attach` (idempotent, not
   refused) or `/v4/events` claims it; after that the single-holder rule is unchanged. A release clears the claim, so a released or
   woken worker still needs `/v4/attach`. What attach does beyond the flag (lease deadline, lease arming, release on a dropped poll, no
   host identity in the protocol) is unchanged; the window in which another authenticated caller could take an unclaimed start
   attachment is the same window that already existed between start and attach.
2. 02c53fb7a: each reverse call reaches an attachment once (a per-attachment delivered set). A poll with nothing new parks. A release
   clears the set, so a replacement holder still receives every unanswered call; a reply retires its entry.
No protocol versioning was needed: neither change alters what a current client sees (it attaches before its first poll and awaits each
reply before polling again).

Request sequence of the old app's seed build (stderr logging in a scratch copy, never committed):

| Call | Before (104cb2237 base, upgrade-sf2) | After fix 1 only (0498c0a52, log-run) | After both fixes (02c53fb7a, log-run2) |
|---|---|---|---|
| /v4/inspect, /v4/build, /v4/artifacts, /v4/start | 200 | 200 | 200 |
| /v4/events (first poll) | 400 unknown_worker | 200 | 200 |
| /v4/request extension/discover | 400 cancelled "Worker closed" | 200 | 200 |
| /v4/reply (first) | - | 200 | 200 |
| /v4/reply (same call again) | - | 400 unknown_request | (not sent) |
| next /v4/request | - | 400 cancelled "Worker closed" | 200 |
| upgrade (semantic only) | exit 1, operation_failed | exit 1, operation_failed | exit 0, seed, candidate and restore asserted |

- [x] G1: R1 red first, two levels. CHECK: (a) `bash unit.sh red-r1a` at 104cb2237 with the two new cases, then `bash unit.sh red-r1a-reverse` at 0498c0a52 with the third; (b) the gated E2E upgrade run (semantic only, podman) at the base EXPECT: (a) "a host that never calls /v4/attach…" 400 unknown_worker "Worker event stream is unavailable or already attached"; "the 3ec53eaa RunnerClient completes a forward request it sends after its first event poll" rejected "Worker session closed"; "the 3ec53eaa RunnerClient answers each reverse call once…" answered 6 times, not 1; (b) exit 1, operation_failed EVIDENCE: unit-red-r1a.log, unit-red-r1a-reverse.log, r1b-e2e-red/ (the 21:23Z run at d341d8690; the runner and upgrade scripts are identical at 104cb2237, so it stands as the base red), r3c-e2e/ (exit 1 at 0498c0a52 with fix 1 only)
- [x] G2: R2 fix at the root. CHECK: 0498c0a52 (start claim) and 02c53fb7a (once per attachment); hook EXPECT: no recovery test changed or weakened; hook 1 suite each (service-detach.test.ts 13/0, then 14/0) EVIDENCE: commit1.log, commit2.log, hook-mapped-c1.txt
- [x] G3: R3 green. CHECK: (a) the three new cases; (b) every recovery and attach test; (c) one gated E2E upgrade run at 02c53fb7a EXPECT: (a) 14/14 in service-detach.test.ts; (b) unit: client-reattach, service-detach, service, ext-dev, runner-connection, host-launch-supervisor 45 pass 0 fail; podman: main.integration 1/0, podman.integration 19/0, provision.integration 3/0, host-launch-transport.integration 6/0, supervisor.podman.integration 2/0; (c) exit 0, seed, candidate upgrade and backup restore asserted EVIDENCE: units-green2.log, units-coverage.log, r3b-integ.log, r3b-integ/*.log, r3c-e2e-2.log, r3c-e2e-2/controller.log, r3c-e2e-2/exit (0)
- [x] G3d: the full historical-upgrade lane (not semantic only), "if runnable locally". OPEN: queued at 23:02Z, the inner gate saw a 1-minute load of 10.0 to 16.7 at every try until 23:18Z, so it never started (r3d-full.log); stopped by me at 23:22Z to commit this file, re-queued at the docs head. The hosted "Production proof (recovery)" after the next push is its proof of record. — closed locally by validator-6 (verdict-validator-6-w4h9-r3d.txt f54bdc118cdab08f, receipt a5c5afebe; run w4h-9/r3d-full-3, exit 0, "UPGRADE VERIFIED", semantic stages plus Phases 1-5 at c49f4b727). The hosted historical-upgrade lane remains the CI-side proof.
- [x] G4: legs at 02c53fb7a. CHECK: checks.sh EXPECT: patch coverage PASSED (service.ts), new-file PASSED (no new source file; the fixture lives under tests/), CRAP changed max 18 (startRunnerService), dispatch 16, collectEvents 6, all at 100% coverage and under 30; typecheck, lint, boundaries 0; gate-integrity vs origin/main = the expected 8 label findings (findings-match PASS) and vs integ/w00 PASSED; guard set 39 files 477 pass 0 fail EVIDENCE: checks-02c53fb7a.log, checks/*.log, checks/gate-integrity-integ.log

- [x] G5: the attach rules the start claim must keep, pinned by name (17d1762fd; hook 1 suite, service-detach 16/0). CHECK: the two cases
  below, and a mutant without the claim-clearing line on attach EXPECT: both green at the head; the mutant fails "after the starter claims
  its worker, a second attach is refused" (and one existing case) EVIDENCE: commit4.log, unit-pins.log, unit-mutant-claim.log, units-at-17d1762fd.log (six suites 47/0)

Detach and reattach tests by name, all green at 17d1762fd (service-detach.test.ts and client-reattach.test.ts):
- "every host disconnect form releases the worker attachment and a replacement host attaches again"
- "a dropped connection releases the attachment from the runtime's own signal, never from the lease"
- "a host that half-closes and stops collecting is released within one attachment lease"
- "one host's disconnect never releases another worker's attachment"
- "a process whose hosts all disconnect holds no attachment afterwards"
- "a released attachment keeps every queued reverse call and notification for the replacement host"
- "a host busy with a reverse call is never evicted while it still owes a reply"
- "a host waiting inside a long forward request is never evicted while that call runs"
- "a caller that does not hold the stream cannot renew the attachment lease"
- "an event poll window or attachment lease outside its declared range is refused by name"
- "oversized headers, an absent body and an unknown endpoint are each refused"
- "a host that never calls /v4/attach still polls its events and completes a forward request"
- "the 3ec53eaa RunnerClient completes a forward request it sends after its first event poll"
- "the 3ec53eaa RunnerClient answers each reverse call once and keeps its worker"
- "a released worker refuses an event poll until a host attaches it again"
- "after the starter claims its worker, a second attach is refused"
- "a host takes its event stream back after a refusal it did not cause"
- "a host stops polling when the worker itself is gone rather than retrying forever"
Also green: tests/service.test.ts, src/__tests__/ext-dev.test.ts, src/extensions/runner-connection.test.ts,
src/factory/runner/host-launch-supervisor.test.ts, and the five podman suites under G3.

Notes:
- The fixture tests/runner-client-3ec53eaa-fixture.ts is the 3ec53eaa RunnerClient byte for byte except two import paths; it is frozen.
- Scratch logging copies (.worktrees/w4h-1-sf2, .worktrees/w4h-9-log) were never committed and are removed; their diffs are kept
  (w4h-1/upgrade-sf2/scratch-logging.diff 2b243a7c022b7c03, w4h-9/log-run2/scratch-logging-at-02c53fb7a.diff 1b36aea97e36bd76).
