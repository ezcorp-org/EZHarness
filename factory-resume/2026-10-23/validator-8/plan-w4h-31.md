# validator-8: W4H-31 validation plan (prepare only; wait for the owner's freeze)

Package: merge origin/main 934531e2e (PR #339: processSpawn + capabilities() on every runner.start caller; the factory sites via
FACTORY_GUEST_PROCESS_SPAWN = "allow" in src/factory/runner/guest-process-policy.ts; a spawn guard in extension-runner's podman.ts,
python.ts, supervisor.ts) into a branch from the integ head after the W4H-30 publish; the union resolved in host-launch-service.ts,
host-launch-supervisor.ts, supervisor-process.ts, supervisor-services.ts and their tests.

## Facts read at 934531e2e
- Factory start sites on main: attempt-runtime.ts:326/352, host-launch-supervisor.ts:98 (processSpawn: FACTORY_GUEST_PROCESS_SPAWN)
  and :256, reference-data/pack.ts:201-202, runner/supervisor.ts:114; scripts/verify-factory-image-pack.ts:338/425.
- RunnerClient gains capabilities() (client.ts:47-48: unknown_method -> processSpawnEnforcement false); PodmanRunner answers
  processSpawnEnforcement from its guard probe (podman.ts:388); policy parsed at podman.ts:736.
- Guard tests: extension-runner tests/spawn-guard.test.ts, spawn-guard-probe.test.ts, service.test.ts, podman.integration;
  extension-contract process-spawn.test.ts; src/__tests__/runner-worker-isolation.proof.test.ts, gate-scripts.test.ts.

## Legs
V1 Identity: on the merge commit and the owner's commits (author and committer = the noreply address); main's commits in content
   mode (the personal address 0 times in the merged diff and messages).
V2 Tree equality: every file equals one parent (the integ head or 934531e2e) except the resolved ones; each resolved file read as
   the union (main's processSpawn/capabilities lines AND W4H-26's preparation, records, join and bounds lines).
V3 Every runner.start site in the merged tree passes processSpawn (git grep of every `.start(` on a Runner and every StartRequest
   literal; W4H-26's sites included: the supervisor's launch path in host-launch-supervisor.ts with the durable preparation code,
   the provisioned loader in supervisor-process.ts). The preparation path calls runner.build, not start: I read whether #339's
   guard covers build; if it does, the build call carries the policy too.
V4 Mutants: a factory site dropping processSpawn -> a named test red (#339's guard test or a factory test); capabilities()
   ignored at a site that must refuse a runner without enforcement -> red. W4H-26's D6 mutants (peer tenant, supervisor source
   digest, client artifact digest, product binding artifact) and the R6 mutants (T1 sameSource, N6 failed build recorded, N7
   entry after an await, refused entry kept) still die on the merged code.
V5 Suites: #339's guard tests and the podman supervisor suites (spawn-guard, spawn-guard-probe, service, the podman integration
   suites, runner-worker-isolation proof); W4H-26's host-launch-service/supervisor/supervisor-process suites; the
   invariant list; the PostgreSQL provisioning suites on my own PostgreSQL.
