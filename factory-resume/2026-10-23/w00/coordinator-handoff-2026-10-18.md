# Coordinator handoff — 2026-10-18 22:28Z

For the next coordinator session (identity `ezcorp-9e`, addressed by the team as `team-lead`). Read this file first, then the tail of the coordinator log, then the task list. Nothing in this file is a secret; every record is cited by path and the first 16 hex of its sha256.

## 1. Where everything is

| What | Path | Hash at write |
|---|---|---|
| Coordinator log (append-only; the source of truth) | `evidence/w00/HANDOFF-2026-09-24-weekly-limit.md` | 872c758c5e4a26ed, 6342 lines |
| Release task list (sections A to L, 63 items) | `evidence/w00/release-tasks-2026-10-18.md` | afd3f1cc93171f09 |
| Leftovers ledger, FINAL | `evidence/w00/leftovers-2026-10-18.md` | 3c06d0188876a7c7 |
| Team briefs (common rules) | `evidence/w00/briefs/w4h.md` and `w4h-33..36.md` | see files |
| Validator plan and verdict for W4H-35 | `evidence/validator-8/plan-w4h-35.md`, `verdict-w4h-35.txt` | 6dd3682f50ca287a, 373bdd17a573ab82 |
| Mirror of the evidence tools and records | `/home/<USER>/work/EZCorp/factory-evidence-mirror/` | copy after every append |
| Integration worktree (integ/w00 = main = 802d46288) | `/home/<USER>/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration` | |
| W4H-35 owner worktree (clean at bf89c37ed while a session is pending) | `/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35` | |
| Pinned Bun | `/tmp/factory-tools/bun-1.4.2/bun-linux-x64/bun` | never a bare `bun test` at a repo root |

## 2. The team

- `validator-8`: reads every set by hash; its OK by exact hash is required before any install, word or merge. Its plan files under `validator-8/`.
- `integrator-5`: owns the w00 shared tools and the integration branch; does the detached merge, the hold, publish, receipts and the tasks commit; never pushes without a push word.
- `w4h-35`: owner of W16 (Kubernetes profile, GPU and CPU-only profiles, wrapped keys); the session now in flight.
- `w4h-36`: docs: lessons part 9 (38 on scratch), the ledger versions, the followup6 PR body; folds the release task list into `tasks/todo.md` at the receipts step.
- `w4h-34`, `w4h-33`, `w4h-32`, `w4h-28`: done; `w4h-34` agreed to the scope-aware assertion in its test on three conditions (log 21:36Z).
- Rule: no teammate holds a turn over five minutes; every wait is a background watch; reports from woken turns; the coordinator pings a quiet owner at each 20-minute heartbeat.

## 3. State at 22:28Z

- PR 341 is MERGED into main as 802d46288 by the user (admin merge). integ/w00 is fast-forwarded to it. The W4H-34 round is closed.
- W4H-35: two commits landed on `wp/w4h-35-w16-k8s-profiles` with the hook green: d11596003 (merge of integ 063b3d16e, tree d9bf1261) and bf89c37ed (rows, tree 95d5a20d). Session 5 is launched on word `<WORD>` (line 1 of `w4h-35/logs/gated-merge13-static.log`); it waits lock-free for an outside holder, bound about 02:22Z. It commits 02d (rows amendment, tree dd2d917f) and 03e (code, tree 781218a2), then runs two commit mutants, the fast stage and C9. Frozen set: `w4h-35/merge-prep/session-shas.txt` 9f0b866137839458, `SHA256SUMS` 9cf4f7800f9ab5d6, launcher `bin/merge13-static-launch.sh` cce4ed4f5a6d4665, typecheck log ec47d511ac2c51e2 (green at 781218a2). Validator OK: plan-w4h-35.md 6dd3682f50ca287a.
- Next after session 5 exits: read `w4h-35/merge13-static.exit.<stamp>` (cat the file; a listing shows its size, not its content); validator judges from the records; on ACCEPT of the resolved head: issue the run 13 proof word (needs disk >= 112G, now 130G); then the integrator's detached merge onto integ 802d46288, the hold (hold-w4f.sh b4c85a2592a15ddf; pg-hook-lib.sh 8b087d44f488aca0; commit.sh d300cdfa907db4ab), publish word, receipts, tasks commit (lessons part 9, the ledger, the release task block), push word for `feat/factory-platform-followup-4`, hosted compare, the followup6 PR body, the user's merge. That is section A of the task list.
- Host: disk 130G free (floors: session 104G, run 13 112G); memory floats 13 to 16 GiB (floors: launch 15 GiB; lock-free typecheck gate 16 GiB; in-lock typecheck 12 GiB). The Codex app server (pid <PID>) runs lock jobs and pulls `rocm/pytorch` in a loop; a user item. Four outside lock-holder forms seen today (item 9 in the next staging round).

