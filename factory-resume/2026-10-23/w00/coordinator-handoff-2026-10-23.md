# Coordinator handoff — 2026-10-23 02:15Z

For the next coordinator session (addressed by the team as `team-lead`). It replaces `w00/coordinator-handoff-2026-10-18.md` (86bdf4e6f49916c5) for the state; that file stays valid for the rules (its sections 4 to 6). Read this file first, then the tail of the coordinator log from line 6340, then the task list. Every record is cited by path and the first 16 hex of its sha256. All times are UTC (read `date -u`; never write a time you did not read).

## 1. Where everything is

| What | Path | Hash at write |
|---|---|---|
| Coordinator log (append-only; the source of truth) | `evidence/w00/HANDOFF-2026-09-24-weekly-limit.md` | deac56d118b24cf7, 6451 lines |
| Old handoff (rules: word form, binding rules, log append form) | `w00/coordinator-handoff-2026-10-18.md` | 86bdf4e6f49916c5 |
| Team restart brief (read order for re-created teammates) | `w00/briefs/restart-2026-10-19.md` | 57e9ddd94f7afcfc |
| Common team rules | `w00/briefs/common.md` | 8533145d1e35feac |
| Release task list (sections A to L) | `w00/release-tasks-2026-10-18.md` | afd3f1cc93171f09 |
| Leftovers ledger, FINAL | `w00/leftovers-2026-10-18.md` | 3c06d0188876a7c7 |
| Next-ledger queue (w4h-36) | `w4h-36/ledger-queue/next-ledger.txt` | 449c2cb566fa9a51 |
| Validator plan and verdict | `validator-8/plan-w4h-35.md`, `validator-8/verdict-w4h-35.txt` | d811c964a947a482, c71c82fcb6a19b3e |
| Integrator queue | `integrator-5/queue.md` | 4363e0cf6d166ae0 |
| W4H-35 owner worktree (branch `wp/w4h-35-w16-k8s-profiles`) | `/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35` | clean at 631e60da2 |
| Integration worktree (integ/w00 = origin/main) | `/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration` | 802d46288 |
| Mirror (copy after every append) | `/home/<USER>/work/EZCorp/factory-evidence-mirror/` | |
| My helper scripts | `/tmp/coord-a7/heartbeat.sh` (98494a0558e95743), `/tmp/coord-a7/touch-loop.sh` (5d3a53dc060d0203) | |

## 2. The team — IMPORTANT

`validator-8`, `integrator-5`, `w4h-35`, `w4h-36` are IN-PROCESS teammates of the session that wrote this file. If that session closes, they close with it, and so does any launcher it started. A new coordinator must re-create them with the same names (as on 2026-10-20: spawn each with `w00/briefs/restart-2026-10-19.md` plus its own records; validator-8 reads `plan-w4h-35.md`, integrator-5 reads `queue.md`, w4h-35 reads `w4h-35/merge-prep/` and notes, w4h-36 reads its scratch and `next-ledger.txt`).

## 3. State at 02:15Z

**W4H-35 head chain** (all on the owner branch only, NOT pushed): d11596003 (merge of integ 063b3d16e) → bf89c37ed → 6f41625e1 (02d) → caa09d283 (03e) → 00aabc453 (04, held-roles provider required) → a26b85011 (05, the hosted init makes the harness data folders) → **631e60da2 (06, the role constant in a leaf module `service-roles.ts`; the node-entries guard `scripts/factory-node-entries-registration.test.ts`, always-run in the fast stage and CI)**.

**Last verdict:** validator-8 REJECT of 631e60da2 (`verdict-w4h-35.txt` c71c82fcb6a19b3e). Session 9: commit 06 good, 5 mutants killed, fast 53/53, C9 all green EXCEPT `newfile-coverage`: `src/factory/service-roles.ts` has no key in `scripts/coverage-thresholds.json`.

**In flight:** w4h-35 builds the SESSION-10 set: commit 07 on 631e60da2 = exactly one added line `"src/factory/service-roles.ts": 100` in `scripts/coverage-thresholds.json` (sorted, valid JSON). Ruled: no separate mutant (the C9 newfile leg is red in session 9 and must be green in session 10). Then: validator OK by hash → session word → launch.

