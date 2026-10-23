# FACTORY RELEASE — FULL COORDINATOR HANDOFF (self-contained) — 2026-10-23

This one file holds everything a new coordinator session needs: the start prompt, the rules, the team, the state, the next steps, the definition of done, the lessons, and (at the end) the full release task list. It replaces `w00/coordinator-handoff-2026-10-18.md` and `w00/coordinator-handoff-2026-10-23.md` for reading; those stay as records.

## 0. Start prompt (paste into the new Claude Code session)

```
/goal complete @evidence/w00/coordinator-handoff-2026-10-23-full.md

You are the new coordinator (team-lead) for the factory release round. Read
evidence/w00/coordinator-handoff-2026-10-23-full.md first,
then the coordinator log tail from line 6340, then validator-8/plan-w4h-35.md and
integrator-5/queue.md. Follow its section 10: check the teammates with ListAgents
and re-create them if they are gone, confirm the launch authorization with me,
restart the heartbeat, read the session-10 exit record, and continue.
```

If the new session runs on ANOTHER machine, that machine also needs (copied, not pushed): `evidence/` (or its mirror `/home/<USER>/work/EZCorp/factory-evidence-mirror/`), `/tmp/factory-tools/` (pinned Bun 1.4.2, Node 24.14.1, kind, kubectl), the repo with its LOCAL branches and worktrees (the W4H-35 commits and integ/w00 are not on GitHub; a push needs the user's push word), and the podman images by digest. Without them the gates cannot run the same way.

## 1. Where everything is (hashes at 02:24Z)

| What | Path | Hash |
|---|---|---|
| Coordinator log (append-only; the source of truth) | `evidence/w00/HANDOFF-2026-09-24-weekly-limit.md` | about 6456 lines; read the tail |
| Release task list (sections A to L; copied in section 12 below) | `w00/release-tasks-2026-10-18.md` | afd3f1cc93171f09 |
| Leftovers ledger, FINAL | `w00/leftovers-2026-10-18.md` | 3c06d0188876a7c7 |
| Next-ledger queue (w4h-36) | `w4h-36/ledger-queue/next-ledger.txt` | 449c2cb566fa9a51 |
| Common team rules | `w00/briefs/common.md` | 8533145d1e35feac |
| Team restart brief | `w00/briefs/restart-2026-10-19.md` | 57e9ddd94f7afcfc |
| Validator plan, verdict | `validator-8/plan-w4h-35.md`, `validator-8/verdict-w4h-35.txt` | (latest in the log), c71c82fcb6a19b3e |
| Integrator queue | `integrator-5/queue.md` | 4363e0cf6d166ae0 |
| Word tool, lock reader, gated-flock | `w00/coord-word.sh`, `w00/lock-read.sh`, `w00/gated-flock.sh` | 34d9989d558e3b61, 750e77ce772ebf22 |
| Gate-leg check (installed 2026-10-21) | `w00/gate-leg.sh` | 0037edeb941be7be |
| W4H-35 owner worktree (branch `wp/w4h-35-w16-k8s-profiles`) | `/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35` | clean at 631e60da2 before session 10 |
| Integration worktree (integ/w00 = origin/main) | `/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration` | 802d46288 |
| Merge folders | `w00/w4h-merge/w4h-35-w16-k8s-profiles-<head>-on-802d46288/` | latest: a26b85011 (stale; rebuild for the final head) |
| Mirror (copy after every append) | `/home/<USER>/work/EZCorp/factory-evidence-mirror/` | |
| Pinned Bun | `/tmp/factory-tools/bun-1.4.2/bun-linux-x64/bun` | never a bare `bun test` at a repo root |
| Coordinator helpers | `/tmp/coord-a7/heartbeat.sh` 98494a0558e95743, `/tmp/coord-a7/touch-loop.sh` 5d3a53dc060d0203 | |

## 2. The team

- `validator-8`: reads every set by hash; its OK by exact hash is required before any install, word or merge; verdicts top-inserted in `validator-8/verdict-w4h-35.txt`; plan in `plan-w4h-35.md`.
- `integrator-5`: owns the w00 shared tools and integ/w00; does the detached merge, the hold, publish, receipts and the tasks commit; never pushes without a push word. Its watch: pid <PID>, 7-day bound to 2026-10-30T02:14:48Z.
- `w4h-35`: owner of W16 (Kubernetes profile, GPU and CPU-only profiles, wrapped keys); builds each session set and the run-13 set; reports exit facts.
- `w4h-36`: docs: lessons part 9 (38 on scratch), the next ledger version (from `next-ledger.txt`), the followup6 PR body; folds the release task list into `tasks/todo.md` at the receipts step.
- **IMPORTANT:** all four are IN-PROCESS teammates of the session that wrote this file. If it closes, they close, and so does any launcher it started. Re-create them with the same names: each reads `w00/briefs/restart-2026-10-19.md`, THIS file, `w00/briefs/common.md`, and its own records (above).
- Rule: no teammate holds a turn over five minutes; every wait is a background watch; the coordinator pings a quiet owner at each 20-minute heartbeat. Teammate background notices often arrive hours late, and the system may stop idle background watches when memory is low: ping owners at events.

## 3. How a word works

- The launcher sources `w00/coord-word.sh` and writes `COORD_WORD=<id> <label> <UTC>` as line 1 of its launch log. The id is the first 8 hex of the coordinator's SendMessage id of the word message. Send the word message, take its `msg_id` from the SendMessage result (PASTE it; never type it), then send the id as TEXT in a second message, and log "WORD ISSUED: COORD_WORD=<id>" with the bound hashes.
- A word binds to the hashes the validator OK'd. It is spent when the job enters gated-flock. A launcher that stops without launching leaves it unspent: then mv the log aside with its hash recorded and relaunch on the same word. A changed file (notes included) means a new list, a new OK and a new word. Do not issue a word while a ruled change to that set is still being built.
- Before any lock launch the launcher requires two reads of `w00/lock-read.sh` with `lock=free gated=0 holders=0 yield=no` and mem >= 15 (run 13 also disk >= 127G in both reads). `holders` misses outside forms; a `/proc/<pid>/fd` scan finds every holder.
- Session launcher (no argument): `COORD_WORD=<id> bash evidence/w4h-35/bin/merge13-static-launch.sh > /dev/null 2>&1 &`. Run-13 launcher (head argument): `COORD_WORD=<id> bash evidence/w4h-35/bin/run13-launch.sh <head> > /dev/null 2>&1 &`. Before a relaunch, the owner moves the previous live log (and for run 13 `proof/` with a hash list, `proof.exit`, `logs/run13-launch.log`) aside by mv with records.

## 4. Binding rules (short list; the log carries the rest)

Never place a secret in a document, transcript or argv. No model call. Podman only; digest-pinned images; no Docker Hub pull without the user's word (one is allowed, see section 6). The coordinator never integrates, never pushes, never edits permission settings. Only the coordinator creates or restarts the shared stores. Nobody edits the shared `.git/config`; no bare `git stash`; every merge or rebase runs with `-c rerere.enabled=false`. Never kill a lock holder; a teammate stops only its own job by pid. Never prune; remove only what you built, by id, after a hashed record, with the lock free (or, on the user's word, named items with records). Nothing under `evidence/` is removed; rename by mv with hashes recorded. Receipts, plans, verdicts and the log are append-only; verdicts top-insert. Red first; one planted mutant per commit (a pure gate key needs none: its gate leg is red then green); 100 percent of changed lines; no gate lowered (the 15 GiB launch floor and the 112G proof floor stay unless the user rules). Shared tools install only on the validator's OK by exact hash, by mv with a named backup, tested against the installed file, then mirrored. A pass that waits for a person never holds the heavy lock. Every remote read bounded (`timeout 60`); SSH to GitHub with `GIT_SSH_COMMAND='ssh -o IdentityAgent=none -o BatchMode=yes'`; pushes through the push tool, one try, on a push word. Hashes pasted, never typed. One ruling per question, amended only on a finding. A refused command is reported with its exact text and nobody else runs it. Write in Simplified Technical English; end every final turn with "Your Actions:".

