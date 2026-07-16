# docs-updater — proactive PR-drafter (flagship loop)

The user's exact example, honestly scoped: **it drafts a docs PR, a human
approves, and on the `/repo` self-dev mount the merge stays manual on GitHub.**
It is the Phase-3 flagship of the Loops campaign — the first loop that composes
the whole primitive: a deterministic `check`, a deferred coding-agent `act`, a
gated `proposal`, and a human `approve`/`decline` that resolves it.

```
trigger (daily cron | run_docs_update tool)
  → check    : git HEAD vs the durable cursor (sandboxed git, NO LLM)
      · unchanged → skip (no draft)
      · new commits → advance the cursor, collect the review span
  → act      : spawn a coding agent to update README / docs (DEFERRED)
  → onComplete: the agent's PR → a proposal (kind "pr") that PARKS for approval
  → approve  : finalize — re-validate write-scope + mergeability, mark ready
  → decline  : discard — close the PR
```

## Honest scoping — merge stays manual on `/repo`

On the `/repo` self-dev mount, GitHub auto-merge is deliberately disabled.
docs-updater **respects** that: an approval marks the PR **ready** (comment +
un-draft) but **never merges** — a human does the merge on GitHub. On any other
target you may set **Merge on approve** to also merge (`gh pr merge --squash`)
once approved; this is the capability Phase 8's autonomous-merge demo points at
a scratch repo. `/repo` is always manual, regardless of the setting.

## Write-scope jail — grants, not prompt hope

The drafted PR is validated to touch **only** the configured `write_paths`
(default `README.md,docs/`). A PR that changes anything outside them is
**refused** — closed before it can ever reach a human approver at `onComplete`,
and re-checked again at `finalize`. The check is **rename-aware**: it reads the
PR's files through `gh api …/pulls/<n>/files` and gates **both** the new
`filename` **and** any `previous_filename`, so a rename that moves a source
file into `docs/` (or a docs file out to `src/`) is caught. Absolute paths,
`..` traversal segments, and `\`-separated paths are refused outright. The
preset prompt also asks the agent for docs-only edits, but the structural path
check is the enforcement, not the prompt. (The agent runs in its own jail;
docs-updater cannot Landlock the agent's writes, so the enforcement lives at the
PR boundary it *does* own.)

**Approval-time drift — an honest caveat.** If a PR passes the pre-park check,
parks, a human **approves**, and only *then* drifts out of scope, `finalize`
still refuses it: it **closes** the PR and records `rejected_out_of_scope` on
the outcome. By primitive design the approval label captures the human's
**decision** (stamped *before* `finalize` runs), so the label reads `approved`
while the outcome carries the refusal — the outcome, not the label, is the
source of truth for what actually happened to the PR.

## gh is pinned to the watched repo — no cross-repo action

Every `gh` call is pinned to the origin resolved from `git remote get-url
origin` (`gh api repos/<owner>/<repo>/…` and `gh pr … --repo <owner>/<repo>`).
A full PR URL the agent reports for **any other repo** is **refused with no gh
action** (`foreign_pr_ref`) — a prompt-injected "close that other repo's PR"
can never execute. A bare `#N` or an own-repo URL is normalized to a bare PR
number carried alongside the explicit `--repo`, so a shell metacharacter can
never ride in on the ref. When the completion cites several own-repo PR URLs
the **last** is chosen (agents cite reference PRs before their own result). If
origin is unreadable, the loop takes no gh action (`no_origin`, skip-not-fail).

## At-most-once cursor

The cursor (`loop:docs-updater:cursor`) advances **in `check`**, the moment new
commits are seen — before the agent runs. If the later draft or approval never
lands, that window's commits are **not** re-drafted on the next fire. This is
deliberate: at-most-once (never draft the same span twice) beats at-least-once
(which would re-open a near-duplicate PR on every sweep after a transient
failure). `maxConcurrent: 1` keeps a slow daily sweep from overlapping a manual
run and double-advancing.

## `decidedBy` is host-stamped

Approve/Decline are the dashboard's per-run row actions. The host events route
stamps `PageActionEvent.userId` from the authenticated session — the client
body cannot carry a `userId`, so the acting identity can never be forged. The
row action threads that host-stamped `event.userId` into `approveRun` /
`declineRun` as `decidedBy`, which is written verbatim onto the LOCKED approval
label (the Phase-9 eval signal) and the `loops:approval_resolved` audit mirror.
See [docs/extensions/loops.md](../../loops.md#decidedby-is-host-stamped--never-trusted-from-extension-code).

## Settings

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Draft docs PRs when new commits land. |
| `repo_path` | `""` | Repo to watch + draft against. Blank = active project (`/repo`). |
| `agent_name` | `coder` | The coding agent dispatched to update the docs. |
| `write_paths` | `README.md,docs/` | Path prefixes the PR may touch (the write-scope jail). |
| `auto_merge` | `false` | Merge on approve on a **non-`/repo`** target only. Ignored on `/repo`. |

## Try it (demo)

1. Enable **docs-updater** and set **Repository path** to your project (or leave
   blank to use `/repo`). Optionally set **Docs write scope**.
2. Draft on demand with the `run_docs_update` tool (or wait for the daily
   06:00 cron). With new commits since the last review, it dispatches the
   coding agent and, when the agent opens a PR, parks it for approval.
3. Open the **docs-updater** Hub page. A parked run shows the PR ref plus
   **Approve** / **Decline** buttons.
4. **Approve** → the PR is re-validated (write-scope + mergeability) and marked
   ready; on `/repo` you finish the merge on GitHub. **Decline** → the PR is
   closed. Either decision is captured as a durable approval label.

`gh` absent (exit 127) is skip-not-fail: the PR steps are skipped and the run
records `skipped_gh_unavailable` rather than erroring — the loop still parks,
labels, and resolves.

## See also

- [docs/extensions/loops.md](../../loops.md) — the `defineLoop` primitive + the
  approval / `decidedBy` / staleness reference.
- [`repo-activity-notify`](../repo-activity-notify/index.ts) — the read-only
  check-stage trust probe (Phase 1) this builds on.
