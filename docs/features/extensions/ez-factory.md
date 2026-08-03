# ez-factory — the workflow job console

> _A bundled extension that turns EZCorp's workflow engine into a **job console**: named, saved job definitions over the three `*.workflow.yaml` templates it ships, fired by hand or from chat, with real approval gates and links out to core's run traces._

## Intent

[[workflows]] gives EZCorp a workflow *engine* — a graph you can run. What it does not give you is a place to say "this particular graph, with these particular inputs, on this schedule, called *Refresh the API docs*". `ez-factory` is that missing layer: a saved **job** binds a shipped workflow template to a name, a fixed input set, and a trigger, so running it is one button instead of one re-typed form.

The design bet is that the *definitions* are the valuable part, not another execution engine. `ez-factory` never executes anything itself — it calls `ctx.workflows.run()` and links out to core's `/workflows` run traces and `/workflows/approvals` inbox. It owns the job list, the three tools its templates dispatch to, and an audit log; core owns every run.

Two decisions in the manifest are worth internalizing before reading the code, because both look like preferences and are actually requirements:

- **It must be bundled.** Its `write_file` / `emit_artifact` tools only authorize because the sensitive-capability gate in `src/extensions/permission-engine.ts` short-circuits to allow for bundled extensions (the `bundled-ceiling-auto-allow` branch). `fs.write` *is* a sensitive capability, so for a non-bundled extension the PDP returns `prompt`; a workflow's non-interactive scope rejects a prompt synchronously → `WorkflowApprovalRequiredError` → the run terminalizes `awaiting_approval`. Sited under `docs/extensions/examples/` these tools would be structurally unusable inside a workflow.
- **Shipping a template is not the privileged act; firing it is.** A `*.workflow.yaml` on disk is just an asset. The grant that authorizes running one is `permissions.workflows.names`, and the names there are **bare** — the host prefixes each with `ez-factory:` before resolving, so the wire can never express a host workflow or another extension's.

## How it works

### The three shipped templates

`docs-factory.workflow.yaml`, `etl-factory.workflow.yaml`, and `draft-and-verify.workflow.yaml` ship inside the extension. `src/runtime/workflow-extension-loader.ts` namespaces each to `ez-factory:<name>` before it enters the merged workflow cache. The bare name in the YAML must match `permissions.workflows.names` in `ezcorp.config.ts` **exactly** — the grant is keyed on it.

`docs-factory` is the reference for the engine's harder construct: its `review-loop` is a `kind: "workflow"` step carrying a `loop`, over a child graph that itself contains an `approval`. That combination is built for, not merely tolerated — `nestedOutcome` (`src/runtime/workflow-executor.ts`) branches explicitly on a live child (`suspended`/`running`), so the parent throws `WorkflowSuspendedError(step, "nested-suspended")` and **parks** instead of failing, and `WorkflowRunner` later re-claims and resumes it into the same step. Replay is safe by construction: each iteration is its own child run keyed `nested:<parentRunId>:review-loop#<iteration>`, and `runNestedWorkflow` short-circuits on `findWorkflowRunByIdempotencyKey`, so a parent resumed five times re-serves iteration 1 from its recorded row and pays for it once.

### Data model (`extensions/ez-factory/lib/jobs.ts`)

A `FactoryJob` is `{ id, name, description, workflow, input, trigger, enabled, runAs, consentHash, createdBy/At, updatedBy/At, lastRunAt?, lastWorkflowRunId? }`, persisted through `ctx.storage` at `JOB_STORAGE_SCOPE = "global"` — jobs are **install-wide**, not per-user and not per-project, and the console says so on the page.