## 5. Log append form

```
cd /tmp/factory-platform-evidence && L=w00/HANDOFF-2026-09-24-weekly-limit.md; M=/home/<USER>/work/EZCorp/factory-evidence-mirror/$L; h0=$(sha256sum "$L" | cut -c1-16); test "$h0" = <last hash> || { echo "GUARD FAIL $h0"; exit 3; }
printf -- '- %s <text>\n' "$(date -u +%H:%MZ)" >> "$L"; cp -p "$L" "$M"; sha256sum "$L" | cut -c1-16; wc -l < "$L"
```

## 6. User rulings in force

- **Launches:** the classifier refused the launchers in w4h-35's session ("Unauthorized Persistence" detached; "Auto-Mode Bypass" in-session). The USER authorized team-lead to start each validator-OK'd launch line itself from its session, on its issued word, with pre-launch checks and a log line (2026-10-23 00:55Z). The push and the PR merge still need the user's word. A new coordinator session confirms this once with the user.
- **Docker Hub:** exactly ONE pull, in run 13, in the kind node only: `docker.io/library/nginx@sha256:2f4e10193b0c4f61472245e9d26cea78e7df7af266c7e7cf5e67353ee2731b51` (also a local host image). The run-13 judges stop red on any other pull and require this digest after step 6.
- **Removed on the user's word:** the `rocm/pytorch` image <IMAGE-ID> (record `w00/removal-rocm-pytorch-20261021.txt`); SIGTERM to a TypeScript server and to the Codex app server <PID> (2026-10-23 01:24Z; the app server ignored SIGTERM and still starts heavy-lock jobs; stopping it is the user's, section L).
- **Not done (user chose):** no kill of `<EMAIL>` (it holds the rootless podman containers and the GPU runner); no page-cache drop.
- **Gate-integrity:** no expected-findings file; each gate leg must show the exact "Gate integrity PASSED" line and no FAILED/BYPASSED/ERROR; `GATE_CHANGE_APPROVED` unset.
- **Merge hook:** list-bound ruling: the merge commit's hook runs ALL name-mapped files of its prep list, one per process (`EZ_PRECOMMIT_TEST_MAX` = the list count), pg suites on the commit's own pg15; the cap of 12 is exceeded for this merge only.
- **Move to a "sandbox machine":** asked on 2026-10-23; the machine is not yet named; see section 0 for what it needs.

