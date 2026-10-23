# Handoff: finish the factory-platform W4H-35 release round on another machine

Written 2026-10-23 about 15:00Z by the coordinator (`team-lead`). This file is self-contained. Read it first, then the files it names. Nothing in it is a secret.

## 0. Paste this into the new Claude Code session

> You are the new coordinator (`team-lead`) of the factory-platform release round W4H-35 in the repo `ezcorp-org/EZHarness`. Read `factory-resume/2026-10-23/w00/HANDOFF-OTHER-MACHINE-2026-10-23.md` on branch `evidence/factory-w4h35-resume-2026-10-23` first, then do its section 7 ("First actions"). Write in Simplified Technical English. End every final turn with "Your Actions:". Ask the user before any outward action that the user has not approved in this file.

## 1. The goal

Get W4H-35 (the Kubernetes hosted profile, the GPU and CPU-only resource profiles, the wrapped keys) into `main` through PR #349, with every gate green, then close the round (owners remove their worktrees). The user merges the PR; the team never merges `main`.

## 2. What is on GitHub (read 2026-10-23 about 14:56Z)

| Ref | Sha | What it is |
|---|---|---|
| `main` | `802d46288ab9` | Unchanged base (PR 341 merged). |
| `feat/factory-platform-followup-4` | `a27d301c437c` | Draft **PR #349** into `main`: merge commit `b701cf0e2` (W4H-35 head `3698c8e84` on `802d46288`), receipts `d6ba7dedb`, tasks `a27d301c4`. Hosted CI on it FAILS (section 4). |
| `wp/w4h-35-w16-k8s-profiles` | `3698c8e842f2` | Backup of the W4H-35 owner branch (commits 01-07). |
| `evidence/factory-w4h35-resume-2026-10-23` | `ea694eedb8b8` | The resume bundle: redacted copies of the coordinator log, handoffs, release task list, the 10-23 leftovers ledger, verdicts, plans, briefs, tools and scripts, under `factory-resume/2026-10-23/`. Start at `_bundle/README.md`. Placeholders in angle brackets (for example `<USER>`, `<WORD>`) replace private values. |

Not on GitHub: the full evidence tree (about 7.3 GB of raw logs, images, coverage). The bundle is enough to continue; raw logs can be re-made by re-running the steps.

## 3. Where the work stands

Done and judged by the validator: owner head `3698c8e84` (session 10, ACCEPT); run 13 (kind proof in Podman, ACCEPT); the integration merge `b701cf0e2` (hook 44 suites, 979 pass); hold 2 (174 legs, 0 red); publish; receipts; tasks; the push of `feat/factory-platform-followup-4`; draft PR #349.

Hosted CI on PR #349 (ci run `39956956620`, two attempts) is red against the PR 341 baseline run `39092674643` (54 pass / 2 known red / 3 skip). Three root causes, all reproduced:

- **R1, a W4H-35 defect.** `deploy/factory/Dockerfile` uses `ADD --checksum=sha256:...`. The hosted runner (ubuntu-24.04 image 20261012.334, Podman 4.9.3, Buildah 1.33.7) refuses that flag: "ADD only supports the --chmod=<permissions> and the --chown=<uid:gid> flag", exit 125. Local Podman 5.8.7 accepts it, so local holds could not see it. Fix: plain `ADD <url> <dest>`, then the next instruction `RUN echo "<sha256>  <dest>" | sha256sum -c -`; `scripts/check-factory-deployment-locks.ts` accepts exactly that pair and refuses `ADD --checksum` by name.
- **R2, a test-isolation defect (older W4H-34 test code).** `tests/postgres/factory-notification-sender.test.ts:334` gets 2 where 1 is expected: an earlier test's receiver hook (`Bun.sleep(50)`) adds its key after a later test's `reset()`. Fix: the test webhook receiver counts a request only in the reset generation in which it arrived.
- **R3, a date bomb (older test code; it also breaks CI on `main`).** `web/e2e/personal-github-settings.spec.ts:208`: the page clock is fixed at 2026-09-23, but the code expiry comes from the runner's real clock. Since about 2026-10-18T08:21Z the delay exceeds 2^31-1 ms, Playwright's fake clock fires it after 1 ms, and the test fails on every run. Fix: the test takes the expiry from the page clock.

Also due now (the must-fix leftovers): an unused `stat` import in `src/factory/runner/supervisor-process.ts:48`; 3 `noConfusingVoidType` warnings in `src/factory/service-probes.ts` (fix: `probeOf` / `heldProbeOf` split, fixtures return `undefined`); an `afterAll` that calls `rm(undefined)` in `src/factory/observability/alert-evaluator.integration.test.ts` after a failed setup.

**Session 11** (the four fix commits 08-11 on top of `3698c8e84`) was running on the old machine at the time of writing. Unless a later backup push of `wp/w4h-35-w16-k8s-profiles` shows commits after `3698c8e84`, assume it did NOT finish and redo it (section 6).

## 4. The team model (re-create it)

Four teammates, re-created with the same names: `validator-8` (reads every set by hash; its OK by exact hash comes before every word; writes verdicts, top-inserted), `integrator-5` (integration branch, merge, hold, publish, receipts, tasks, pushes), `w4h-35` (owner of the W4H-35 code), `w4h-36` (docs: lessons, ledger, PR body). The coordinator gives "words": a SendMessage whose message id's first 8 hex is the word id, sent as text in a second message, logged, and bound to the hashes the validator approved. A job's launcher writes `COORD_WORD=<id>` as line 1 of its log; the word is spent when the job enters the lock.