- `workflow` is a bare name constrained to `FACTORY_WORKFLOWS`.
- `input` keys are allowlisted **per workflow** by `JOB_SETTABLE_INPUT_KEYS`, and `RESERVED_CONTROL_FLOW_FIELDS` are refused outright.
- Bounds: `MAX_JOB_NAME_LEN` 80, `MAX_JOB_DESCRIPTION_LEN` 500, `MAX_JOB_INPUT_CHARS` 16 384, `MAX_JOB_INPUT_DEPTH` 8, `MAX_RUNS_PER_JOB` 50, `JOB_ID_RE` = `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
- `validateJobDraft` is the **only** way to mint a `ValidatedJobDraft`, a type-only branded `JobDraft`. `createJob`/`saveJob` accept nothing else, so a job's `workflow` or `input` cannot be written without passing the allowlist first. (This is the deliberate divergence from `ez-code-factory`, whose `updateJob(id, patch: Partial<Job>)` merges an arbitrary patch straight into the stored row — a second, unvalidated write path around its own protected-step check.)
- `runAs` and `consentHash` are **written but never read** — forward-compat landing spots for delegated execution and consent hashing. v1 always writes `{kind:"user", id:<creator>}` and `null`.

`JobTrigger` is a union of `manual`, `cron`, `webhook`, `event`, and `workflow` (on another workflow reaching one of N statuses). Cron and webhook triggers are minted at runtime through `ctx.triggers`: the extension supplies a **key** and the host mints `<webhookPrefix><digest>`, so slug collision and forgery are inexpressible rather than merely denied.

### The three tools (`extensions/ez-factory/lib/tools/`)

| Tool | What it does |
|---|---|
| `read_files` | Walk the active project by root + globs. Every returned file is **sanitized** and wrapped in untrusted-data markers. Bounded: depth 8, 500 dirs, 100 files, 256 KB/file, 200 KB total output. Over-bound items land in `skipped[]` with a reason and the call still succeeds — gate on the scalar `skippedCount`/`fileCount`, never on the arrays. |
| `write_file` | Write one file inside the active project. `ifMatch` is an optional compare-and-swap (a prior read's sha256, or `"absent"` to require non-existence). Content over 4 MB is **rejected, never truncated**. |
| `emit_artifact` | Publish a run's work product under `.ezcorp/extension-data/ez-factory/artifacts/<runId>/<name>`. The destination is assembled from validated slugs, so it cannot be steered elsewhere. Derives the run id from the host's conversation coordinate, because the ref language has no `$run.*` root. |

`run_command` and `http_fetch` were deliberately **cut** — the sandbox preload poisons the process-spawn surface and neither had a consumer.

Three properties of `kind: "tool"` steps shape every schema above:

1. `validateWorkflow` rejects any step `input` mapping value that is not a string (`src/runtime/workflow-validator.ts`), so a template literally cannot write `maxFiles: 40` or a YAML array. Every list arg therefore also accepts a newline-separated string, and every numeric arg a numeric string. Over-cap input is still **rejected, never clamped** — a coercion that accepts `"40"` must not become one that accepts anything.
2. Nothing applies `inputSchema.default` at run time, so an unset `$input.x` arrives as `undefined` with its key present. Every optional arg tolerates that; the documented defaults are applied by the **tool**.
3. None of the three declares an `rbacScope`, and that is a decision. `ToolExecutor.executeToolCall` enforces a declared scope against a project **derived from the conversation**, and a workflow tool step runs under the synthetic key `workflow-run:<uuid>` — a conversation row that does not exist and has no project. A scope here would not tighten anything; it would deny every call from inside a workflow, the only place these are called from.

### Untrusted-input framing (`lib/sanitize.ts`)

Everything `read_files` returns passes `sanitizeUntrusted`: `stripAdversarial` removes prompt-control constructs, `redactSecrets` replaces credential-shaped matches with `[REDACTED]`, `neutralizeMarkers` defuses forged `-----BEGIN UNTRUSTED INPUT-----` delimiters in the source text, and `frameUntrusted` wraps the result in the real markers. Read project content is data, never instructions.

### Audit (`lib/audit.ts`)

A bounded, self-pruning log: `AUDIT_BUCKET_CAP` 500 entries/day, `AUDIT_DETAIL_MAX_BYTES` 2048 (over-size detail is clamped, not dropped), `AUDIT_RETENTION_DAYS` 30, day-bucketed by `auditDayKey`. `appendWithCap` writes an `AuditTruncationMarker` rather than silently dropping, and `auditableJobDiff` records only the fields in `DIFFABLE_FIELDS`. Background fires are attributed to `SYSTEM_ACTOR`.

### The two Hub pages (`lib/page.ts`, `index.ts`)

Both pages declare `perProject: true` (see [[hub-pages]]). This does **not** scope the data — jobs are install-wide either way, since storage has no project scope. It scopes the **render context**: a project-hub pull carries `ctx.project`, a global-hub pull carries the project list, so the pages' own hrefs stay inside whichever hub the viewer is in instead of bouncing them to the global one. It also makes `projectId` the page-cache variant, keeping the two href flavours from serving each other's cached tree.

- **`factory`** — the console: saved jobs with status and last run, the shipped templates, and recent runs. It multiplexes sub-views through `?view=` (`parseFactoryView`).
- **`job`** — the single-job editor: name, which shipped workflow it runs, its trigger, its inputs. One Save, one audited diff (`?view=` carries `new` or the job id via `parseJobView`).

The **approvals inbox deliberately does not live here.** `pendingApprovals()` is per-acting-user, while the page cache is keyed `(extensionId, pageId, variant=projectId)` and shared across every viewer — rendering it into the extension tree would hand one user's parked decisions to everyone. The console links to core's `/workflows/approvals` instead (`APPROVALS_HREF`).

## Usage

### As a user

1. Open the **Factory** tab in the Hub (global) or on a project (`/project/<id>/hub/ext:ez-factory:factory`).
2. Create a job in the **Job** editor: pick one of the three shipped workflows, fill the allowlisted inputs, choose a trigger, Save.
3. Fire it from the console, from chat via `![workflow:ez-factory:<name>]` / the `run_workflow` tool (see [[workflows]]), or let its cron/webhook trigger fire it.
4. Follow the run on core's trace at `/workflows/runs/<id>`; answer any parked gate at `/workflows/approvals`.

### REST API

None of its own. `ez-factory` contributes Hub pages and tools; every HTTP surface it uses is core's — `GET/POST /api/hub/pages/[id]`, `POST /api/extensions/ez-factory/events/ez-factory:job-save`, and the `/api/workflows*` family documented in [[workflows]].

### Permissions & RBAC scopes

Granted (and repeated byte-for-byte in `BUNDLED_CEILING`): `storage`, `filesystem: ["$CWD"]`, `triggers` (25 cron / 25 webhook, prefix `factory-`, 500 runs/day), `workflows` (`["docs-factory","etl-factory","draft-and-verify"]`, 60 runs/hour), and the single event subscription `ez-factory:job-save`.

`rbacScopes` declares three console-button scopes — `manage-jobs`, `run-job`, `approve-gate` — queried via `ctx.rbac.check`. These are **declarations, not privileges**: holding one requires an explicit `extension_rbac_grants` row, `intersectPermissions` drops them from every intersection, and the bundled ceiling deliberately carries none. They are **not** attached to any tool and **not** to workflow approval gates: `answerApproval` checks a declared scope at `{projectId: null, extensionId: null}`, which an ez-factory-scoped grant does not cover, *and* declaring one **replaces** the owner check — so the person who created a job could no longer answer their own gate.

## Key files

- `extensions/ez-factory/ezcorp.config.ts` — the manifest: 2 pages, 3 tools, the `triggers`/`workflows`/`filesystem`/`storage` grants, 3 `rbacScopes`, and the long rationale header.
- `extensions/ez-factory/index.ts` — thin wiring only: two `definePage` calls sharing the `job-save` action, `createToolDispatcher(createFactoryToolHandlers(deps))`, `getChannel().start()`.
- `extensions/ez-factory/lib/jobs.ts` — `FactoryJob`/`JobDraft`/`JobTrigger`/`JobStore`, `validateJobDraft` (the sole minter of `ValidatedJobDraft`), the bounds, `diffJob`.
- `extensions/ez-factory/lib/page.ts` — page ids, hrefs (`hubHref`, `runTraceHref`, `APPROVALS_HREF`), `parseFactoryView`/`parseJobView`, cell formatters.
- `extensions/ez-factory/lib/sanitize.ts` — `sanitizeUntrusted` and the untrusted-input marker framing.
- `extensions/ez-factory/lib/audit.ts` — bounded day-bucketed audit log with truncation markers and retention pruning.
- `extensions/ez-factory/lib/tools/` — `read-files.ts`, `write-file.ts`, `emit-artifact.ts`, `shared.ts`, and the `index.ts` handler map.
- `extensions/ez-factory/docs-factory.workflow.yaml` — the reference template (nested workflow step + loop + child approval).
- `extensions/ez-factory/etl-factory.workflow.yaml`, `extensions/ez-factory/draft-and-verify.workflow.yaml` — the other two shipped templates.
- `src/extensions/ez-factory-agents.ts` — the host-side agent definitions the templates dispatch to.
- `src/extensions/bundled.ts` — the `ez-factory` boot entry (`path: "extensions/ez-factory"`; no `bootSpawn` — the console is user-driven, not event-subscription-only).
- `src/extensions/bundled-ceiling.ts` — the `ez-factory` ceiling row; must repeat `webhookPrefix` and all four `triggers` numerics byte-for-byte.
- `src/runtime/workflow-extension-loader.ts` — namespaces each shipped YAML to `ez-factory:<name>`.
- `src/__tests__/ez-factory-bundled-install.test.ts` — exercises the `triggers` install path, previously unexercised by any bundled extension.
- `manifest.lock.json` (repo root) — the shared bundled-extension tamper lockfile; carries the `ez-factory` `version`/`entrypoint`/`toolsHash` row.
- `packages/@ezcorp/sdk/src/runtime/workflows.ts` — `ctx.workflows`: `run()`, `runs()`, and the per-acting-user `pendingApprovals()` the console deliberately links to rather than renders.

## Features it touches

- [[workflows]] — the engine `ez-factory` is a console over; it runs nothing itself and links out to core's run traces and approvals inbox.
- [[hub-pages]] — its two `perProject: true` pages and the single `ez-factory:job-save` page action.
- [[bundled-catalog]] — the boot entry and the capability ceiling that bounds it; bundling is load-bearing, not a packaging choice.
- [[permissions-and-grants]] — the `bundled-ceiling-auto-allow` branch is what lets `fs.write` authorize inside a non-interactive workflow scope.
- [[scheduling-and-loops]] — cron and webhook job triggers are minted through `ctx.triggers`, with host-minted slugs.
- [[data-and-entities]] — jobs live in `ctx.storage` at global scope; artifacts land under `.ezcorp/extension-data/ez-factory/artifacts/`.
- [[rbac-and-permission-modes]] — the three `rbacScopes` are per-extension grant declarations checked via `ctx.rbac.check`.
- [[ez-code-factory]] — the *other* factory: an installable example extension gating `git push`, unrelated to this one beyond the name.
- [[audit-and-observability]] — job edits and fires write to the extension's own bounded audit log, distinct from the platform audit trail.
- [[mention-grammar]] — a job's workflow is reachable from chat via the `!` sigil's `workflow` kind.

## Related docs

No standalone spec exists; this file is the primary reference. The manifest header in `extensions/ez-factory/ezcorp.config.ts` and the module headers in `lib/jobs.ts` / `docs-factory.workflow.yaml` carry the decision rationale in full.

## Notes & gotchas

- **`ez-factory` ≠ `ez-code-factory`.** Two different extensions with confusingly similar names. `ez-factory` (this doc) is **bundled**, a job console over workflows. `ez-code-factory` ([[ez-code-factory]]) is an **example** extension that intercepts `git push gate <branch>`. They share no code.
- **Background fires are refused, not broken.** A cron or webhook fire is ownerless, and `ctx.workflows.run()` fails `-32106` without an acting user (`src/extensions/workflows-handler.ts`). A job that fires and silently starts nothing is worse than a job that cannot be created, so the refusal is deliberate and loud.
- **The ceiling row must repeat `webhookPrefix` byte-for-byte.** `intersectPermissions` does not intersect or merge a namespace claim — when the two sides disagree it **drops the whole `triggers` grant, silently, at boot**. All four numeric fields are likewise required on the granted shape: a missing numeric makes `Math.min(NaN, …)` and kills the grant the same silent way.
- **Editing `tools` OR `permissions` requires regenerating the repo-root `manifest.lock.json` in the same commit** (`bun run scripts/regenerate-manifest-lock.ts`; the lock is one shared file keyed by extension name, not a per-extension file). The permissions half is not obvious: the lock hashes `manifest.tools`, and a tool that declares no `capabilities` of its own **inherits** one derived from the permissions block, so adding `eventSubscriptions` rewrites every tool's canonical form and moves `toolsHash` without a character of the `tools` array changing. The host then logs `reason: "tool-list drift"`, which points at the one thing that did not drift. A stale lock does not fail on first install — it fails on the **next** boot, fail-closed with `enabled: false`, so the extension looks perfect and then silently disables itself.
- **Exactly one page action, on purpose.** Every page action is attack surface on a tree that is **shared across users**, so v1 buys only the one that makes the console writable (`ez-factory:job-save`). Retire a job with `enabled: false` rather than deleting it. Adding a second action means adding it to the manifest, the bundled-ceiling row, **and** the install grant in `src/extensions/bundled.ts` — all three, or `intersectPermissions` drops what any two disagree on.
- **A dropped action fails silently, not loudly.** `validatePageTree` validates every action against `allowedEvents` (derived from the runtime grant's `eventSubscriptions`; empty ⇒ `[]`), and a `form`/`button`/table row whose action fails the check is **dropped from the tree** — not rendered disabled, not an error. The page renders, looks complete, and has no Save. The POST route independently 404s via `isRegisteredExtensionEvent`.
- **`runAs` and `consentHash` are inert.** Both are written and never read. Reading either to make a decision today would be inventing a capability that does not exist — delegated execution and consent hashing are unbuilt.
