# ez-code-factory — the git "gate" coding pipeline

> _A local git **gate** (installable example extension) that intercepts `git push gate <branch>`, runs a fixed 9-step review/test/lint/PR/CI pipeline in a disposable worktree, parks each gate for human approval, and only force-pushes upstream once every step passes. Modelled on [no-mistakes](https://github.com/kunchenguid/no-mistakes); reimplemented pure-on-harness with native sub-agents._

Source lives under `docs/extensions/examples/ez-code-factory/` (manifest
`ezcorp.config.ts`, wiring `index.ts`, logic in `lib/`). It is an **example**
extension — nothing is bundled into the platform (`BUNDLED_EXTENSIONS` is
untouched, no `manifest.lock.json`). The extension's own `README.md` is the
operator setup guide; this doc is the feature-level reference.

## What it is

`git push gate <branch>` lands objects in a **local bare gate repo**
(`<projectRoot>/.ezcorp/extension-data/ez-code-factory/repos/<sha256(abspath)[:12]>.git`).
That push is fast, local, and always succeeds — `origin` is never touched by the
push itself. The gate's managed `post-receive` hook (POSIX sh, always exits 0)
POSTs the generic extension-events route with a minted key; the extension
records a **run**, materializes a **detached worktree** at the pushed SHA, and
executes the pipeline in it. Only after every local step passes does the pipeline
guarded-force-push to the real upstream, open a PR, and babysit CI.

## The fixed 9-step pipeline

The order is **not** configurable (`PIPELINE_STEPS` in `lib/config.ts`; the step
registry is `STEP_REGISTRY` in `lib/executor.ts`). Each step runs an auto-fix
loop bounded by a per-step cap; hitting the cap (or an `ask-user` finding) parks
the gate for a human.

| # | Step | Behaviour | auto-fix cap |
|---|------|-----------|--------------|
| 1 | intent | Explicit intent (authoritative acceptance criteria) or inferred from the EZCorp conversation (a hint). Never fails the run. | 0 |
| 2 | rebase | Fetch fresh `origin/<default>` + the pushed ref, rebase; conflict → findings → agent fix on the user's `fix` action; empty diff after → skip all remaining steps. | 3 |
| 3 | review | Structured AI review (severity + `auto-fix`/`ask-user`/`no-op` action + risk level). Cap **0** → the review gate **always** parks for a human. | 0 |
| 4 | test | Run `commands.test` if configured + an agent evidence pass; new test files always require approval. | 3 |
| 5 | document | Agent finds + fixes doc gaps ("one authoritative owner per fact"); ANY unresolved finding parks; absorbs lint when `commands.lint` is unset. | 3 |
| 6 | lint | Run `commands.lint`, or consume the document step's stashed housekeeping result, or a cold agent pass. | 3 |
| 7 | push | Commit leftover fixes + patch-id-safe `--force-with-lease` force-push. Never needs approval. | 0 |
| 8 | pr | Conventional-commit title; deterministic body (`## Intent` verbatim + agent `## What Changed` + Risk/Testing/Pipeline from the DB). GitHub via `gh`. Skips on the default branch / unauthenticated host. | 0 |
| 9 | ci | Adaptive poll (30s→60s→120s, injected clock) with an idle timeout; on failure fetch logs → agent fix → guarded push; the instant checks go green the run RESTS at `checks_passed` (worktree + lock released, PR left open); opts into the ReconcileApprovalGate. | 3 |

### Findings model (the safety contract)

Every step emits `Findings` (`lib/runs.ts`): items carry `severity`
(`error`/`warning`/`info`), `action` (`no-op`/`auto-fix`/`ask-user`), file/line,
description, source, and category. **Deserialization is fail-closed**: a missing,
empty, or unrecognized `action` becomes `ask-user` (always blocks) — enforced at
the boundary, not just in app logic. `error`/`warning` block; `info` alone does
not, unless its action is `ask-user`.

Park statuses are `awaiting_approval` and `fix_review`; the user answers with
**approve / fix / skip / abort**.

## Security invariants (ported field-for-field)

1. **Trusted-branch config reads** (`lib/repo-config.ts`) — executing keys
   (`commands.*`, `agent`, `document.instructions`, `disable_project_settings`,
   and the `allow_repo_commands` opt-in itself) are ALWAYS read from the freshly
   fetched **default branch**, never the pushed SHA (fixes a supply-chain-RCE
   class bug). A default-branch fetch failure aborts the run before any agent
   dispatches.
2. **Verbatim ask-user relay** (`lib/chat-contract.ts`) — a gate/status result
   carrying an `ask-user` finding is wrapped with a machine-enforced "relay to
   the user verbatim; do not paraphrase or pre-judge; STOP" directive, and
   structurally separates ask-user (must relay + stop) from auto-fix/no-op.
3. **Patch-id force-push safety** (`lib/steps/push.ts`) — `git rev-list
   --cherry-pick --right-only` against a last-observed anchor; refuse on
   out-of-band commits; `--force-with-lease`, never bare `--force`; fail closed
   if unverifiable.
4. **`assertPipelineHeadContinuity`** — before every fix commit, verify the
   worktree HEAD still descends from the pipeline's last-recorded head.
5. **Prompt hygiene** — sanitize re-entering findings (strip conflict-marker
   lookalikes, collapse whitespace); intent framed as data, not instructions;
   transcript secret-redaction.
6. **No blanket approval** (`lib/chat-contract.ts`) — a chat `approve`/`fix` that
   does not name explicit `findingIds` (or carry standing consent) over a gate
   with ask-user findings is rejected.

## Chat entry point (contract-in-code tools)

Four LLM-callable tools (docstrings in `ezcorp.config.ts`; wiring in `index.ts`;
logic in `lib/chat-tools.ts`):

- **`code_factory_run(intent?, branch?)`** — start a gate run. Explicit `intent`
  is authoritative; omitted → inferred from the current conversation (a hint).
- **`code_factory_status(runId?)`** — the run's gate state + findings, with the
  verbatim ask-user relay wrapper when parked on an ask-user finding.
- **`code_factory_respond(runId, step, action, findingIds?, …)`** —
  approve/fix/skip/abort a parked gate. Enforces the no-blanket-approval
  contract. **Requires the `respond-gate` RBAC scope** (host-enforced via the
  tool's `rbacScope`).
- **`code_factory_doctor()`** — read-only health report (see below).

## RBAC on the triage actions

The gate-triage verbs are gated behind two custom `permissions.rbacScopes` +
`extension_rbac_grants` (the github-projects `write-tickets` pattern; deny-by-
default, admins hold every scope). Enforced host-side from the acting user's
provenance (a Hub click resolves `onBehalfOf = the clicking user`):

- **`respond-gate`** — answer a parked gate (approve / fix / skip / abort), from
  the `code_factory_respond` tool AND the Hub respond action (`handleRespond`).
- **`yolo`** — the yolo autopilot (`handleYolo`). Its OWN scope, strictly broader
  than a single approve (it clears every remaining gate of a run).

A user without the grant gets a clear refusal (a `toolError` for the chat tool;
a no-op + logged refusal for the Hub action) — never a 500, and the run is never
mutated. The `reconcile` action is **not** RBAC-gated: it is read-only (it only
completes a run when external truth says the PR merged/closed) and is also driven
by the background sweep, which has no acting user.

## Yolo autopilot (fix-once)

`decideYoloAction` (`lib/yolo.ts`): for each remaining parked gate the autopilot
FIXES its actionable `auto-fix` findings **once**, then APPROVES — but STOPS the
instant a gate carries an `ask-user` finding (the ones the gate exists to force a
human to see). It drives the SAME approve/fix respond path the Hub buttons use
(no gate-semantics bypass) and is bounded so a pathological re-park can never
spin.

## Jobs & the Hub job editor

Multiple named pipeline jobs per project (`lib/jobs.ts`), each independently
triggered by **push** (branch pattern — literal or ONE trailing `*` glob),
**schedule** (`15m`/`hourly`/`daily`, routed off the every-15-min sweep tick;
literal branch), or **manual** ("Run now"). A default catch-all push job is
auto-seeded on first read so pre-jobs behavior is preserved exactly.

The Hub job page (`?view=job:<id>`, `buildJobView` in `lib/page.ts`) edits a
job in **one inline on-page form** (the Hub `form` node — no modal dialogs;
the earlier "Edit job"/"Edit prompts" prompt-and-dialog editors are gone):
name, the trigger as three components — a **kind select**
(push/schedule/manual), a branch text field, and a **cadence select** that
renders and submits only while the kind reads `schedule` (`visibleWhen`;
hidden = key omitted, so a non-schedule save never clears the cadence) — the
agent override, the intent template, and the three operator prompt-instruction
textareas (review/fix/document, ≤ 500 chars each). One Save submits every
visible field (blank clears an optional field); `applyJobEdit` (`lib/jobs.ts`)
reassembles the trigger from the `trigger_kind`/`trigger_branch`/
`trigger_every` components (the legacy free-text `trigger` spec — `push
<pattern>` / `schedule <every> <branch>` / `manual <branch>` — is still
accepted, and the components win when both are present), then the whole draft
re-validates (`validateJobDraft`) and one diff is audited. Skip-steps are
toggled per-step in the Flow table (protected steps —
intent/rebase/review/push — always run and carry no toggle). The read-only
Prompts section previews what the job will send the agent (render-knowable
values substituted) and points at the Edit form's intent + instruction fields
as the editable prompt parts — the base prompt skeleton is fixed on purpose
(it carries the structured-output contract the pipeline parses).

## Background reconcile sweep

A run rests at `checks_passed` (or is parked at CI on an idle timeout) until its
PR merges/closes. A `Schedule` cron (`*/15 * * * *`, declared in
`permissions.schedule`; handler `handleScheduleFire` → `reconcileSweep` in
`lib/sweep.ts`) polls every reconcilable run and completes the ones whose PR
resolved. It is read-only per run, bounded (`maxPerSweep`), deterministic (an
injected clock — no wall-clock), and records a heartbeat that
`code_factory_doctor` reports.

## Crash recovery

On (re)start, `recoverRuns` (`lib/recovery.ts`) re-derives every run's state from
Storage:

- a cleanly **parked** run recovers ONLY if the gate row is fully recorded (a
  step is actually parked) and every prior step completed/skipped — otherwise it
  fails closed;
- a **mid-flight** run (running/created/worktree_ready) fails closed (a restart
  cannot safely re-enter a half-executed step);
- **orphaned worktrees** of terminal/failed runs are reaped — a live parked run's
  worktree (the human's review copy) is never touched.

## Supersede-on-new-push

A new push to a branch with an in-flight prior run (parked or resting) cancels it
(`supersedePriorRuns` in `lib/runs.ts`): the prior run is marked `aborted` with a
persisted "superseded" reason and its worktree reaped, then the new run starts.
Different branches stay fully concurrent. Within a branch the per-`(repo,branch)`
mutex is an unbounded FIFO chain (no timed cap): a new push waits behind a
genuinely running prior segment until it reaches its next park/finish yield point
before superseding it — so a running agent is never killed mid-execution; only a
prior run that has already parked/rested is aborted.

## Diagnostics — `code_factory_doctor`

A read-only report (`lib/doctor.ts`) with one line per check — `ok`
(nominal), `warn` (degraded but usable), or `fail` (broken):

| Check | fail / warn condition |
|---|---|
| `gate` | fail: no bare gate repo (run `init_gate`) |
| `hook` | fail: no post-receive hook · warn: a foreign (unmanaged) hook |
| `gh` | warn: gh not on PATH, or unauthenticated (pr/ci skip) |
| `token` | warn: no `github_token` secret (gh uses ambient auth) |
| `default-branch` | warn: gate has no origin remote (cannot fetch / PR) |
| `reconcile-sweep` | warn: the sweep has not fired since boot |

`report.ok` is true iff nothing `fail`ed.

## Setup

1. Run **`init_gate`** on the active project (idempotent) — creates the bare gate
   repo + managed hook, points the gate's `origin` at your upstream, adds the
   `gate` remote to the working repo.
2. **Mint the hook credential** (path-to-credential — the key lives in a file the
   hook reads at push time, never inline):
   ```bash
   (umask 077; ezcorp key mint --scopes read,chat > \
     "$(git rev-parse --show-toplevel)/.ezcorp/extension-data/ez-code-factory/gate-key")
   ```
3. For PR/CI, make **`gh`** available on the daemon's `PATH` and authenticate —
   either `gh auth login`, or set the `GitHub token` secret setting (stored
   encrypted, passed to `gh` via `GH_TOKEN`; classic PAT `repo`, or fine-grained
   PRs read+write / Checks read / Actions read).
4. `git push gate <branch>`.

## v1 trims + follow-ups

Accepted v1 scope reductions (all reversible):

- **GitHub only** — `gh` shellout; GitLab/Bitbucket/Azure are later.
- **EZCorp-conversation intent inference** — the platform owns the transcripts,
  so no external `~/.claude`/Codex JSONL scraping; external-CLI transcript
  readers are later.
- **Native sub-agents only** — every pipeline agent turn runs through the
  platform's host-brokered provider layer (pi-ai). No Claude Code / Codex / other
  external coding-agent CLI subprocesses; the only external binaries shelled
  (inside the nested jail) are `git` and `gh`.
- **Web UI only** — the Hub dashboard; no terminal TUI (a companion CLI over the
  Control tier is a possible follow-up).

Full 9-step pipeline, full findings taxonomy, and all six security invariants
ship in v1.