## 4. How a word works

- The launcher sources `w00/coord-word.sh` (34d9989d558e3b61) and writes `COORD_WORD=<id> <label> <UTC>` as line 1 of its launch log. The id is the first 8 hex of the coordinator's SendMessage id of the word message. Send the word message, take its `msg_id`, then send the id as TEXT in a second message, and log "WORD ISSUED: COORD_WORD=<id>" with the bound hashes.
- A word binds to the hashes the validator OK'd. It is spent when the job enters gated-flock. A launcher that stops without launching leaves it unspent; then mv the log aside with its hash recorded and relaunch on the same word. A changed file means a new list, a new OK and a new word.
- Before any lock launch the launcher requires two reads of `w00/lock-read.sh` with `lock=free gated=0 holders=0 yield=no` and mem >= 15. Note: `holders` misses outside forms; `lock=` is right; a `/proc/<pid>/fd` scan finds every holder.

## 5. Binding rules (the short list; the log carries the rest)

Never place a secret in a document, transcript or argv. No model call (the single real run is done). Podman only; digest-pinned images; no Docker Hub pull without the user's word. The coordinator never integrates, never pushes, never edits permission settings. Only the coordinator creates or restarts the shared stores. Nobody edits the shared `.git/config`; no bare `git stash`; every merge or rebase runs with `-c rerere.enabled=false`. Never kill a lock holder; a teammate stops only its own job by pid. Never prune; remove only what you built, by id, after a hashed record, with the lock free and no gated job in the lock (or, on the user's word, named items with records). Nothing under `evidence/` is removed; rename by mv with hashes recorded. Receipts, plans, verdicts and this log are append-only; verdicts top-insert. Red first; one planted mutant per commit; 100 percent of changed lines; no gate lowered (the 15 GiB launch floor and the 112G proof floor stay unless the user rules). Shared tools install only on the validator's OK by exact hash, by mv with a named backup, tested against the installed file, then mirrored. A pass that waits for a person never holds the heavy lock. Every remote read bounded (`timeout 60`); SSH to GitHub with `GIT_SSH_COMMAND='ssh -o IdentityAgent=none -o BatchMode=yes'`; pushes through the push tool, one try, on a push word. Hashes pasted, never typed. One ruling per question, amended only on a finding. A refused command is reported with its exact text and nobody else runs it. Write in Simplified Technical English; end every final turn with "Your Actions:".

## 6. Log append form

```
cd /tmp/factory-platform-evidence && L=w00/HANDOFF-2026-09-24-weekly-limit.md; M=/home/<USER>/work/EZCorp/factory-evidence-mirror/w00/HANDOFF-2026-09-24-weekly-limit.md; h0=$(sha256sum "$L" | cut -c1-16); test "$h0" = <last hash> || { echo "GUARD FAIL $h0"; exit 3; }
printf -- '- %s <text>\n' "$(date -u +%H:%MZ)" >> "$L"; cp -p "$L" "$M"; sha256sum "$L" | cut -c1-16; wc -l < "$L"
```
Lessons for the coordinator: read an exit file with `cat` before quoting it; a listing shows the size. In zsh a plain variable does not word-split; loops use literal words or arrays. Write a result line only after reading the check output. The classifier refuses some batch deletions and merges; split into single objects or hand the exact command to the user.

## 7. Background tasks to restart in the new session

- Heartbeat (20 minutes; keyed on path and size of `*.exit*`, `publish.out`, `compare-*.txt` under the evidence tree plus `integ/w00`): see the log entries "heartbeat watch armed" for the exact command.
- The 48-hour age-refresh loop: `touch -c` every 6 hours on `/tmp/factory-platform-evidence` and `/tmp/factory-tools`, logging to `w00/tmpfiles-touch.log`; it protects the trees from the daily tmpfiles cleanup.

## 8. The user's open decisions (section L of the task list)

Where W19 runs; the Docker Hub pulls (ingress nginx; runner logins); registry publication by digest; the mutation threshold; the GitHub App, secrets and the real runner host; per-job memory budgets; the old containers, volumes and trial branches; stopping or bounding the Codex app server's lock jobs and its pytorch loop.

## 9. First actions of the new session

1. Announce yourself to `validator-8`, `integrator-5`, `w4h-35`, `w4h-36` as the new coordinator session and ask each for a one-line state; tell them which messages since 22:28Z you did not see.
2. Read the tail of the coordinator log from line 6342 and `w4h-35/logs/gated-merge13-static.log`; then this file's section 3.
3. Restart the two background tasks (section 7) and append a log line "coordinator session restarted" with this file's hash.
