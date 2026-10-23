# validator-8: W4H-33 validation plan — test hygiene on main (prepared from the brief; extended when the owner reports)
Brief w00/briefs/w4h-33.md a6fa1c68b5a2038f. Branch wp/w4h-33-test-hygiene from 390c49a90. Standing rules:
plan-common-w4h-32-36.md 147bb9ec215b3a14 (S1-S10).

V1 Inventory complete: I run my own search on 390c49a90 (git grep for describe.skip / test.skip / it.skip / .todo / env-var
   gates such as DOCKER_TEST, *_TEST=1, process.env.X && test) and compare it with the owner's list (file, reason,
   decision). A file on my list and not on theirs = finding. Also every *.docker.test.ts and every env gate no lane sets
   (I read ci.yml and the hold scripts for the set variables).
V2 Never-running tests (task-stack / todo-tracker sdk-integration under docs/extensions/examples): made to run (red first by
   assertion, then green in the hold), or deleted with a one-line reason in the commit and a leftover entry, ruled by
   team-lead BEFORE the freeze; a kept skip carries a tracked issue reference and a reason string the gate can read.
V3 Docker-only tests (preview-dynamic-e2e, preview-uid-keystone): a Podman form that runs here [H], or marked for the hosted
   lane that has the engine (the W4H-4 pattern) with the lane name in ci.yml; never silently skipped. I run the Podman form.
V4 Reserved-domain fixtures: web/e2e/reliability.spec.ts:355 and admin-dashboard-edges.spec.ts:75 moved to reserved domains;
   identity-check.sh files on every changed file clean WITHOUT the W-SYNC exemption; the e2e specs still pass [H] (browser).
V5 Timeouts: the two supervisor-services tests measured (p95 over >= 10 runs; the raw times in the report); declared timeout
   >= 6 x p95 rounded (W4H-24 rule), declared in the test, not inherited; or the slow setup fixed. I re-measure 10 runs.
V6 Inventory test: extends the existing inventory suite or w00/invariant-tests.txt pattern (no duplicate); RED on 390c49a90
   by assertion naming the offending files; green at the head; mutants: a new describe.skip without a reason -> red; a new
   env gate no lane sets -> red; a skip WITH a tracked reason -> green.
V7 Gates: gate-integrity default/main/base = 0 (S6); every deleted test visible in the commit and the receipt and ruled by
   team-lead (no maintainer-label route); no product change unless a test exposes a defect (then the owner stops; any
   product diff = finding).
Verdict per S10. REJECT on: an unruled deletion; a silent skip left; a real-domain fixture left; a timeout raised without
measurement.

## Addendum A (2026-10-16, validator-8): owner inventory (w4h-33/inventory.txt) and team-lead's rulings 1-5
Inventory classes: A never-run (2 describe.skip SDK integration tests; 4 empty test.todo in web sub-conversation.test.ts; 5
todoIf in ai-kit shape.test.ts); B env gates no lane sets (2 DOCKER_TEST preview files; price-chart e2e and
price-chart-stream-bridge on live Yahoo Finance; ai-kit e2e bundled/fanout/quickstart); C lane-set gates and D capability
gates kept and registered (2 rg-gated tests never run on hosted: no workflow installs ripgrep); F reliability.spec.ts:355
test.com -> example.com (test.local reserved, unchanged); G supervisor-services 27/2 at Bun's 5 s default; H inventory test
scripts/test-skip-inventory.test.ts reusing gate-integrity's forbiddenTestAdditions scanner (DRY).
Rulings: (1) delete the two retired tests with a named behaviour -> replacement map; (2) implement each test.todo whose
behaviour exists, delete only a dead one with its reason; (3) price-chart: an injectable fetch base URL in the example
extension + a loopback stub, no tracked skip; (4) the repo-wide 430 non-reserved fixture addresses in 133 files as one
mechanical commit, run under the full-run hook form in the lock, then a repository rule (identity-check files mode over the
tests, inside the inventory test) that fails on any new one; (5) the inventory test joins w00/invariant-tests.txt at the
merge; plus the two rg-gated tests must run on hosted (install ripgrep in the workflow, pinned, or use the project's search
abstraction).
Checks added:
- A1 inventory: my own search at 390c49a90 (V1) compared line by line with inventory.txt (classes A-H); a file only on my
  list = finding.
- A2 ruling 1: for each of the 2 retired files, the map names each behaviour and the test (file + name) in
  e2e-server-pipeline.test.ts that covers it; I read each named test and run both replacement files (5 behaviours each)
  green; gate-integrity's deleted-test finding is answered by the ruling line in the commit and the receipt.
