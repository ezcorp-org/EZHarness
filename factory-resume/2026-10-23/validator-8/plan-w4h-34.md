# validator-8: W4H-34 validation plan — W17 outbound sender, metrics, alerts (prepared from the brief; extended later)
Brief w00/briefs/w4h-34.md 93a819890f6cb5ec. Branch wp/w4h-34-w17-notifications-metrics from 390c49a90. Standing rules:
plan-common-w4h-32-36.md 147bb9ec215b3a14 (S1-S10).

V1 Rows first: C11 alerts with operator actions; the sender contract (destination kinds, payload shape, redaction,
   retry/lease bounds, settlement codes).
V2 Sender on the durable queue (W01 pattern): leases and bounded retries (the bound by test; a mutant with an unbounded retry
   -> red); webhook first. Exactly-once logical delivery under re-drive: a test with a crash between send and settle (a real
   process kill, not a mock) -> the receiver sees the logical notification once (idempotency key); mutant: key dropped -> two.
V3 Readiness: notification-send stays HELD with its reason until a sender is configured AND confirmed one delivery to the
   local receiver; then running. Cases: no sender -> HELD; sender configured, no delivery -> HELD; confirmed -> running;
   mutant: running on configuration alone -> red.
V4 Metrics: every factory metric enumerated by a test; label sets bounded (no run id; tenant only where already bounded);
   a test fails on an unbounded label (mutant: add runId label -> red); no secret or run id in any metric or payload
   (marker strings).