## 7. State at 02:24Z

**W4H-35 head chain** (owner branch only, not pushed): d11596003 (merge of integ 063b3d16e) → bf89c37ed → 6f41625e1 (02d) → caa09d283 (03e) → 00aabc453 (04, held-roles provider required) → a26b85011 (05, the hosted init makes the harness data folders) → 631e60da2 (06, the role constant in the leaf module `src/factory/service-roles.ts`; the always-run guard `scripts/factory-node-entries-registration.test.ts`; CI cov-shard gets the pinned Node).

**Last verdict:** validator-8 REJECT of 631e60da2 (`verdict-w4h-35.txt` c71c82fcb6a19b3e): all green except C9 `newfile-coverage` (service-roles.ts had no threshold key).

**SESSION 10 IN FLIGHT:** commit 07 on 631e60da2 = one added line `"src/factory/service-roles.ts": 100` in `scripts/coverage-thresholds.json` (tree db72146552be0b02). Set: session-shas 7f734b594d20048c, SHA256SUMS e34e88474a97a0f6, launcher 8221afc270b2bd64; validator FULL OK; **word <WORD>**; launched by team-lead 2026-10-23T02:16:27Z; waiting for the heavy lock (an outside Codex job held it). First step for the new coordinator: `cat` the newest `w4h-35/merge13-static.exit.*` and route the result.

**Spent words:** <WORD>, <WORD>, <WORD>, <WORD>, <WORD>, <WORD>, <WORD>, <WORD> (when its job entered the lock). **Retired unused:** <WORD>, <WORD>, <WORD>.

