# ez-code — coding-agent control plane

A Warren-style control plane for ephemeral coding-agent runs, built as an
EZCorp `multi` extension. Dispatch, steer, cancel, and list runs from a live
Hub dashboard; with cron triggers, branch→PR automation, and persistent agent
memory + a task queue — all operating on the **active EZCorp project**.

It rides on the **ez-sandbox** OS-isolation layer (Part A): every run's
shell/tool execution is jailed to a per-run workspace (Landlock in containers,
bwrap on capable hosts), so a run can never read `.ezcorp/data` (the PGlite DB
+ JWT secret).

## Tools

| Tool | What it does |
|---|---|
| `dispatch_run` | Spawn a coding-agent run (`spawnAssignment`), persist a run record, surface it live on the dashboard. |
| `list_runs` | List dispatched runs (newest first) with status + latest event. |
| `steer_run` *(B2)* | Inject a steering message into a run's sub-conversation (`appendMessages`). |
| `cancel_run` *(B2)* | Cancel a live run (`cancelRun`) + update its record. |
| `open_pr` *(B3)* | Under the per-run jailed workspace: `git switch -c ez-code/<run>` → commit → push → `gh pr create`. |

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

Run records live in SDK `Storage` (global scope, key `runs`), capped at the
last 100 runs with up to 50 event-log entries each. The `.ezcorp/` directory is
gitignored.