**Then, in order (section A of the task list):**
1. Session 10 → validator ACCEPT of the new head.
2. RUN 13 at that head: w4h-35 re-binds the run-13 set (v5 form; only the launcher's head/chain check changes), validator OK, a run-13 word. The run-13 launcher takes the head as its first argument: `COORD_WORD=<id> bash .../w4h-35/bin/run13-launch.sh <head>`. Before it: move aside `proof/` (hash list first), `proof.exit`, and `logs/run13-launch.log`. Run 13 must be GREEN (proof.exit "0", full path: C12 steps 1-7 incl. ingress, the stopped wave, the allowed nginx digest in the node, no other pull).
3. integrator-5: a new merge folder for the new head onto 802d46288 (from the a26b85011 form), validator OK, the lock-free prep word, then (after green run 13) the commit word, the hold word, the publish word. The hook runs the bound list one per process (list-bound ruling; the cap of 12 is exceeded for this merge only).
4. Receipts and tasks commits (w4h-36: lessons part 9, the next ledger version from `next-ledger.txt`, the release block in `tasks/todo.md`).
5. The push word (user), the hosted CI compare, the followup6 PR body (w4h-36), the user's PR merge.

**Spent / retired words:** <WORD>, <WORD>, <WORD>, <WORD>, <WORD>, <WORD>, <WORD> spent; <WORD>, <WORD>, <WORD> retired unused.

**Run-13 history:** 2026-10-22 00:48Z at 00aabc453 RED (harness: factory-secrets-dir-required → commit 05); 02:28Z at a26b85011 RED (orchestrator: Node strip-only refused service-readiness.ts via 03e's import → commit 06).

**Host at 02:15Z:** disk 202G, mem 16.4 GiB, lock busy (outside). Floors: launch mem 15 GiB (two reads); run-13 disk 127G in both reads; driver import 112G; in-lock typecheck 12 GiB; lock-free typecheck 16 GiB and no heavy holder.

## 4. User rulings to keep (beyond the 10-18 file)

- **Launches:** the classifier refused the launchers in w4h-35's session (detached: "Unauthorized Persistence"; in-session: "Auto-Mode Bypass"). The USER then authorized team-lead (this coordinator) to start each validator-OK'd launch line itself from its session, on its issued word, with pre-launch checks and a log line (2026-10-23 00:55Z). The push and the PR merge still need the user's word. A new coordinator session should confirm this authorization with the user once.
- **Docker Hub:** exactly ONE pull is allowed, in run 13, in the kind node only: `docker.io/library/nginx@sha256:2f4e10193b0c4f61472245e9d26cea78e7df7af266c7e7cf5e67353ee2731b51` (it is also already a local host image). No other Docker Hub or unpinned pull.
- **Removed on the user's word:** `rocm/pytorch` image <IMAGE-ID> (record `w00/removal-rocm-pytorch-20261021.txt`); SIGTERM to a TypeScript server and to the Codex app server <PID> (2026-10-23 01:24Z). The Codex app server ignored SIGTERM and still starts heavy-lock jobs; stopping it is the user's (section L). Never stop a lock holder.
- **Not done (user chose):** no kill of `<EMAIL>` (it holds the rootless podman containers and the GPU runner); no page-cache drop.
- **Move to a "sandbox machine":** asked by the user on 2026-10-23; the machine is NOT yet named. Moving needs the unpushed commits (a push needs the push word) and the evidence tree (rsync); nothing moved.

## 5. Background tasks

- Heartbeat: `/tmp/coord-a7/heartbeat.sh` as a background task every 20 min (path+size of `*.exit*`, `publish.out`, `compare-*.txt`, plus refs/heads/integ/w00). Pause it only when the round waits on the user alone.
- Touch loop: `/tmp/coord-a7/touch-loop.sh` (48 h, `touch -c` every 6 h). Loop 3 was STOPPED by Claude Code at about 17:20Z on 10-22 (host low on memory); last pass 2026-10-22T16:39:48Z, old 0. Do not restart it without the user's word; the trees are safe until about 2026-11-01.
- integrator-5 watch: pid <PID> (24 h, to 2026-10-24T02:14Z); approved to restart with a 7-day bound.

## 6. Lessons from this session (keep)

1. Read `date -u` in the same step before any time label in a message; I wrote wrong labels several times.
2. Paste message ids from the SendMessage result; never type them (I once wrote a wrong id suffix).
3. When messages cross, wait for them to settle before a reversal; one ruling per question.
4. A word binds the final set: do not issue it while a ruled change to that set is still being built; every changed listed file (notes included) needs a new OK and word.
5. zsh: an empty glob is an error; use `bash -c 'shopt -s nullglob; ...'`. `ls -t` is aliased (eza); use `ls -1t` inside bash.
6. Never run a host-wide `find` while a job waits for memory; bound it (timeout).
7. `pgrep -f` can match its own shell; check the exact cmdline and parent before a kill.
8. File mtimes in the evidence tree are reset by the touch loop; never read a job's end time from an mtime.
9. Run 13 finds faults that the Bun unit gates cannot (a live boot, a Node-run orchestrator); expect it and route each red to a red-first commit plus a guard.
10. Teammate background notices often arrive hours late; ping owners at each heartbeat.

## 7. First actions of the next coordinator session

1. Read this file, then the log tail from line 6340, then `validator-8/plan-w4h-35.md` and `integrator-5/queue.md`.
2. Check whether the teammates still exist (ListAgents). If not, re-create them (section 2) with this file added to their read list.
3. Confirm with the user the launch authorization (section 4) and the sandbox-machine question.
4. Restart the heartbeat; append a log line "coordinator session restarted" with this file's hash.
5. Continue section 3: session 10.

## 8. What "done and fully tested" means (added 2026-10-23, on the user's question)

This handoff details only the CURRENT round (section A of `w00/release-tasks-2026-10-18.md`, afd3f1cc93171f09). Two levels of "done":

**Round done (A1 to A8):** the W4H-35 head ACCEPTED (session 10 green), run 13 GREEN at that head, the integ merge + hold green, publish, receipts and tasks commits, the push word, the hosted CI compare equal or explained, the followup6 PR merged by the user, and **A8: the owners remove their own worktrees (w4h-35, w4h-35-mergeprep, w4h-36; the W4H-34 worktree too) after the merge, by id, with records**. Session 10 launched 2026-10-23T02:16:27Z on word <WORD> (after this file was first written): read its exit record first.

**Release done and fully tested (sections B to L, all open):**
- B: W16 rest: hosted control plane and tenant directory; first-admin invitation and login; a fault in every provisioning step with recovery; canary-first upgrades, rollback, teardown; hosted ingress proof (C12 steps 6-7, now unblocked by the one allowed nginx pull); registry publish proof; air-gap mirror, IPv6, GPU profile; operator docs.
- C: W17 rest: optional SMTP sender; W17 under the Kubernetes profile; the FactoryMetricsTargetDown split (ledger 1c).
- D: W18 hosted enforcement: real and GPU runners, branch protection, required checks; reference-data image producer in CI; nightly mutation (about 50-56% vs the 80% threshold); gate-change labels.
- E: W19 sustained campaigns: frozen workload, 26.5 h local campaign, 1 and 10 concurrent 10,000-node runs, hosted 100-installation profile; needs a host that holds the floors for over a day (user decision L1).
- F: W20 final integration and INDEPENDENT AUDIT: frozen candidate; full app, backend, web, browser and legacy regressions; type, lint, build, image, schema, migration proofs; review by people who did not implement the area; the release evidence manifest for F01-F13 with hashes, commands and exit codes; every pass verified from its producer. **This is the "fully tested" gate.**
- G: other packages (W01-W15 open items); H: product defects (12a-31b); I: tests, gates and CI (ledger 32-70z); J: host and evidence (move the evidence out of /tmp to durable storage; shared containers under <EMAIL>; trial branches; the Codex lock jobs); K: team tooling (lock-read holder scan, the empty-list guard, lessons part 9).
- L: user decisions: where W19 runs; Docker Hub pulls beyond the one nginx digest; registry publication; the mutation threshold; the GitHub App, secrets and runner host; per-job memory budgets; old containers, volumes and trial branches; the Codex app server.

**New leftovers from this session** (queued for the next ledger version, `w4h-36/ledger-queue/next-ledger.txt` 449c2cb566fa9a51): the Bun mock.module leak (test-pglite.ts); the hook name-only map (import-only suites); G1 findings-match passes an ERROR or empty gate log; the weak w4h-35 gate-leg test (closed by the w00 install); run13-launch.sh without a proof.exit value check and without a time bound; service-readiness.ts not Node-loadable; no repo-wide erasableSyntaxOnly check; and (to queue) run check-new-file-coverage lock-free in every set prep.
