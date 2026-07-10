# ez-code — coding-agent control plane

A Warren-style control plane for ephemeral coding-agent runs, built as an
EZCorp `multi` extension. Dispatch, steer, cancel, and list runs from a live
Hub dashboard; with cron triggers, branch→PR automation, and persistent agent
memory + a task queue — all operating on the **active EZCorp project**.

It rides on the **ez-sandbox** OS-isolation layer (Part A): every run's
shell/tool execution is jailed to a per-run workspace (Landlock in containers,
bwrap on capable hosts), so a run can never read `.ezcorp/data` (the PGlite DB
+ JWT secret).

`open_pr` (B3) goes further: its git/gh subprocess runs inside a fresh git
**worktree** checked out OUTSIDE the repo. A worktree contains only tracked
files, so the gitignored `.ezcorp/` is absent by construction. The jail's
allowlist is just that worktree (read-write) + the main repo's `.git` dir
(read-write — a SIBLING of `.ezcorp`, so granting it does not grant
`.ezcorp`) + read-only runtime libs + `/dev`. The project repo ROOT is never
granted on any tier, so `.ezcorp/data` is never in the jail's allowlist —
reading the platform DB/JWT secret is denied (EACCES), proven in-container.
The run's pending changes are carried into the worktree without `git stash`
**and without `node:fs`** — every file op runs through the host SHELL
(subprocesses run OUTSIDE the sandbox preload's `node:fs` poisoning): tracked
changes via `git diff HEAD --binary | git apply --index` (replays
modify/delete/rename/symlink/binary), and untracked non-ignored files via
`git ls-files -o --exclude-standard` + `cp -Pp --parents`. Both passes are
git-driven, so gitignored `.ezcorp/` is excluded by construction. The PR
carries exactly the intended diff including newly-created files; the throwaway
worktree (created via `mktemp -d`) is removed via shell `rm -rf` on every exit
path.

> Why no `node:fs`? The extension loads inside the sandboxed subprocess, where
> `src/extensions/runtime/sandbox-preload.ts` ALWAYS poisons `node:fs` /
> `node:child_process` / `Bun.spawn`. A static `import … from "node:fs"` (or a
> transitive one via the host sandbox layer) crashes module load on the FIRST
> spawn — the dashboard render — surfacing "Transport closed" on the Hub tab
> and every tool. open_pr therefore uses the shell for all file manipulation,
> and lazily (dynamic-import) loads the host jail builder only when it actually
> runs. A real-subprocess regression test
> (`src/__tests__/sandbox-ez-code-render.test.ts`) renders the dashboard under
> the preload to lock this down.

## Tools

| Tool | What it does |
|---|---|
| `dispatch_run` | Spawn a coding-agent run (`spawnAssignment`) and persist a run record to the caller's **per-user** store — visible via `list_runs`, NOT on the shared Hub dashboard (which renders only global cron/system runs). `agentName` is **optional** — omit it (or pass `coder`) to use the bundled default coder. |
| `list_runs` | List dispatched runs (newest first) with status + latest event. |
| `steer_run` *(B2)* | Inject a steering message into a run's sub-conversation (`appendMessages`). |
| `cancel_run` *(B2)* | Cancel a live run (`cancelRun`) + update its record. |
| `open_pr` *(B3)* | In a fresh `.ezcorp`-free git **worktree**, jailed to the worktree + the main `.git` (never the repo root): `git switch -c ez-code/<run>` → commit → push → `gh pr create`. |

## Default coding agent

`dispatch_run` works **out of the box** — it dispatches to a default coding
agent that ships with ez-code, so a fresh install does not need any
pre-existing agent config. Omit `agentName` entirely (or pass the friendly
alias `coder`) and the run targets the bundled **ez-code coder**: an LLM coding
persona that reads/edits files and runs shell/git on the active project, then
summarizes its changes so `open_pr` can branch + PR them. Pass an explicit
agent name to dispatch any other (e.g. a custom `reviewer`) agent instead.

**How it resolves.** The spawn path (`resolveAgentConfigForUser`) only resolves
rows in the `agent_configs` DB table — a manifest `agent:` block is *not*
spawnable by name. So ez-code ensures a single well-known **system**
`agent_configs` row named `ez-code coder` (`userId: null`) on boot
(`src/extensions/ez-code-coder-agent.ts`, wired into `ensureBundledExtensions`),
and the host's resolver falls back to it by name (and the `coder` alias) for
every user — a per-user row would be invisible to other users. The agent's
file/shell ability comes from the host agent runtime on the active project, not
from the agent config (the prompt is what makes it a coder).

## Dashboard (Hub page)

The `dashboard` page (`/hub/ext:ez-code:dashboard`) renders a stats header and
a runs table with status badges + an event-log view. It refreshes live via
`pushPage` on every `task:assignment_update` event (content-free SSE
invalidation → the open tab re-pulls).

## Triggers (B4)

`Schedule.on(cron, …)` reads `.ezcorp/extension-data/ez-code/triggers.json`
(Warren's `triggers.yaml` analog); each fire dispatches a run. Per-agent
persistent memory (mulch) and the task/issue queue (seeds) are surfaced on the
dashboard.

## Permissions

`spawnAgents`, `eventSubscriptions` (`task:assignment_update` + the page-action
events), `storage` (self-tracked run history — extensions can't read
`agent_runs` through the SDK), `filesystem` (`$CWD`, for B3's git/gh work),
and — added in later phases — `appendMessages`, `network: ["api.github.com"]`,
and `schedule`.

## Storage

Run records live in SDK `Storage` as one key per run
(`loop:ez-code:run:<runId>`) plus a small index key (`loop:ez-code:index`),
capped at the last 100 runs with up to 50 event-log entries each. They are
split across TWO scopes: runs dispatched by the user-facing `dispatch_run`
tool go to the per-user store (`Storage("user")`), while cron/system runs go
to the global store (`Storage("global")`) that backs the shared dashboard.
The `.ezcorp/` directory is gitignored.
