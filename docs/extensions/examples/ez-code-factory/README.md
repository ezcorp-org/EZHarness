# ez-code-factory — a git "gate" as an EZCorp extension

A local git **gate** that sits in front of your real remote, modelled on
[no-mistakes](https://github.com/kunchenguid/no-mistakes). `git push gate
<branch>` lands objects in a **local bare repo** (fast, local, always
succeeds); the gate's `post-receive` hook hands control to this extension,
which records a run and checks the pushed commit out into a disposable detached
**worktree**. In later milestones the worktree is where a fixed
review/test/lint/PR/CI pipeline runs before anything is force-pushed upstream —
`origin` is never touched by the push itself.

**This is M0 — gate bring-up only.** It brings up the gate, the run/worktree
lifecycle, and the Hub dashboard. No pipeline steps, findings, or approvals yet
(those are M1+). It is an **installable example extension** — nothing about it
is bundled into the platform.

## How a push becomes a run

```
git push gate <branch>
   │  objects → local bare gate repo (push always succeeds)
   ▼  post-receive hook (POSIX sh, ALWAYS exits 0)
POST /api/extensions/ez-code-factory/events/push-received   (minted key)
   │  { source: "hub", pageId: "dashboard", payload: {repoId, branch, oldSha, newSha, ref, pushOptions} }
   ▼  the platform dispatches the Hub action to this extension
run manager: per-(repo,branch) mutex → detached worktree from the gate repo at
newSha → recorded on the run → torn down (`git worktree remove --force`)
   ▼
Storage (global): runs + step_results   •   Hub dashboard: runs table
```

### Why the events route, not `ez.triggerHubAction`

The harness contract's `ez.triggerHubAction(pageId, action, payload)` targets
`POST /api/hub/pages/:id/actions/:action`, which is **core-page-only** (it
rejects any `pageId` whose kind is not `core`). Extension Hub-page actions go
through the **generic extension-events route**
`POST /api/extensions/<name>/events/<event>` with the `{ source: "hub", pageId,
payload }` body shape — the exact same route an in-app Hub action button POSTs
to. That is a pure-extension surface (no new platform route), so the hook uses
it directly with a minted `chat`-scoped key. This is the fallback anticipated
by the spec's locked Decision #1.

## Setup

1. **Provision the gate** (idempotent) — run the `init_gate` tool on the active
   project. It creates the bare gate repo, installs the managed hook, points the
   gate repo's `origin` at your upstream, and adds a `gate` remote to the
   working repo. Re-running is safe: it only rewrites hooks it wrote itself and
   only repoints gate wiring it owns (a foreign `gate` remote or a foreign hook
   is never clobbered).

2. **Provision the hook's credential** (path-to-credential). The hook
   authenticates to the events route with a minted API key it reads from a
   **file** at push time — the key is never written into the hook script. Mint a
   `chat`-scoped key and drop it at the credential path `init_gate` prints:

   ```bash
   ezcorp key mint --scopes read,chat > \
     "$(git rev-parse --show-toplevel)/.ezcorp/extension-data/ez-code-factory/gate-key"
   ```

   `.ezcorp/` is gitignored, so the key never lands in a commit. If the file is
   missing or empty the hook logs a one-line hint (to `notify-push.log` and the
   pusher's stderr) and still exits 0 — a gate never blocks a push.

3. **Point the hook at your server** (optional). The hook POSTs
   `http://127.0.0.1:3000` by default; set `EZCORP_BASE_URL` before running
   `init_gate` to bake a different base URL into the hook.

Then just:

```bash
git push gate <branch>
```

## The managed hook

The `post-receive` hook is POSIX sh and:

- carries a version marker (`ez-code-factory:managed-post-receive:v1`) so
  `init_gate` only ever overwrites hooks it wrote — a hand-written hook is left
  untouched;
- is installed **atomically** (temp file → `chmod 0755` → `mv`);
- **ALWAYS exits 0** — the push's success never depends on the gate;
- forwards `oldrev/newrev/refname` plus any `--push-option` values (as a JSON
  array) to the events route;
- reads its key from the credential **file**, never inline;
- appends any notify failure to `notify-push.log` in the gate dir **and** echoes
  a one-line banner to the pusher's stderr.

`receive.advertisePushOptions=true` is enabled so `git push -o key=value` push
options reach the hook. Per-worktree hook isolation
(`extensions.worktreeConfig` + per-worktree `core.bare`) is best-effort — a
no-op on git too old to know the keys.

## Dashboard (Hub page)

`/hub/ext:ez-code-factory:dashboard` renders a stats header and a runs table
(Run · Branch · Head · Status · Updated), refreshed live via a content-free
`ext:page-state` SSE signal (`pushPage`) after each run state change.

## Permissions

`storage` (self-tracked run + step records), `shell` (git orchestration +
per-run worktree lifecycle), and `filesystem: ["$CWD"]` (the gate repo, hook,
and credential all live under
`<projectRoot>/.ezcorp/extension-data/ez-code-factory/`). **No `network`
grant** — the callback is made by the post-receive hook (a shell process git
runs at push time), not by the extension subprocess.

## Storage

Run records live in SDK `Storage("global")` as one key per run (`runs/<id>`)
plus a `run-index` key, with per-step outcomes under `step_results/<runId>/<step>`.
Global scope is deliberate: a gate run is system/CI-like (a push is not a
per-user chat action) and must be visible on the shared, cross-user Hub
dashboard. The findings model (`Finding`/`Findings`) ships **now**, fail-closed
at the deserialization boundary — a missing/empty/unknown `action` becomes
`ask-user` (always blocks) — so the safety contract exists from day one even
though no M0 step produces findings yet.
