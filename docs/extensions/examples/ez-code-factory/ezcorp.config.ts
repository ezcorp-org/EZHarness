import { defineExtension } from "../../../../src/extensions/sdk/define";

// ── ez-code-factory — no-mistakes-style git "gate" as an EZCorp extension ──
//
// M0 (gate bring-up): `git push gate <branch>` on a target repo lands objects
// in a LOCAL bare gate repo whose `post-receive` hook POSTs the EXISTING
// generic extension-events route; the extension records a run, materializes a
// detached worktree, and tears it down. No pipeline steps yet — everything
// downstream (review/test/lint/PR/CI) arrives in later milestones.
//
// This is an INSTALLABLE example extension (not bundled): M0 never touches
// BUNDLED_EXTENSIONS, manifest.lock.json, or bundled-ceiling.ts.
export default defineExtension({
  schemaVersion: 2,
  name: "ez-code-factory",
  version: "0.1.0",
  description:
    "A local git 'gate' that intercepts `git push gate <branch>` in front of " +
    "your real remote: the push lands in a bare gate repo whose post-receive " +
    "hook triggers this extension, which records a run, checks the pushed " +
    "commit out into a disposable detached worktree, and (in later milestones) " +
    "runs a fixed review/test/lint/PR/CI pipeline before force-pushing " +
    "upstream. M0 brings up the gate + run/worktree lifecycle + Hub dashboard.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  category: "Development",
  tags: ["hub", "pages", "git", "gate", "ci", "control-plane"],

  tools: [
    {
      name: "init_gate",
      description:
        "Idempotently provision the git gate for the ACTIVE project: create a " +
        "local bare gate repo under the extension's data dir, install a managed " +
        "post-receive hook, enable push-option advertisement + per-worktree " +
        "hook isolation, point the gate repo's `origin` at the project's " +
        "upstream, and add a `gate` remote to the working repo (refusing to " +
        "clobber a foreign remote of the same name). Safe to re-run: it only " +
        "rewrites hooks it wrote itself and only repoints gate wiring it owns. " +
        "After running, `git push gate <branch>` routes the push through this " +
        "extension. Returns the gate repo id + paths.",
      inputSchema: {
        type: "object",
        properties: {
          upstream: {
            type: "string",
            description:
              "OPTIONAL upstream URL the gate repo's `origin` should point at. " +
              "Omit to reuse the working repo's existing `origin` URL.",
          },
        },
      },
    },
  ],

  // Hub page declaration (Extension Pages Hub). Declaring the page IS the
  // grant — the tab appears at /hub/ext:ez-code-factory:dashboard once the
  // extension is enabled.
  pages: [
    {
      id: "dashboard",
      title: "ez-code-factory",
      icon: "GitBranch",
      description:
        "Gate runs — one row per `git push gate` intercepted, with branch, " +
        "head SHA, and lifecycle status, refreshed live via a content-free " +
        "page-state SSE signal.",
    },
  ],

  // Settings v0 (M1): per-step auto-fix caps + the gate remote name + review
  // ignore globs + default branch. The KEY NAMES here match exactly what
  // lib/config.ts `resolvePipelineConfig` consumes (gateRemote / defaultBranch /
  // reviewAutofixCap / autofixCap / ignorePatterns), so no knob is silently
  // dead — each is validated + clamped there, falling back to defaults (review
  // cap 0 = always parks, others 3) on absent/invalid values. `SettingsField`
  // only renders scalars (no array/object type), so per-step caps collapse to
  // one review knob + one "other steps" knob and ignore globs are a
  // comma-separated string that resolvePipelineConfig splits. index.ts:120 still
  // uses defaultPipelineConfig(); the live `resolvePipelineConfig(settings)`
  // read is wired in M2. No repo-file config yet — trusted-branch
  // `.no-mistakes.yaml`-equivalent reads land in M3.
  settings: {
    gateRemote: { type: "text", label: "Gate remote name", default: "gate" },
    defaultBranch: { type: "text", label: "Default branch", default: "main" },
    reviewAutofixCap: {
      type: "number",
      label: "Review auto-fix cap (0 = always ask a human)",
      min: 0,
      max: 10,
      default: 0,
    },
    autofixCap: {
      type: "number",
      label: "Auto-fix cap for other steps (rebase/test/document/lint/ci)",
      min: 0,
      max: 10,
      default: 3,
    },
    ignorePatterns: {
      type: "text",
      label: "Review ignore globs (comma-separated, e.g. *.snap, dist/**)",
      default: "",
    },
    // CI monitor idle timeout, declared in HOURS for the UI (resolvePipelineConfig
    // converts to ms: < 0 = unlimited/poll-until-merged, 0/blank = the 7-day
    // default, > 0 = that many hours).
    ciTimeoutHours: {
      type: "number",
      label: "CI monitor idle timeout in hours (-1 = never time out)",
      min: -1,
      max: 720,
      default: 168,
    },
    // The GitHub token the PR + CI steps hand to `gh` (via GH_TOKEN). Stored
    // ENCRYPTED in user Storage under the `github-token` key (never in the
    // settings JSON, never echoed). An env name matching /_TOKEN$/i is refused at
    // install for a `permissions.env` grant — this `type:"secret"` field is the
    // supported path. Needs `repo` + `pull_request` scope to open/update PRs and
    // read checks. See README "GitHub token setup".
    githubToken: {
      type: "secret",
      label: "GitHub token (repo + pull_request scope)",
      description:
        "Personal access token gh uses to open/update PRs and read CI checks. " +
        "Stored encrypted; never shown again. Leave unset to use gh's own " +
        "configured auth (`gh auth login`).",
      storageKey: "github-token",
    },
  },

  permissions: {
    // Self-tracked run/step records (the run history the dashboard renders).
    storage: true,
    // git orchestration (init-gate + per-run worktree lifecycle + the M1
    // pipeline's rebase/commit/push) shells `git`; the M4 pr/ci steps also shell
    // `gh` (GitHub CLI) for PR create/update + CI checks. The `gate` remote's
    // post-receive hook — installed on the gate repo, run by git at push time —
    // is what calls back into the platform.
    shell: true,
    // `gh` reaches the GitHub API. Narrow allowlist — only api.github.com (the
    // v1 GitHub-only scope; GHE hosts are out of scope).
    network: ["api.github.com"],
    // Pipeline agent turns (review, rebase-conflict fix) run as EZCorp-native
    // spawn-assignment sub-agents (decision #2) — host-brokered LLM only, no
    // external CLI. That dispatch requires the spawnAgents grant. Bounded: a
    // pipeline runs its agent turns sequentially, so a small concurrency cap
    // is ample (many parallel gate runs on different branches share it).
    spawnAgents: { maxPerHour: 200, maxConcurrent: 8 },
    // Gate repo + managed hook + credential file all live under
    // <projectRoot>/.ezcorp/extension-data/ez-code-factory/ (a `$CWD`-relative
    // path). Per-run worktrees live under the host-provided per-extension
    // TMPDIR (granted separately by the host), never under the project root.
    filesystem: ["$CWD"],
    // Hub actions via the generic extension-events route: `push-received` (the
    // post-receive hook's trigger), `respond` (the approve/fix/skip/abort gate
    // action), and `yolo` (M2 — auto-approve every remaining gate of a run in
    // one click). Declaring each event both wires the page action and lets the
    // events route accept its POST (the route 404s undeclared events).
    eventSubscriptions: [
      "ez-code-factory:push-received",
      "ez-code-factory:respond",
      "ez-code-factory:yolo",
      // M4: re-check a run parked at the CI gate — a read-only ReconcileApproval
      // Gate poll that auto-resolves the gate when its PR has merged/closed.
      "ez-code-factory:reconcile",
    ],
  },

  resources: {
    memory: "256MB",
  },
});
