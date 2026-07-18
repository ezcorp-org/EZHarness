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
  // The pipeline holds LONG-LIVED in-memory state between host calls: the
  // per-(repo,branch) run mutex and the spawn dispatcher's pending-terminal
  // map (an agent dispatch awaits `task:assignment_update` for up to 10
  // minutes with NO host→subprocess traffic in between). The default idle
  // eviction (5 min after the last host call) would kill the subprocess
  // mid-await — the dispatch's own timeout dies with it and the run is left
  // frozen "running" forever. Must stay resident.
  persistent: true,

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
    {
      name: "code_factory_run",
      description:
        "Trigger a code-factory gate run for the active project's current branch: " +
        "stage the branch into the local gate repo and run the fixed review/test/" +
        "document/lint/PR/CI pipeline, parking for human approval at each gate. " +
        "Pass `intent` to state the goal EXPLICITLY (treated as AUTHORITATIVE " +
        "acceptance criteria the change must satisfy). Omit `intent` and it is " +
        "INFERRED from THIS conversation (a low-confidence hint) — so discuss what " +
        "you want first, then run. CONTRACT: when the run parks on an `ask-user` " +
        "finding, the result carries a `mustRelayVerbatim` flag + the findings — you " +
        "MUST relay those findings to the user verbatim and STOP; never approve on " +
        "the user's behalf. Poll `code_factory_status` and answer with " +
        "`code_factory_respond`. Run `init_gate` once first.",
      inputSchema: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            description:
              "OPTIONAL explicit goal for the change — authoritative acceptance " +
              "criteria. Omit to infer a hint from the current conversation.",
          },
          branch: {
            type: "string",
            description:
              "OPTIONAL branch to run the gate on. Omit to use the project's " +
              "currently checked-out branch.",
          },
        },
      },
      suggestExamples: [
        "run the code factory on my branch",
        "gate this change and review it before pushing",
        "start a code-factory run for what we just built",
      ],
    },
    {
      name: "code_factory_status",
      description:
        "Report a gate run's current state: the pipeline step statuses, the parked " +
        "step, and its findings. Pass `runId` for a specific run, or omit it for the " +
        "most recent run. CONTRACT: when the parked gate has `ask-user` findings the " +
        "result sets `mustRelayVerbatim:true` and lists them under `askUserFindings` " +
        "with a `relayDirective` — relay those findings to the user WORD FOR WORD and " +
        "STOP; do not paraphrase, summarize, or decide for them. `agentDiscretion" +
        "Findings` (auto-fix / no-op) are informational.",
      inputSchema: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description: "OPTIONAL run id. Omit to report the most recent run.",
          },
        },
      },
      suggestExamples: [
        "what's the status of my code-factory run",
        "show the current gate findings",
      ],
    },
    {
      name: "code_factory_respond",
      description:
        "Answer a parked gate: `approve` (accept the step), `fix` (re-run the step on " +
        "selected findings with optional instructions), `skip` (skip the step), or " +
        "`abort` (cancel the run). CONTRACT — NO BLANKET APPROVAL: `approve` and " +
        "`fix` are REJECTED unless you pass the explicit `findingIds` you are acting " +
        "on (proof you surfaced them to the user), or set `consentAll:true` ONLY with " +
        "the user's explicit standing consent. Always call `code_factory_status` and " +
        "relay `ask-user` findings verbatim BEFORE approving anything. Requires the " +
        "`respond-gate` extension RBAC scope (the host refuses it otherwise).",
      // Extension-RBAC ENFORCEMENT (M6): the host denies this tool pre-dispatch
      // unless the acting user holds `respond-gate` — declared in
      // `permissions.rbacScopes` below. Defence in depth alongside the in-code
      // `ctx.rbac.check` guard the Hub respond/yolo actions run.
      rbacScope: "respond-gate",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string", description: "The run to act on (required)." },
          step: {
            type: "string",
            description:
              "The parked pipeline step (intent|rebase|review|test|document|lint|push|pr|ci).",
          },
          action: {
            type: "string",
            enum: ["approve", "fix", "skip", "abort"],
            description: "The gate action.",
          },
          findingIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Finding ids this approve/fix acts on. REQUIRED for approve/fix unless " +
              "consentAll is true.",
          },
          instructions: {
            type: "object",
            description: "OPTIONAL per-finding fix instructions, keyed by finding id.",
          },
          addedFindings: {
            type: "array",
            description:
              "OPTIONAL user-authored findings to merge into a `fix` round — an issue " +
              "the user spotted that the agent missed. Each is a finding object; the " +
              "list length and per-field text are size-capped (over-cap payloads are " +
              "rejected, not truncated).",
            items: {
              type: "object",
              properties: {
                description: { type: "string", description: "What the finding is." },
                action: {
                  type: "string",
                  enum: ["no-op", "auto-fix", "ask-user"],
                  description: "How to treat it (defaults to ask-user when omitted/unknown).",
                },
                severity: { type: "string", enum: ["error", "warning", "info"] },
                file: { type: "string", description: "Repo-relative path the finding is about." },
                line: { type: "number", description: "1-based line, or omit." },
                userInstructions: { type: "string", description: "Guidance for the fix." },
                category: { type: "string" },
              },
            },
          },
          consentAll: {
            type: "boolean",
            description:
              "Set true ONLY with the user's explicit standing consent to clear every " +
              "finding of this gate without naming ids.",
          },
        },
        required: ["runId", "step", "action"],
      },
      suggestExamples: [
        "approve the review gate findings we discussed",
        "fix the findings the user selected",
        "skip the document step on this run",
      ],
    },
    {
      name: "code_factory_doctor",
      description:
        "Run a READ-ONLY health check on the code-factory gate for the active " +
        "project and report each diagnostic: gate initialized?, managed " +
        "post-receive hook installed?, gh CLI available + authenticated?, " +
        "GitHub token set?, default-branch fetch reachable?, and the background " +
        "reconcile sweep's heartbeat. Each check is `ok` (nominal), `warn` " +
        "(degraded but usable — e.g. gh unauthenticated makes pr/ci skip), or " +
        "`fail` (the gate is broken — run init_gate). Mutates nothing. Use it to " +
        "diagnose why a push isn't producing a run, or why pr/ci is skipping.",
      inputSchema: { type: "object", properties: {} },
      suggestExamples: [
        "check the code factory's health",
        "why is my gate not working",
        "run code factory diagnostics",
      ],
    },
  ],

  // Extension-level composer suggestions — surface the code-factory gate as a
  // whole when the user's intent spans it rather than one specific tool.
  suggestExamples: [
    "gate my change through code review before merging",
    "run an automated review/test/lint pipeline on this branch",
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
  // ignore globs + default branch. The KEY NAMES here are snake_case (the
  // manifest's SETTINGS_KEY_REGEX requires it — a camelCase key fails
  // validateManifestV2 and the extension won't install) and match exactly what
  // lib/config.ts `resolvePipelineConfig` consumes (gate_remote / default_branch /
  // review_autofix_cap / autofix_cap / ignore_patterns), so no knob is silently
  // dead — each is validated + clamped there, falling back to defaults (review
  // cap 0 = always parks, others 3) on absent/invalid values. `SettingsField`
  // only renders scalars (no array/object type), so per-step caps collapse to
  // one review knob + one "other steps" knob and ignore globs are a
  // comma-separated string that resolvePipelineConfig splits. index.ts:120 still
  // uses defaultPipelineConfig(); the live `resolvePipelineConfig(settings)`
  // read is wired in M2. No repo-file config yet — trusted-branch
  // `.no-mistakes.yaml`-equivalent reads land in M3.
  settings: {
    gate_remote: { type: "text", label: "Gate remote name", default: "gate" },
    default_branch: { type: "text", label: "Default branch", default: "main" },
    review_autofix_cap: {
      type: "number",
      label: "Review auto-fix cap (0 = always ask a human)",
      min: 0,
      max: 10,
      default: 0,
    },
    autofix_cap: {
      type: "number",
      label: "Auto-fix cap for other steps (rebase/test/document/lint/ci)",
      min: 0,
      max: 10,
      default: 3,
    },
    ignore_patterns: {
      type: "text",
      label: "Review ignore globs (comma-separated, e.g. *.snap, dist/**)",
      default: "",
    },
    // CI monitor idle timeout, declared in HOURS for the UI (resolvePipelineConfig
    // converts to ms: < 0 = unlimited/poll-until-merged, 0/blank = the 7-day
    // default, > 0 = that many hours).
    ci_timeout_hours: {
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
    // supported path. Scopes: a classic PAT needs `repo`; a fine-grained PAT
    // needs Pull requests (write) + Checks (read) + Actions (read). See README
    // "GitHub token setup".
    github_token: {
      type: "secret",
      label: "GitHub token (classic: repo — or fine-grained: PRs write + Checks/Actions read)",
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
    // DECLARATIVE grant — documents that the extension's own code only talks to
    // api.github.com (v1 GitHub-only scope; GHE hosts out of scope). It is
    // enforced by the host ONLY on in-process `fetch`
    // (src/extensions/runtime/network-wrapper.ts); it does NOT constrain the `gh`
    // subprocess, which makes its own calls outside that wrapper and, for
    // `gh run view --log-failed`, follows redirects to non-GitHub object storage.
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
    // action), and `yolo` (the fix-once autopilot — auto-fix each remaining gate
    // once then approve, stopping at any ask-user gate). Declaring each event both
    // wires the page action and lets the events route accept its POST (the route
    // 404s undeclared events).
    eventSubscriptions: [
      "ez-code-factory:push-received",
      "ez-code-factory:respond",
      "ez-code-factory:yolo",
      // M4: re-check a run parked at the CI gate — a read-only ReconcileApproval
      // Gate poll that auto-resolves the gate when its PR has merged/closed.
      "ez-code-factory:reconcile",
      // Platform direct-carrier event (DIRECT_CARRIER_EVENT_TYPES): the
      // terminal status of every `ezcorp/spawn-assignment` sub-agent this
      // pipeline dispatches. WITHOUT this subscription the spawn dispatcher's
      // `registerEventHandler("task:assignment_update", …)` resolver never
      // fires — the host only delivers granted events — so every step's agent
      // dispatch dangles until its 10-minute timeout and the run fails.
      "task:assignment_update",
    ],
    // Custom RBAC scope DECLARATIONS (M6, extension-RBAC layer — inert, NOT a
    // privilege): name the per-extension scopes gating the gate-triage verbs.
    // Granting lives in `extension_rbac_grants` (admins implicitly hold every
    // scope); these declarations make the scopes appear in the grant UI and be
    // checkable from extension code via `ctx.rbac.check(...)` + enforceable via
    // a tool's `rbacScope`. `respond-gate` gates approve/fix/skip/abort (the
    // `code_factory_respond` tool + the Hub respond action); `yolo` is its OWN
    // scope because the autopilot clears every remaining gate of a run — a
    // strictly broader authority than a single approve (M2 review's RBAC note).
    rbacScopes: [
      { name: "respond-gate", description: "Answer a parked gate (approve / fix / skip / abort) from chat or the Hub" },
      { name: "yolo", description: "Run the yolo autopilot — bulk fix-once-then-approve every remaining gate of a run" },
    ],
    // Persistent cron for the background reconcile sweep (M6): every 15 min the
    // host fires `ez-code-factory`'s `Schedule.on(SWEEP_CRON)` handler, which
    // re-checks every checks_passed / CI-parked run and completes the ones whose
    // PR merged/closed. Read-only per run + bounded. The CI step's own poll
    // handles the fast path; this is the coarse catch-up the README promised.
    schedule: {
      crons: ["*/15 * * * *"],
      maxRunsPerDay: 100,
      purpose:
        "Reconcile sweep — poll checks_passed / CI-parked runs and complete the ones whose PR merged/closed.",
    },
  },

  resources: {
    memory: "256MB",
    // The run/respond tools legitimately hold a call open while a review or
    // fix agent runs (the spawn dispatch waits up to 10 min for its terminal
    // update). The DEFAULT 30s ceiling KILLS the subprocess on timeout —
    // destroying the run mutex + pending-terminal map and freezing the run
    // (drive-2 flake). 15 min = dispatch budget + pipeline overhead. The
    // chat tools still self-detach at LIFECYCLE_WAIT_MS as a safety valve
    // below this ceiling.
    callTimeoutMs: 15 * 60_000,
  },
});