V6 The preparation-through-the-supervisor proof re-run on the merged head (the owner's), and my real H4 restart tool re-run
   (first / second / control / failed), heavy under gated-flock.
V7 Gates: gate-integrity main (934531e2e) = exactly 0; lint; typecheck by the tc rule; 100 percent of the resolved files'
   changed lines; CRAP.
Note for W4H-28: it rebases onto this result; its P3 validator runtimes and the supervisor build operation must pass processSpawn
(my W4H-28 V6 gains this check).

## Verdict
ACCEPT when V1-V7 hold. A start site without processSpawn, a lost W4H-26 behaviour (any R6/D6 mutant surviving), or a guard test
red = REJECT with the finding.

## Addendum (2026-10-15T21:08Z, validator-8): verifying the full hold RE-RUN before publish (team-lead ruling)
No judgment-based publish: publish.sh keeps heavy.exit = 0 and "HEAVY DONE status=0". hold-judgment.txt 67a632feddae3ee2
stays on record for the first run (not verified by me; it was PENDING).
Tooling the re-run must use (I check the hashes recorded in the run's logs or at its start): leg-judge.sh 929d0a6fc43d2150;
heavy-lib.sh 000cb68ac789d36e; not-runnable.txt 386c769458507dad; tracer bash-trace-env.sh 5bd68174bcace71c;
w00/bash-line-cover.py 08d2107533834b01; w00/sync-base-leg.py d44bbd55bb717c2c (v3; checked 21:07Z).
Checks on the recorded result (read only, no re-run):
1. heavy.exit = 0 and the log line "HEAVY DONE status=0"; the commit under test = 390c49a90.
2. Every leg's exit and classification, from the logs: a leg is green (0), INFORMATIONAL with its raw exit kept (only
   where a ruling names it: CRAP; case-check coverage sub-checks on main's own lines), or NOT RUNNABLE list-bound. No other
   non-zero leg.
3. The list-bound legs: exactly the four ruled paths, each leg naming exactly ONE file (AH-1), each raw exit 97 with
   "zero tests ran"; the four files byte-identical at b80a00f47, 934531e2e and 390c49a90.
4. case-check: every by-name case passed; each informational coverage sub-check names only lines that are main's own
   (lines whose file is byte-identical at 390c49a90 and 934531e2e, or lines outside the merge's own resolution lines);
   container-engine.test.ts and installer-core.test.ts green under the fixed tracer.
5. W-SYNC base leg: sync-base-leg v3 receipt line "files named N; not main's own 0"; main leg exactly 0 with an empty
   expected file.
6. No leg hidden: the count of legs in the run equals the count in the hold script's leg list (no leg skipped).

## Addendum (2026-10-15T21:2xZ, validator-8): case-check v8 and sync-line-owner.py (integrator-5) for the re-run
Hashes: w00/sync-line-owner.py 0690f5d1a7147084 (test 50a9a697e55fcc08); case-check.sh v8 79eb4acad3c2b062 (in
w4h-24-web-shard-timeout/; test w00/case-check-sync.test.sh 3f8df1cb88607c63); w4h-31 case-rerun.sh 928beab632fb4ffd.
Re-runs: rerun1 = v7 + fixed tracer (lock 21:06:24Z); rerun2 = v8, queued 21:17:05Z, the mechanical one.
- sync-line-owner read: a named line is main's own when it is not on the + side of `git diff -U0 A M -- <path>`; hunk
  "+start,0" adds nothing; a file renamed against main shows as all + (conservative: not main's own); input lines that
  do not match "<path>: ... uncovered|missed N -> [..]" are not counted, and case-check v8 turns a failed sub-check that
  names no line RED, which covers that.
- On my copy: 6/0. Mutant "no line is ever added" -> 5/1 (killed). Mutant "hunk range shifted by one line" -> 6/0
  (SURVIVED): the test does not pin an exact line list at a hunk edge. Minor finding SLO-1: add a case where the uncovered
  list straddles a one-line hunk (for example hunk +90,1 with uncovered [89, 90, 91]) and the answer must be exactly [90].
- case-check-sync.test.sh NOT run by me: it cds into integrator-5's worktree (w00-integration) and runs a unit test file
  there, while rerun2 is queued for that worktree. I judge v8 by its code and by rerun2's recorded receipts instead
  (each informational sub-check's per-file line "not main's own 0"; any K > 0 -> RED in the record).

## Addendum (2026-10-15T21:3xZ, validator-8): AH-1 closed — leg-judge hash for the re-run checks REPLACED
The re-run must use w00/leg-judge.sh 46576c39abb6b205 (not 929d0a6fc43d2150); test leg-judge.test.sh 441ec6be69e5e46c.
On my copies (validator-8/legjudge-check/ah1-run.log): new 14/0; the pre-AH-1 judge (.bak-20261015T2117Z-ah1) 10/4 (red
first); heavy-lib-leg.test.sh 8/0 with the new judge. Rule: a zero-test exit is excused only when the leg has test-file
arguments (*.test.ts/tsx/js/mjs) and every one is listed.
Note (minor, leftover): *.spec.ts / *.test.cts / *.test.mts are not test-file arguments for the judge; such an unlisted file
in a leg with a listed file would be skipped by the check. No such leg in W4H-31 (I confirm in the record).
After rerun2, the FULL hold is re-run under the installed tooling; my checks above apply to that full re-run.

## Addendum (2026-10-15T21:4xZ, validator-8): SLO-1 closed; rerun1 facts
sync-line-owner.test.sh 4a96ce63480266d2 (tool unchanged 0690f5d1a7147084). On my copy: 8/0; my +1 shift mutant now 6/2
(killed). Log validator-8/slo-check/slo1-run.log.
rerun1 (v7 + fixed tracer, 21:06-21:18Z), as reported: exit 1 only from the two coverage sub-checks that v7 always marks red;
no "RED:" test file (container-engine.test.ts and installer-core.test.ts pass under the fixed tracer); by-name 5/5. I read
rerun1's log for these three facts when I verify the full re-run. rerun2 (v8) holds the lock since 21:18:00Z. The judge's
test-file pattern is being widened (.spec / .cts / .mts); its hash replaces 46576c39abb6b205 when it arrives.

## Addendum (2026-10-15T21:5xZ, validator-8): leg-judge hash for the re-run checks REPLACED again
The re-run must use w00/leg-judge.sh 16c38d52cc01c97f (not 46576c39abb6b205 or 929d0a6fc43d2150); test leg-judge.test.sh
f808408a621c6480. Test files = *.test.* and *.spec.* with ts/tsx/js/mjs/cts/mts. On my copies
(legjudge-check/ah1b-run.log): new 17/0; the previous judge (.bak-20261015T2119Z-ah1b) 14/3 (red first); heavy-lib-leg 8/0.
The leftover note on .spec/.cts/.mts is closed.

## Addendum (2026-10-15T22:3xZ, validator-8): rerun2 (case-check v8) checked ahead, read only
Record: case-rerun2.exit = 0; heavy-w4h26-invariant-cases-rerun2.log (251 lines). By-name: 5 CASE PASS (T1, N6, N7, the slow
start join, the spawn-policy case). Coverage sub-checks, both INFORMATIONAL under SYNC_BASE_MAIN 934531e2e: test lines 75
in 4 files, bash lines 13 in 6 files, "not main's own 0" for each file.
Independent cross-check (git blob equality, not the integrator's tool): 9 of the 10 named files are byte-identical at
390c49a90 and 934531e2e. The one that differs, src/__tests__/extension-lifecycle-service-trusted-local.test.ts, names
uncovered line 16; the merge's + hunks against main are lines 53, 55 and 89-94, so line 16 is main's own. The v8 result
for rerun2 is correct. This carries into the full re-run check only if its case-check output is byte-equal in substance
(same files, same lines); otherwise I re-check it there.

## Addendum (2026-10-15, validator-8): identity-check.sh becomes pattern-based (user decision, relayed by team-lead 2026-10-15): integrator-5/identity-deny.txt is dropped (deleted by name by integrator-5); content and files modes refuse ANY email-like string that is not the <USER> noreply address, by pattern, with no stored personal address anywhere; commits mode stays "author and committer = noreply"; red first; installed before the W4H-31 publish. My redaction rule ("<a non-noreply address>") stays.
Checks on copies when the hashes arrive [L]: (1) red first: a fixture line with a made-up non-noreply address is refused by the new check and passed by the old one; (2) the <USER> noreply address passes; (3) false positives, each named in the test with its decision: RFC 2606/6761 fixture addresses (for example the proof fixture user at example.invalid, example.com, .test), package scopes such as @ezcorp/x (no local part), user@host in URLs or ssh remotes, other GitHub noreply addresses; (4) no file anywhere stores a personal address (a search of the tool, its test and its fixtures for email-like strings finds only noreply and reserved-domain fixtures); (5) identity-deny.txt is absent (listing by name); (6) the refusal output names the file and line but prints the address as "<a non-noreply address>".

## Addendum (2026-10-15, validator-8): identity-check v2 status: integrator-5 deleted integrator-5/identity-deny.txt by exact name (my listing at 23:4xZ: absent). v2 15dac2e8898a9c5b (test 77095f05c2efde4d; owner: old 2/10, new 13/0; bash-line-cover 19/19). Exceptions ruled by team-lead: (a) RFC 2606/6761/6762 reserved special-use domains incl. *.local; (b) systemd unit types and "patch" last labels (for example user@<uid>.service); (c) URL/scp user@host form, to be added; (d) for a W-SYNC merge, content mode judges only lines that are not main's own (sync-line-owner.py or blob equality; receipt names MAIN-OWN). Today's finding: b80a00f47..390c49a90 names 1 file, main's own web/e2e/reliability.spec.ts (a fixture on a real domain) -> not blocking under (d); leftover for main: move it to a reserved domain. I verify v2 with (c) and (d) on copies when those hashes arrive, with the checks of the previous addendum plus: (c) cases (https://user@host/..., git@host:org/repo) pass and a bare address does not; (d) a non-main line with an address is refused while the main-own fixture line is reported MAIN-OWN.

## Addendum (2026-10-15T23:1xZ local 19:1x EDT, validator-8): final identity-check verified on copies
w00/identity-check.sh 3a9da7ef720e7a0e; identity-check.test.sh 1e491ce920156796; W4H-31 leftovers-pending.txt d40e1bd6321bf38a.
Evidence validator-8/identity-check/run.log, dry-sync.out, dry-nosync.out.
- Test on my copies: final 21/0; v3 (.bak-20261015T2310Z-v3, 5db4cd7f0a7df6d0) 19/2 (red first).
- Self-check (counts only, no address printed): the tool holds 1 email-like string (the noreply address); the test holds 10,
  all the noreply address or reserved-domain fixtures (a subdomain of example.org and an upper-case EXAMPLE.NET needed a
  second look; both reserved). No personal address stored.
- Dry run, read only, in the main repository: commits b80a00f47..390c49a90 with IDENTITY_EXCLUDE=934531e2e and
  SYNC_BASE_MAIN=934531e2e -> rc 0, "3 commit(s) checked, clean", one line "MAIN-OWN: web/e2e/reliability.spec.ts:355 ...
  holds <a non-noreply address>; main's own line, not judged (W-SYNC)". Without SYNC_BASE_MAIN -> rc 1, the same line as an
  IDENTITY finding. Both outputs hold 0 email-like strings other than noreply.
- The main repository's working tree shows 6 modified files dated 2026-10-04 to 2026-10-13 (another session's); my run
  only read with git and changed nothing.
Identity check: VERIFIED for the W4H-31 publish.

## Addendum (2026-10-15, validator-8): publish wiring with the W-SYNC identity step, verified on a copy
integrator-5/publish-if-main.sh 363d269e22f8fe6b (test babefee10d96e6b4); W4H-31 config.sh a66984c5d937668b (exports
SYNC_BASE_MAIN and IDENTITY_EXCLUDE = 934531e2e9e8fd0c...); launch.sh c46ac9dd03de6c1d.
- Guard read: main compare first (moved or unreadable main -> rc 1); then identity-check commits BASE..merge with the
  config's environment into <D>/identity-publish.txt; any non-zero -> rc 1, nothing published; then publish.sh (or the
  test seam PUBLISH_IF_MAIN_PUBLISH).
- Test on my copy (seam present; never run against a version without the seam): 4 ok, rc 0: moved main; W-SYNC equal main
  with the main-owned fixture as MAIN-OWN, published (marker); no SYNC_BASE_MAIN -> rc 1, nothing published; unresolvable
  sha -> rc 1. Output holds 0 email-like strings other than noreply. Evidence validator-8/publish-check/run.out.
- launch.sh publish refuses unless <D>/heavy.exit = 0 (exit 3), then runs the guard with expected main = SYNC_BASE_MAIN.
  It does not check my verification of the re-run; that order is team-lead's (my OK before "launch.sh publish").

## Addendum (2026-10-16, validator-8): identity-check false-pass fix verified on copies (before any publish identity step)
w00/identity-check.sh ef09124c9d7360ed (test 83146e964c80c90a); publish-if-main.sh b4730a8ae6ce46ee; reprep.sh
268da709b02720f2. Test on my copies: new 26/0; the previous 3a9da7ef720e7a0e 22/4 (red first); 0 addresses printed. Outside
any repository: rc 1 "no repository". My reproduction from the W4H-36 worktree with HEAD (read only): previous version rc 0
"0 commit(s) checked, clean" (the false pass); new version resolves HEAD to 7e4dbaae0 and checks 3 commits. Evidence
validator-8/identity-check/v5-run.log, v4-wt.out, v5-wt.out. The publish dry run (3 commits clean, MAIN-OWN
reliability.spec.ts:355) is integrator-5's record; my earlier dry run gave the same.

## Addendum (2026-10-16, validator-8): own-pg.sh tag pull (team-lead ruling (b); integrator, after the W4H-31 hold)
w00/own-pg.sh pulls docker.io/pgvector/pgvector:pg15 by tag (line 7). Ruling (b): the integrator makes own-pg.sh read
w00/test-images.lock.json (same shape as scripts/test-images.json) and refuse a tag, red first; after W4H-33 lands, own-pg.sh
reads the repo's "pgvector" key with the w00 file as fallback. Checks when the hashes arrive (copies only; own-pg.sh starts
containers, so the test must use a fake podman on PATH or a dry-run seam): a tag in the lock file -> refused by name before
any podman call; a digest -> the podman run line uses image@sha256:...; the repo key wins over the w00 fallback when both
exist; a missing key in both -> refused (never a silent tag); the start logic is not copied (W4H-35 Q9 reuses it).

## Addendum (2026-10-16, validator-8): own-pg (b) staged files verified on copies (install after the hold)
w00/test-images.lock.json a7f07437bc0971b1 ("postgres" copied from the repo; "pgvector" =
docker.io/pgvector/pgvector@sha256:9a169499888c9d75ad14d0401be64839d2c325f32e399098261589faff93d65c); w00/own-pg.sh.new
364ec5affe6bfa9a; w00/own-pg.test.sh e3381dba0a79d75d. Read: the image comes from OWN_PG_LOCK key "pgvector"; anything not
"<name>@sha256:<64 hex>" stops with rc 3 before any podman call; neither version calls podman by an absolute path (so the
PATH stub catches every call); readiness runs through podman exec (stubbed). Test on my copies: new 9/0; current
(ad7babdd3199dfc0) 2/7 (red first). After the runs: no /tmp/i5-ownpg-test-*-home folder and no i5-ownpg-test container
exists (nothing to clean). Evidence validator-8/ownpg-check/. Open for later: after W4H-33 lands, the repo key first with
the w00 file as fallback (ruling (b)); I check that change when it comes.

## Addendum (2026-10-16, validator-8): W4H-31 published; the ls-remote stall; checks for the bounded-timeout fix
Published: integ/w00 = 390c49a90 at 02:51:51Z (identity step 3 commits clean, one MAIN-OWN line; publish.sh CAS + reattach).
Deviation recorded: the first publish try hung 192 s in `git ls-remote origin` (a stalled SSH; a fresh ls-remote took 0.6 s);
the integrator ended its own child; the guard refused ("remote main none ... not published", rc 1; integ unchanged; evidence
publish.out.try1-lsremote-stall). Ruling: a bounded timeout on the guard's ls-remote and on the push step's remote reads, red
first with a hanging stub, before the PR 341 push.
Checks when the hashes arrive (copies only; the remote is never contacted: a stub git or a stub remote):
- T1 red first: with a stub that hangs (sleeps far longer than the bound), the CURRENT publish-if-main.sh / publish.sh hang
  until an outer test timeout (the test fails by its own bound, not by a hang of the test run); the new versions end within
  the bound with a NAMED refusal (for example "STOP: remote read timed out after Ns"), rc 1, nothing published (the publish
  seam's marker absent).
- T2 bounded, not disabled: the timeout value is a named constant or variable with a default (seconds, > a normal ls-remote,
  far < the 192 s stall); a value of 0 or empty does not disable it (refused or clamped to the default: a test); a slow but
  answering stub inside the bound still succeeds (no false refusal).
- T3 every remote read covered: git grep in publish-if-main.sh, publish.sh and the push step for ls-remote, fetch, and any
  remote call; each runs under the bound (one helper; no second timeout implementation); mutant: the timeout removed from
  one call -> its hang test red.
- T4 the timeout kills the whole child group (no stray ssh left: a process listing after the timed-out case shows no stub
  child).
- T5 identity and the moved-main and unresolvable cases still pass (the existing 4 cases); bash-line-cover on the changed lines.

## Addendum (2026-10-16, validator-8): gitleaks finding = random id CONFIRMED; the timeout fix judged (3 findings)
Gitleaks (generic-api-key) on the receipts copy of heavy-unit-src-extensions-__tests__-workflows-delegated-seam-test-ts.log line 6,
field "tokenActorExtensionId": RANDOM ID CONFIRMED from the source: the field is logged at
src/extensions/tool-executor/provenance.ts:29 as prov?.actorExtensionId; the test sets actorExtensionId to its extensionId
(workflows-delegated-seam.test.ts:164, :178), which is row!.id from an insert into extensions WITHOUT an id
(:210-215); src/db/schema.ts:1413 defines extensions.id as text().primaryKey().$defaultFn(() => crypto.randomUUID()). Not a
configured secret, not read from the environment or a file. Both hold logs (run 1 and run 2) hold one value each, UUIDv4
shaped; no other file under w00/w4h-merge/w4h-31-sync-main-934531e2e/ holds either value (so the two differ). Value never
printed.
Timeout fix: publish-if-main.sh 780a82fe39b36adf (was b4730a8ae6ce46ee: no timeout at all), test 6907b0cb9e186b38; also
w00/remote-read.sh b42a8ecb635b5ca1 + test 991348a865711221 (helper remote_head / pr_state, REMOTE_READ_TIMEOUT_S default 60,
UNREADABLE on a failed or stalled read). publish.sh f55db31d526c443a has NO remote read (update-ref + checkout only), so
nothing to bound there.
- T4 holds: GNU timeout ends the child group (my stub: rc 124 after 2 s; no stray sleep child left).
- TF-1 (T2) the bound can be disabled: GNU timeout treats a duration of 0 as NO timeout (checked: "timeout 0 sleep" runs to
  completion); PIM_LSREMOTE_TIMEOUT_S=0 and REMOTE_READ_TIMEOUT_S=0 disable the bound. Fix: clamp to >= 1 (or refuse 0) with a test.
- TF-2 (T1/T3) two implementations and an unnamed stall: publish-if-main.sh:12 has its own inline timeout instead of sourcing
  remote-read.sh's remote_head; on a stall it reads "none" and refuses as "remote main none ...", which names a missing branch,
  not a stall. Fix: publish-if-main uses remote_head (one helper) and refuses with UNREADABLE named as a timed-out or failed read.
- TF-3 the test itself reads the real remote without a bound: publish-if-main.test.sh:8 runs `git -C <integ worktree> ls-remote
  origin refs/heads/main` unbounded (a stall hangs the test), and the non-stall cases contact GitHub through the guard. Fix: a
  local bare repository as origin for the test (no network), or the bounded helper for that read.
- Push step: the PR 341 push script must read the remote through remote-read.sh (the last one, push10/attempt4/push.sh:13,
  had an unbounded ls-remote); the git push itself is a write and not in the ruling (noted).
I did not run the owner's test, because it contacts GitHub (TF-3).
Rulings (team-lead, 2026-10-16): TF-1 (clamp >= 1 or refuse 0, with a test), TF-2 (one implementation: remote_head; UNREADABLE
named as a timed-out read), TF-3 (a local bare repository as origin; no network in the test), the push script's reads through
remote-read.sh; extension T6: the git push itself bounded (a generous default, about 300 s), and after a timed-out push a
remote_head check BEFORE any retry, stub-tested. The receipts commit proceeds under ruling (a); the PUSH waits for my OK.
T6 checks (copies, stubs only): a push stub that hangs is ended at the bound with a named result (not a hang); the default is
named and generous (~300 s) and 0 cannot disable it (TF-1 rule); after a timed-out push the script reads remote_head: if the
remote already has the new sha, it records "landed" and does NOT push again; if it still has the old sha, a retry is allowed
(bounded count); if UNREADABLE, it stops by name (no blind retry); mutants: retry without the remote_head check -> the
"already landed" case pushes twice (red); the bound removed -> the hang case fails at the test's outer bound (red).
Also for TF-1..TF-3: the old files must be red against the new tests (the 0 case; the "none" wording; the network-free origin).
Note (2026-10-16): the GitHub SSH stall is the host's SSH agent (herdr socket; ssh-add -l hangs), not GitHub. Ruled (a'): remote reads and the push run with GIT_SSH_COMMAND='ssh -o IdentityAgent=none -o BatchMode=yes' in the environment (no config edit, no transport change, no credential in argv). T1-T6 unchanged and network-free; when I read the push script I check only that this env carries no key material or path to a secret in argv (option names only), and that BatchMode=yes keeps a prompt from hanging.

## Addendum (2026-10-16T03:2xZ, validator-8): TF-2 / TF-3 / T3 / T4 judged; receipts b8ca14a60 and tasks ff8331a70 checked
Files at judgment: w00/remote-read.sh b42a8ecb635b5ca1; w00/remote-read.test.sh 4969b26f79839a7f (team-lead relayed
ddbb5d6a4854d4a2 with 7 cases; the file now has 10 cases incl. TF-1 cases for an rr_bound function the library does not have
yet); integrator-5/publish-if-main.sh 8a658ea7fff5fc34 + test 98b1f4b49b1f973b; w00/push-lib.sh e3d04d73b27343bc +
push-lib.test.sh 4bd9aaeb15d9d186 (relayed ddcc46e9964c4028; changed after the relay; judged with T6 later).
- TF-2 / T3 PASS: publish-if-main.sh sources w00/remote-read.sh and reads main through remote_head (line 13; its only
  "ls-remote" is a comment); a stall refuses as "STOP: remote main UNREADABLE (bounded read); not published". The guard test on
  my copy: new 5/5; the previous guard 780a82fe39b36adf 4/5 (fails the named stall case: red first). push-lib.sh has no direct
  remote call (it sources remote-read.sh).
- TF-3 PASS for the guard test: a stub git on PATH answers ls-remote (or stalls with STALL=1); identity runs in the test's own
  repository; no case reads the network.
- remote-read.test.sh on my copy of the library: 8 pass / 2 fail, the 2 being TF-1 cases (rr_bound) the library does not
  have yet; without the library 0/10. Its stall stubs record their pids and the EXIT trap ends them.
- T4 PASS (earlier: GNU timeout ends the child group).
- My stray: my first run of remote-read.test.sh (23:13:41 local) left one "sleep 300" (pid <PID>) under my own tool shell;
  stopped by pid; my rerun left none. Another "sleep 300" (pid <PID>, parent push-lib.test.sh, 23:12:48 local) is
  integrator-5's run, not mine, not touched (reported).
- Pending: TF-1 (rr_bound clamp; the library change), T1/T2 and T6 (push-lib) on their final hashes.
Receipts and tasks (integration worktree, read only):
- identity-check v5 commits 390c49a90..ff8331a70: 2 commits, clean.
- ff8331a70 tasks delta: tasks/lessons.md +99 -0, tasks/todo.md +62 -0 (insertions only, 161 lines); no <W4H-31-*>
  placeholder left; the W-SYNC-9 landing record names the hold re-run (906/906, status 0), my OK 2ed52d08e6bfabbe and
  receipts b8ca14a60; it cites my ACCEPT verdict 8ed9d677f804b3f0 (the sha at that time; correct as history).
- b8ca14a60 receipts: 937 files, insertions only; w4h-31-merge.json excludedFromReceipts names the file, its sha256
  daa30558a77b8d80a121b19562716008e8f63f72af9835eee0909e2c31a90952 (= the hold log's sha256, recomputed by me), the receipt
  name, the gitleaks rule and line, the reason and the ruling; no receipt file named *workflows-delegated-seam* exists (neither
  run's copy); deviations listed (publish try 1 stall; hold 1 red; the exclusion).

## Verdict (2026-10-16T03:2xZ, validator-8): TF-1, T1/T2, T6 PASS; the push script NOT OK yet (one finding)
Files: w00/remote-read.sh 9f306874848177fb + test 2b1b1f8679af3eb0; integrator-5/publish-if-main.sh 8a658ea7fff5fc34 + test
255dd1ee43727bca; w00/push-lib.sh 788c654c099a17e2 + test 4bd9aaeb15d9d186; w00/wave4i-3/push11/push.sh 0e92dd3341ee281c.
- TF-1 / T2: rr_bound VAR DEFAULT (remote-read.sh:8): a non-numeric value -> the default; a value below 1 -> 1; every bound of
  the read, the guard and the push goes through it. The helper test on my copy: final 9/0; the old helper
  (.bak-tf1, b42a8ecb635b5ca1) fails the two TF-1 cases (bound 0 runs unbounded to rc 124; rr_bound absent): red first.
- T1: the guard test 6/6 on the installed guard (adds "PIM_LSREMOTE_TIMEOUT_S=0 + stall -> UNREADABLE in 1 s, nothing published").
- T6 (push_once, read): the push runs under timeout $(rr_bound PUSH_TIMEOUT_S 300); after it, one bounded read decides:
  UNREADABLE -> STOP rc 8, the local ref left at NEW; the new sha -> landed (after rc 124 it says "LANDED despite the push
  timeout ... not repeated"); any other sha -> the local ref restored to OLD. The restore runs only when the remote does NOT
  read NEW, so it cannot fire on a landed push; there is no retry in push_once and none in push.sh. The push-lib test on my copy
  11/0 in 10 s (incl. "push lands then hangs -> LANDED, not restored" and "PUSH_TIMEOUT_S=0 still bounded").
- A re-queue cannot double-push: if push.sh is re-run (for example a gated-flock re-queue on exit 75 from tc_run's gate, which
  comes before any push), push_once first requires the remote to read OLD, so a landed push makes a re-run refuse (rc 4).
- push.sh (read): the integration worktree must be clean at ff8331a70 on integ/w00; config check; identity first in the W-SYNC
  environment (identity-check v5 ef09124c9d7360ed); push_once with PR 341 OPEN required; PUSH_TIMEOUT_S=3600; no direct
  ls-remote or gh; no force, no -u, no retry.
- FINDING (team-lead's requirement): push.sh does NOT set GIT_SSH_COMMAND='ssh -o IdentityAgent=none -o BatchMode=yes' (grep:
  absent). With the known agent hang, a recurrence inside the 3600 s bound would cost an hour. Fix: export it in push.sh before
  push_once (option names only). After that change I check the one line and the new sha; then OK.
- Strays: none of mine left (one "sleep 300" from my old-helper run ended by itself within seconds). Integrator-5's
  "sleep 300" pid <PID> (since 23:21:40 local, under its red run's "timeout 0 git ... ls-remote") is still running (not mine).

## FINAL (2026-10-16T03:27Z, validator-8): OK TO PUSH — push11/push.sh c552bdf7f1921c7e
- push.sh c552bdf7f1921c7e: the command lines are the ones I judged in the verdict above plus line 14
  `export GIT_SSH_COMMAND='ssh -o IdentityAgent=none -o BatchMode=yes'` (option names only; no key or path); no direct
  ls-remote, gh or fetch (0 non-comment matches). The finding is closed.
- push-lib.test.sh 128770e157d56f4e on my copy of push-lib.sh 788c654c099a17e2: 12/0 in 10 s (case 12: no stub child outlives
  its bounded command before the exit trap).
- Unchanged and already judged: remote-read.sh 9f306874848177fb + test 2b1b1f8679af3eb0 (9/0; old 7/2); publish-if-main.sh
  8a658ea7fff5fc34 + test 255dd1ee43727bca (6/6). Deviations file push11/deviations.txt a7ba0f3a7b010362 (read by sha only).
- After my runs no "sleep 300" or stub process exists on the host (both integrator strays have ended too).
Follow-up (2026-10-16, not a gate): integrator-5 changed the three test files only (stub pids recorded and ended by the EXIT trap, the guard test also on TERM/INT; stubs sleep 30 s, not 300). Code under test unchanged (remote-read 9f306874848177fb, push-lib 788c654c099a17e2, guard 8a658ea7fff5fc34, push.sh c552bdf7f1921c7e), so OK TO PUSH stands. When the new test hashes arrive I re-run them on copies (expected 9/0, 12/0, 6/6) and a hard-kill case (timeout -k 5 on each test; 0 stub survivors at +1 s and +35 s, counted by my run's own start time).
Follow-up DONE (2026-10-16, validator-8): new tests on copies of the unchanged code: remote-read.test.sh 039cff800647a822 9/0; push-lib.test.sh 7e2d970677faa13b 12/0; publish-if-main.test.sh 42cca53cf0645a86 6/6. Hard kill: the unbounded old guard b4730a8ae6ce46ee under the new guard test with timeout -k 5 25 -> rc 137 after 30 s; sleep stubs from my run (elapsed time within my run) at +1 s: 0, at +35 s: 0. Stub cleanup closed.
Push try 1 and the byte diff (2026-10-16, validator-8): push11/push.sh.v1 (0e92dd3341ee281c) vs push.sh (c552bdf7f1921c7e): the ONLY change is 3 added lines (2 comment lines + the GIT_SSH_COMMAND export) -- now proven by diff, not only by reading. Try 1 (push.try1-tc-gate-75.log): local moved to ff8331a70 at 03:33:53Z; push command exit 75 (tc-gate refused the lock-free typecheck); the bounded read found the remote at d2add3048; the local ref restored to d2add3048 (read by me: refs/heads/feat/factory-platform-followup-3 = d2add3048; integ/w00 = ff8331a70). The relaunch under gated-flock (PUSH_TC_IN_LOCK=1) starts from the same precondition.
Post-push check (2026-10-16, validator-8): push11/push.exit = 0; the remote feat/factory-platform-followup-3 reads ff8331a70d86e600c6d23dd4c9c664320a656dfe (bounded read, agent bypass, under bash: remote-read.sh is a bash library; sourcing it in zsh fails at rr_bound's ${!1}, my calling error); PR 341 OPEN, draft, headRefOid ff8331a70d86e600c6d23dd4c9c664320a656dfe, MERGEABLE, BLOCKED, updated 2026-10-16T04:47:44Z. The cut-down body is checked when the integrator reports it.
PR 341 body and hosted pre-check (2026-10-16, validator-8): the applied body push11/pr-body-applied.md de2b276e1d989ecc equals
the approved cut-down w00/wave4i/followup4a-pr-body-cutdown.md 0abac8656bfc257c except the one placeholder line, filled as
"pending: ci 38850371515 (deps-audit 38850371442 success); the comparison follows when ci completes."; no placeholder left; the
live body (gh pr view, read only, validator-8/pr341-live-body.md) equals the applied body plus one trailing blank line;
identity-check files on the live body: clean. Hosted (read only, gh run view): ci 38850371515 on ff8331a70 conclusion failure;
non-success jobs exactly: Factory runner readiness precheck = failure; Factory deployment and operations, Factory isolation,
Factory product and domain E2E = skipped. Main's ci 38591921239 on 934531e2e: the SAME four. Parity (no new red). I judge the
integrator's A/B classification and receipts when they come; the HOSTED-COMPARISON fill must then be updated from "pending".

## Addendum (2026-10-16T05:1xZ, validator-8): hosted classification, receipts d2845e151, the PR body (read only)
- Hosted ci 38850371515 on ff8331a70: conclusions {success 55, skipped 3, failure 1} (59 jobs); the job names AND conclusions are
  identical to PR 341 attempt 2 (38525604869) (diff empty). Against main's ci 38591921239 (54/3/1) our run has one more job,
  "Factory image under shipped isolation" (W4H-27's job on integ; green). Failure = Factory runner readiness precheck (class
  A); skips = deployment and operations, isolation, product and domain E2E (cascade). Production proof (resources), Gate
  integrity, Per-file coverage gate, Factory image under shipped isolation: success. Classification A/B only: CONFIRMED.
- Receipts d2845e151 (integration worktree, read only): identity-check v5 commits ff8331a70..d2845e151: 1 commit, clean;
  18 files changed, 4263 insertions(+), 0 deletions.
- FINDING (record mismatch): the live PR 341 body's hosted line is NOT the one in push11/pr-body-applied-2.md (99ef04ed97dc1672):
  the file says "ci 38850371515 at ff8331a70, attempt 1 (04:23-04:53Z): 59 jobs, 55 success, 3 skipped, 1 failure = ... No new red
  against attempt 2 ... or main;" while the live body (read 05:1xZ) says "ci 38850371515: parity with main 934531e2e — one class-A red
  (runner readiness precheck; needs the factory-real host and its three secrets) and its three cascade skips; everything else
  green."; the rest is equal. Both statements are true; the receipts' claim "live equal" is not. Someone edited the body after
  the apply, or the apply used another text. identity-check files on the live body: clean.
Corrections checked (2026-10-16, validator-8): the live PR 341 body (gh, read now) has raw sha16 9a3aa78ec72501bf (= integrator-5's raw value) and equals push11/pr-body-applied-3.md (866c454abbd57820) apart from trailing whitespace; applied-2 (99ef04ed97dc1672) was live only until 04:57:28Z (integrator's timeline). Receipts on integ/w00 after d2845e151: TWO commits, 614179903 (the hosted classification correction) and b7dbd9210 (the live-body record): identity-check v5 clean (2 commits); 6 files, 104 insertions, 0 deletions. The classification text now says: vs attempt 2 the same 59-job set; vs main 58 vs 59 (one more: W4H-27's shipped-isolation image, green); failed/skipped identical; no C/D/E. CLOSED.

## Addendum (2026-10-16, validator-8): the dead dump-and-drop call in w00 heavy-lib mock_pass (w4h-35's finding)
Facts (read): heavy-lib.sh mock_pass ran `[ -f <record> ] && bash .../w01h/graph/dump-and-drop.sh <record> >> heavy-batch.log`
after the graph-mock-pass leg; the call was not a leg, so its exit 127 set no status. The helper printed "no retained database
... nothing to dump" up to 2026-10-05 (w4h-1, w4h-10-sync); from 2026-10-06 (w4h-12) every hold logs "No such file or
directory" for it. W4H-31 runs (hold-run1 line 2721; try-2 line 8150): the leg END exit=0, then the missing-helper line, then
"outcome: passed". The W4H-31 record has no retainedProductDatabase; its databases (w19a_pool_*, w19a_product_*) are dropped
by the stack itself (scripts/factory-graph-proof/stack.ts:238-239 at 934531e2e and at def32c1a4: DROP DATABASE ... WITH
(FORCE) unless keepProduct, which records retainedProductDatabase). Judgment: the masked call lost nothing in any hold (with no
retained database the helper had nothing to do); the W4H-31 verdict and its graph-mock-pass leg stand unchanged.
The fix (integrator-5, 05:24Z): heavy-lib.sh 2cfcb4efd60cf447 (bak 000cb68ac789d36e) removes the call (comment names the
stack's own drop); heavy-lib-leg.test.sh c9a128d5ae746f54 adds (a) every absolute evidence-folder .sh/.py path in
heavy-lib.sh exists, and (b) a leg with a missing helper ends red by name with exit 127. On copies (mine, removed): the fixed
lib 10 pass / 0 fail; the old lib 9 pass / 1 fail, naming .../w01h/graph/dump-and-drop.sh (red first). ACCEPTED.
Limit (informational): (a) sees only literal absolute paths; a helper path built from a variable ($D, $REPO) is not checked.
Every call of a helper that matters should be a leg (then (b) applies), not a bare call.