- A3 ruling 2 and the todoIf tests: each implemented test.todo fails first by assertion when its behaviour is broken (a
  mutant per test: the behaviour's key line reverted), passes at the head; each deleted one names why it is dead; the 5
  todoIf become plain tests and pass (if one fails, it is a product defect: the owner stops and reports).
- A4 ruling 3: the example extension's fetch base URL is injectable with the public default unchanged; the tests use a
  loopback stub; I run them with no outside network (a Podman network none run or an unreachable proxy) and they pass; a
  mutant that hard-codes the live URL again -> red under no network.
- A5 ruling 4 (mechanical commit): every changed line differs from the base ONLY in the address literal (a diff filter: the
  line with the old address replaced by the new equals the new line); every new address is reserved (identity-check files on
  all 133 files clean without W-SYNC); no assertion about a domain changed meaning (I list tests that assert on the domain
  part and read them); the full-run hook form in the lock is green. [H]
- A6 repository rule: inside the inventory test, identity-check files over the test tree; red on a planted non-reserved
  fixture (built at run time), green at the head; the rule names file:line and prints "<a non-noreply address>" only.
- A7 ruling 5: the inventory test is listed for w00/invariant-tests.txt in the report (added by the integrator at merge).
- A8 ripgrep on hosted: the workflow change installs a pinned ripgrep (version and checksum or a pinned package) or the two
  tests use the project's search abstraction; the gate-integrity reading of a workflow change; proof = a hosted run where
  the two tests report as run (not skipped); I read the hosted job log when it exists.
- A9 G (timeouts): root cause first; if a fix, red at 5 s default before / green after, no timeout raise; else my own 10-run
  p95 and the declared timeout >= 6 x p95.

## Addendum B (2026-10-16, validator-8): owner report 2 (commits) and the deviations team-lead accepted
Commits (noreply; hooks <= 7 suites): baf9c2338 deletes the two retired describe.skip files with a 10-behaviour ->
replacement map in the commit and the gate file (replacements 7/7 each); 54e606157 Podman form for the Docker-only preview
tests (proof "preview-isolation" in production-proof-plan.ts; scripts/verify-shipping-preview-isolation.sh runs them in the
candidate image under rootless Podman with uid map 0..56535 + 90000..99000; gate var EZCORP_PREVIEW_ISOLATION_PROOF; one
Bun-report check; hosted --bound-tests subtraction; reds on 5 suites; in-image run pending, heavy); 6869be27c ripgrep:
.github/actions/ripgrep used by the 6 backend-suite jobs, held by scripts/ripgrep-registration.test.ts; rg cases now require
rg (without rg: 3 fail instead of 2 skip; with rg 18/0; actionlint clean); fd450bdb7 placeholders: one new assertion test
(red with start-assignment.ts:590 reverted), three already asserted in named tests and now comments naming them.
Accepted deviations: (1) price-chart stub behind the broker (session fetchImpl; a real Bun.serve on loopback; the exact
production URLs asserted; the rotted web bridge suite rebuilt on the v4 release session; the real-PDP case asserts that all
decisions allow); (2) a repo port of identity-check files mode inside the inventory module (CI cannot reach /tmp), with a
parity leg 426 = 426 against the w00 script; the integrator re-points w00's files mode at the repo function after the merge;
(3) the mechanical rewrite of 131 files with mention logic ("<first label>.example"; look-alikes -> example.com.invalid;
case kept; a per-file check refuses merged addresses; 426 findings -> 0; full-run hook form EZ_PRECOMMIT_TEST_MAX=128 in the
lock). ai-kit bundled/quickstart/fanout run in the real-auth spec (fanout sleeps -> polling; the any-outcome case requires a
4xx).
Checks added:
- B1 retired-test map: each of the 10 behaviours names a test (file + name) in the replacements; I read each and run both
  replacement files (7/7 each); the ruling line is in the commit and the gate file; gate-integrity's deleted-test finding is
  answered by it.
- B2 preview-isolation uid map: I read /etc/subuid and /etc/subgid for the user (read only) and check the map 0..56535 +
  90000..99000 lies inside the allotted ranges and does not map container root to host root; I ask why the gap
  56536..89999 exists and what the keystone test relies on (the uid it checks must be inside a mapped range). The proof runs
  in the candidate image in the lock [H]; the gate var is set only by that proof; the hosted --bound-tests subtraction
  removes exactly these two files (no other file drops out of the hosted count).
- B3 ripgrep: the composite action pins ripgrep by version and checksum (or a pinned package digest); all 6 backend-suite
  jobs use it (ripgrep-registration.test.ts red if one job drops it: mutant); the rg cases fail, not skip, without rg (by
  design now): I check that this host and every hook leg have rg on PATH so local runs stay green; a hosted log shows both
  tests ran.
- B4 placeholders: the new assertion test is red with start-assignment.ts:590 reverted (I re-run it); the three comments name
  tests that exist and assert the behaviour (I read each).
- B5 price-chart (deviation 1): the tests use the session fetchImpl and a loopback Bun.serve, assert the exact production
  URLs, and pass with no outside network (a Podman network none run); the rebuilt bridge suite is not vacuous (assertions in
  the test bodies; gate-integrity 0); the real-PDP case: I compare with the old assertion. "All decisions allow" must be the
  real policy's answer for these inputs, not a weaker check: a mutant policy that denies one decision -> red.
- B6 identity port (deviation 2): parity leg = the repo function and the w00 script over the SAME file list give the same
  findings (426 = 426 before the rewrite; 0 = 0 after); a planted run-time fixture is found by both; the leftover "re-point
  w00 files mode at the repo function" is recorded (one implementation after the merge).
- B7 mechanical rewrite (deviation 3): a diff filter over the 131 files: every changed line differs from the base only in
  address literals; every new address is reserved; the per-file merged-address check is red on a planted merge; tests that
  assert on a domain part still assert the same property (I list and read them); the full-run hook form ran in the lock.
- B8 ai-kit real-auth: fanout uses polling with a bound (no sleep); the any-outcome case requires a 4xx (not any status).
B2 note (read 2026-10-16): /etc/subuid and /etc/subgid give user dev (uid 1001) 165536:65536, so rootless Podman has
65,537 container ids (0 -> 1001, plus 65,536 subordinate ids). The map 0..56535 + 90000..99000 (inclusive) = 56,536 + 9,001 =
65,537 ids: it fits exactly; container root maps to uid 1001, not host root. Still to check: the keystone test's uid lies in
90000..99000. rg on this host: ripgrep 15.2.0 on PATH.

## Addendum C (2026-10-16, validator-8): product defect (sub-conversation 400) assigned to W4H-33 (scope extension)
Defect, reproduced by the owner end to end (built web app, real routes, PGlite, real session; probe not committed; evidence
w4h-33/subconvo-probe.json, logs/subconvo-probe.log, w4h33-subconvo-probe.spec.ts): startSubConvo
(web/src/lib/chat/page-handlers/send-message.ts:1025) sends agentConfigId "" through web/src/lib/api.ts:697; POST
/api/conversations answers 400 {"error":"Validation failed","fields":{"agentConfigId":"Invalid UUID"}} (schema
z.string().uuid().optional(); "" is not absent); the same body without the field -> 201. Effect: the @agent sub-conversation
UI never opens; handleSubConvoReturn is unreachable in production; component and handler tests mock createSubConversation.
Placeholder-3 comment corrected by the owner (the summary IS inserted; a "last" proof with .reverse() red).
Checks added:
- C1 reproduction (mine): on 390c49a90 I run the owner's probe spec (or the new e2e test) against the built app on my own
  server and see the 400 with the same field error; the same request without the field gives 201. [H] (browser + build)
- C2 e2e red/green: the real-auth e2e test fails on the base by assertion (400; the sub-conversation UI does not open) and
  passes at the head (201; the UI opens; "Return to main" runs handleSubConvoReturn and shows the summary in the main
  conversation). No mock at the payload boundary: the test drives the real client function to the real route (I read the
  spec: no route interception, no stub of createSubConversation or of fetch for that call).
- C3 root cause: the owner states where "resolved server-side by agent name" comes from (a comment or a missing route);
  the fix either omits the field when the name path exists on the server (I find that server code and its test) or resolves
  the id before the send; an empty string is never sent for an optional id (a unit test on the payload builder).
- C4 schema-contract test between the client payload type and the server schema (zod): the client's actual payload for each
  call path parses with the server schema; mutants: the schema field renamed -> red; the client sends "" again -> red.
- C5 the corrected placeholder-3 proof: the "last" assertion fails with .reverse() applied (I re-run it).
- C6 scope note: this is a product change inside a test-hygiene package by team-lead's assignment; the commit says so; rows:
  if the conversation API contract is in the contracts document, its row is checked; otherwise none is needed.

## Addendum D (2026-10-16, validator-8): pgvector pin assigned to W4H-33 (team-lead ruling (a))
Facts (read at 390c49a90 and on this host): scripts/test-images.json holds only "postgres" =
docker.io/library/postgres@sha256:485935f9...; CI pulls pgvector/pgvector:pg15 BY TAG at ci.yml:267 and db-postgres.yml:69
and :263; w00/own-pg.sh pulls docker.io/pgvector/pgvector:pg15 by tag. The local image: Digest sha256:9a169499... and
RepoDigests 9a169499... and 47af0b65... (arch amd64): one is the multi-arch index digest, the other the amd64 manifest digest.
Checks:
- D1 digest form: the "pgvector" entry uses the SAME form as the "postgres" entry (index digest vs platform manifest digest);
  the owner shows the registry's media type for the chosen digest (an image index / manifest list for an index digest) and
  for the postgres entry's digest; a platform-only digest for a multi-arch CI is a finding unless ruled. The digest is the
  pg15 image the tag points to today (or the report says why not). A 429 from the registry stops the query (no retry loop).
- D2 both workflow files: ci.yml:267 and db-postgres.yml:69 and :263 use pgvector/pgvector@sha256:<the same digest>; no
  other workflow line pulls pgvector or postgres by tag (git grep over .github/).
- D3 the refusal test: a repository test reads the workflow service images and scripts/test-images.json and refuses any tag
  (red first by assertion on 390c49a90: it names the three lines); mutants: one line back to :pg15 -> red; the json entry
  replaced by a tag -> red. actionlint clean on both workflow files.
- D4 one source: the workflow lines and the json name the same digest (the test compares them).
D1 RULED (2026-10-16, team-lead): the repo's "postgres" entry is a platform manifest digest
(application/vnd.oci.image.manifest.v1+json), so the form is platform (linux/amd64) manifest digests; the pgvector pin is
the amd64 manifest that the pg15 index lists (9a169499...); hosted runners are amd64; a move to index digests if arm64
runners come is a leftover line, not a finding. My D1 check becomes: the owner's evidence shows 9a169499... is listed in the
pg15 index for linux/amd64 and has the manifest media type; the three workflow lines and the json use 9a169499...

## Addendum E (2026-10-16, validator-8): the 400 fixed (8ef65903f, the field omitted); a second defect assigned
Facts: 8ef65903f (normal hook; vitest 72/72): the comment "resolved server-side by agent name" was false (POST
/api/conversations never resolves a name); the fix OMITS agentConfigId. Resolving an id instead gives 201 but no interactive
block, because ChatThread renders the block only for records WITHOUT an agent config id (records with one are agent-run
sub-conversations shown as chips); the e2e refuted that alternative. api.ts gains subConversationBody() as the one
serialiser; a contract test sends the real body through the real createConversationSchema (red with ""); the create mock now
echoes what it was sent; a new real-auth e2e web/e2e/real-auth/sub-conversation-flow.spec.ts in the lane manifest (mention ->
POST 201 without an agent id -> the block opens -> a message answered inside the sub-conversation through the API). Red: e2e
400 "Invalid UUID" and 3 handler tests fail on the old file; green vitest 72/72, e2e 1 passed (a single-spec lock-free run
under the owner's reproduction word), e2e-lanes 32/0. SECOND DEFECT (reproduced): the sub-conversation's assistant reply is
stored server-side but nothing adds assistant messages to subConversationStore (send-message.ts adds only the user's;
startStreaming(runId, subId) does not feed the store), so handleSubConvoReturn posts nothing; the with-return spec (red at the
reply step) at w4h-33/sub-conversation-flow.with-return.spec.ts. Assigned to W4H-33: fix at the root (one stream path feeding
the sub store), a unit test for the routing (red with the routing removed), the e2e asserts the summary in the parent.
Checks added:
- E1 omit-field rationale: I read ChatThread's condition (the block renders only when the record has no agent config id) and
  the server route (no name resolution); both as stated, with file:line in my verdict.
- E2 one serialiser: every client path that creates a sub-conversation calls subConversationBody() (git grep for a second
  body literal for /api/conversations); the contract test parses its output with the real createConversationSchema.
  Mutants: the field sent as "" again -> the contract test red; a second inline body -> grep finds it (finding).
- E3 the e2e red/green: red on the base (400 "Invalid UUID"), green at the head; no interception of the create call (C2);
  the mock that now echoes its input is used only in unit tests, never in the e2e.
- E4 second defect: one stream path feeds the sub store (git grep: startStreaming(runId, subId) routes assistant messages
  into subConversationStore; no second streaming path for subs); the unit test is red with the routing removed (I re-run it);
  the with-return e2e is red at the reply step on 8ef65903f and green at the fix: the parent shows the summary after
  "Return to main". Mutant: routing removed -> both red.
- E5 the e2e runs in the lane manifest (e2e-lanes test includes the spec; a lane runs it on hosted).

## Addendum F (2026-10-16, validator-8): pgvector pin 656bb7808 checked read only (D1-D4)
- Commit noreply; 4 files (ci.yml, db-postgres.yml, scripts/test-images-registration.test.ts, scripts/test-images.json).
- D1: the owner's raw index file w4h-33/pgvector-pg15-index.json hashes to sha256 47af0b65960b... = the pg15 index digest (so
  it is the registry's raw index); mediaType application/vnd.oci.image.index.v1+json; it lists 9a169499888c... as linux/amd64
  with application/vnd.oci.image.manifest.v1+json (arm64 61177e0ae79b...; two attestation entries). Matches the ruled form.
- D2: ci.yml:269 and db-postgres.yml:69 and :263 read docker.io/pgvector/pgvector@sha256:9a169499888c9d75ad14d0401be64839d2c325f32e399098261589faff93d65c;
  scripts/test-images.json "pgvector" has the same value. git grep over .github at 656bb7808 finds no image line by tag; the
  only "postgres:15" left is the comment at db-postgres.yml:9.
- D3/D4: the registration test (reusing check-factory-deployment-locks.ts's line parser and pin rule) and its two mutants,
  red 0/3 -> green 3/3, are the owner's record; I re-run them and actionlint in my snapshot at the freeze (actionlint's 3
  findings must be the same 3 at base and head).
- Kept by design: scripts/fixtures/podman-guest-jobs/base/db-postgres.yml keeps the tag (a frozen snapshot of
  db-postgres.yml at 1bc5f63c7); the new test must not read fixtures (I check its file glob).

## Addendum G (2026-10-16, validator-8): defect 2 fixed (703621531); E4 applies here
Root cause (owner): no code wrote an assistant message to subConversationStore; the sub's run saves its turn like any run
(run:turn_saved -> window event ez:turn_saved) and ChatThread's handler dropped every turn whose conversation was not the main
thread. Fix: send-message.ts handleSubConvoTurnSaved routes a saved turn of the ACTIVE sub-conversation into the sub store
(each message id once; a final turn ends the sub's streaming; returns whether it took the turn); ChatThread's ez:turn_saved
handler calls it first; other turns stay with the main thread; send-message.ts stays the only writer of the sub store. Owner
evidence: red 2 unit fails before the handler and 2 with the routing removed; the with-return e2e red at the reply step while
the server had stored the reply (logs/subconvo-e2e-green2.log); green vitest 74/74, ChatThread.coverage 53/53; e2e 1 passed
(logs/subconvo-e2e-return-green.log): the parent receives "[Sub-conversation summary]: Sub answer ready.".
Checks added (with E4):
- G1 one writer: git grep at the head: send-message.ts is the only module that writes subConversationStore (no
  store.add/update/set elsewhere).
- G2 routing cases by name: an active sub's turn goes to the sub store and NOT to the main thread; the same message id
  twice is added once; a final turn ends the sub's streaming state; a turn of another, inactive sub-conversation is not shown
  in the main thread and does not enter the active sub's store (I ask for this case if it is absent); a main-thread turn is
  unchanged (regression).
- G3 mutants (re-run by me): routing removed (handler always false) -> red; dedup removed -> the twice-same-id test red;
  ChatThread calling the handler after the main-thread path -> the e2e or a component test red.
- G4 the full real-auth leg runs the with-return spec in the lock [H] (the single-spec lock-free run was the owner's
  reproduction only).

## Addendum H (2026-10-16, validator-8): the inactive-sub case (ccc8b705c); G2/G3 checked on that commit at the freeze
Behaviour: handleSubConvoTurnSaved returns false for a non-active sub and ChatThread's own conversation check drops the turn:
it enters neither the main thread nor the active sub's store. Decision DROP, not buffer: an inactive sub's block lazy-loads
its saved messages from the server when opened (SubConversationBlock), and startSubConversation empties the store, so a
buffered turn would be discarded anyway. Tests: a unit case (inactive sub refused; the active store stays empty) and a
component case through the real ez:turn_saved window event. The behaviour was already right, so the cases passed at once;
the red proof is by mutants (owner logs/mutant-*.log): routing removed 3 fail; dedup removed 1 fail; handler order swapped
1 fail (the new component case; before, only the e2e caught it); "any sub taken while one is active" 3 fail.
Checks: G2/G3 at ccc8b705c with the four mutants re-run by me in my snapshot (files restored after each; my own copies);
the DROP rationale checked by reading SubConversationBlock's lazy load (a server fetch on open) and startSubConversation's
store reset (file:line in my verdict); an e2e or component case that reopens an inactive sub and sees its saved reply (from
the server) is asked for if none exists, because DROP relies on that lazy load.
H follow-up CLOSED (2026-10-16): the DROP guard exists on main: web/src/lib/components/sub-conversation.component.test.ts
(blob 870e237570eb at ccc8b705c; from 2bae67b89), test "historical child loads messages once and uses the saved summary before
expansion" (line 56): an inactive SubConversationBlock expanded -> fetch /api/conversations/child/messages?all=true (:64) ->
the saved reply visible (:66) and loaded once; two retry cases also need the loaded reply. Owner mutants: load call removed
-> 3 fail incl. the guard; response ignored -> 3 fail incl. the guard; green 6/6 (logs/lazy-*.log). I re-run both mutants at
the freeze. No new commit needed.

## Addendum I (2026-10-16, validator-8): W4H-33 chain 1 results; the executor live-network finding; ai-kit ruling (c)
Facts: image localhost/w4h33-production:ffc07998683e built (02:51:42Z, from a clean git archive); the 132-file fixture commit
LANDED as 2ddf43f8f at 03:05:44Z in the full-run hook form (EZ_PRECOMMIT_TEST_MAX=128; 103 bun suites 0 fail; vitest 24 files
385/385); the preview proof exited 1: the worktree's src/__tests__ is 0700 (umask 077), so the image's bun user could not read
the mount; fixed in 41c06824b (plan files staged 0644 in a 0755 temp folder, mounted read-only, removed after; test red 2/1 ->
green 3/3; shellcheck clean). Price-chart exited 1 with two findings: the URL assertions assumed the hostname while the broker
pins the resolved address and carries the host in the Host header (the stub now records from the header); SERIOUS: the
ToolExecutor path (tool-executor/executor.ts:1529) calls the broker with no options -> real DNS + global fetch, so the
executor, real-PDP and web-bridge cases reached LIVE Yahoo and passed with no recorded request; fixed test-side by
routeHostMarketTraffic (exactly the two market hosts -> the loopback stub through a DNS placeholder + fetch; other hosts pass
through; both restored; unit test 2/2, 100 percent). Ai-kit ruling (c): a precondition probe per suite; a skip only in the
exact form `skip: precondition <name> missing; tracked: leftovers-2026-10-16 ai-kit-deployed-lane`; FAIL when the precondition
is present and the behaviour wrong; the inventory test accepts only that form with an existing ledger id (red first);
seeding (a) is a ledger leftover.
Checks added:
- I1 executor live-network: every price-chart case (executor, real-PDP, web-bridge, the rest) asserts that the loopback stub
  RECORDED its request (a live request leaves the stub count 0 -> the case fails); I run the price-chart suites with no outside
  network (a Podman network none run or an unreachable resolver) and they pass; mutant: routeHostMarketTraffic's routing
  removed -> the cases FAIL (stub count 0 or a DNS error), they do not pass by reaching Yahoo; the helper restores DNS and
  fetch after each case (a test that a later case sees the originals); hosts other than the two market hosts pass through
  unchanged (unit test).
- I2 product note: the ToolExecutor path calling the broker with no options is the product's production behaviour (real DNS
  and fetch); the report states this is intended and that the test-side routing is the right seam (no product change); if
  the owner finds the broker should take an injected fetch there, that is a ruling for team-lead, not a silent change.
- I3 the 0644/0755 staging: the test is red 2/1 on the old harness (the 0700 mount refused) and green 3/3 (re-run by me on a
  copy with umask 077 set); the temp folder is removed after (listing); the mount is read-only (podman inspect in the proof
  record).
- I4 the skip form: the inventory test is red first on a skip without the exact form or with an unknown ledger id; green on the
  exact form with "ai-kit-deployed-lane", which must exist in leftovers-2026-10-16.md (grep); a precondition present and the
  behaviour wrong -> FAIL (a test that fakes the precondition present).
- I5 hook logs: 2ddf43f8f in the full-run form (MAX 128; 103 bun suites, 0 fail; vitest 24 files 385/385) and 41c06824b under
  the normal hook inside the lock: I read both logs (suite counts and results), not their rc.
I4 ADJUSTED (team-lead, 2026-10-16): the inventory test must not read the ledger under /tmp (a hosted checkout has none). The
skip ids come from a tracked repo registry, scripts/test-skip-registry.json (rows {id, suites[], preconditions, reason, ledger
reference, owner}); the string `skip: precondition <name> missing; tracked: <id>` is accepted only when <id> is a registry row
AND the skipping file is one of that row's suites. Checks: red first on an unknown id, a malformed string, and a suite not
listed (three cases, each by assertion); the registry holds exactly the three ai-kit suites and no other row (a test or my
read of the JSON: one row, three suite paths, each path exists); the inventory test reads only repo files (grep: no /tmp path,
no leftovers file read); a precondition present but the behaviour wrong -> the suite FAILS (a test that fakes the precondition
present and the behaviour wrong). The W4H-36 ledger row with the same id comes in W4H-36's final round (W4H-33's freeze does
not wait for it); I check the ids match when it lands.
I5 DONE (2026-10-16, validator-8; logs read, not rc): hook-logs/2ddf43f8f-fixture-commit-hook.log ecc82a0905b6631d records the
full-run form (EZ_PRECOMMIT_TEST_MAX=128) in the lock; 104 bun summary lines, every one "0 fail" (the owner wrote 103), and
vitest "Test Files 24 passed (24)", "Tests 385 passed (385)": 104 + 24 = 128 = the mapped list (2ddf43f8f-mapped-list.txt
bdf301699d156be4: 37 web/ and 91 other entries; 37 = 24 vitest + 13 bun web files). The bun reporter prints no file names, so
the per-file match is by count only (noted as a limit). 41c06824b-preview-stage-hook.log 425a8faada2fd8d1: 3 pass 0 fail.
Parity (B6): parity-w00-before.txt and parity-repo-before.txt are byte-equal (426 lines each; 0 email-like strings in them);
identity-tree-after: "identity-check files: 866 file(s), clean".
I4 pre-check (2026-10-16, validator-8; working tree, not committed; read only): the four files hash differently from the
owner's report (now registry 955722d407f7dc2c vs 0d9d8fe7ab5cddb0; inventory .ts 39b9c48a577e2ec4 vs 9658fb08f5da9dc7; test
ab8168025232e325 vs c8c6d8d9a1219c7f; .json 6a58d7ae2bb8ff40 vs 6cc4b18b1bc9d4b4), so they are still being edited; I judge the
committed versions. Content now: exactly one row "ai-kit-deployed-lane" with keys id, suites, preconditions (5), reason,
ledger, owner; its three suites exist (packages/@ezcorp/ai-kit/test/e2e/{bundled,fanout,quickstart}.test.ts); the module reads
no /tmp path and no leftovers file. Still to show at the freeze: the four red cases (unknown id, suite not listed,
precondition not listed, malformed string) re-run by me; and a suite case with the precondition present and the behaviour
wrong that FAILS (not skips).
I4 case added (2026-10-16): commit 7442d80091b7a05be2634d81ba9226df8c49521b, packages/@ezcorp/ai-kit/test/unit/deployed-preconditions.test.ts
(blob e1fec2727065bf8e928d3c83ca02f91a9d3856ba): runs test/e2e/bundled.test.ts as a child bun test against an in-process stub
server: precondition PRESENT (GET /api/extensions lists ai-kit) and behaviour WRONG (the tools omit spawn_chats) -> the child
exits non-zero, reports "(fail) e2e: bundled ai-kit > ai-kit's tools are reachable...", and prints no "skip: precondition";
precondition MISSING -> exit 0, the tracked reason "skip: precondition ai-kit installed missing; tracked: ai-kit-deployed-lane",
0 fail 0 pass. Red: the skip path forced -> 1 pass 1 fail (logs/precond-contract-red.log 7a1b9336ea51c7cf...); green 2/0
(precond-contract-green.log 0e40760691642d74...); the hook ran it (2/0). At the freeze I re-run green and the forced-skip mutant;
the case covers bundled only: I ask whether fanout and quickstart share the same probe code (one helper) or need their own case.
I4 shared helper (2026-10-16, owner's answer): all three suites skip through one helper, skipUnless(present, reason) in packages/@ezcorp/ai-kit/test/e2e/_guard.ts:42 (bundled.test.ts:22, quickstart.test.ts:14, fanout.test.ts:28 cases a/b/c; blobs at 7442d8009: _guard.ts ac583a9a202a, bundled 6abe810c803c, quickstart 9312cd1200b5, fanout 70afffdc30ea). The bundled present-and-wrong case covers the shared skip path; each call site's own 'present' boolean is not covered (quickstart: Boolean(MODEL_PIN); fanout: its probes). My recommendation to team-lead: add one call-site case per suite (present -> not skipped; missing -> the tracked skip), so a wrong boolean cannot skip silently. Team-lead rules.
I4 call-site cases (2026-10-16, team-lead's ruling): commit 0d4a9d9e7 (noreply; deployed-preconditions.test.ts blob 2c163b7c72e7 + manifest.lock.json 4 lines): bundled / quickstart / fanout (a,b,c): present -> runs and fails against the wrong-behaviour stub (no 'skip: precondition' printed); missing -> the tracked skip, 0 fail. Red: quickstart's present forced false 5/1 (callsite-red-quickstart.log 83814d1a10e661fd); fanout (c) forced false 5/1 (callsite-red-fanout.log 9e314f4e17c77fcf); green 6/0 (callsite-green.log d1878568c5ca707a): read by me. At the freeze I re-run green and both mutants, and read the manifest.lock.json change (see below).
manifest.lock.json at 0d4a9d9e7: the ai-kit entry's bytes 407558 -> 410245 and sourceDigest f686c24e... -> d5a37a82... (the package includes its test files, so a changed test moves both). At the freeze: the repo's own manifest-lock check passes at the head (its digest recomputed by the repo tool), and no other entry changed.
Typecheck fix (2026-10-16): typecheck run 1 (04:46-04:47Z) exit 1: 7 errors, one cause: 703621531 added handleSubConvoTurnSaved
to makeSendMessage's returned object but not to the explicit SendMessageHandlers interface (TS2551 x6 in send-message.test.ts;
TS2561 at send-message.ts:1096; vitest does not typecheck); fixed in ebb0f1ecf (the interface declares the handler with its
contract); run 2 exit 0. Checks at the freeze: the raw typecheck output at the frozen head ("0 errors" / the pass line, read);
grep: every key of makeSendMessage's returned object is a member of SendMessageHandlers (a script lists both and compares).
Other legs (owner): preview proof in localhost/w4h33-production:ffc07998683e exit 0 (7 tests, 2 files, 0 fail; receipt
proof-preview-isolation/controller.log); price-chart 6e6506ba5 hook inside the lock (8/0, 2/0, 6/0); real-auth ai-kit full spec
exit 0 (3 passed; tracked skips printed). Re-read from raw logs at the freeze.

## Addendum J (2026-10-16, validator-8): FROZEN at 0cfd7b104 (report.txt 06dfd54fb1850b35; pending-lesson afd6f369d81c00c3)
Holds: hold-w4h-33-light.sh 76c316936a1ffc84 (lock-free; out w4h-33) and hold-w4h-33-heavy.sh (gated-flock; out w4h-33-heavy).
Tools: v8-address-diff-filter.py e1f1198f39abafe4; v8-handlers-vs-interface.py 5254331f0861a31c.
Read-only results so far:
- B7 address filter on 2ddf43f8f: 132 files, 366 hunks, 430 line pairs; 428 differ only in address literals (incl.
  template-literal local parts such as `${i}@test.com` -> `${i}@test.example`); the 2 others are in
  web/src/__tests__/mention-logic.unit.test.ts: "line1\<EMAIL>" -> "line1\n" + "@app.ts" and "hello\<EMAIL>" -> "hello\t" +
  "@bar.ts": the identity pattern read "<EMAIL>" / "<EMAIL>" as addresses, and the split gives the SAME string value; no
  test meaning changed.
- Handlers vs interface: at the head every key makeSendMessage returns is a member of SendMessageHandlers; the same check at
  703621531 names handleSubConvoTurnSaved (the defect the typecheck found): the check is red-first.
- Timeouts (G1): declared 65,000 ms and 125,000 ms = 6 x p95 (10,088 and 20,098 ms) rounded up to 5 s (W4H-24 rule); the tests
  wait a real 10 s abort grace on the real clock, so a declared timeout (not a fix) is the right form; my 10-run p95 in the hold.
- FINDING (minor, process): 9 of the owner's 16 scripts set Bun's PATH by hand and none sources w00/bun-pin.sh
  (bin/inlock.sh, preview-proof.sh, price-chart-leg.sh, real-auth-aikit.sh, run1.sh, shape-red.sh, subconvo-probe.sh,
  typecheck-leg.sh, plus one more counted by grep), so their runs lacked BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 (the W4H-32
  Addendum C class). Most of these runs use PGlite, so the effect is likely nil; my holds use bun_pin, so my results stand on
  their own. Recorded; team-lead rules whether the owner re-runs anything.
- The preview proof runs in the owner's image localhost/w4h33-production:ffc07998683e (id <IMAGE-ID>), read only; I
  neither rebuild nor remove it.
Ruling on Addendum J (team-lead): the scripts switch to bun_pin; NO leg re-run (the preload's guard asserts the flag whenever
FACTORY_TEST_POSTGRES_URL is set and throws by name, so a PG-form leg that passed had the flag; PGlite legs do not read it). Done
by the owner: TEN scripts now call bun_pin (the 8 hand-pinned + commit-fixtures.sh and price-chart-commit.sh, which run git
commit and so the hook); checked by me: no factory-tools/bun path left in bin/ (grep 0); each of the 10 calls bun_pin once;
hashes commit-fixtures e37d7b995f8c1a5f, inlock 63804f7f7ffc7080, preview-proof 2f48b553bd839f64, price-chart-commit
650b89f0d44669e5, price-chart-leg 49fb86e4c41611bf, real-auth-aikit 47246e3a51b34c16, run1 9d336fb508d1044e, shape-red
a1bb2b320259028d, subconvo-probe a134e75561cb727f, typecheck-leg 82c2f73acf94ad4d; report.txt now 697d3147d1532201 (a new
section; my report-shas leg read the 181 repo file shas before it: differing 0); pending-lesson.md 0f09c1b5251de91f (lesson 13).
B7 split literals accepted (team-lead).

## Addendum K (2026-10-16, validator-8): BLOCKING finding at 0cfd7b104 (git-spawn guard) fixed at 1dcaac301; delta checked
At 0cfd7b104 (follow-up 3, out w4h-33-fu3): src/__tests__/git-spawn-context-guard.test.ts RED 18/1, "Unguarded git spawn in:
scripts/test-skip-inventory.ts (env: env)" (a hand-stripped env at line 300-301). My first light hold had left out the invariant legs
(my omission; pkg-common.sh finish_tree now refuses a hold without them). Fix 86df17911: withoutGitContext(process.env) from
@ezcorp/sdk/git (explicit-target class, accepted by team-lead; the unit test's fixture git uses the same helper); 1dcaac301 gate file.
Delta follow-up at 1dcaac301 (followup-w4h-33-delta.legs d130808a7e172a80, out w4h-33-delta, exit 0): 51 invariant legs green (guard
19/19); skip-inventory 25/0; gate-integrity default/main/base: only the 2 ruled deletions; lint 0; typecheck 0 (tc rule, lowest
12.2 GiB); identity-check commits 390c49a90..1dcaac301 25 commits clean; file hashes = the owner's (inventory .ts 3f9fbb29dcec63dd,
test 67b9c24f879792ce). Follow-up 3 at 0cfd7b104 (all carry over; the delta touches only the inventory module and its test): H mutants
any-sub-taken, order-swapped, lazy-load-removed, lazy-response-ignored RED by assertion; b4-run-on-parent RED; b5-pdp-deny RED (the
executor refuses the denied call); i3-old-harness RED 2/1; i4-malformed-unchecked and i4-precondition-unchecked RED; actionlint: the
same 3 self-hosted label findings at base and head. Coverage (follow-ups 1-2): every gated changed line covered (api.ts by its canonical
producer api-client-coverage.sh 100/0); production-proof-plan.ts 73-74 outside SOURCE_GLOBS (informational; exercised by a spawn test).
Open for the verdict: the heavy base-red run of the sub-conversation spec (C1/E3), queued after the W4H-28 integration hold.

## Addendum L (2026-10-16, validator-8): the owner's red-on-base list (496a1fc7dce5100b) judged; rule 11 mutants; finding F2
Form = W4H-28's red.sh form at base 390c49a90 (head 1dcaac301), 28 files: RED 7, RED-LOAD-ERROR 3, GREEN as listed 8, not runnable 10; the
two ruled deletions absent. Rule 11 (corrected): a planted mutant per load-error file, RED by assertion (follow-ups w4h-33-rule11 and -11b,
lock-free at 1dcaac301): test-skip-inventory: i4-malformed-unchecked, i4-precondition-unchecked and the registry mutants (Addendum K);
production-proof-plan: m-proof-plan-guard-removed RED; production-proof-results: m-proof-results-entry-dropped SURVIVED -> FINDING F2.
GREEN reasons: sound (shape: todo before; deployed-preconditions: forced-skip reds; market-stub: helper of the red suites; runtime-tools-grep:
red on a host without rg; start-assignment-plumbing: b4 mutant RED; supervisor-services: base file at 5 s 27/2; sub-conversation.test: todo
removed); api-users-id ("no red by design") needed a mutant: m-users-refused-caller-writes2 RED by the new assertion ("expected vi.fn() to
not be called at all"). Not runnable 10, covered by my runs at 0cfd7b104 (the delta to 1dcaac301 touches only the inventory module): the two
preview docker files (in-image proof 7/0, heavy); price-chart.e2e and the bridge (10/0, 6/0 with no outside network; routing mutant RED);
sub-conversation-flow and ai-kit-public-api specs (real-auth 4/4; base red by assertion, 400 Invalid UUID); reliability.spec (fixture address:
its check is identity-check, clean); the ai-kit e2e suites (precondition contract 6/0 + guard mutant RED; run in the real-auth lane).
The W4H-33 hold needs legs for: the in-image preview proof, the price-chart Podman suites, the real-auth Playwright specs (with the lane's
variables, the ai-kit e2e suites included); not for reliability.spec (identity check).
FINDING F2 (W4H-33, medium): PREVIEW_ISOLATION_PROOF_TESTS (scripts/verify-shipping-production-results.ts:43) is not pinned to the test
names the two preview files declare: production-proof-results.test.ts builds its fixture FROM that list (lines 19-20), so dropping an entry
changes both and passes (mutant SURVIVED 5/0); the verifier would then accept a receipt that never ran that preview test. The namespace list
has such a pin ("the verifier's namespace test list is exactly the tests the runner isolation proof declares"). Fix: the same pin for the
preview list (the names the two files declare, e.g. Bun's junit or a static read), red first by the dropped-entry mutant.

## Addendum M (2026-10-16, validator-8): the W4H-33 prep (w00/w4h-merge/w4h-33-test-hygiene) judged: derivation SOUND, hold plan has 2 GAPS
SOUND: my merge-tree 7e5365696 + 1dcaac301 = a013268080bcc572... (183 files); identity-check commits 7e5365696..1dcaac301 25 clean; my
recomputed hook list on the merge tree (diff vs the first parent 7e5365696) = hook-mapped-1dcaac301.txt, 153 = 153; warn-cases.txt
5da55c9c775b2105: 25 lines, my case-list-check at 1dcaac301 0 misses (every line a real title, no escape); whole-files.txt 6 = the 2
RED-by-assertion files without a new name (check-factory-lanes, shipping-production-suite-wiring) + the 4 GREEN-as-listed without a name
(ai-kit shape, supervisor-services, api-users-id.server, sub-conversation); the 3 load-error files carry no case (ruled; rule 11 mutants in
Addendum L); hashes as relayed.
GAP 1: no extra-legs.sh in the folder (hold-w4f.sh line 30 sources $D/extra-legs.sh only), so the hold runs neither the in-image preview
proof (scripts/verify-shipping-preview-isolation.sh in the candidate image) nor the real-auth Playwright specs (sub-conversation-flow,
ai-kit-public-api, with the lane's variables, which select the ai-kit e2e suites).
GAP 2: unit.txt holds files that run ZERO tests on the host and no folder not-runnable.txt lists them (heavy-lib reads $D/not-runnable.txt):
src/__tests__/preview-uid-keystone.docker.test.ts and preview-dynamic-e2e.docker.test.ts (describe.skipIf without
EZCORP_PREVIEW_ISOLATION_PROOF), packages/@ezcorp/ai-kit/test/e2e/{bundled,fanout,quickstart}.test.ts (skipUnless their preconditions) ->
each a unit leg with exit 97 by the zero-tests rule. (doctor, internal-auth, on-behalf-of e2e: to be read the same way.) Fix: a folder
not-runnable.txt naming each such file with its ruling, plus the extra legs of GAP 1 that run them for real.
F2 (Addendum L) also stands: a new W4H-33 head; the prep is redone there anyway.
- Leg forms sent to integrator-5 (2026-10-16): (1) preview proof `env EZ_PRODUCTION_IMAGE=<image> EZ_PRODUCTION_RECEIPT_DIR=<dir> timeout 2400
  bash scripts/verify-shipping-preview-isolation.sh` in an image built from the MERGE commit (image-leg.sh "full" form; own tag removed after);
  (2) price-chart with NONET (unreachable proxy 127.0.0.1:9, NO_PROXY loopback): root price-chart.e2e + market-stub, web stream-bridge;
  (3) real-auth Playwright `cd web && timeout 3600 bunx playwright test --config playwright.real.config.ts e2e/real-auth/sub-conversation-flow.spec.ts
  e2e/real-auth/ai-kit-public-api.spec.ts --project=chromium --reporter=list` (no extra variables; the owner's real-auth-aikit.sh
  47246e3a51b34c16 sets none). Plus a folder not-runnable.txt for the zero-test unit files. I OK the staged files before the W4H-33 hold.
  The 1dcaac301 prep judgment is superseded: I judge the re-prep at the F2 head.
- Integrator's leg drafts answered (2026-10-16): (1) preview proof form OK; no umask (the proof stages 0644 since 41c06824b); 7 tests
  expected; the image tag from the FULL merge sha (image-leg tags ${H:0:12} of rev-parse). (2) price-chart: add the NONET proxy variables to
  both legs (check I1: a live request must fail); no Podman variable was set in my run. (3) real-auth: no env file; the ai-kit spec sets
  EZCORP_E2E_BASE_URL and EZCORP_E2E_API_KEY itself (lines 45-46, 67-68) and EZCORP_E2E_SUBPROCESS=1 (line 86); EZCORP_E2E_MODEL unset ->
  tracked skips, as in my green run.
- W4H-33 extra-legs.sh.new 734ab779b2cfe1f8 OK (forms as sent; PIMG ${M:0:12} right: merge-sha.txt holds the full rev-parse HEAD).
  not-runnable.txt.new 78be9abe8153c1aa NOT OK for one fix: the two docker lines say "DOCKER_TEST"; at a01326808 both files are gated
  only on EZCORP_PREVIEW_ISOLATION_PROOF. The five ai-kit lines are right; doctor rightly absent (1 host-run test).
- not-runnable.txt.new a2d7f07ce7a1b1a4 OK (7 lines x 2 fields; DOCKER_TEST 0; docker lines name EZCORP_PREVIEW_ISOLATION_PROOF);
  extra-legs.sh.new back at 734ab779b2cfe1f8 (OK; 687684cf1c427465 withdrawn). Both for the re-prep at the F2 head.

## Addendum N (2026-10-16, validator-8): F2 delta at e4aa0cb44 — ACCEPT of the delta
One commit on 1dcaac301; only src/__tests__/production-proof-results.test.ts (+21/-8); identity-check 390c49a90..e4aa0cb44 26 clean.
The shared helper declaredTests(files, env) reads Bun's JUnit names; the namespace pin now calls it (no copy); the new test "the verifier's
preview-isolation test list is exactly the tests the two in-image preview files declare" calls it on the two preview files. Follow-up
w4h-33-f2-e4aa0cb44 (followup-w4h-33-f2.legs fd39a3cee42a093b, lock-free, exit 0): the file 6/0; its changed lines as the case leg measures
them: 21 changed, 12 instrumented, 0 missed; my mutants on PREVIEW_ISOLATION_PROOF_TESTS: an entry dropped -> RED 5/1 and an undeclared name
added -> RED 5/1, both by the new pin test by name; 51 invariant legs green. Records append-only: red-on-base.txt c56b0b4d834d7b12 = the
5924 bytes of 496a1fc7... + a 441-byte dated section (the file RED-LOAD-ERROR at the base: the export does not exist there); report.txt
82d2ce8d8e8da848 = d94ef947ac170643 + 1254 bytes (section "F2 fix, re-freeze"). F2 CLOSED. W4H-33 stays ACCEPTED, now at e4aa0cb44.
- not-runnable.txt.new a7a03d3ad7f13309 OK (team-lead's ruling on all 7 lines; gates true: _guard.ts reads EZCORP_E2E_BASE_URL and
  EZCORP_E2E_API_KEY; note: quickstart's EZCORP_E2E_MODEL cases end as the registry's tracked skip inside real-auth-specs).
  Re-prep at e4aa0cb44 (w4h-33-test-hygiene-e4aa0cb44) SOUND: my merge-tree bd755a896bd8f15e = config TREE; vs a01326808 only the F2 test
  file; identity 26 clean; hook/unit/pg/guard/warn-cases/whole-files/red-first byte-equal to the 1dcaac301 prep; case-list-check 0 misses;
  commit-msg changes only the sha; extra-legs 734ab779b2cfe1f8.
- Re-prep onto c8ae394ca OK (w4h-33-test-hygiene-20261016-on-c8ae394ca; my merge-tree b4ca9895858ce695 = TREE; the prep diff = the base
  diff byte for byte (d5c105ef23384a99); lists, extra-legs 734ab779b2cfe1f8 and not-runnable a7a03d3ad7f13309 byte-equal); launch trio
  226ef7db6ada6f5a / ca065db2bb33bf45 / 427fc5a727373572 differ from W4H-28's only in path, labels and comments; commit.sh 22db59d4e7eb94e0
  (rerere off) installed. At the commit: the flag in the record and no replayed resolution.

## Commit record (2026-10-16 10:4xZ, validator-8): W4H-33 merge 15d71f83b — OK
Folder w4h-33-test-hygiene-e4aa0cb44-on-c8ae394ca; commit.exit 0; commit.log 6f10f5360a8bdcee; commit-gate.log 10e8a19ad2357763;
stage.log 96bb6a194a796153 ("Automatic merge went well"; no "previous resolution" line); commit.sh 22db59d4e7eb94e0 line 39
merges with -c rerere.enabled=false. Lock 10:30:27-10:37:39Z (gate green try 1; pins bun 1.4.2, node v24.14.1).
- 15d71f83b: tree b4ca9895858ce695 (= the prepared TREE); parents c8ae394ca, e4aa0cb44; author = committer = <USER> noreply;
  identity-check commits c8ae394ca..15d71f83b: 27 clean.
- Hook full-run form EZ_PRECOMMIT_TEST_MAX=153; hook-mapped-staged.txt = hook-mapped-e4aa0cb44.txt (cmp); 126 bun files each
  "0 fail" (no "Ran 0 tests"; 1968 tests) + vitest 27 files / 540 passed = 153.
- staged-files.txt (ACMR, 181) = the merge's 183 changed files minus the two ruled deletions
  (task-stack- and todo-tracker-sdk-integration.test.ts).

## Publish inputs (team-lead, 2026-10-16 ~10:55Z): judged at the W4H-33 publish with the receipts (as for W4H-28)
- PR body draft w00/wave4i/followup5-pr-body-draft.md 334d1c7e127aa9ec: facts equal my reads (merge, hold, verdicts, the
  deletions, gate-integrity); identity clean; placeholders only the known ones; applied = live hash read back.
- Landing record tasks-landing-w4h-33.staged.md fe743741e2c7ca07: <W4H-33-MERGE> stays a token until the publish, then filled
  with the published merge; every other fact equal my reads; lessons unchanged unless ruled.

## Rulings and views for the W4H-33 re-hold (2026-10-16 ~15:40Z)
- R2 list written at the re-prep from the real run's child lcov; D2 withdrawn (bun wrapper, W1-W3).
- D3 (owner delta): fanout.test.ts 36-41 helper. Preferred: a host-runnable unit test with a stub client, red first (found row, deadline,
  poll loop). A move "into the describe" does not satisfy tracked-skip-lines.py (its block rule takes test( / it( headers only); a move
  must put the helper inside the NEEDS_AGENTS test( block, or the tool's rule changes for my OK.
- R7 record: the hold carries heavy-lcov-foreign-sources.log ("N foreign of M SF record(s)", M = the merged lcov's SF count) as a receipt.
- Gate sets at W4H-33's turn (team-lead, ~17:10Z, on record): origin/main = {scripts/merge-lcov.ts + the two ruled deletions}; base = {the
  two ruled deletions} (per-folder files in the new W4H-33 folder; the expected-*.txt.new fed36ef2b24bf3ee in the old folder are then
  stale for main and must be rewritten).
- W4H-33 re-staged expected sets OK (2026-10-16 ~18:00Z; integrator-5/staging/w4h-33-expected/): main ea41e0e9a9bb5462 = {scripts/merge-lcov.ts,
  the two ruled deletions}; base fed36ef2b24bf3ee = {the two deletions}. Condition: gate-integrity at the re-prep shows found = these sets.
  Inventory 25daed1350596c26 filed as a record only (stand-down).
- Re-prep judged (2026-10-16 ~19:45Z), folder w4h-33-test-hygiene-e50aedefd-on-b0b7bedf1: all integrator hashes equal; TREE ba1726d73 = my merge-tree;
  identity 27 clean; prep gate-integrity both legs PASS vs ea41e0e9a9bb5462 / fed36ef2b24bf3ee; commit-msg names the deletions and the
  base-owned merge-lcov.ts; warn-cases 5da55c9c775b2105 (25), whole-files c2051757657f9227 (6) from red-on-base f156134e8f67c89d; extra-legs
  396ec755424bdcc4 (static, preview proof, NONET price-chart, child-cov on real-auth, case-check v9 "$D"). NOT YET: R2 list inactive (.form
  only) -> the hold would be red by construction; derive tracked-skip-lines.txt now from a lock-free coverage run of the 3 files at the
  merge tree (instrumented, 0-hit changed lines inside tracked-skip test blocks), verified both ways in the hold. Hook 154: list-bound word
  from team-lead pending.
- Prep OK (2026-10-16 ~19:55Z): folder w4h-33-test-hygiene-e50aedefd-on-b0b7bedf1, TREE ba1726d73 (commit trigger with the kind proof's exit).
  Rulings: hook 154 full-run granted; R2 path (a): an in-lock child pre-run after the commit writes tracked-skip-lines.txt; the hold
  needs my commit OK (naming the merge sha) AND my list OK. Prep gate-integrity matches checked: main 2cc91c7e9d429bf5, base 28670599d8f50f3d PASS.
- R2 list 107921f30993854b (integrator, lock-free method; crossed team-lead's path (a)): fanout 10 lines in 3 test.skipIf blocks correct; NOT YET:
  quickstart 39-40 (uncovered) sit under describe.skipIf(... NEEDS_MODEL_PIN) (line 14), which tracked-skip-lines.py's header rule cannot credit
  -> the hold would be red by construction. Asked team-lead: T (the tool credits the nearest enclosing describe/test skipIf header, red first,
  my OK by hash; recommended) or Q (owner moves the skipIf to the test header; new head, new prep).
- Commit try 1 (2026-10-16 19:12Z) refused, verified: fast typecheck exit 75 (another typecheck ran: w4h-32-mockparent), web-check green;
  the staged gate-integrity is advisory; nothing committed (integ = HEAD = b0b7bedf1, clean); records *.try1 (hashes equal). The lock-free
  list is moved aside as r2-derive/tracked-skip-lines.lockfree-dropped.txt (107921f30993854b); no active list (path (a)).
- followup5e 70e7132f172ddc88 pre-read OK (19:15:22Z): item 1 = my W4H-33 records; 185 files confirmed (16 A, 2 D, 167 M on b0b7bedf1; 183 was the
  c8ae394ca merge); verdict fe06312730a8d9e6 current; tokens PENDING-COMMIT, PENDING-HOLD x2, PENDING-PUBLISH, HOSTED-COMPARISON-5; named only after fills.
- Ruled T (team-lead, ~20:05Z): tracked-skip-lines.py credits the nearest enclosing describe.skipIf/test.skipIf header naming the constant;
  red first (a describe-level case listed and green; the same line with a non-matching constant red; existing 15 cases unchanged); my OK by
  hash; the list gains quickstart 39-40 under NEEDS_MODEL_PIN. Path (a)'s in-lock pre-run still runs after the commit; my list OK rests on the
  real child output (module-level lines covered; the 5 skip lines printed). Hold = my commit OK + my list OK.
  My checks of the tool change: diff limited to the block rule; the "nearest" header (a nested test.skipIf inside a describe.skipIf takes
  the test's); a line in a plain test( under a plain describe stays red; mutants: credit any enclosing header (not the nearest) RED;
  credit a describe without skipIf RED.
- Ruling T staged (2026-10-16 ~20:15Z): tracked-skip-lines.py.new 9546de85ac79395b code OK (only describe.skipIf; max(outer) = innermost). Test
  tracked-skip-lines.test.sh.new 78a4afb54372f098 NOT YET: new 22/0, describe-rule-removed RED 20/2, but outermost-describe (t1) and
  plain-describe (t2) mutants SURVIVE 22/0; asked for synthetic cases 12 (nested describes) and 13 (plain describe) in a temp git repo.
- Ruling T OK (2026-10-16 ~20:25Z): tracked-skip-lines.py.new 9546de85ac79395b + test 0af890a452bacc18 (27/0; installed 22/5; t1 24/3, t2 25/2,
  t3 24/3 RED by name; old test 15/0 on the new tool; fixture repo noreply from an existing commit, no config).
- Commit OK (2026-10-16 ~20:50Z): merge b6414ec0b137272e413da5e0db9b4421bc7ac386, tree ba1726d73, parents b0b7bedf1/e50aedefd; hook 154 (127 bun
  all 0 fail, 1953 pass; 27 vitest 540); rerere off; identity 28 clean; message = commit-msg.txt. Hold trigger half 1 of 2 (the R2 list OK pending).
- R2 list OK (2026-10-16 ~21:00Z): tracked-skip-lines.txt.new e7672cd176fa4fd2 (fanout 3 entries + quickstart 39,40 / NEEDS_MODEL_PIN), judged on the
  in-lock pre-run (crosscheck ce9aed783c2e1aea): the installed tool 9546de85ac79395b 0 red over 3 files; the 5 skip lines once each in the child
  output; module-level lines (bundled 15-17, fanout 19-20) covered by the child. Hold trigger complete (commit OK b6414ec0b + this list OK).
- case-web-junit v2 pair OK (2026-10-16 ~21:20Z): w00/case-web-junit.sh.new 54a275b92bc80fb2 (28 lines), case-web-junit.test.sh.new 5a6cf428986bc369 (73); installed 0edc417ff697d64b / 01ffaf1a2baedb75 become backups.
  Routes by web_bunleg_files of the tree under test (sourced in a subshell; a missing function is red by name, nothing runs); bun pool: bun test --reporter=junit from web/; the rest vitest as before; zero testcases red by name.
  My runs (validator-8/cwj-check/): staged 25/0; installed 18/7; my mutants: all-vitest 21/4, zero-testcase check removed 23/2, missing-function check removed 22/3; each mutant is caught by its own case.
  Real proof (case-web-junit-v2-proof/, hashes equal to the integrator's): old rc=old rc=1, new rc=new rc=0 (sub-conversation bun 7 pass 0 fail, junit 7 testcases failures=0; the 3 vitest files 75/54/7), mutant rc=mutant rc=1 (0 testcases, red by name). The pool in the proof is 193 lines, byte-equal to my own web_bunleg_files run at b6414ec0b.
  Notes (not blocking): (1) the classifier stderr goes to /dev/null; a partial failure falls back to vitest and the zero-testcase rule makes it red, but the cause is not logged. (2) An old junit in a reused out dir could hide a missing write; the re-run must use a fresh case-check out dir (the red run's sub-conversation junit c12f033ca32130a3 is still in case-check/).
  (Clarification: the .rc files hold the text "old rc=1", "new rc=0", "mutant rc=1"; the doubled words above are from that text. The values are old 1, new 0, mutant 1.)

## Addendum (2026-10-16 ~21:55Z): team-lead ruling after the hold red: harness fix, partial re-run, union judged
Ruled: owner ruling reversed; head stays e50aedefd; merge b6414ec0b NOT void. (1) case-web-junit v2 54a275b92bc80fb2 / test 5a6cf428986bc369
installs on my OK (OK given, proof old 1 / new 0 / mutant 1). (2) New hold leg "web-bunleg-changed". (3) Re-run = case leg (v2) + new leg
only, at b6414ec0b, one gated job, records appended beside the original; I judge the union. (4) W4H-33 first; W4H-32 then re-rebases.
My checks for leg (2) before its OK:
- L1 the file list = the merge's diff-files.txt (web/ lines) INTERSECT web_bunleg_files of the tree under test (the same classifier as v2,
  sourced, DRY; no own list, no import scan). For this folder that is 12 files (validator-8/w4h33-changed-web-bun.txt).
- L2 each file runs from web/ with bun test --reporter=junit; a file that fails, writes no junit, or has zero testcases is red by name.
- L3 a missing classifier is red by name and nothing runs; when the merge changes files in the pool, N > 0 is required. An empty
  intersection is a named line, not a silent pass.
- L4 red first: the installed hold without the leg runs none of the 12; a planted failing pool file makes the leg red; a mutant that
  skips the intersection (or routes to vitest) is caught. Test hermetic (stub bun and stub classifier), and the real proof on this folder.
- L5 registered in the hold like the other extra legs, its END line in heavy-batch.log, and its exit sets the hold status.
Union judgment: the original 375 green legs stand only if every tool they ran is byte-equal at the re-run (hash list before and after);
the re-run's case leg is green with v2 in a FRESH out dir; web-bunleg-changed green with N = 12; the 17 list-bound records unchanged.
- v2 installed (verified ~22:00Z): case-web-junit.sh 54a275b92bc80fb2, test 5a6cf428986bc369; backups .bak-20261016T2049Z-bunleg-route 0edc417ff697d64b / 01ffaf1a2baedb75; no .new left; my run of the installed test with no argument: case-web-junit.test: 25 pass, 0 fail.
- Ruled (team-lead ~22:05Z): route A. Re-run out dir is case-check-rerun/ (fresh). The owner's lane-agreement inventory rule is a leftover for a later round; no file move.
- web-bunleg-changed trio NOT OK yet (~22:30Z): web-bunleg-changed.sh.new eec5aa8d184df206, test 9bb013cdbf4227cd, hold-w4f.sh.new 58c9dc683f515d12.
  Met: L1 (diff INTERSECT the sourced classifier; stderr kept in .pool.err), L3 (missing classifier exit 3 named; empty list a named NOTEST line),
  L5 (one block after extra-legs.sh; a non-empty list is a test leg, so the aggregate needs N > 0), one process per file (mock leak shown 195/9).
  My runs (validator-8/wbc-check/): staged 22/0; installed hold 17/5; my mutants no-pool-filter 18/4 and red-swallowed 19/3, both caught.
  NOT met, L2: per file there is no junit or zero-test check. Planted proof (wbc-check/plant-skip/): a changed pool file with only test.skip
  runs "0 pass 1 skip" and the leg exits 0 next to a green file. That is W4H-33's own class (a never-running test) passing the new leg.
  Required: per file, a missing junit or 0 passed testcases is "RED: <file>: ..." by name; a test case for it; a mutant without it caught.
  DRY: v2 (case-web-junit.sh) already has the bun junit run and the zero-testcase check; put the one-file bun junit run and its checks in
  one shared helper that both tools call (v2's bun branch included), and re-run both tests.
  Open point price-chart-stream-bridge (team-lead rules): my view (a), DRY form: --list leaves out a file that the folder's extra-legs.sh
  runs as a named file_leg and prints "covered by leg <name>"; that leg's own exit already sets the hold status. (b) copies the NONET
  form into a second place. Also: the lock-free scratch proof started a Podman setup (price-chart beforeAll); a file that needs Podman
  runs only in the lock.
- Chain (team-lead ~22:40Z): my union OK naming b6414ec0b (original hold record + the re-run of the case leg with v2 and web-bunleg-changed)
  pre-authorizes publish, receipts, tasks. Then my three reads: (1) publish b0b7bedf1 -> b6414ec0b; (2) receipts commit: P7 with my verdict
  at its copied hash, owner report and lane evidence, the original AND re-run hold logs, the exemption list, r2-prerun records; (3) tasks
  commit: blocks 4 and 5 byte-equal to a dry run. Then the followup5e body (70e7132f172ddc88 before fills) named only on w4h-36's FINAL
  line after the fills (commit, hold-union, publish facts), re-hashed at naming; the push on team-lead's word.
  Waiting now: the re-staged web-bunleg-changed (per-file 0-pass red, shared helper) and team-lead's price-chart ruling.
- Union input, tool content (~22:55Z): the 4 tools integrator-5 could not prove are EQUAL to my pre-hold records: heavy-lib.sh e9ab2c05a91d7a45
  and test-count.sh c70294f528decb8c (plan-gate.md lines 192 and 189, the 07:55Z cleanup addendum), resource-gate.sh 6d494b2772241dea (plan-gate
  line 35), leg-judge.sh 16c38d52cc01c97f (verdict-w4h-31, before 00:39Z). Also equal there: merge-commit-gates 7c449267be86c11c, image-leg
  2b24cb184a26d55e, bun-pin cf1aad7852b8afdc. plan-gate is append-only and these lines come before its 15:37Z install line, so the records are
  pre-hold. The hold itself records no tool hashes at its start (heavy-batch.log head): the union rests on these records.
- Mass touch at 20:02:03Z: 185 of 192 files in w00/ top level, and my own files; content unchanged where a copy exists (8 of my files
  byte-equal to the mirror). No touch source found in readable scripts; the user systemd-tmpfiles-clean timer runs next at 23:43Z.
- Union input, support files (~23:05Z): all 15 of integrator-5's corrected list re-computed EQUAL, and each equals a pre-hold record:
  heavy-lib, leg-judge, resource-gate, test-count as above; plan-gate.md lines (all before its 15:37Z install line 343): lock-veto 36055ae9a28cf0f8 l130,
  own-pg 364ec5affe6bfa9a l77, config-check cc982a962b99c3d7 l183, findings-match e4058b1f027c0fcb l186, prune-scan e45a77e8c52fd7f0 and
  attestation-check afcbb0d8dc4a4636 l187, guard-suites ad5060a9d8573bbd l141, child-cov-bun ffd8ad5aecdcf2de l322, lcov-foreign-sources
  853340d4a2d00c42 l325, bun-pin cf1aad7852b8afdc l191; w4h-24 bunfig-testfiles.toml 9feea3b012349d1d is in committed receipts
  (git -S: a53f93a49 2026-10-13, 61c60df08 2026-10-14) as w4h-24-merge-bunfig-testfiles.toml.txt. Tool basis for the 375 legs: complete.
- Ruled (team-lead ~23:10Z): price-chart option (a): --list skips a listed file that the folder's extra-legs.sh runs as a named file_leg,
  printing "covered by leg <name>". L2 adopted (per-file red by name for a missing junit or 0 passed testcases, with a test and a mutant).
  One shared bun-junit helper called by web-bunleg-changed AND case-web-junit v2 (v2's call site re-staged). Podman-dependent test files run
  only in the lock, also in proof runs. The 20:02Z mtimes are team-lead's six-hourly touch loop (14:02Z, 20:02Z, 02:02Z) against the /tmp
  cleanup; content unchanged; the union is judged by hashes only.
  My checks for the re-stage: (a) the skip reads the file_leg names from extra-legs.sh (no second list), names the covering leg, and a
  listed file covered by no leg still runs; L2 by a planted all-skipped file (red by name) and a mutant; the helper is the ONE place of
  the bun junit run and the checks (grep: no second bun --reporter=junit in either tool); case-web-junit test still 25+ green with v2 on
  the helper; old 1 / new 0 / mutant 1 re-proven on this folder for v2.
- Noted (team-lead ~23:20Z): the 20:02Z touch is team-lead's six-hourly find -exec touch -c loop over /tmp/factory-platform-evidence and /tmp/factory-tools, logged in w00/tmpfiles-touch.log (2 line(s) now); next 02:02Z, through 18 Oct; the 23:43Z age clean does not remove files touched at 20:02Z; the permanent fix is the user's decision. Order after W4H-33: W4H-32 first, then W4H-34 (w4h-34's rerere-off dry runs: 788a514c8 merges cleanly onto b6414ec0b, no new conflict shape).
- Re-staged six files OK (~23:45Z): bun-junit-lib.sh.new 2c398d6c8aeaf95e (16), case-web-junit.sh.new v3 247e29a17ea48697 (29), its test
  b09a126a676f52d0 (84), web-bunleg-changed.sh.new v2 eea2f14dad7b00bb (31), its test 49a42d3d04eadcee (70), w4f-merge/hold-w4f.sh.new
  d3dacb9697e7bb0d (107). All re-hashed.
  L2 met in ONE place: junit_judge (missing junit or 0 passed testcases, skipped/failure/error not a pass, parse error = 0) and bun_junit_one;
  no other bun junit run in either tool. Ruling (a): file_leg names read from the folder's extra-legs.sh (awk), "covered by leg <name>".
  My runs (validator-8/wbc-check/v2/): wbc staged 29/0; cwj staged 30/0; cwj installed v2 22/8; my lib mutant "skipped counts as pass":
  wbc 27/2 (case 8) and cwj 26/4 (cases 9, 10), caught.
  Real proof hashes equal (list.out 708dc1ea871ea603, list 7ff9eb1626bb9740, run.log c06586736af45646, cwj-v3.out 03b5b0216339536b):
  covered by leg price-chart-stream-bridge; N = 11 of 193; the 11 = my 12 minus price-chart; all 11 green by junit (39..4 passed); cwj v3 on
  the folder rc 0 (vitest 75/54/7, sub-conversation bun 7).
  Notes, not blocking: (1) my mutant "covered line printed for a file_leg file that did not change" survives (list unchanged, only a false
  line); add an assertion. (2) awk reads every file_leg line, also one inside a conditional branch that may not run; this folder has none.
  (3) bun_junit_one does not clear an old junit first; the re-run's fresh out dir covers it. (4) case-web-junit still sends the classifier
  stderr to /dev/null. Install order: bun-junit-lib.sh first (both tools source its installed path).
- rerun/rerun.sh d3e69af690a606d3 OK (~23:55Z): header with the content hash of 27 hold tools at start (MISSING named); refuses unless at the
  clean detached merge b6414ec0b; diff-files from HEAD^1; the case leg in the SAME form as extra-legs.sh:40 (NOTEST=1 leg w4h33-red-first-cases
  case-check.sh) into fresh rerun/ (rerun/case-check absent now); the new leg's block read from the INSTALLED hold-w4f.sh with its hashes logged.
  Inputs byte-equal to the originals (cmp): red-first-files, tracked-skip-lines, warn-cases, not-runnable, whole-files, case-files-extra,
  hook-mapped-e50aedefd, config.sh, merge-sha.txt, extra-legs.sh (396ec755424bdcc4); childcov -> the hold's own childcov.
  Union checks after the run: header hashes = the pre-hold records for the 25 unchanged tools, and = the OK'd hashes for case-web-junit,
  bun-junit-lib, web-bunleg-changed, hold-w4f, tc-gate; rerun diff-files.txt = the original; case leg exit 0; web-bunleg-changed N = 11, exit 0.
- Time correction (validator-8, 2026-10-16T21:25Z by date -u): my '~HH:MMZ' labels written after about 20:50Z today were estimates and run ahead of the clock (for example '~21:45Z' to '~23:55Z'); the true UTC times of those sections are about 20:50Z to 21:20Z. Order and content are unchanged; logs with clock stamps are the time source.
- Union gate form ruled (2026-10-16T21:27:42Z): see plan-gate.md 'Standing rule: the union publish gate'. Waiting: step 1 (checker, test, publish.sh.new), then step 2 (union.exit, union-check.log, config.union.sh), then the publish.
- Union gate step 2 OK (2026-10-16T21:38:07Z) for W4H-33 b6414ec0b137272e413da5e0db9b4421bc7ac386: union.exit 9a271f2a916b0b6e (0), union-check.log 76100f09f092bb1b (a-e pass; last line HEAVY DONE status=0 dirty=0), config.union.sh 1265c6495f042dd0 (sources config.sh 1640af15351acff2 = prep-version.txt record: BASE b0b7bedf1, TREE ba1726d73; sets HEAVY_EXIT, HEAVY_LOG, REVIEW = verdict-w4h-33.txt 3123dab932aab470). Installed: union-exit.py 3ec27ab6246a68c7, test e75fda96a4986b05, publish.sh e3919a185e9386f0 (backup f55db31d526c443a); no .new. My re-derivation on a private copy (union-check/realcopy/): rc 0, lines a-e equal. Unchanged: heavy.exit 4355a46b19d348dc, heavy-batch.log f516e03c89df1710; reattach-proof-ref.log 0c2eea2e3eaa66a3 = the hash before the mv, no reattach.log. The publish may run with config.union.sh.
- Read 1 of 3, publish: OK (2026-10-16T21:49:16Z). Labelled reads: integ/w00 = b6414ec0b137272e413da5e0db9b4421bc7ac386; worktree HEAD = same, branch integ/w00, dirty 0; b6414ec0b^1 = b0b7bedf1. publish.out 919e802ed3f25b42: remote main 934531e2e = expected; identity b0b7bedf1..b6414ec0b 28 commits clean; 'published ... (was b0b7bedf1)'. One gated job w4h-33-publish (launch-publish.sh 307d79f3328f2ced, config.union.sh), command exit 0 at 21:46:54Z (publish-gate.log 100bb78b9e1e8abd; publish.exit 0). New reattach.log d19b03a3ecbd034c ('Switched to branch integ/w00'); reattach-proof-ref.log 0c2eea2e3eaa66a3, union.exit, union-check.log, heavy.exit, heavy-batch.log unchanged. Next: read 2, the receipts commit.
- Read 2 of 3, receipts: OK (2026-10-16T21:50:18Z). integ/w00 = 2f7cb00ccb697a6bcd4c4285852f9235b5644ac7 (labelled read), parent b6414ec0b, tree b6f97e8f3; author and committer <USER> noreply. 280 paths: 279 A + SHA256SUMS M; SHA256SUMS append-only (5352 -> 5631 lines, old is a byte prefix; 9e4f9446880f777d), each of the 279 added sums lines equals its committed file (0 mismatches). Committed hashes: w4h-33-validation.txt 3123dab932aab470 (= my verdict), merge-batch.log f516e03c89df1710, merge-batch-rerun.log 0ecdc4f5fa6d367d, owner report c303c1793bbad473, red-on-base f156134e8f67c89d; owner files = report, red-on-base, pending-lesson + 16 lane logs; union.exit, union-check, config.union.sh, config.sh, not-runnable, tracked-skip, warn-cases, whole-files, both reattach logs, publish records, 17 rerun and 6 r2-prerun records, gate-integrity, graph present. Added lines: no address outside noreply/reserved domains. Next: read 3, tasks.
- Read 3 pre-check of the tasks dry run (2026-10-16T21:51:06Z, before the commit): inputs equal (v10 304b09ad72800a1b, extract-blocks.py 4e8c6369cd3252c2, blocks 4 2a52b7d387817066 and 5 b298ce6c4b2a48f8); tasks-b45 hashes equal the integrator's. Dry lessons.md 2564d7f84c14bc12 vs 2f7cb00cc:tasks/lessons.md: ONE insert of 42 lines at line 2379, nothing removed; the insert is exactly block 4 + blank line + block 5 + blank line, directly before '#### Owners (from w4h-5/pending-lesson.md)'; neither block was in the base. Second run refuses ('already applied'). For read 3: committed tasks/lessons.md must be byte-equal to dry/tasks/lessons.md 2564d7f84c14bc12, todo.md unchanged, parent 2f7cb00cc, identity noreply.
- Tasks try 1 FAILED, nothing committed (2026-10-16T21:57:12Z, checked): labelled reads integ/w00 = HEAD = 2f7cb00cc, branch integ/w00, porcelain clean; tasks/lessons.md ef7ead75ff953597 and todo.md 02a6d188ca323c6c equal HEAD. Cause: 'git add tasks/lessons.md' refused (tasks/ is gitignored). Fixed tasks-locked.sh 04c4e6cc863919cf: line 15 'git add -f tasks/lessons.md && TC_IN_LOCK=1 git commit -F tasks-msg.txt', 75 mapped to 76; guards at lines 9-10 (clean on integ/w00 at 2f7cb00cc; v10 hash). Note: the try-1 script (40f1b1a056ff5faf) was replaced in place, not kept as a named copy, so its diff cannot be shown; try1 logs kept (apply, gate, exit, out). Ignored dirs tasks/tasks (2026-09-13) and tasks/testing-gaps/browser (to 2026-10-09) predate try 1. Try 2 waits for team-lead's word.
- Read 3 of 3, tasks: OK (2026-10-16T22:03:59Z). Labelled reads: integ/w00 = HEAD = 8fb4474e993a381ee9bc68b70cd16e4d95586550, parent 2f7cb00cc, tree 749618135, worktree clean; <USER> noreply; 1 file, tasks/lessons.md +42 -0. Committed lessons.md 2564d7f84c14bc12 = dry run; todo.md 02a6d188ca323c6c = parent; raw commit message 9bcc95314a1002e9 = tasks-msg.txt; subject names blocks 4 and 5. All three reads OK; the W4H-33 publish chain is complete. Next: the followup5e body, named only on w4h-36's FINAL line, re-hashed at naming.
- followup5e fill pre-check (2026-10-16T22:06:32Z; w4h-36's announcement, before the write; base FINAL 70e7132f172ddc88): COMMIT facts true: b6414ec0b parents b0b7bedf1 + e50aedefd, tree ba1726d73, 185 files, 28 commits; try 1 refused by the in-lock typecheck gate at 19:12:26Z ('another typecheck runs'); try 2 commit.sh exit 0 at 19:38:42Z; hook 127 bun files 1953 pass 0 fail, 27 vitest files 540/540. HOLD and PUBLISH facts equal my reads (f516e03c89df1710, 0ecdc4f5fa6d367d 21:16:05-21:20:49Z, verdict 3123dab932aab470, union files, publish 21:46:54Z, receipts 2f7cb00cc, tasks 8fb4474e9). At the FINAL line: re-hash the named file on disk; diff vs 70e7132f172ddc88 = only the 4 tokens filled, <HOSTED-COMPARISON-5> still open; identity check clean; no secret.
- BODY NAMED (2026-10-16T22:07:07Z) on w4h-36's line 'FINAL 91b2dea9abda3a4e (w00/wave4i/followup5e-pr-body-draft.md), no further edit': evidence/w00/wave4i/followup5e-pr-body-draft.md re-hashed on disk at naming = 91b2dea9abda3a4e (27106 bytes). Diff vs backup 70e7132f172ddc88 = lines 37 and 78 only (the four tokens filled); only <HOSTED-COMPARISON-5> left; '@' 0; identity-check files clean; secret pattern sweep 0. Every filled fact equals my records (commit, hook 127/1953/0 + 27/540, hold f516e03c89df1710, re-run 0ecdc4f5fa6d367d, verdict 3123dab932aab470, union files, publish 21:46:54Z, receipts 2f7cb00cc 9e4f9446880f777d, tasks 8fb4474e9). Wording note, not blocking: 'six shared tools' lists four; the other two installed files are their tests.
- Name WITHDRAWN (2026-10-16T22:09:21Z, team-lead's order): followup5e 91b2dea9abda3a4e is no longer named; w4h-36 corrects only 'six shared tools' (to four tools and their two tests) under a new FINAL line. Re-name checks: re-hash on disk; diff vs 91b2dea9abda3a4e = that phrase only; <HOSTED-COMPARISON-5> open; identity clean; '@' 0; secret sweep 0. The NAMED line goes to the integrator and team-lead and pre-authorizes push15 (head 8fb4474e9, push.sh 55a9c5bc6f0f81bb, launch-push.sh 45a3787ffe99e962). After the push: the hosted compare by bounded reads, judged against the push14 compare receipts.
- BODY RE-NAMED (2026-10-16T22:10:06Z) on w4h-36's line 'FINAL 7e896dd3ca53c8a1 (w00/wave4i/followup5e-pr-body-draft.md), no further edit': evidence/w00/wave4i/followup5e-pr-body-draft.md re-hashed on disk at naming = 7e896dd3ca53c8a1. Diff vs 91b2dea9abda3a4e (backup .bak-20261016-before-six-files): one line (37), only 'six shared tools installed on validator-8's OK (' -> 'six shared files installed on validator-8's OK (four tools and their two tests: '. <HOSTED-COMPARISON-5> the only token; '@' 0; identity-check files clean; secret sweep 0. This NAMED line pre-authorizes push15 (team-lead): head 8fb4474e9, push.sh 55a9c5bc6f0f81bb, launch-push.sh 45a3787ffe99e962, in the lock with the margin.
- Ledger NAMED (2026-10-16T22:11:32Z) on w4h-36's line 'FINAL 99366963ea015fd1 (w00/leftovers-2026-10-16.md), no further edit': evidence/w00/leftovers-2026-10-16.md re-hashed at naming = 99366963ea015fd1; backup .bak-20261016-before-70k = d928bab84fd67c19 (byte-exact). Diff: 1 header line (70a to 70j -> 70a to 70r) + 24 lines of items 70k-70r; 92 -> 100 items, 0 duplicate numbers, 70a-70r in order. Item facts check against my records: verdict-w4h-32.txt aa6fdcbdff3067f9, w4h-32/report.txt fe3072c1eda73462 (LEFTOVER 3 and 4), installed tools eea2f14dad7b00bb / 2c398d6c8aeaf95e / 247e29a17ea48697, plan-w4h-33.md at 2d0b29f89329bc61 notes 1-4. identity-check clean; secret sweep 0.
- Time-label note (2026-10-16T22:12:09Z): verdict-w4h-33.txt sections labelled '~20:50Z' (hold NOT OK) and '~21:05Z' (record judgment) carry estimated times, written between the hold end (20:39:38Z) and the union OK (21:25Z); see the plan time correction above. verdict-w4h-33.txt is NOT changed: its first line is the union OK that union-exit.py condition e reads, and the receipts (w4h-33-validation.txt) and the named body cite it at 3123dab932aab470. verdict-w4h-32.txt got a correction section on top (now cefbf3eec51a9021): its fix B ACCEPT was written at 20:50:22Z, not '~21:45Z'.
- push15 read: OK (2026-10-16T22:15:38Z). One gated job w4h-33-push15, in the lock (tc-gate push in-lock=1 GREEN 22:13:33Z, END exit 0 22:14:46Z; command exit 0 22:14:47Z; push.exit 0). push.log: b0b7bedf1..8fb4474e9 fast-forward of feat/factory-platform-followup-3; local = remote 8fb4474e9. Heads before/after: 98 refs each; the diff is that one ref only; main 934531e2e unchanged. identity b0b7bedf1..8fb4474e9: 30 commits clean. PR 341 OPEN, headRefOid 8fb4474e9. Body: pr-body-applied-5e.md = the named followup5e 7e896dd3ca53c8a1 (cmp) = pr-body-live-5e.md (cmp); the body before was 5b628b8ac128f917. Next: the hosted compare by bounded reads against the push14 compare receipts, when the hosted run ends.
- BODY NAMED (2026-10-16T22:55:44Z) on w4h-36's line 'FINAL df3112999b290212 (w00/wave4i/followup5e-pr-body-draft.md), no further edit': re-hashed on disk = df3112999b290212; diff vs backup 7e896dd3ca53c8a1 (push15's live body) = the one 'Hosted, this push' line; tokens 0; '@' 0; identity clean; secret sweep 0. Facts check: 59/45/3/11; class A/B unchanged; gate integrity 3 findings; D1-D5 as in my verdict; '21 mutants with no test run' = the log ('21 mutant(s) "survived" without a single test run'; 23 instrumented); verdict cited at 1c2656204f7bb402. Verdict chain (top-insert, suffix equality): 1c2656204f7bb402 minus the 6-line D5 section = c516b962ad86f059; minus the 22-line D1-D4 section = 3123dab932aab470 (the receipts' copy). D5 complete; 1c2656204f7bb402 is final for this round.
- Body edit 2 read OK (2026-10-16T22:59:37Z): push15/pr-body-live-before-edit-2.md 7e896dd3ca53c8a1; pr-body-applied-edit-2.md = pr-body-live-after-edit-2.md = the named df3112999b290212 (cmp); PR 341 OPEN, headRefOid 8fb4474e9 before and after (body-edit-2-before.json 60e21c9de3faf1a7, -after.json 123360e5a6c8b3f4).