V5 Alerts: every C11 rule shipped for both deployment profiles and verified by FORCING its condition against a real evaluator
   (Prometheus rule evaluation in Podman or the project's evaluator), not by reading YAML; one forced-condition record per
   alert; mutant: a rule's threshold inverted -> its forced test red. [H]
V6 Delivery proof: a local receiver in Podman receives the approval and the uncertain-release notifications; inbox actions
   through the public API; operator actions keep authority and uncertainty. No real external endpoint, person or device. [H]
V7 Security: payload redaction tested (a secret in the source event never in the payload); webhook target credentials only
   by reference.
Verdict per S10. REJECT on: duplicate delivery under re-drive; an unbounded label; an alert verified only by reading; a
real external send.

## Addendum A (2026-10-16, validator-8): owner report 1 (inventory, rows N1-N9 / M1-M4 / A1-A9) and team-lead's rulings
Existing: factory_notifications DurableDeliveryStore (kinds approval_requested, command_approval_requested,
release_uncertain, release_settled; "delivered" = in-app only); durable-delivery-queue (expired lease -> outcome_unknown at
claim; backoff 1 s x 2^(n-1), cap 60 s); role seam notification-send; inbox public API; no /metrics, exporter, rules or
Prometheus image. Rulings: N7 a sender-only re-queue counts as an attempt (default unchanged, with a mutant); N8 yes; SMTP
out; Prometheus pulled once BY DIGEST, removed by name, stop on HTTP 429.
Checks by row (rows committed before code, S2):
- N1 outbox factory_notification_sends unique per (notification, destination): a second insert for the same pair is a no-op
  (constraint test); mutant: constraint removed -> duplicate test red.
- N2 destinations: HTTPS only (http:// refused by name); caPath used for a private CA (the Podman receiver's own CA); a URL
  with userinfo refused; smtp refused by name; mutants: userinfo accepted; http accepted -> red.
- N3 signature: HMAC-SHA256 over "<timestamp>.<body>"; the secret read by file path (0600; never in env, argv, logs); headers
  Delivery-Id and Idempotency-Key; the receiver verifies; mutants: timestamp not signed (a replayed body with a new
  timestamp passes) -> red; secret from env -> red. I ask how a receiver bounds replay (timestamp tolerance) and check it.
- N4 payload factory.notification.v1: an allowlist, <= 4 KiB (a test at 4 KiB + 1 refused/trimmed by name); no run id, no
  context, no digest, no secret: an enumeration test over every kind with marker values in the source event.
- N5 lease 30 s + heartbeat, request timeout 10 s, maxAttempts 8, expiry: each bound by a test (a fake clock is fine for the
  arithmetic; one real-time case for the heartbeat); mutant: maxAttempts unbounded -> red.
- N6 settlement codes: every code reachable by a test, by name.
- N7 exactly-once logical delivery under re-drive: a REAL process kill between send and settle (not a mock); the receiver
  logs 2 physical, 1 logical (dedup by Idempotency-Key); mutant: key regenerated per attempt -> 2 logical; the sender-only
  re-queue counts as an attempt (ruling) with a mutant that does not count it.
- N8 readiness: notification-send HELD with its reason until the first DURABLE confirmed delivery (survives a restart:
  confirmed, restart, still running; HELD -> running only after a 2xx from the receiver is recorded); mutant: running on
  configuration alone -> red.
- N9 redaction: a secret-shaped value in a source field never reaches the payload or a log (marker test).
- M1 declarative metrics registry with closed label sets: an unknown label value is refused or dropped and counted (the drop
  counter itself is a metric); M2 no run/attempt/digest/URL labels, tenant only on pool families; M3 the families list =
  the code (enumeration test); M4 scrape behind a bearer token read by path; a request without it -> 401; the token never in
  a metric or log. Mutants: a runId label added -> enumeration test red; a URL label -> red; scrape without token -> red.
- A1-A9 alerts: one source rendered for both profiles, a drift test (rendered files = committed files); verification by
  promtool rule tests (firing, not firing, the edge) AND a live Prometheus in Podman scraping a real harness with the
  condition forced; one record per alert. Mutants: a threshold inverted -> its promtool test red; one profile's render
  edited by hand -> drift test red. [H]
- Delivery proof [H]: the local HTTPS receiver in Podman gets approval_requested and release_uncertain; inbox actions through
  the public API; no external endpoint. Images by digest only; the Prometheus image and the receiver removed by name after
  (by the owner; I check the listing); a 429 stops the pull with no retry loop.

## Addendum B (2026-10-16, validator-8): owner report 2 (rows 66d507aae, sender c134d90d9) and team-lead's rulings
Facts: N7 amended: a reclaim counts as an attempt; at the limit -> dead letter attempts_exhausted. Queue: claim option
expiredLease "reclaim", sender-only; the default (outcome_unknown) unchanged. Real PostgreSQL suite: 12 tests, stable over 4
runs (fan-out once per pair; expiry; command deadline; signed send; 5xx/429/unreachable/timeout retries under one key; 4xx and
exhausted -> dead letter; destination_removed; corrupt rows; confirmation across restart; two re-drive tests: a lapsed lease
reclaimed with delivery_lease_lost to the stale owner; a real child SIGKILLed between the receiver's receipt and the settle
-> the next sender re-sends with the same Idempotency-Key and delivery id: physical 2, logical 1, attempts 2). Readiness:
HELD with the pending reason until the first durable delivered row, then running; an unreadable or short secret or an
unreadable CA -> HELD with a typed cause, the role does not run. Disclosure: the sender module was written before its unit
test file (missing-module reds); team-lead ordered assertion-level reds (Idempotency-Key removed -> 2 logical; the
confirmed-delivery check removed -> running early; reclaim for all -> the default test fails). Ruled: no sandbox-escape
producer exists, so A8 covers cross-tenant broker denials only; sandbox_escape is out of the label set; a leftover line.
Single-file isolated PostgreSQL suites may run lock-free.
Checks added:
- B1 order: 66d507aae precedes c134d90d9 (rows, incl. the N7 amendment).
- B2 the missing-module reds do not count (S3); the three ordered assertion-level reds are re-run by me on c134d90d9 with
  each change reverted in my snapshot: Idempotency-Key removed -> the SIGKILL test shows 2 logical; the confirmed-delivery
  check removed -> readiness running before a delivery; reclaim for all callers -> the default outcome_unknown test fails.
- B3 the SIGKILL re-drive test is a real child process killed by SIGKILL between receipt and settle (I read the test: no
  mock of the kill, no in-process shortcut); the receiver's log shows the same Idempotency-Key and delivery id twice.
- B4 the reclaim counts as an attempt: attempts 2 after one reclaim; at maxAttempts a reclaim gives dead letter
  attempts_exhausted; mutant (team-lead's earlier ruling): a reclaim not counted -> red.
- B5 stability: I run the 12-test PostgreSQL suite 4 times in my snapshot against my own PostgreSQL (lock-free allowed for a
  single-file isolated suite); any failure = flake finding.
- B6 readiness: HELD -> running only after a durable delivered row; a restart after the first delivery stays running;
  unreadable/short secret and unreadable CA -> HELD with a typed cause and the role not started (no send attempted:
  receiver count 0).
- B7 metrics sources: each family's source is a bounded aggregate from the product database (I read each query: GROUP BY
  only bounded columns; no run id); sandbox_escape absent from every label set (ruling) and the leftover line present.

## Addendum C (2026-10-16, validator-8): owner report 3 (metrics 9de360e75; alert rules A1-A10; A8 correction)
Facts: 9de360e75 metrics M1-M4: one registry with closed label sets (strict mode throws; production drops and counts);
installation collector (bounded SQL, zero-filled states); pool collector (tenant label only from the pool's configured
tenants, <= 100); one node:http /metrics listener with a bearer token by file path on harness, pool, gateway and supervisor
(an endpoint that cannot start is reported by code and skipped); new-file gate 8 files, patch gate 23 files; hook 12 suites.
Orchestrator /metrics uncommitted (node --test 7/7). Delivery states and pool state lists moved into two small Node-safe
modules re-exported by the queue and the ledger. Alert rules: src/factory/observability/alert-rules.ts is the one source for
deploy/factory/prometheus/factory-alerts.yml and a PrometheusRule; a drift test pins the shipped files; each rule's condition
and action equal the C11 table text word for word (a test reads the contracts document); 27 forced cases; unit 7/7.
Evaluator leg (lane "Factory deployment and operations"; check-factory-lanes 44/44): promtool check + test; per-rule inverted-
condition mutants; a live Prometheus scraping a real installation listener over the proof PostgreSQL (quiet -> no alert; all
forced -> all 10 fire with C11 annotations). Prometheus pinned docker.io/prom/prometheus@sha256:87861b8c... (v3.13.4).
Correction: A8 counts forbidden_host only (token_audience_refused is not cross-tenant); label set cross_tenant_broker only.
Checks added:
- C1 strict vs production: strict mode throws on an unknown label value; production drops it and increments the drop
  counter (a test for each); mutant: production mode lets the unknown value through -> the enumeration test red.
- C2 tenant bound: the pool collector's tenant label comes only from the pool's configured tenants and never exceeds 100
  (a test with 101 configured tenants: refused or capped by name); mutant: tenant read from the event row -> red.
- C3 listener: one node:http listener implementation (git grep for a second); the bearer token read by file path (0600),
  never in env, argv, a metric or a log; no token -> 401; an endpoint that cannot start is reported by code and skipped
  (the role still runs; the readiness or log names the code).
- C4 one source per list: the two Node-safe modules are the only definitions of the delivery states and the pool states;
  the queue and the ledger re-export them (git grep for a second literal list).
- C5 C11 word-for-word test: it reads the contracts document at test time (not a copy); mutant: one word of a rule's
  action changed in alert-rules.ts -> red; one word changed in the contracts table -> red.
- C6 drift test: the shipped factory-alerts.yml and the PrometheusRule equal the render of alert-rules.ts byte for byte;
  mutant: a hand edit of the shipped YAML -> red.
- C7 evaluator [H]: promtool check and test pass; each per-rule inverted-condition mutant fails its promtool test; the live
  Prometheus (pinned by digest, v3.13.4; image removed by name after) scrapes a REAL installation listener: quiet -> no
  alert; all forced -> all 10 fire, each with its C11 annotation; one record per alert.
- C8 A8 correction: A8 counts forbidden_host only; token_audience_refused does not reach A8 (a test sends one and A8 stays
  quiet); the label set is cross_tenant_broker only; sandbox_escape absent (ruling).
- C9 orchestrator /metrics (when committed): its Node coverage leg in the lock; the same registry (no second registry).

## Addendum D (2026-10-16, validator-8): the owner's review findings, ruled fixed before the freeze (red first by assertion)
Findings (code reading by the owner's review agent): (1) one bad notification stops all outbound sends for good: identifier()
is stricter than releases.ts text(); a payload or decode error throws before any send row, on every pass; (2) retry
exhaustion dead-letters with the retry code (webhook_status_5xx) instead of attempts_exhausted (N6/N7); (3) the fan-out NOT
EXISTS has no covering index and rescans every delivered notification per step; minors: a dead-lettered claim leaves
claimedAny false (the worker idles while due rows wait); the deduplication id's ":" separator can collide with a project id
that contains ":"; a misplaced doc comment. Rulings: a per-row catch -> dead_letter notification_payload_invalid (row first)
while sendOne runs regardless; one shared identifier validation for the sender and the store; exhaustion mapped to
attempts_exhausted (in the sender's settle path, or a queue option that leaves other callers' codes untouched); a probe on
deduplication_id + an index migration on the four columns (also the FK) + an expiry skip; claimedAny counts dead-letter
progress; a safe separator or a length-prefixed dedup id.
Checks added (each red first on the head before the fix, by assertion):
- D1 poison row: one notification with an invalid identifier/payload among good ones: the good ones are all sent in the same
  pass (receiver count), the bad one is dead-lettered with notification_payload_invalid, and a send row exists for it first;
  the next pass does not stall. Mutant: the per-row catch removed -> red (good rows not sent).
- D2 one identifier validation: the sender and the store call the same function (git grep for a second rule); a value that
  releases.ts text() accepts and the old identifier() refused now passes both, or both refuse it by the same code.
- D3 exhaustion: an 8th attempt that fails with 5xx dead-letters with attempts_exhausted (not webhook_status_5xx); other
  queue callers keep their codes (a test on a non-sender caller). Mutant: the mapping removed -> red.
- D4 index: the migration adds the index on the four columns (and the FK index); EXPLAIN (on PostgreSQL, with enough rows that
  the planner prefers it, or with enable_seqscan off as a check of usability) shows the index used by the fan-out probe;
  mutant: the index removed -> the EXPLAIN plan changes to a sequential scan (the test asserts the plan node). Expired rows
  are skipped. Schema drift clean; the migration is reversible or forward-only as the project's rule says.
- D5 claimedAny: a claim that dead-letters counts as progress; with one dead-letter row and one due row, the worker handles
  both without idling (a test on the loop's return value).
- D6 dedup id: two notifications whose project ids differ only around ":" (for example "a:b"+"c" vs "a"+"b:c") get different
  ids (red with ":" join); the new form is a safe separator or length-prefixed; existing rows: the report says whether a
  migration of stored ids is needed and why not if none.
- D7 the doc comment moved to the right function (read).

## Addendum E (2026-10-16, validator-8): 7e5f02888 and 1ef163a04; the port collision; a lock lapse; commit consistency
Facts: 7e5f02888 alert rules for both profiles, the fleet host's Prometheus service, metrics ports and token delivery, hosted
PodMonitors + PrometheusRule, a runbook section; the first host metrics ports collided with the Temporal HTTP route (+1004)
and the ingress (+1005) -> moved to +1006/+1007/+1008, with FACTORY_FLEET_PORT_OFFSETS as the one table and a distinctness
test. 1ef163a04: an unsendable or corrupt notification is recorded once in dead letter instead of blocking the fan-out (D1);
projection lag per run; the M4 test (one scrape of all five services over HTTP; every series checked against the registry; no
identifier, no marker secret). Gates over 390c49a90..HEAD: new-file PASS (10 files), patch PASS (31 files at 7e5f02888);
factory boundaries, gate-integrity, biome, tsc (63 TS files) clean. DISCLOSURE (rule lapse): at ~00:37Z a lock-free bun test
over two directories included the bound evaluator test, so Prometheus was pulled by digest (one pull) and promtool
containers ran outside gated-flock; no container left; the promtool case failed there (the gated leg records why); correction:
explicit test paths only. Ruling: each commit stands alone; at 7e5f02888 the provisioner renders a metrics key into
orchestrator.json while the parser lands later, so the owner folds/reorders (non-interactive rebase; no integrator squash).
Checks added:
- E1 ports: FACTORY_FLEET_PORT_OFFSETS is the only offset table (git grep for a literal +100x elsewhere); the distinctness
  test covers EVERY offset in the table (Temporal HTTP, ingress, the three metrics ports and the rest); mutant: a metrics
  offset set back to +1004 -> red. Red first: the distinctness test fails on the first port choice (the report or my
  re-run).
- E2 each commit stands alone: for every commit in 390c49a90..HEAD after the reorder I run build:packages + typecheck +
  the commit's hook-mapped suites in my snapshot (a loop over git rev-list); the metrics-key render and its parser are in the
  same commit or the parser first. [H] for typecheck if under 16 GiB lock-free.
- E3 the promtool case: the gated leg's record names why it failed in the lock-free run (for example the container's network
  or file paths); it passes in the lock; no promtool or Prometheus container exists after the gated leg (names-only listing).
- E4 the lapse: recorded in the owner's lessons ("explicit test paths only; never a directory that contains a bound test");
  I check that every later lock-free run in the owner's logs names explicit files.
- E5 1ef163a04's dead letter "recorded once": a corrupt row dead-letters once (a second pass adds no second record).
- E6 M4 scrape: the test reaches all five services over real HTTP with the bearer token; an unregistered series fails the
  test (mutant: a stray metric added -> red).
Chain before the reorder (2026-10-16, owner's correction): 66d507aae rows, c134d90d9 sender, 9de360e75 metrics, 7e5f02888
rules + evaluator config, b9e97069e coverage keys, 1ef163a04 fan-out fix + scrape test. The fold/reorder changes these hashes
before the freeze; E2 runs on the reordered chain, and I map each new commit to its old content with git range-diff.

## Addendum F (2026-10-16, validator-8): team-lead's ten review findings at 1ef163a04, ruled fixed before the freeze
Rule for all ten: red first by assertion on 1ef163a04 (I re-run each red in my snapshot), green at the head, the named mutant
red; a C11 row change precedes its code (git log) and the word-for-word C11 test moves with it.
F1 dedup id ':' collision (= D6): project "a:b" + "c" and "a" + "b:c" give two ids; the fix either forbids the separator in
   the identifier rule (one shared rule, D2) or hashes/length-prefixes the parts; mutant: the old ":" join -> red; the report
   states whether stored ids need a migration.
F2 decodeSend inside claimCandidate: a corrupt SEND row (mismatched input_hash) is dead-lettered ONCE and the queue goes on:
   the next due send goes out in the same or the next step (receiver count); the corrupt row is not claimed first on every
   step (a step counter test); mutant: the decode error rethrown -> red.
F3 hosted scrape targets (kubernetes-profile.ts:272): a target per factory service INCLUDING the supervisor; the selector's
   port name equals W4H-35's DaemonSet port name (I read both files; a test renders both and compares the name); the false
   comment fixed; the forced-condition evaluator run shows up{job="factory-supervisor"} = 1 in the hosted render. Merge note:
   W4H-35 owns the DaemonSet; a name change on either side must red the comparison test.
F4 FactoryNotificationSendStuck (alert-rules.ts:82): no longer fires for ever on dead_letter > 0: a growth form (for example
   increase over a window) or a resolution path; C11 row + word-for-word test first; on the REAL evaluator: an old dead
   letter only -> quiet; a new dead letter -> fires; promtool cases for both; mutant: the old "> 0" -> the quiet case red.
F5 fan-out (= D4): the anti-join uses an index (or an indexed deduplication_id probe); EXPLAIN on PostgreSQL asserts the plan
   node; refreshConfirmation runs once until confirmed, then is cached (a counting spy over N steps after confirmation: 0
   further calls); mutants: index removed -> plan node changes; cache removed -> spy count > 0.
F6 projection lag (installation-metrics.ts:92): a missing sequence no longer reads 0: LEFT JOIN or a gap gauge; test: cursor 4,
   next existing 10, batch 5 missing -> lag non-zero (and the gap gauge, if added, names the gap); mutant: inner JOIN back ->
   red.
F7 factory_service_ready (gateway-process.ts:85): derived from real health, not a constant 1; test: database unreachable ->
   0, back -> 1; mutant: constant 1 -> red. I list every other service's ready gauge and check none is a constant.
F8 shutdown abort (notification-sender.ts:489): an abort at shutdown releases the lease and records NO attempt and no
   webhook_unreachable; test: abort mid-send -> attempts unchanged, the row claimable again; mutant: counted as an attempt ->
   red.
F9 scrape single-flight (metrics-listener.ts:75): two concurrent scrapes share one collection (a counting spy: one run of the
   ~17 queries); a scrape after the first finishes runs a new collection (no stale cache beyond the in-flight one); mutant:
   single-flight removed -> two runs.
F10 render cost (metric-registry.ts:166): one output array, Sets built once per family per render; a test with 1,024 series
   asserts a bound (allocation or time bound with a margin that a quadratic render exceeds; I check the bound is not so loose
   that the old code passes: the old code must fail it, red first).
Integrator note (recorded, not a W4H-34 check): W4H-34 and W4H-35 both touch installation-startup, pool/process,
supervisor-process, runtime-composition, startup-config (+ tests, + the contracts document); the second merge reconciles;
I compute resolution-lines.py on that merge and require coverage of every line that differs from both parents.

## Addendum G (2026-10-16, validator-8): a premature "frozen" at 2f5e253af; legs so far; two defects; what the real freeze needs
Team-lead ruled W4H-34 NOT frozen at 2f5e253af: F1-F10 (Addendum F) not mapped or done; the stand-alone fold (1d3a1b8ed's
orchestrator-parser part into 7e5f02888) pending; its typecheck wrapper was queued against the lock order.
Legs so far (owner): evaluator leg w4h34-evaluator3 exit 0 (promtool 27 forced cases; each of 10 inverted rules fails its cases;
a live Prometheus on the shipped self-hosted config over a real PostgreSQL installation: quiet = no alert, all 10 fire when
forced, each with its C11 action and tenant label; proof/live-alerts.json, forced-conditions.txt); delivery leg w4h34-delivery2
exit 0 (a real approval request and an uncertain release reach the Podman receiver once each, signed, no run id/tenant/secret;
re-drive and a sender restart add nothing; inbox actions keep authority and uncertainty). In-lock commit 1d3a1b8ed hook green;
Node coverage 102; static clean; new-file 10, patch 33 PASS (Bun + Node merged). Commits so far: 66d507aae, c134d90d9,
9de360e75, 7e5f02888, b9e97069e, 1ef163a04, afcb2d169, 380d3c568, 1d3a1b8ed, 2f5e253af (gate file + requirement rows C04.12,
C11.5-7). Leftovers it names: SMTP refused by name; the sandbox_escape detector (A8 on broker denials only, ruling); hosted
supervisor /metrics on loopback; the hosted profile rendered + unit-tested only; proofs bound to the factory-real lane. The
Prometheus image removed by name.
Two defects the legs found:
- afcb2d169: Prometheus ran as nobody and could not read umask-077 files (also in the shipped Compose service) -> keep-id as the
  fleet user, dir 0700. Checks: red/green as recorded; mutant: the nobody user back -> the evaluator leg (or a unit test of the
  rendered service: user, userns keep-id, 0700) red because the files are unreadable; the shipped Compose service file carries
  the same user setting (one renderer, both profiles).
- 380d3c568: a validator streak of plain failures never counted (NULL inside bool_and ignored; a fixture stored JSON wrongly and
  hid it). Checks: reds in proof/try1, try2 read; a test with a NULL in the streak set counts it (mutant: the old bool_and form
  back -> red); the fixture now stores JSON as the product does (a test that reads it back through the product's parser).
At the real freeze (in addition to Addenda A-F):
- G1 a manifest F1..F10 -> commit(s) and test name(s), each red first by assertion (re-run by me) and its mutant red.
- G2 the fold: git range-diff old..new shows only 7e5f02888 (gains the orchestrator-parser part) and 1d3a1b8ed (loses it) change
  in content; the rest differ by parent only; tree equality before/after the fold; then E2 (each commit stands alone) over the
  folded chain in one locked job.
- G3 the typecheck in the lock (not lock-free) at the frozen head, output read.
- G4 the evaluator and delivery legs at the frozen head (or a tree-equality proof that their inputs did not change).
Ruling (2026-10-16): three distinct causes, three codes: notification_payload_invalid, notification_payload_too_large,
factory_notification_corrupt; each a C11 row covered by the word-for-word test. Check: each code has its own forcing test
(an invalid payload; a payload over 4 KiB; a corrupt stored row) and its own C11 row; the word-for-word test reads all three.
D6: no migration (the table is new in this package, never shipped) — accepted. The owner's wrapper ran ahead of the push at
04:20:58Z against the lock order (disclosed; recorded).

## Rebase job pre-check (validator-8, 2026-10-16T22:45:48Z): NOT OK yet, two required changes
Staged: rebase-in-lock.sh b13b113c4d7ebdee, launch-rebase.sh f0dd606d72146a3b (w4h-34/rebase/), stop-shapes.py 548582ae8438a4a0,
leg-evaluator.sh d86507fdc69f0bd1. Form: W4H-32's 6c0708a0d6fe474a / a54b0df83360a7ef (diffs *.diff-vs-w4h32.txt read).
Good: frozen df0002770 on wp/w4h-34-w17-notifications-metrics, 25 commits from 390c49a90; INSIDE = c586125ab must be in the integ head;
proof ref kept; the two commits made on the new base are checked to touch one file each (factory-provisioning.test.ts;
check-factory-lanes.ts); the modelProvider test is red first at assertion level on a mutated fleet-cli.ts line, file restored and
checked; PG URL built in a child shell, never printed; graph mock pass included; expect-main = 6e315f8400142f3f.
Required:
R1 REBASE_STOPS=resolve. Team-lead's rule for the post-W4H-33 rebase was "a stop is reported, not resolved". Resolve mode needs
   team-lead's explicit ruling for W4H-34 (five verified shapes via stop-shapes.py; each stop recorded as stop-N-conflict.txt and
   stop-N-resolved.diff; ALLOWED_DIFF defaults to the five files). If ruled, I judge every stop record after the job.
R2 Step 6 removes the Prometheus image by name whenever it exists (podman image exists && podman rmi), but leg-evaluator.sh pulls
   it only when it is absent. If another session pulled it first, the job removes an image it did not create. Fix: the leg records
   'pulled by this job' and the removal runs only then.
Notes, not blocking: mock-lib.sh e900108ea6abd4c0 is W4H-32's afd7f9a2c3cb9505 plus one header line (DRY: source that file);
the storage-secrets lookup is a second copy of mock-lib's (DRY). The dry run dry-20261016T224324Z: 4 stops, DIFFERENT = 3 of the
five allowed files.
expect-main facts for team-lead's ruling: W4H-32's informational main leg at c586125ab (which contains W4H-32's changes) was exactly
the 3 lines of 6e315f8400142f3f, so W4H-32 adds no origin/main finding; on my facts the set for W4H-34 stays these 3 lines.
- Team-lead's six pre-check items (2026-10-16T22:50:03Z): (1) stop-shapes.py 548582ae8438a4a0 OK: my planted cases (w4h34-shapes/) refuse 2 hunks for a 3-hunk shape, a wrong hunk, a sixth file and an unknown commit (exit 1, named), and pass the verified shape; resolve-stop.sh aborts the rebase on its refusal. (2) check-titles.sh: NOT OK as written: it subtracts every title the range removed, so a test title the range deletes with no replacement passes. Today the range removes 1 title (deployment.test.ts, the 6705f04d8 rename), adds 9. Required: a removed title passes only as a named rename pair (old -> new, the new title among the added), else TITLES DIFFER; a planted delete must fail. (3) the two in-job commits: one file each checked in the script; 25 + 2 = 27 checked. (4) Prometheus image docker.io/prom/prometheus@sha256:87861b8cf915...: digest-pinned but from docker.io; the team rule forbids a Docker Hub pull without the team's mirror (the mirror is the user's open item): the evaluator leg cannot run as staged; another source (for example the same digest from another registry, if the publisher pushes it there) or a ruling is needed. Plus R2 (remove only if this job pulled). (5) expect-main: facts sent (W4H-32 adds no main finding; the rename is a changed test, gate-integrity flags deleted FILES, not titles). (6) dry-20261016T224324Z read as stated (4 stops; DIFFERENT 3 of the five; titles ok on 5 files with removed 1 / added 9).
- R2 re-check OK (2026-10-16T22:51:26Z): rebase-in-lock.sh e2312a57f6972ca7 (diff vs b13b113c4d7ebdee: removal through remove-pulled-image.sh 9140393ca8841d94; W4H-32's mock-lib.sh sourced, pinned at afd7f9a2c3cb9505); leg-evaluator.sh 06813d8980b91941 writes the mark only after its own pull; the removal runs only when the mark names the same image; dry-check-r2.sh 3c3452297b00c8ab: 4/4 ok, exit 0. launch unchanged f0dd606d72146a3b. Still open: R1 (stop mode), R3 (titles: named rename pairs only), R4 (Prometheus from docker.io without mirror), expect-main ruling.
- Ruled (team-lead, recorded 2026-10-16T22:53:12Z): R1 stop mode = resolve, bounded by stop-shapes.py to the five verified shapes keyed by commit and file; every stop recorded; any other stop aborts; I read every stop record after the job. expect-main = the 3 lines of 6e315f8400142f3f. R4: one more in-job commit moves the Prometheus pin to quay.io/prometheus/prometheus@sha256:87861b8cf91579109319ebc300f3f1060e6da9c05d6ae8ad15a20c879e84e32e in scripts/test-images.json and deploy/factory/compose/host.yml, with the compose-profile test holding them equal. Re-check at the new hashes: R3 (titles named rename pairs), the pin commit (two files, same digest, verified manifest), the commit count then 25 + 3, the in-job commit file checks extended.
- R3 OK and quay commit read (2026-10-16T22:54:25Z). check-titles.sh fa28dcbbcb9992ff: a removed title passes only as a named pair in title-renames.txt 8f14218e1442f422 (one pair, deployment.test.ts four->seven ports) with the new title among the added; dry-check-r3.sh 163592446b613a67 exit 0: real range ok on 5 files; a planted deletion (unreferenced commit) and the real rename with an empty list both TITLES DIFFER, exit 1. MISMATCH in the owner's message: rebase-in-lock.sh is NOT e2312a57f6972ca7 on disk but 7e40b1afbf3d5c71 (written 22:53:20Z; e2312 kept as .bak-...-before-quay): it adds team-lead's ruling-4 quay commit: apply-quay-pin.py 375d06ca92ae690d moves the pin in test-images.json, host.yml and the evaluator test's precondition pattern (3 files; the commit check lists exactly these); red first: test-images.json alone makes compose-profile fail at assertion level, restored, then green; a pull by the hook is recorded so removal stays R2-safe; commits on the base 25 + 3; install moved before step 3. Digest verified by me read-only: HEAD https://quay.io/v2/prometheus/prometheus/manifests/sha256:87861b8c... = 200, docker-content-digest equal, manifest list. Needed: a dry run of 7e40b1afbf3d5c71 (DRY skips the in-job commits, so the range part) and the owner's corrected hash list; then the job may run with EXPECT_JOB=7e40b1afbf3d5c71.
- Rebase job pre-check OK (2026-10-16T22:56:27Z): STAGED rebase-in-lock.sh 6e79832ceb38860a, launch-rebase.sh 18e442fbef5556a1 (25 + 3 = 28), check-titles.sh fa28dcbbcb9992ff. Diff vs e2312a57f6972ca7 (77 lines; = the owner's rebase-in-lock.diff-quay.txt): the quay commit (apply-quay-pin.py 375d06ca92ae690d, 3 files, red first), the install + web install + build:packages moved before the in-job commits, the count +3, the commit file checks; nothing else. Version history in script-hashes.txt: 7e40b1af and 891a9ce2 were never staged or dry-run. Dry run dry-20261016T225353Z header script-sha=6e79832ceb38860a: 4 stops, 6 conflicted files all 'verified shape' (stop-shapes), 25 commits identity ok, DIFFERENT = 3 of the five, titles ok on 5, DRY DONE. dry-check-quay.txt: red exit 1 on the test-images-only mutant (pattern matches), green 56/0, clean after restore. Digest on quay verified by me (HEAD 200, equal digest). EXPECT_JOB=6e79832ceb38860a for team-lead's word; the job then runs after the W4H-32 publish with base = the W4H-32 merge commit. After the job: I read every stop-N-conflict.txt / stop-N-resolved.diff, the three in-job commits and the mock pass.

== 2026-10-17T05:31:31Z team-lead: the w4h-34 watch predicate was stale (it named c586125ab, the pre-rebase W4H-32 head; that head landed as 13c439661 and merge ba9acd166, so the predicate could never be true). Owner: stop its watch by pid, replace the script by mv with the predicate "7f8317656 and ba9acd166 are ancestors of integ/w00, plus push16 push.exit 0", re-arm, and report the old and new hashes. Its rebase job (EXPECT_JOB 6e79832ceb38860a, rebase-in-lock.sh) launches under the push16 pre-authorization, with the lock condition. My judgment as planned: the rebase of wp/w4h-34 onto integ 39baed85a; <USER> identity; rerere off; the stop records (resolve mode, stop-shapes.py, the five verified shapes keyed by commit and file, every stop recorded, any other stop aborts); then its freeze legs. Check that the EXPECT_JOB hash 6e79832ceb38860a is the job file actually run, and that the job base = 39baed85a (not 8fb4474e9 from the earlier plan).
== 2026-10-17T05:32:11Z W4H-34 watch re-armed (my read of launch-checks.log): the old watch was stopped by pid at 05:30:51Z (0 processes left; no launch had happened); watch-and-launch.sh is now 043c22f39627fd19 (old d3dcef58c29a797b kept as .bak-20261017T053135Z-stale-predicate); the predicate is push16 push.exit 0 plus 7f8317656 and ba9acd166 ancestors of integ/w00; it passes base = git rev-parse integ/w00 at launch (now 39baed85a) to launch-rebase.sh 18e442fbef5556a1 with EXPECT_JOB 6e79832ceb38860a = rebase-in-lock.sh on disk. INSIDE stays c586125ab (an ancestor of 39baed85a: checked). The job runs diff-equality (rebase-in-lock.sh:179) against the frozen head df0002770: at my read, DIFFERENT files must be only the ruled job commits (modelProvider test, doc comment, quay pin) and the stop resolutions.
