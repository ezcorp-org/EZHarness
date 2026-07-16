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
   (umask 077; ezcorp key mint --scopes read,chat > \
     "$(git rev-parse --show-toplevel)/.ezcorp/extension-data/ez-code-factory/gate-key")
   ```

   The `umask 077` creates the key file `0600` (owner-only) so it is never
   group/world-readable. `init_gate` also best-effort `chmod 0600`s the key if it
   already exists at init time. `.ezcorp/` is gitignored, so the key never lands
   in a commit. If the file is missing or empty the hook logs a one-line hint (to
   `notify-push.log` and the pusher's stderr) and still exits 0 — a gate never
   blocks a push.

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
- acts on **branch updates only** — it skips non-`refs/heads/*` refs (tags,
  notes, …) and branch **deletions** (an all-zero newrev), so neither creates a
  junk run;
- forwards `oldrev/newrev/refname` plus any `--push-option` values (as a JSON
  array) to the events route, JSON-escaping the ref/branch (a `"` is legal in a
  git ref name);
- reads its key from the credential **file**, never inline;
- treats an **HTTP ≥ 400** response (401/404/429/5xx) as a failure, not just a
  transport error — it captures curl's `%{http_code}` so a rejected POST is
  never a silent drop;
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

## PR + CI (GitHub only)

Once the local steps pass and the branch force-pushes to the real upstream, the
**pr** step opens (or updates) a pull request and the **ci** step babysits its
checks:

- **PR body is deterministic.** The agent authors ONLY the `## What Changed`
  slice; `## Intent` is the verbatim (sanitized) run intent, and
  `## Risk Assessment` / `## Testing` / `## Pipeline` are computed from the
  persisted step results + rounds. The title is a conventional-commit subject.
  Oversized bodies shed content in priority order (drop Testing → drop the
  oldest Pipeline rounds → hard-truncate) to stay under GitHub's 63,488-byte cap.
- **CI is polled with an injected clock** (30s → 60s → 120s), with an idle
  timeout (default 7 days, `ciTimeoutHours` setting; `-1` = never) that re-arms
  whenever the base branch advances. On failure it fetches the failed logs,
  drives an agent fix, guarded-force-pushes, and resumes (cap 3).
- **Green checks rest, they don't babysit.** The instant every reported check
  passes on an open PR, the CI step EXITS and the run rests at `checks_passed`:
  the worktree is torn down and the per-branch lock released, the PR left open.
  It does NOT hold those resources for days waiting on a human merge. The run is
  not failed and not fully completed — a **Re-check PR state** button on the
  dashboard (or any `ez-code-factory:reconcile` POST) re-reads the PR state and
  completes the run once it merges/closes. Re-check is **manual** today; a
  periodic auto-sweep that reconciles parked/rested runs without a click lands in
  M6, together with supersede-on-new-push and reclaiming a genuinely
  failing/pending CI held until the idle timeout.
- **Skip-not-fail.** pr/ci quietly skip on the default branch, on a non-GitHub
  upstream, or when `gh` is unauthenticated **or not installed**. `gh` is NOT in
  the base container image — operators who want PR/CI must make `gh` available on
  the daemon's `PATH` (e.g. `gh auth login` on the host). Without it PR/CI
  gracefully skip; the pipeline still runs review/test/lint/push.

### GitHub token setup

The pr/ci steps shell `gh` (which must be installed on the host `PATH`), and it
needs auth. Two options:

1. **`gh auth login`** on the host — the extension inherits gh's ambient auth.
2. **The `GitHub token` setting** on `/extensions/ez-code-factory` — a
   `type:"secret"` field stored **encrypted** in user Storage (key
   `github-token`), never shown again. Scopes: a **classic** PAT needs `repo`; a
   **fine-grained** PAT needs **Pull requests: read & write** (open/update PRs)
   plus **Checks: read** and **Actions: read** (the CI-checks + failed-log
   paths). The extension passes it to `gh` via `GH_TOKEN` at spawn time; a
   `GH_TOKEN`/`GITHUB_TOKEN` already in the process env overrides it.

An env name matching `/_TOKEN$/i` is refused for a `permissions.env` grant at
install — the `type:"secret"` setting is the supported path, so no token env is
declared in the manifest.

## Permissions

`storage` (self-tracked run + step records), `shell` (git orchestration +
per-run worktree lifecycle + the pr/ci `gh` calls), `network: ["api.github.com"]`,
and `filesystem: ["$CWD"]` (the gate repo, hook, and credential all live under
`<projectRoot>/.ezcorp/extension-data/ez-code-factory/`). The push-trigger
callback itself is still made by the post-receive hook (a shell process git runs
at push time), not the extension subprocess.

**On the `network` grant — it is DECLARATIVE, not a `gh` sandbox.** The
`network: ["api.github.com"]` allowlist documents intent and is enforced only on
in-process `fetch` (via `src/extensions/runtime/network-wrapper.ts`). It does
**not** constrain the `gh` subprocess this extension spawns: `gh` makes its own
network calls outside that wrapper, and `gh run view --log-failed` in particular
follows redirects to non-GitHub object storage to fetch logs. Treat the grant as
a statement of where the extension's *own* code reaches, not a hard boundary on
what `gh` can talk to.

## Storage

Run records live in SDK `Storage("global")` as one key per run (`runs/<id>`)
plus a `run-index` key, with per-step outcomes under `step_results/<runId>/<step>`.
Global scope is deliberate: a gate run is system/CI-like (a push is not a
per-user chat action) and must be visible on the shared, cross-user Hub
dashboard. The findings model (`Finding`/`Findings`) ships **now**, fail-closed
at the deserialization boundary — a missing/empty/unknown `action` becomes
`ask-user` (always blocks) — so the safety contract exists from day one even
though no M0 step produces findings yet.