**Run-13 history:** 2026-10-22 00:48Z at 00aabc453 RED (harness: factory-secrets-dir-required → commit 05); 2026-10-22 02:28Z at a26b85011 RED (orchestrator: Node strip-only refused service-readiness.ts, pulled in by 03e's import → commit 06). Run 13 has never reached the ingress step yet.

**Host:** disk about 200G; memory 14-17 GiB (Codex jobs and editors take it); lock often held by the Codex app server's jobs. Floors: launch mem 15 GiB (two reads); run 13 disk 127G (two reads), import 112G; in-lock typecheck 12 GiB; lock-free typecheck 16 GiB and no heavy holder.

## 8. Next steps to finish THIS round (section A)

1. Session 10 exit → validator ACCEPT of the commit-07 head (or a red report → a fix commit → a new session).
2. RUN 13 at the accepted head: w4h-35 re-binds the run-13 set (v5 form; only the launcher's head/chain check changes), validator OK, a run-13 word, the old run-13 records moved aside, team-lead launches. It must be GREEN: proof.exit "0", full path (C12 steps 1-7 incl. ingress and invitation, the stopped wave), the allowed nginx digest in the node, no other pull, no new host docker.io image.
3. integrator-5: a new merge folder for the accepted head onto 802d46288 (from the a26b85011 form, `hook-cap-input.py` for the list), validator OK, the lock-free prep word; after a green run 13: the commit word, the hold word (the hold checks both gate logs with gate_leg_ok), the publish word.
4. Receipts and tasks commits (w4h-36: lessons part 9, the next ledger version, the release block in `tasks/todo.md`).
5. The push word (user) for `feat/factory-platform-followup-4`, the hosted CI compare, the followup6 PR body (w4h-36), the user's PR merge.
6. A8: the owners remove their own worktrees after the merge (w4h-35, w4h-35-mergeprep, w4h-36; the W4H-34 worktree too), by id, with records.

## 9. What "done and fully tested" means

**Round done:** section 8 complete (A1 to A8).

**Release done and fully tested:** sections B to L of the task list in section 12, all open: B W16 rest (hosted control plane, first-admin login, a fault in every provisioning step, upgrades and rollback, hosted ingress proof, registry publish, GPU profile, operator docs); C W17 rest (SMTP sender, W17 under Kubernetes, the TargetDown split); D W18 hosted enforcement (runners, branch protection, nightly mutation vs the 80% threshold); E W19 sustained campaigns (26.5 h and 10,000-node runs; needs a host that holds the floors for over a day); **F W20 final integration and INDEPENDENT AUDIT (frozen candidate, full regressions, review by people who did not write the code, the release evidence manifest for F01-F13): this is the "fully tested" gate**; G other packages; H product defects; I tests, gates and CI; J host and evidence (move the evidence out of /tmp); K team tooling; L user decisions.

**New leftovers from this session** (queued in `next-ledger.txt` 449c2cb566fa9a51 unless marked): the Bun mock.module leak (test-pglite.ts); the hook name-only map (import-only suites); G1 findings-match passes an ERROR or empty gate log; the weak w4h-35 gate-leg test (closed by the w00 install); run13-launch.sh without a proof.exit value check and without a time bound; service-readiness.ts not Node-loadable; no repo-wide erasableSyntaxOnly check; (to queue) run check-new-file-coverage lock-free in every set prep.

## 10. First actions of the new coordinator session

1. Read this file, then the log tail from line 6340, then `validator-8/plan-w4h-35.md` and `integrator-5/queue.md`.
2. ListAgents: if the teammates are gone, re-create them (section 2).
3. Confirm with the user: the launch authorization (section 6) and the sandbox-machine question.
4. Restart the heartbeat (`/tmp/coord-a7/heartbeat.sh` as a background task, 20 min). The touch loop (`/tmp/coord-a7/touch-loop.sh`) was stopped by Claude Code for low memory on 2026-10-22 (last pass 16:39:48Z); restart it only on the user's word; the trees are safe until about 2026-11-01.
5. Append "coordinator session restarted" with this file's hash; read the session-10 exit record; continue section 8.

## 11. Lessons (keep)

1. Read `date -u` in the same step before any time label in a message.
2. Paste message ids from the SendMessage result; never type them.
3. When messages cross, wait for them to settle before a reversal; one ruling per question.
4. A word binds the final set; every changed listed file needs a new OK and word.
5. zsh: an empty glob is an error; use `bash -c 'shopt -s nullglob; ...'`. `ls -t` is aliased (eza); use `ls -1t` in bash.
6. Never run a host-wide `find` while a job waits for memory; bound it with a timeout.
7. `pgrep -f` can match its own shell; check the exact cmdline and parent before a kill.
8. File mtimes in the evidence tree are reset by the touch loop; never read a job's end time from an mtime.
9. Run 13 finds faults the Bun unit gates cannot (a live boot; a Node-run orchestrator); route each red to a red-first commit plus a guard.
10. Teammate notices arrive late; ping owners at events and at each heartbeat.
11. Run every gate that needs no lock (for example check-new-file-coverage) lock-free in the set prep.

## 11b. What is pushed (remote `<EMAIL>:ezcorp-org/EZHarness.git`; read 03:02Z with `timeout 60 git ls-remote`)

| Ref | Remote state | Local state |
|---|---|---|
| `main` | 802d46288ab9f15310a5d54bd038b14075789286 (PR 341, merged) | integ/w00 = 802d46288 |
| `wp/w4h-35-w16-k8s-profiles` | **PUSHED** 3698c8e842f2223e600ddbf65fe8d5b3d938a586 (new branch, 02:58-03:01Z; push word <WORD> after validator OK by hash; push.exit 0; pre-push hook lint and typecheck ran, push.out 3bdb447dc4298d5e). Records: `w00/wave4i-3/push-w4h35-backup-3698c8e84/`. | Owner worktree head 3698c8e84 = ACCEPTED (validator) and run 13 ACCEPTED (verdict-w4h-35.txt d2e23947cf9654c9) |
| `feat/factory-platform-followup-4` | NOT made yet. Step A5. The user gave the word "you push it when ready" (log 02:56Z); it still needs the validator OK by hash of its push set, then the coordinator push word. | made from the tasks-commit head |

Open push items:
1. integrator-5 removes `./.worktrees/i5-push-w4h35-3698c8e84` (composable-factory-platform repo) with a hashed record.
2. A5: the followup-4 push as above.

What Git does NOT carry (copy it by hand to move the work to another machine):
- `evidence/` (7.3G): the coordinator log, verdicts, receipts, launchers, run records. Its mirror `/home/<USER>/work/EZCorp/factory-evidence-mirror/` (4.6G) is a local copy, not a remote. Copy with `rsync -a` and check hashes; read the gitleaks logs before any upload.
- `/tmp/factory-tools/` (pinned Bun 1.4.2 and Node 24.14.1).
- The teammates. They are in-process in this session and do not move; a new session re-creates them from `w00/briefs/restart-2026-10-19.md`.

## 12. The full release task list (copied verbatim from `w00/release-tasks-2026-10-18.md`, afd3f1cc93171f09)

# Factory platform — remaining work to release (2026-10-18)

Source: the plan `docs/plans/2026-09-13-composable-factory-platform-completion.md` (open checkboxes W16 to W20), the leftovers ledger `w00/leftovers-2026-10-16.md` (912e25208a101978; open items 1 to 75l; ids below are its ids), and the coordinator log. Landed on main 802d46288 (PR 341): W00 to W15, W17, W18 as built in waves 1 to 4, W4H-26 to W4H-34 with 32b and 33b, the single real reference run. This list is the order of work; the integrator folds it into `tasks/todo.md` at the W4H-35 receipts step.

## A. In flight now: the W4H-35 round (W16 code) to main
- [ ] A1 Lock-free typecheck green at the final code tree (03e); manifests written last; one bound list.
- [ ] A2 Validator OK of the rows amendment 02d (C11 M2, the scope sentence, leftover 1c) then of the full set.
- [ ] A3 Word 5; session 5 in the lock: rows commit, code commit, two commit mutants red, fast stage and C9 at the new head.
- [ ] A4 Validator ACCEPT of the resolved head (full fast stage at the exact head).
- [ ] A5 Run 13 proof word (kind in Podman): image build, cluster, clean install, readiness, stopped-wave; needs 112G free; disk 131G now.
- [ ] A6 Integrator: detached merge of the resolved head onto integ/w00 802d46288; the hold (hold-w4f.sh b4c85a2592a15ddf); publish word; receipts; tasks commit with lessons part 9 and the ledger.
- [ ] A7 Push word for feat/factory-platform-followup-4; hosted CI compare; followup6 PR body; the user merges.
- [ ] A8 Close the round: owner worktrees removed by their owners after the merge; the W4H-34 worktree too.

## B. W16 deployment, the rest (plan checkboxes still open)
- [ ] B1 The operator-only hosted control plane and tenant directory (routing, membership, resource references; no product facts).
- [ ] B2 First-admin invitation and login; bootstrap consent and trust grants with transactional audit.
- [ ] B3 Fault every provisioning step; recover or tear down only owned resources; prove rotation, revocation, rerun idempotence.
- [ ] B4 Canary-first fleet upgrades in C12 order, old build retention, failure-stopped waves, additive rollback, teardown, human-admin purge.
- [ ] B5 Hosted ingress proof, C12 steps 6 and 7 (8f): blocked on the Docker Hub nginx pull; user decision.
- [ ] B6 Hosted-profile release publish proof to a local registry (8b).
- [ ] B7 Air-gapped registry mirror setting (8g); IPv6 and dual-stack (8c); exported render functions (8d); the kind network leftover (8e); NixOS kind facts in operator docs (8a).
- [ ] B8 Production GPU profile: CDI, dedicated host (8).
- [ ] B9 Operator docs complete: prerequisites, locks, secret references, recovery, drain, upgrades, rollback, CPU-only availability.

## C. W17 notifications, the rest
- [ ] C1 The optional SMTP sender (1a).
- [ ] C2 W17 under the Kubernetes profile: shipped alert rules and the sender's held role proven there (1b).
- [ ] C3 FactoryMetricsTargetDown split into an installation rule and a host rule, each with a forced-condition live test (1c).

## D. W18 hosted enforcement
- [ ] D1 Real and GPU runners available; a no-runner failure within five minutes; a deliberate lane failure blocks the candidate; required checks (10).
- [ ] D2 Runner labels, secret names, branch protection applied on the user's accounts (10); the factory-real runner host and its three secrets (11).
- [ ] D3 The reference-data image producer in CI and the coverage recheck against 2588c9f19 (40).
- [ ] D4 Nightly mutation: honest score about 50 to 56 percent against the 80 threshold (33); the three sandbox loading defects (34, 35, 36).
- [ ] D5 The gate-change label for the eight standing coverage-tool findings (39); the patch gate scope for scripts/ (42).

## E. W19 sustained campaigns (needs a host that holds the floors for over a day)
- [ ] E1 Freeze the workload manifest, image and model locks, host resources, seed, retained-data size, process counts, metric definitions; run the capacity experiment first (2).
- [ ] E2 The local profile of plan section 6: the 26.5-hour campaign, one and ten concurrent 10,000-node runs, continuous report, separate fault and barrier windows.
- [ ] E3 The self-hosted C11 profile and the 100-installation hosted profile when their infrastructure exists; separate verdicts.
- [ ] E4 Real model, GPU and publication journeys beside the synthetic benchmark; latency and usage reported separately.
- [ ] E5 Repeat affected soaks after any source, configuration, workload or infrastructure change; no splicing across restarts.
- [ ] E6 The proof's image import by archive versus a registry pull (2a).

## F. W20 final integration and independent audit
- [ ] F1 Freeze the final candidate; full application, backend, web, browser and legacy regressions; all type, lint, build, image, schema and migration proofs; native coverage; full patch and new-file gates (3).
- [ ] F2 Independent review of standards and reuse, specification and security, by people who did not implement the area; fix and rerun.
- [ ] F3 The release evidence manifest for every F01 to F13 requirement and every gate: hashes, commands, runtime, timestamps, exit codes, counts, raw artifacts.
- [ ] F4 Verify every claimed pass from its producer; keep historical failures; reject missing, skipped, expired, dirty or mismatched evidence.
- [ ] F5 Operating docs, task ledger and gates updated only on complete proof; the final reviewable diff and handoff.

## G. Other packages with open items
- [ ] G1 W07: the selected-repository GitHub App and the broker-only branch ruleset (9).
- [ ] G2 W15: real cloud KMS, Temporal archival, PostgreSQL WAL archiving, cluster-wide restore, real fencing (7); manifest key binding, keyed report digest, constraint re-add, purge and inbox tombstones (29).
- [ ] G3 W04a: an independent archive failure domain with a distinct restore identity (6).
- [ ] G4 W10 to W13 provider line: the real generator and judge beyond the single real run (4); catalog driver G8d (5); orphaned legacy run detection within 30 seconds (30).
- [ ] G5 W14: HTTP journeys across two installations; purge preconditions; real-stack repair (18); a denied approval leaves the run running (28).
- [ ] G6 W01: cross-host recovery and replacement on a real second host; inspect-failure and Node-kill cases (19).
- [ ] G7 W02: hostile fetch, unpack, build, import and asset-mutation fixtures; fetch proxy role; fence acceptance (20); bounded back-off on the stop retry (26).
- [ ] G8 W03: nested cancellation, losing join branches, one-slot parent and child; Retry-After on 429 (21); a lost response that wedges stopping (27).
- [ ] G9 W05: freshness and issuer-grant rejection proofs on real isolated validators (22).
- [ ] G10 W06 and W09: a failed Release node still emits a cancel-node (25).
- [ ] G11 W11 and W12: human review of the car and tree verdicts and a published variant with measured quorum (23); guest mount bounds at mount time (24).

## H. Product defects and small product leftovers
- [ ] H1 The stale S3 release-adapter lock (12a). H2 The held-role re-probe after admission (12b). H3 A product-readable content-addressed artifact store (13).
- [ ] H4 The third-party API call at boot (14). H5 The GPU probe spawn policy (15). H6 Orchestrator restarts at boot (16). H7 Factory modules imported with factories off (17).
- [ ] H8 Validator node bounds as operator material (31); the CLI that imports a proof-harness module (31a); no sandbox-escape producer (31b); one wrong header comment (31c).

## I. Tests, gates and CI (ledger 32 to 70z)
- [ ] I1 Test hygiene on main, items 32a to 32e (32).
- [ ] I2 Docker Hub pulls from hosted runners (37); the Prometheus pin (37a); the kind node image pin (37b); Ubuntu 26 wall-time medians (38).
- [ ] I3 Data-image registry publication by digest, user decision (41); load-sensitive tests (43); shard container shape (44); lane manifest hardening (45); the Docker-only legacy proof (46); the bootstrap safety-net cap (47).
- [ ] I4 Missing unit seams and flaky waits (48, 58 to 66); Node signature check (49); install race (50); conmon journald (51); hooks re-stamp the shared git config (52); the bare tasks ignore line (53); hook-lib notes (54); svelte-check memory (55); CI ordering (56); the dependency advisory (57); ci-wall-time (67); actionlint labels (68); the shipped-isolation guard boot (69).
- [ ] I5 The proof harness restored into the repository (70) and the 70a to 70z tool records, including the provenance key rename (70a) and the hook per-file environment (75m).

## J. Host, evidence and administration
- [ ] J1 Shared containers under <EMAIL> and the swap pressure (71, 71b); the stray systemctl start (72); the test tenant purge (73).
- [ ] J2 Evidence and tools under /tmp: move to durable storage with checksums (74, 75); the daily temp cleanup (74b); the 48-hour touch loop stays until then.
- [ ] J3 The six proof trial branches (70c); the resource-gate headroom rule (70b).
- [ ] J4 Outside sessions on the heavy lock and the disk: the Codex app server's loops and root jobs; a user item today.

## K. Team tooling for the next staging round
- [ ] K1 Item 9: lock-read counts every holder form by an open-file scan; unreadable processes reported, never counted as zero.
- [ ] K2 Item 10: the shared empty-list guard in w00, callers switched.
- [ ] K3 Lessons part 9 (38 on scratch) and the next ledger version; the followup6 PR body; all at the W4H-35 receipts step.

## L. User decisions outstanding
- [ ] L1 Where W19 runs. L2 The Docker Hub pulls (ingress nginx; runner logins). L3 Registry publication by digest. L4 The mutation threshold. L5 The GitHub App, secrets and the real runner host. L6 Per-job memory budgets. L7 The old containers, volumes and trial branches. L8 Stop or bound the Codex app server's lock jobs.

## Corrections (appended 2026-10-18T22:09Z, from the w4h-36 read against the ledger 912e25208a101978)
- H1: ledger 12a is CLOSED at 98245c2d4 (receipts cf1de889b; hosted compare 69613fcc779f3bc1); the item keeps H2 and H3 open.
- I1: ledger 32a to 32g are CLOSED at b6414ec0b (W4H-33); I1 is "32h, the ai-kit deployed-service lane" with that note.
- I2: ledger 37a (the Prometheus pin) is CLOSED at 9e1fef6fa (06f17843b); 37, 37b and 38 stay open.
- Placement in tasks/todo.md: a new last section "## Factory release — remaining work (2026-10-18)", extracted as tasks-todo-release-block.md in part 9; lessons stay in tasks/lessons.md.