## 5. Binding rules (short)

No secret in any document, transcript or argv. Podman only; digest-pinned images; no Docker Hub pull without the user's word. The coordinator never integrates and never pushes; integrator-5 does. Nobody edits shared `.git/config`; no bare `git stash`; `-c rerere.enabled=false` on every merge. Never kill a lock holder; a teammate stops only its own job. Never move or edit a file of an approved set while its launch may be queued. Remove only what you built, by tag, never a shared image id. Red first; one planted mutant per commit; 100 percent of changed lines; no gate lowered. Every remote read `timeout 60`; SSH with `GIT_SSH_COMMAND='ssh -o IdentityAgent=none -o BatchMode=yes'`; one try per push, on a push word. Hashes pasted, never typed. One ruling per question; never change a ruling while its owner is building; wait for the owner's ack. A command refused by the permission system is reported with its exact text, and nobody else runs it (the user may run it with `!`). The heavy lock is shared by every job on the host: read its holder from `/proc/locks`, not by an fd scan.

## 6. Remaining steps (in order)

1. **Session 11** on `wp/w4h-35-w16-k8s-profiles` at `3698c8e84`: commit 08 (R1), 09 (R2), 10 (R3), 11 (must-fix lint and test patches). Each red first with a planted mutant. Before commit 10, prove R3 red on the old head (20 repeats, all red), else stop. Build the factory image with Podman 4.9.3 (the hosted runner's version) and with the local Podman; both must pass. Then the fast stage and C9 at the new head. The approved drafts are listed in section 8.
2. Validator ACCEPT of the new head; then a backup push of `wp/w4h-35-w16-k8s-profiles` (fast-forward).
3. **Run 13** again at the new head (the image changed): the kind proof in Podman, the pull judge, the full-path judge, the host check.
4. **Integration round** on top of `a27d301c4`: a merge folder for the new head (from the W4H-34-form held folder, with `extra-legs.sh` and the hosted-builder leg as a file leg), prep, merge commit with the hook, hold (every mandatory leg), publish, receipts, tasks (lessons, ledger, release block), each with validator OK and a word.
5. **Push** a fast-forward of `feat/factory-platform-followup-4` (PR #349 updates). The user gave the word for this push: "you push it when ready".
6. **Hosted CI compare** of the new run against `39092674643` and `39956956620`; expect R1-R3 green; the "Factory runner readiness precheck" stays red (no `factory-real` runner; a user decision).
7. **PR body**: w4h-36 fills the hosted result; integrator-5 edits PR #349 after validator OK.
8. **The user** marks PR #349 ready and merges it.
9. **A8**: owners remove their worktrees after the merge, by name, with records.

## 7. First actions of the new session

1. Fetch: `git fetch origin` and read section 2's refs again (`git ls-remote origin`, with the timeout). If `wp/w4h-35-w16-k8s-profiles` is past `3698c8e84`, session 11 finished: start at step 2 or 3.
2. Read `factory-resume/2026-10-23/_bundle/README.md`, `w00/leftovers-2026-10-23.md` (the FINAL ledger), `w00/release-tasks-2026-10-18.md`, and the tail of the coordinator log in the bundle.
3. Make the evidence tree on the new machine (for example `/tmp/factory-platform-evidence`), copy the bundle folders into it, re-create the pinned tools (Bun 1.4.2, Node 24.14.1), and record hashes.
4. Re-create the team (section 4) with the restart brief in the bundle (`w00/briefs/restart-2026-10-19.md` form), pointing them at this file.
5. Ask the user the open questions in section 9 that block the next step.

## 8. The approved session-11 drafts

The four patches and the session plan were drafted, tested red-first and approved as content by the validator on the old machine (`w4h-35/merge-prep/session11/08.patch` ... `11.patch`, plan `session-11-plan.txt`, launcher `bin/s11-launch.sh`, session `bin/locked-s11.sh` v4, which calls the shared hosted-builder leg `w00/hosted-builder/hosted-builder-leg.sh`). If the bundle branch has a newer commit that adds `w4h-35/merge-prep/session11/`, use those files; otherwise re-make each fix from section 3 (each is small), red first.

## 9. Open user decisions

- A runner with the `factory-real` label (the readiness precheck stays red without it).
- Docker Hub pulls for ingress nginx (the one allowed pull by digest is recorded).
- Per-job memory budgets; the Codex jobs that hold the shared heavy lock often.

## 10. Lessons from this round (keep)

- Local proof must use the hosted tool versions (Node strip-only; Podman 4.9.3), or a guard must refuse forms the hosted tools do not accept.
- Copy the last HELD merge folder, never a draft; a hold must refuse to start without its extra legs.
- A judge must know the designed failures of the run it judges (the stopped-wave canary).
- A test fixture must look like the real input; a file choice made in two places must agree.
- Messages cross: one ruling, held until the owner acks; never move a pinned file while a launch may be queued.
- Public pushes of internal records need redaction and the user's final OK; the permission classifier may refuse them, and then only the user runs them.
