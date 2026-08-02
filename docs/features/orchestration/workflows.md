# Workflows

> _Declarative graphs that orchestrate a mix of **agent** steps (invoke one agent), **tool** steps (invoke one deterministic extension tool), **transform** steps (pure, declarative data reshapes — no LLM, no I/O), **gate** steps (assert a declarative condition), **approval** steps (park the run for a human and continue once they answer), and **workflow** steps (run a nested definition as a first-class child run). Any step may declare a **`when`** guard that skips it — and its dependents — without failing the run. Any agent/transform/workflow step may **loop** with a bounded until-condition. The executor topo-sorts steps into parallel batches with fail-fast, loud-failure semantics; a parked run is **durable** — it records a cursor, survives a restart, and is resumed by the `WorkflowRunner` daemon._

## Intent

A workflow is a named, reusable graph of steps. Where a single `@agent` run answers one prompt, a workflow chains steps: step B can depend on step A and consume A's output. Workflows are the renamed, extended successor to the old **pipelines** subsystem — they exist as a **separate subsystem from teams** (no per-member tool-scoping, no team roster). They are defined (in YAML or the DB), listed, and fired through a small REST surface, a dedicated `/workflows` UI, and — since the chat path landed — a `!workflow:` mention plus the `run_workflow` tool (see **The chat path** below). The runner is intentionally thin: topo-sort, fan out each batch with `Promise.all`, thread prior outputs into dependents, emit SSE events, halt loudly on the first failure.

Three design constraints are load-bearing (not stylistic):

1. **Hard rename, no API aliases.** This is a self-hosted, versioned product, so every in-repo caller was updated. The only compatibility kept is a hidden CLI alias (`ezcorp pipeline …` → `ezcorp workflow …`) and a legacy YAML glob (`*.pipeline.yaml` still loads, with a deprecation warning) — both for one release.
2. **No arbitrary code steps.** DB workflows are creatable by any `chat`-scoped caller, so deterministic steps must be **declarative** (a mapping/condition DSL), never evaluated JS. This is a security constraint.
3. **Loud failure.** Loop exhaustion fails the run by default, gates throw with a descriptive message, and nothing silently truncates.
4. **A parked run is alive, not dead.** An `approval` step suspends the run at a step boundary and records where to pick up (`suspended`), which is the one non-terminal, non-`running` status. It is deliberately NOT the older `awaiting_approval`, whose meaning is unchanged — *parked and dead* (`src/types.ts:303-307`, `src/runtime/workflow-executor.ts:109-131`).
5. **Skipping is not failing, and it is not a licence to break rule 3.** A false `when` skips a step and the run still succeeds — but a downstream `$steps.<skipped>` still throws, because handing a step a value nobody produced is exactly the silent wrong answer rule 3 exists to prevent. The definition-time skip/ref rule is what makes that throw unreachable in practice.

`kind` defaults to `"agent"`, so **every legacy pipeline definition (YAML or DB row) remains valid with zero edits.**

## How it works

### Data model (`src/types.ts`)

- `WorkflowDefinition` = `{ name, description, inputSchema?, defaultModel?, steps, source? }`. `source` is `"extension" | "yaml" | "db"` — the provenance stamp applied by whichever loader produced the definition, never read from the asset's own content. It is optional: a hand-built definition (a test, an ad-hoc caller) carries none.
- `WorkflowStep` = `{ name, kind?, agent?, tool?, workflow?, input?, retries?, output?, condition?, when?, skipDependents?, model?, dependsOn?, loop?, prompt?, choices?, rbacScope?, formSchema?, requireItemConsent?, itemsRef?, timeoutMs?, onTimeout? }`. `kind` is one of `"agent" | "tool" | "transform" | "gate" | "approval" | "workflow"` (default `"agent"`).
  - **agent** — `agent` is an agent name resolved by `AgentExecutor`; `input` is a `Record<string,string>` of input mappings; `retries` is a per-step retry budget (clamped 0..2); `model` is a per-step model binding (see **Per-step model bindings**).
  - **tool** — `tool` is a runtime-namespaced extension tool (`<extension>__<tool>`, e.g. `extension-author__create_extension`) dispatched through `ToolExecutor.executeToolCall`. `input` uses the **same** ref language as an agent step (there is deliberately no second grammar). `agent` is forbidden; `loop` is forbidden (see gotchas).
  - **transform** — `output` is a `Record<string,string>` output mapping (same ref language as inputs, plus `{{…}}` template interpolation). Pure: no LLM, no I/O, no clock.
  - **gate** — `condition` is a `WorkflowCondition` tree.
  - **workflow** — `workflow` names a **nested definition**, resolved through the same merged cache (and the same authorization ladder) the run route uses. It is a **LITERAL name, never a ref** — see **Composition**. `input` uses the same ref language; the child's terminal `result` becomes the step's result. `agent`/`tool` are forbidden. `loop` **is** allowed.
  - **approval** — parks the run for a human. `prompt` (required) is the question; `choices` (required, non-empty, unique, non-blank strings) is the answer set; `rbacScope` names a permission that gates answering; `formSchema` collects structured fields alongside the choice; `requireItemConsent` + `itemsRef` demand the answer name the items it acts on; `timeoutMs` / `onTimeout` (`"abort" | "approve" | "skip"`, default `abort`) bound how long the run parks and what happens when it stops — applied by the `HostMaintenanceDaemon` sub-tick (`src/runtime/workflow-approval-timeout-sweep.ts`), see gotchas. `agent`/`tool`, `retries` and `loop` are all rejected on it (`src/runtime/workflow-validator.ts:214-266,326`).
- `WorkflowCondition` = a leaf `{ ref, op, value? }` or a composite `{ all: [] } | { any: [] } | { not: … }`. Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `exists`, `truthy`.
- `LoopConfig` = `{ maxIterations, until?, onExhausted? }` — `maxIterations` is **required** (server-clamped 1..25); `until` is a `WorkflowCondition` evaluated after each iteration; `onExhausted` is `"fail"` (default) or `"pass"`.
- `WorkflowRun` = `{ id, workflowName, projectId?, status, startedAt, finishedAt?, steps: WorkflowStepRun[], result? }`; `WorkflowStepRun` = `{ stepName, runId, status, iterations?, provider?, model?, skippedReason? }` (`iterations` is the final count for a looped step; `provider`/`model` are the binding the step's LLM call **resolved** to; `skippedReason` explains a `skipped` step). `status` is `WorkflowRunStatus` = the agent `AgentStatus` union **plus `awaiting_approval`, `suspended` and `skipped`**. `skipped` is a **step** status only — a *run* never terminalizes it, which `TerminalWorkflowRunStatus` states in the type system.
- `WorkflowCursor` = `{ batchIndex, completedSteps, prevStepName }` — where a parked run picks up. `prevStepName` is **recorded, not recomputed**, so a resumed run reproduces the same order-fragile `$prev` the straight-through run saw rather than a graph-deterministic one (`src/types.ts:339-353`).
- `WorkflowRunPhase` = `"boundary" | "in-batch"` — which side of a step boundary the executor was on when it last wrote. Written strictly (never through the swallow-on-error telemetry path), so crash recovery never guesses (`src/types.ts:309-321`).
- `ApprovalStepOutput` = `{ choice, form, itemIds, answeredBy, answeredAt }` — what an answered `approval` step contributes to `$steps`. **Every field is always present** (`form: {}`, `itemIds: []`) because refs resolve strictly: a downstream `$steps.<gate>.output.form` must not throw just because this answer carried no form (`src/types.ts:226-237`, `src/runtime/workflow-executor.ts:1483-1489`).
- `ModelOverride` = `{ provider?, model?, temperature?, maxTokens?, effort? }` — a **resolved** binding (every value concrete). `WorkflowModelBinding` is the same shape as **written in a definition**, where the string fields may be refs, so `effort` widens to `string`.
- The DB table `workflow_definitions` (`src/db/schema.ts`) stores `id` (UUID PK), `name` (unique), `description`, `inputSchema` (jsonb), `defaultModel` (jsonb, nullable), `steps` (jsonb), the ownership columns `project_id`/`user_id`/`visibility`/`forked_from`, and `createdAt`/`updatedAt`. A migration renames the legacy `pipeline_definitions` table in place (data preserved).

### Loading & the in-memory cache (`workflow-loader.ts` + `context.ts`)

Workflows come from **three sources, merged into one in-memory array** at boot:

1. **Extension assets** — `loadExtensionWorkflows()` (`workflow-extension-loader.ts`) globs `*.workflow.yaml` at the root of each installed extension's **own install path** (`ExtensionRegistry.getInstallPath` — deliberately NOT the host's agents dir) and renames every definition to **`<extensionName>:<declaredName>`**. See **Extension-shipped workflows** below.
2. **YAML** — `loadYamlWorkflows(dir)` globs both `*.workflow.yaml` and the legacy `*.pipeline.yaml` (deprecation warning on the latter) in the agents dir (`resolveAgentsDir()`, overridable via `EZCORP_AGENTS_DIR`, default `src/agents/`), parses each with the `yaml` package, and runs the shared `validateWorkflow`; any invalid file is skipped with a warning (warn-and-continue, never throws).
3. **DB** — `loadDbCachedWorkflows()` (`src/db/queries/workflows.ts`) maps every `workflow_definitions` row to a `CachedWorkflow`. (`loadDbWorkflows()` still returns bare definitions and is retained for the CLI, which has no auth context at all.)

`context.ts`'s `buildWorkflowCache()` concatenates them: `workflows = [...extensionWorkflows, ...yamlWorkflows, ...dbWorkflows]` (ONE definition, shared by boot and by every CRUD-triggered `reloadWorkflows()`). There is still no de-duplication — lookup is `find(w => w.name === name)`, so the **first** entry wins a name. Extension entries go first so a `workflow_definitions` row a `chat`-scoped user deliberately named `some-extension:deploy` cannot hijack that extension's asset.

**Each loader stamps `source` itself, always AFTER the parsed object.** The extension loader spreads the parsed YAML and then sets `source: "extension"`; the YAML loader assigns `def.source = "yaml"` unconditionally (not `??=`); `loadDbWorkflows` projects `source: "db"`. Provenance is therefore a property of *which loader produced the definition*, never of the asset's content — a YAML file that declares its own `source:` key has it overwritten, so it cannot relabel itself into a different authorization rule. Both loaders have a test asserting exactly that.

The cache holds **`CachedWorkflow`** entries — `{ definition, source, id, projectId, userId, visibility, forkedFrom }` — not bare definitions. `getWorkflows()` still returns `WorkflowDefinition[]` for every pre-existing caller; `getCachedWorkflows()` returns the wrapped entries and is what authorization consumes. YAML and extension entries are wrapped as `system` with `id: null`: they ship with the install, not with a project.

### Ownership and authorization (`workflow-scope.ts`)

`WorkflowDefinition` is the shape of the **graph** and carries no provenance — it is shared by YAML and extension workflows that have no owner, by `runWorkflow`, by the CLI and by `validateWorkflow`. `loadDbWorkflows` used to project each row into it and **drop `id`**, so by the time a route held a workflow it knew only the name and the steps: there was nothing to authorize against. Adding owner *columns* alone would not have changed that.

So authorization lives in the **lookup**, not the route. `resolveWorkflowForCaller(entries, name, caller, action)` does both, and every consumer routes through it (the REST handlers reach it via `web/src/lib/server/workflow-access.ts`). `workflow-route-ladder.server.test.ts` asserts structurally that no route under `routes/api/workflows/**` compares a `visibility` itself.

| `visibility` | `project_id` | `user_id` | Who may **read/run** | Who may **edit/delete** |
|---|---|---|---|---|
| `system` | NULL | NULL | any `chat` caller — today's behaviour | admin only |
| `project` | set | set (creator) | project members | creator + admin |
| `private` | optional | set | owner + admin | owner + admin |

**`read` and `run` are asked as separate questions.** They share a rung today, but a workflow a caller may *see* is not automatically one they may *fire*; C3 (delegated execution) narrows `run` without touching a call site. Pinned by *"read and run are separate questions — a readable workflow is not automatically runnable"* in `workflow-scope.test.ts`.

**An unauthorized read is a 404, not a 403**, so the endpoint is not an existence oracle. A denied *edit* is a 403 — the caller can already see the workflow, so there is nothing left to conceal.

> **`project` is not a confidentiality boundary today.** This platform has no project-membership model: `projects` has no owner column, there is no `project_members` table, and `GET /api/projects` returns every project to every authenticated caller. `isProjectMember()` therefore returns true for any principal carrying a user identity, which makes `project` an **edit boundary and a label**. `private` is the one real confidentiality boundary in this phase. The predicate is a named single-call-site function precisely so that the day membership lands, its body is the only thing that changes.

### Definition versions (`workflow-versions.ts`)

`workflow_definition_versions` records an immutable snapshot of a definition's **executable content**. `workflow_runs.definition_version_id` names the snapshot a run executed, and only ever one it really did — see *"a run only claims a version whose content it actually executed"* below. `definition_hash` is always the hash of the graph that ran; `versionStepsHash` delegates to the same `workflowDefinitionHash` the runtime writes, so whenever a version *is* claimed the two are the same value and **cannot disagree with each other** — that is the whole of what the identity buys. Both are recorded at run start, so both can still disagree with what a *resume* would execute after an edit; neither is a guard by being written.

> **The precedence is a contract, not yet a mechanism.** `definition_version_id` is meant to be authoritative, with `definition_hash` read only when the version id is NULL (a pre-versioning run, a YAML/extension workflow with no row to version, or a graph whose content matched no version). **No code implements that rule today.** This phase writes both fields and reads neither for drift: `definition_version_id` is consulted only by the retention sweep and the trace label, and C4's resume compares `definition_hash` **unconditionally**, ignoring the version id — so the hash is currently the only drift guard that fires. Adopting the precedence is C4's resume path's job; it is stated here so whoever does it inherits an answer instead of inventing a second one.

A version is minted **only** when `steps`, `input_schema` or `default_model` changes. A description edit mints nothing; neither does a rename (the name is recorded *on* the version, so a rename becomes visible at the next minted version rather than rewriting history). This matters because C3's consent hash pins a version: minting one on a typo fix would suspend every delegated job for re-consent over prose, which trains users to click through.

**A run only claims a version whose content it actually executed.** The executor resolves the definition row by NAME, and a name does not identify a graph: extension and YAML entries win a name in the cache, and `updateWorkflow` + `ensureWorkflowVersion` are two writes with no transaction around them. So the run compares the hash of the graph it was **handed** against the newest version's `steps_hash` and records `definition_version_id` only on a match — otherwise NULL. `definition_hash` is always the hash of what ran, so a resume compares against the right graph. Pinned by *"a graph shadowing a DB row by NAME records NO version, not the row's"* in `workflow-run-persistence.test.ts`.

**No backfill for historical runs** — `definition_version_id` stays NULL for every run created before versioning, and the trace renders "version unknown (pre-versioning)" rather than inventing one. NULL therefore means exactly one thing everywhere: *we cannot name the snapshot this run executed*.

Retention runs as a daily sub-tick on `HostMaintenanceDaemon`: keep every version a surviving run references, every version named in `pinnedVersionIds`, plus the most recent 50 per definition. C3 supplies its non-revoked delegation ids through `pinnedVersionIds` — the sweep **excludes** them from the delete set rather than attempting a delete and catching the FK's `ON DELETE RESTRICT`, because making the database error the control flow is backwards.

`pinnedVersionIds` is a **required** field, and that is load-bearing rather than fussy: the only production caller is that daily sub-tick, inside a `try/catch` that logs `warn` and carries on. A C3 that forgot to supply its pins would turn the RESTRICT violation into a log line and stop the sweep reaping — permanently, silently, from a call site no test can observe. Requiring the field makes the omission a compile error at every call site, including ones not written yet; `[]` is how you say "nothing is pinned". Pinned by *"pinnedVersionIds is REQUIRED, so a caller cannot forget it silently"* in `workflow-versions.test.ts`, whose `@ts-expect-error` fails `typecheck` if the field is ever made optional again.

### Dry run (`workflow-dry-run.ts`)

A dry run evaluates `transform` and `gate` steps **for real** and stands a stub in for every other kind. "Zero side effects" is **structural**, not conventional — three guarantees, none of which depends on a skip list staying correct:

1. the `toolRunnerFactory` **throws**, so a tool step that reaches dispatch fails loudly;
2. the `AgentExecutor`'s `runAgent` **throws**, so zero LLM is a property of the object graph;
3. `persist: false` is asserted explicitly, so no `workflow_runs` row is written.

Substitution hangs off `WorkflowExecutorOptions.stepSubstitute`, consulted at the top of `runStep` **before** the loop branch and the kind dispatch — so it is kind-agnostic and C7's `workflow` step will be stubbed by default rather than executed by a stale deny list. `isPureDryRunKind` is an **allow** list for exactly that reason.

Two honest limits, surfaced in the editor rather than left to be discovered:
- Refs into a stubbed step resolve to a path-answering stub (the ref resolver is strict, so a plain `{}` would fail every real graph at its first `$steps.<agent>.output.<field>`). A dry run therefore **cannot** validate a ref into an `agent`/`tool` result — only refs into steps it actually evaluated.
- A `gate` whose operands are stub-derived is **evaluated but not enforced**. The stub answers every path, so `exists`, `truthy`, `neq` and `not(eq)` — the commonest shapes over an agent's output — all hold against it, and `eq` against a literal never does; both answers are about data nobody produced. So the verdict is recorded in `gatesOnStubs`, the step reports `mode: "evaluated-on-stubs"`, the run **continues** (the rest of the graph is still worth checking), and the report's status is `unverified` rather than `success` — which the editor renders amber, with the unenforced verdict named. Taint is deep and transitive: a stub laundered through a `transform`, or through an earlier unenforced gate's own result, still leaves the gate unenforced. A gate over deterministic operands (`$input.*`, a transform over real data) is enforced exactly as built, and that is the half a dry run can actually prove.

### Fork (`workflow-fork.ts`)

Forking clones a workflow the caller can **read** into an editable, project-scoped row they own. `WORKFLOW_NAME_RE` excludes `:`, which is what makes extension namespacing structural — so a fork **cannot** keep a namespaced source name and takes the **bare** half (`ez-factory:docs-factory` → `docs-factory`). On collision with the global unique index the route suffixes `-2`, `-3`, … and returns the **final** name so the UI can show it. A fork of a fork is an ordinary DB→DB clone through the same rule; `forked_from` records the *immediate* parent as a **string snapshot, not an FK** (the source is often an extension asset with no row, and the extension may be uninstalled later). A fork never widens the original.

### Extension-shipped workflows (`workflow-extension-loader.ts`)

An installed extension may ship `*.workflow.yaml` files at the root of its install directory; they appear in `GET /api/workflows`, on `/workflows`, and run through the same `POST /api/workflows/[name]/run` route as everything else — which re-checks that the owning extension is still installed and enabled before running one (rule 1 in **Run & manage authorization**). Shipping one is an **asset**, not a permission (like declaring a tool) — *triggering* one from extension code is the privileged act, gated by `permissions.workflows`.

Namespacing is the load-bearing security property. Without it an extension could ship a workflow named `demo-deterministic` and silently shadow the host's in the un-de-duplicated cache. Two rules make that impossible:

- Every definition is renamed `<extensionName>:<declaredName>` before it enters the cache — the declared name is never used verbatim.
- A declared name carrying the `:` separator is **rejected** (warn + skip), so an extension can neither forge another extension's namespace nor produce an ambiguous prefix.

Extension names are admit-time-validated against `/^[a-z0-9][a-z0-9-_.]{0,63}$/` (no `:`), so a namespaced name always carries exactly one separator and can never equal a bare host name. The grammar for both halves lives in exactly one place — `src/runtime/workflow-name.ts` (`WORKFLOW_NAME_RE`, `EXTENSION_WORKFLOW_SEPARATOR`, `namespacedWorkflowName`, `isValidWorkflowName`) — shared by the loader, the manifest validator, the permission clamp and the reverse-RPC handler so they cannot drift.

Each file is validated with the same shared `validateWorkflow`; invalid files, unparseable YAML, bad names, unreadable install dirs and intra-extension duplicate names are all **warn-and-skip**. The loader never throws — a broken asset in one extension must not take down boot or block a later extension.

### Run & manage authorization (`workflow-authz.ts`)

One module holds the rules for every caller that can trigger or mutate a workflow, so the REST path and any future caller cannot drift into two different answers for the same action. It exports two things:

- `canRunWorkflow(workflow, principal)` → `Promise<{ allowed: true } | { allowed: false; reason: string }>` — the full decision for a run.
- `canActOnWorkflow(createdBy, principal)` → `boolean` — the owner-or-admin primitive, called directly by `PUT`/`DELETE` (which already hold the row) and delegated to by rule 2 below. The *rule* is shared; each call site phrases its own denial message, because "can update it" and "can delete it" are not the same sentence.

**The three rules**, checked in an order that mirrors `buildWorkflowCache`'s `[...extension, ...yaml, ...db]` precedence. The order is load-bearing where the rules overlap: a `workflow_definitions` row named `some-extension:deploy` matches both rule 1 and rule 2, and extension-first is the only order consistent with how the cache resolves that name — so a disabled extension denies the run even when the caller owns the row.

1. **Extension-namespaced** — a name carrying the `:` separator with a non-empty prefix claims an extension namespace, and that extension must still be installed **and** `enabled === true`, read live from `extensions` via `getExtensionByName`. Ownership does not apply; an extension asset has no `created_by`. (A leading separator names no extension and falls through — `namespacedWorkflowName` can never produce one, since extension names are admit-time-validated non-empty.)
2. **DB workflow** (`source === "db"`) — owner-or-admin. `created_by` is read live from the row: `createdBy === user.id || user.role === "admin"`. A NULL owner is unowned and allows.
3. **Everything else** — YAML, host, hand-built, unknown source — unchanged: any caller that got past the route's scope gate.

Four details are load-bearing:

- **Rule 1 is not a formality — it closes a real staleness window.** `reloadWorkflows()` fires only on workflow CRUD; it is never called on extension install, uninstall, or disable. So disabling an extension leaves its workflows sitting in the in-memory cache, fully runnable, until somebody happens to write a workflow or the process restarts. The live DB re-check is what actually stops them. For the same reason the check reads the `extensions` table and **not** `ExtensionRegistry.getAllManifests()` — the registry is an in-memory snapshot with exactly the staleness problem this check exists to close. Note also that `getExtensionByName` does not filter on `enabled`, so the helper tests that field explicitly.
- **Rule 1 dispatches on the NAME, not on `source`.** That is strictly the stronger test: `source === "extension"` implies a separator (`namespacedWorkflowName` always inserts one), so the name test subsumes it — and it additionally catches a `workflow_definitions` row squatting on `some-extension:deploy`, which would otherwise slide through as an ordinary DB workflow the moment that extension is uninstalled. Cache ordering stops such a row from *shadowing* the real asset; this stops it from *outliving* it.
- **Pass the RESOLVED definition, never a re-lookup by name.** Callers hand `canRunWorkflow` the object they pulled out of the merged cache — the one the executor will actually run. Re-looking the name up in the DB would be wrong: on a YAML/DB name collision both entries exist and YAML wins execution, so a by-name lookup would gate the DB row while the executor ran the YAML one. This is also why `source` had to be a stamped field rather than something inferred from a DB query.
- **Admin is `role === "admin"`, compared directly — deliberately not `checkRole`.** That middleware helper also demands the `admin` API-key *scope*, so it would reject a cookie-authed admin on these `chat`-scoped routes, and it returns an HTTP `Response`, which is meaningless to a non-HTTP caller.

**Enforcement lives at the call sites, never inside `WorkflowExecutor.runWorkflow`.** The CLI (`src/cli.ts`) runs workflows with no principal at all and is documented as auth-free (a local operator tool); an authorization check in the executor would break it instantly. The executor's contract is "run this definition", not "decide who may". The module is likewise registry-free — it knows nothing about the live executor or the workflow cache — so it stays unit-testable and importable from both a SvelteKit route (via the `$server` alias) and the runtime.

**`created_by` and why the migration is not breaking.** The column is nullable, added by `ALTER TABLE … ADD COLUMN IF NOT EXISTS` near the end of `migrate()` — `workflow_definitions` is created long before `users` exists, so an inline FK at the CREATE would have no target. There is **no backfill**: NULL means "unowned legacy / global workflow", so every row that predates the column keeps exactly today's behaviour (any `chat` caller may run, update and delete it). Copying the first-admin backfill CTE used for conversations and memories would instead have retroactively handed every existing workflow to one admin and locked everyone else out. `ON DELETE SET NULL` means a departed author's workflow degrades to global rather than vanishing. Only `POST /api/workflows` records an owner, from the already-required principal.

### The chat path — `!workflow:` + `run_workflow`

**Reference and execution are split on purpose.** The mention grammar carries a bare name and nothing else, while a workflow takes arbitrary JSON matching its `inputSchema` — a token cannot express input. So `![workflow:<name>]` only *describes*, and a separate tool *runs*.

**`![workflow:<name>]` — the reference.** A 6th mention KIND under the existing `!` sigil (not a 6th sigil; the sigil count is unchanged — see [mention-grammar](../composer/mention-grammar.md)). `applyWorkflowExpansion` (`mention-wiring.ts`) emits one system-note block per resolved workflow carrying its name, description and `inputSchema` as plain-text bullets, so the model knows the workflow exists and what input it takes. It follows the feature/lesson passes exactly: resolver-injected, parses the ORIGINAL message, never re-parses its own output, never modifies the user-visible text (the raw token survives in the persisted message), and an unknown name is a silent no-op.

**`run_workflow` — the execution.** A built-in wired per turn by `wireRunWorkflowIfEligible` (`stream-chat/setup-tools.ts`). Its schema has exactly **two** fields, `name` and `input`: every RBAC coordinate (`userId`, `conversationId`, `projectId`) comes from the turn closure, never the tool arguments — an argument is LLM-controlled, and letting the model choose its own principal is letting it choose its own authorization. It calls the **same `canRunWorkflow`** described above, on the definition resolved out of the merged cache, so the chat path and the REST path cannot disagree. The acting user's `role` is read from the DB (`getUserById`), not carried on the turn; a vanished user row fails closed. Denials surface as a normal tool error card carrying the helper's reason.

Two wire-time gates, both security-relevant:

- **Depth 0 only** — skipped entirely when `orchestrationDepth > 0`. A workflow's `agent` step runs an agent turn; if that turn were itself wired with `run_workflow`, a graph could recurse without bound inside a single chat turn. Worse than the recursion: one *"always allow for this conversation"* click would then auto-approve every sensitive step of every nested run. The user's own turn is the only place the tool belongs.
- **Owned conversations only** — the acting principal is the conversation OWNER (`convRecord.userId`). An ownerless row is skipped with a warning rather than run as nobody.

Both gates fail soft: a failure degrades to a turn that cannot run workflows, never a 500.

`RUN_WORKFLOW_CALL_TIMEOUT_MS` is **10 minutes**, matching `shell` — a workflow is a graph of agent turns and would otherwise be reaped by the 90 s undeclared-built-in default mid-run. Time spent waiting on a consent card does **not** burn it: an open gate registers in `pendingPermissions`, which the watchdog defers on indefinitely.

#### Interactive approval mode

`runWorkflow`'s options object takes an optional `conversationId`. Supplying it means **interactive**; omitting it reproduces the previous fail-closed path byte for byte.

| | Non-interactive (REST, CLI, extension RPC, boot sweep) | Interactive (`run_workflow`) |
|---|---|---|
| `conversationId` | synthetic `workflow-run:<runId>` | the REAL conversation id |
| Non-interactive scope | registered | **none** — that absence *is* the mode |
| Sensitive step | PDP `prompt` refused synchronously | gate parks; the user's consent card resolves it |
| Terminal state | `awaiting_approval` | `success` / `error` — `awaiting_approval` is **unreachable** |
| `tool_calls` row | dropped (FK has no conversation) | written |

Three details are load-bearing:

- **A user DECLINE is a normal step failure, not `awaiting_approval`.** The interactive scope stub's `takeDenial()` always returns `undefined`, so a decline falls into `runToolStep`'s generic failure branch and terminalizes the run `error`. That is correct: `awaiting_approval` means "blocked on a human we cannot reach", which is by construction impossible when a human was reached and said no.
- **An empty-string `conversationId` is deliberately NOT interactive.** It would fail the SSE ownership filter *open*, so it falls back to the synthetic key.
- **Interactive mode cannot be laundered.** The stub never CLEARS an outer non-interactive scope, so a REST/CLI run whose agent step reaches back into a chat still has the outer scope live in `AsyncLocalStorage` and the inner gate is refused.

#### Deliberate decisions

- **Referencing is NOT authorization-filtered — enforcement is at the run boundary.** The mention resolver (`build-prompt.ts`) does a bare cache lookup with no `canRunWorkflow` call, and the note carries the description AND `inputSchema` for any caller. This is a choice, not an oversight. Filtering here would make an unauthorized reference expand to nothing, indistinguishable from a typo, giving the user no feedback at all; letting it through means the denial arrives at the point of action as a visible error card. `inputSchema` stays for the same reason — without it the model cannot compose a run, so a reference the user IS allowed to act on would be useless. **Accepted residual gap:** a caller can read a description + input schema for a workflow they cannot run, and because the mention rides a `chat`-scoped route while `GET /api/workflows` requires `read`, a `chat`-only API key can obtain workflow metadata that listing would refuse it. Referencing is a weaker gate than listing. The consequence is that the sanitisation below is the only thing between an attacker-controlled description and a forged instruction — do not weaken it.
- **Per-turn caps: 5 expansions / 8 KiB of joined text**, applied after dedupe, and the count cap is applied BEFORE resolution so a 100-token paste-bomb still costs exactly 5 lookups. `inputSchema` is unbounded and workflows are globally writable by any `chat`-scoped caller, so a paste-bomb of mentions would otherwise be a cheap way to crowd out the context window. The budget bounds the author-supplied blocks; the fence and preamble are host text and are not charged. Overflow uses **skip**, not stop — one oversized workflow drops itself and the rest still render. (The lesson pass deliberately keeps `stop` to preserve its long-standing behaviour.)
- **`run_workflow` is absent from `getBuiltinToolDefs()` and from `/api/tools`.** Same reason as the Ez tools: it is a per-turn factory over per-USER context (`userId`, `conversationId`, `projectId`) and needs no project root, so caching it alongside the project-rooted built-ins would leak one conversation's coordinates into another across a project switch. It is wired per turn instead, and the metadata listing has nothing static to show.

#### Author-supplied text cannot forge structure

Every workflow string is attacker-controlled — `POST /api/workflows` needs only the `chat` scope and workflows are global — so the note is built defensively:

- `sanitizeNoteValue` is applied at **every** interpolation point (name, description, field key/type/label/description/options/default). It collapses all whitespace **including newlines** to single spaces, strips `*`, and trims. A description therefore cannot emit `\n\n**Workflow: …**` and forge a second block that the host never wrote.
- Every line of output begins with host-controlled text.
- The whole section is wrapped in a **per-turn nonce fence** (`<<<ez-workflow-reference:NONCE>>> … <<<end-…>>>`) with the run hint hoisted ABOVE it as a preamble, so a description that restates "you may run this" reads as data inside a marked region rather than as host instruction.
- `inputSchema` interiors are unvalidated at the API boundary, so `sanitizeNoteValue` takes `unknown` and every field access is defensive — a non-object field is skipped, and `options` is only read when it really is an array (otherwise `"abc".join` would throw and take the whole turn's workflow notes down).

### Execution (`workflow-executor.ts`)

`WorkflowExecutor` is constructed once with the singleton `AgentExecutor` + the `AgentEvents` `EventBus`. `runWorkflow(workflow, input, projectId?, userId?, signal?)`:

1. Mints a `WorkflowRun` (`crypto.randomUUID()`, `status: "running"`) and emits **`workflow:start`**.
2. **`resolveExecutionOrder(steps)`** computes batches:
   - If **no** step has `dependsOn`, steps run strictly **sequentially** — one step per batch, in declared order.
   - Otherwise a **topological sort** groups steps whose deps are all resolved into the same batch; an empty batch with steps remaining ⇒ **`Circular dependency detected`** thrown.
3. For each batch, all steps run **in parallel** (`Promise.all`). Per step, the executor dispatches by kind (and delegates to the loop runner if the step declares a `loop`):
   - Push a `WorkflowStepRun` (`status: "running"`), emit **`workflow:step`**.
   - **Skip decision, before any dispatch.** A step is `skipped` if a step it `dependsOn` was skipped (and that step did not set `skipDependents: false`), or if its own `when` evaluates false. The step returns **no result at all** — that is what keeps it out of `$prev` and out of `$steps` — and the run carries on. See **Conditional skip**.
   - **agent** — resolve `input` via the ref language, run the agent (up to `1 + clampRetries(retries)` attempts; a *cancelled* run is never retried), copy `agentRun.id`/`status` onto the step run. A genuine failure after the budget throws `Step "<name>" failed: <error>`.
   - **transform** — resolve `output` (refs + `{{…}}` templates) into `{ success: true, output: <object> }`. `stepRun.runId` stays `""` (no agent run).
   - **tool** — resolve `input` via the ref language, dispatch `ToolExecutor.executeToolCall(tool, resolvedInput, <synthetic conversationId>, null)`, and return `{ success: true, output: parseToolOutput(<tool text content joined with newlines>) }`. An `isError` result or a thrown dispatch error throws `Step "<name>" failed: <text>` (the RAW text — an error message is for a human). A sensitive-capability approval prompt fails the step with `WorkflowApprovalRequiredError` — see **Tool steps & the approval guard** below.
   - **gate** — evaluate `condition`; `true` ⇒ `{ success: true, output: { passed: true } }`; `false` ⇒ throw `Gate "<name>" failed: <human-readable explanation of the decisive leaf>`.
   - **approval** — already answered ⇒ return the answer as an `ApprovalStepOutput`; cancelled ⇒ throw; otherwise park the run and throw `WorkflowSuspendedError` (see **Approval steps**).
   - **workflow** — run the nested definition as a child run through **this same executor instance** and return its result; a child that parked throws `WorkflowSuspendedError` so the parent parks too (see **Composition**).
   - The first failure records the batch error and **cancels still-running siblings** via the abort plumbing.
   - A step already named in the cursor's `completedSteps` is **served from its persisted output, not re-executed** — that is what makes a partial-batch resume safe (`src/runtime/workflow-executor.ts:694-718`).
4. After each batch, `prevResult` is set to the **last EXECUTED result in that batch** (array order, skipping over skipped steps) — this is what `$prev.*` reads next — and `prevStepName` is taken from the **same index**, so the two can never name different steps. A batch that executed nothing leaves both untouched, so `$prev` keeps naming the last real result from an earlier batch. The batch boundary then writes the cursor **strictly** (`advanceWorkflowRunCursor`).
5. On clean completion: `status:"success"`, `result = prevResult`, emit **`workflow:complete`**. On failure: `status:"error"` (or `"cancelled"` for an external abort, `"awaiting_approval"` when a tool step needs consent a workflow structurally cannot obtain, `"suspended"` when an `approval` step deliberately parked it, or `"error"` with code `cursor-write-failed` when a durability write failed), emit **`workflow:error`**. A `suspended` run gets **no `finishedAt`** and is **not** finalized — it has not finished (`src/runtime/workflow-executor.ts:937-1042`).

`runWorkflow` is **fully awaited by default** — the run route blocks until the graph finishes or parks. `X-EZ-Workflow-Async: 1` opts out (see the REST table). The returned run is terminal *unless* its status is `suspended`.

### Tool steps & the approval guard (`workflow-tool-runner.ts` + `tools/permissions.ts`)

A tool step runs through the host's **one** tool dispatch path, so it is authorized, audited and provenance-tracked exactly like a chat-driven call. Three things make that safe without a conversation:

1. **Fail fast on `prompt`, never hang.** The PDP returns `decision: "prompt"` for any `SENSITIVE_KINDS` capability (`shell`, `fs.write`, `ezcorp:extension:install`, `ezcorp:extension:modify`) with no always-allow row. In a chat turn a modal answers it; in a workflow **nobody can**. `runWorkflow` registers its scope key via `beginNonInteractiveScope()`, so `createExtensionPermissionGate` **rejects synchronously** (`NonInteractiveApprovalRequiredError`) instead of parking a promise. The executor turns that into `Step "<n>" requires interactive approval for capability <kind> and cannot run in a workflow` and terminalizes the run `awaiting_approval`.
2. **The gate can now be torn down.** `createExtensionPermissionGate` accepts an optional `timeoutMs` and `signal`. Both default to unset, so the **chat path's behaviour is byte-identical** (block until answered). A cancelled workflow aborts its scope signal, which rejects every gate pending under its key with `PermissionGateAbortedError`.
3. **Structured output, so a tool step can be chained.** `parseToolOutput` (exported from `workflow-executor.ts`) projects the joined text into the value later steps address: a JSON **object or array** is parsed, everything else is returned verbatim. Extension tools overwhelmingly return `JSON.stringify(...)` of a result object, and leaving that opaque made a tool step permanently TERMINAL — no way to thread `draftId` into the next step's `input`, and a gate could only substring-`contains` the blob instead of asserting `pass === true`. Deliberately conservative: a bare `42` / `"true"` / `null` stays a **string** (parsing it would change the value's TYPE and silently break an existing `eq`/`contains` condition), and text that merely looks like JSON stays a string rather than becoming a silent `{}`.

4. **An honest `conversationId`.** A workflow has none, so the executor mints `workflow-run:<runId>` (`workflowScopeKey()`). An **empty string** would fail *open* — `shouldDeliverEvent` short-circuits on a missing `conversationId` and broadcasts to every SSE subscriber, and it nulls out the sec-H2 ownership check in `routes/tool-permission.ts`. The synthetic id fails *closed* everywhere instead: `getConversation()` returns null so the SSE filter denies delivery, and `resolveExtensionScopeGrant` derives `projectId = null` (the strictest RBAC coordinate). `userId` is threaded to `ToolExecutor.setCurrentUserId` so the call is not ownerless.

### Run persistence (`workflow_runs` + `workflow_step_runs`)

`new WorkflowExecutor(agentExec, bus, { persist: true })` (the server and the CLI) mirrors every run to the DB; the default is `false` so unit harnesses without a DB are unaffected. Writes never throw — a DB glitch cannot fail a workflow that otherwise succeeded.

- `workflow_runs` — the executor's **already-minted** `id` (never a column default: it is already in the `workflow:start` payload and the scope key), `workflow_definition_id` (nullable FK — YAML workflows have no row; `SET NULL` keeps history after a delete), `workflow_name` (denormalized so history survives a rename), `project_id`, `user_id` (`SET NULL`, same IDOR-guard rationale as `runs.user_id`), `status`, `input`, `result`, `started_at`, `finished_at`.
  Plus the durability columns: `cursor` (jsonb `WorkflowCursor`), `run_phase`, `suspended_reason`, `resumable`, `definition_hash`, `definition_version_id`, and the daemon's `claimed_by` / `lease_expires_at`.
  Plus the composition columns: `parent_run_id` (self-FK, **ON DELETE SET NULL** — a child's history records what a nested attempt cost and must survive its parent's deletion; declared as plain text in `schema.ts` with the real FK added in `migrate.ts`, mirroring `sdk_capability_calls.parent_call_id`) and `idempotency_key`, which a nested dispatch derives so it is re-entrant across a parent's suspend.
- `workflow_step_runs` — one upserted row per step on `(workflow_run_id, step_name)`; `run_id` is a **nullable** FK to `runs.id` (transform / gate / tool / approval steps mint no AgentRun and carry the in-memory `runId = ""` sentinel, which the query layer maps to SQL NULL). The row also stores the step's `output` — resume fodder for `$steps.<name>`, written only once the step succeeds, and passed through `prepareStepOutput` first: secrets are redacted (`redactSecretsDeep`) and anything over **256 KiB** (`MAX_STEP_OUTPUT_BYTES`) is replaced by a truncation sentinel (`src/runtime/workflow-step-output.ts:40,80-93`).
- **Per-step telemetry (C5).** The same row also carries `attempt` (agent invocations consumed — retries *and* loop iterations), `input_tokens` / `output_tokens`, `cost_usd` (`NUMERIC(12,6)`), `duration_ms`, `error_code` (the typed reason — `cancelled`, `step-failed`, `approval-required`, `suspended` — never the message, so it stays GROUP-BY-able), `resolved_input`, and `skipped_reason` (added for C7's `when`; no writer yet). Every one is nullable with no default and **none is backfilled**: NULL means "not measured", and a zero would be a claim that silently deflates the first aggregate anyone runs.
- **Tokens accumulate; provider/model do not.** `runAgentAttempt` sums each invocation's usage onto the step (a step that retried three times was billed three times) while overwriting `provider`/`model` — "what served the call" has one answer, "what did this step cost" is a total. A provider that reports no usage leaves the columns NULL rather than 0, all the way from `createPiLlmAdapter`'s `usage` accumulator through `AgentRun.inputTokens` (`src/runtime/executor-helpers.ts`, `src/runtime/executor.ts`).
- **`cost_usd` is written by nothing.** There is no host-side price table, so no code path can compute a cost honestly; the column exists so the trace, a future dashboard and C3's spend cap have one place to read from the day a price source lands. The trace renders `—` with the reason on the cell. **C3's per-job spend cap cannot enforce on this column until then** and must bound on tokens instead.
- **`resolved_input` gets `output`'s exact treatment**, by calling the same code: `prepareResolvedInput` and `prepareStepOutput` share one `prepareForStorage` body in `src/runtime/workflow-step-output.ts` and differ only in the cap (**64 KiB** vs 256 KiB — an input mapping is a handful of refs). Redaction runs **before** measurement, so the bytes measured are the bytes stored and the overflow sentinel's `bytes` describes what would have been written. There is exactly **one** redactor in the tree (`redactSecretsDeep`); a second implementation would not fail loudly when it drifted, it would keep storing values, just less redacted ones. Carried to the row **out-of-band** from `WorkflowStepRun` (in a `WorkflowStepInputSink`) because that object is a published SSE payload and this value is the raw mapping, credentials included.
- `workflow_step_iterations` — per-iteration detail for a looped step, one row per `(step, iteration, attempt)`. A child table rather than a widened `uniq_workflow_step_run`: the arbiter is `(workflow_run_id, step_name)`, so a looped step has exactly one parent row and per-iteration facts have nowhere to live on it, and widening a live unique index means `DROP INDEX` plus a backfill for a purely additive need. Each row carries **that pass's own** provider/model/tokens/duration — which is the point, since a `$loop.*` binding is re-resolved every iteration and a workflow can escalate cheap → strong. Rows are written **before** the failure check, so a loop that dies on iteration 3 still records 1 and 2 and what the failing one cost. CASCADE with the step (an iteration without its step is meaningless); bounded by the loop ceiling × the retry ceiling, so no sweep. The parent's `iterations` (the count) stays as the summary (`src/db/queries/workflow-step-iterations.ts`).
- `finalizeWorkflowRunRow(id, status, result?)` is an idempotent CAS on `status IN ('running','suspended')` — a retry or a racing sweep is a zero-row no-op and never clobbers a richer terminal state. `suspended` is in the set deliberately: without it, a cancel-while-parked and a resume that refuses both matched zero rows and were **silently dropped**, leaving the run parked and refusing forever (`src/db/queries/workflow-runs.ts:305-333`).
- `terminalizeOrphanedWorkflowRuns()` runs at boot (`web/src/lib/server/context.ts:174`). Its SELECT stays one predicate — `status='running'` plus "orphaned", which is *either* a NULL lease with `started_at` before this process started *or* an expired lease. **Its action branches on `run_phase`**: `boundary` ⇒ `suspended` + `resumable = true` + reason `orphaned-resumable`, keeping its result and gaining no `finished_at` (it is going to continue, not end); `in-batch` ⇒ `error` + `resumable = false`, because a restart cannot safely re-enter a half-executed step, with a message naming the batch index and the steps that were in flight. Either way the stale `claimed_by` / `lease_expires_at` are cleared, or the daemon could never pick the resumable ones up (`src/db/queries/workflow-runs.ts:386-445`).
- `suspendWorkflowRun(id, {reason, cursor})` is the deliberate park: CAS on `status='running'`, sets `run_phase='boundary'` and releases the claim. It deliberately does **not** set `resumable` — that flag is the *sweep's* verdict on a crashed run, and a deliberate park is resumable by construction (`src/db/queries/workflow-runs.ts:273-293`).
- `loadStepResults(id)` rebuilds `$steps` for a resume and **fails closed**: a `success` step whose `output` is NULL or truncated means the value is gone, so it refuses by name rather than rehydrating empty. That strictness is load-bearing — the executor appends to `completedSteps` *before* issuing the fire-and-forget output write, so "recorded complete, output never landed" is reachable. Relaxing the loader silently turns the executor's ordering into a wrong-answer bug, and every executor-side test would still pass (`src/db/queries/workflow-runs.ts:194-255`, `src/runtime/workflow-executor.ts:815-836`).

### Approval steps (`runApprovalStep` + `workflow-approval-guard.ts`)

An `approval` step asks a human a question and parks the run until they answer. It is **re-entered** on resume — `cursor.batchIndex` still points at its batch — so "has this been answered yet?" is the only question distinguishing the two passes, and both directions live in one function so they cannot disagree (`src/runtime/workflow-executor.ts:1461-1514`):

- **Answered** ⇒ returns the `ApprovalStepOutput` as the step's result.
- **Cancelled** ⇒ throws `Step "<name>" approval was cancelled`.
- **Anything else** (including `expired`) ⇒ parks and throws `WorkflowSuspendedError`. Re-parking an `expired` row is the conservative reading: only the timeout policy decides what an expiry *means*, and it has not been applied.
- **No persistence ⇒ loud failure.** Without `persist: true` there is no row to park in and nothing could ever answer it, so a DB-less harness fails the step rather than hanging forever.

`workflow_approvals` holds **one live row per `(workflow_run_id, step_name)`** — the unique index is the arbiter, so a step that parks, resumes and parks again UPDATES in place rather than stacking rows the inbox would render twice. Re-parking **clears the previous answer columns**, because a step asking again is asking a fresh question (`src/db/queries/workflow-approvals.ts:33-64`).

**`itemIds` is resolved at suspend time**, from what the run actually produced (`itemsRef`, e.g. `$steps.review.output.asks`) — not at definition time from what its author hoped for. That is what makes the consent guard check the answer against reality. Resolution is tolerant in exactly one direction: an unresolvable ref yields an **empty** set (a clean gate, answerable ids-free), because the alternative — reading it as "everything" — would manufacture consent requirements the run cannot satisfy and park it permanently (`src/runtime/workflow-executor.ts:1529-1549`).

The consent rules are pure and live in one module, so all three answer surfaces share them (`src/runtime/workflow-approval-guard.ts`). `requireItemConsent(parked, answer)` runs three checks **in order**, returning the first failure:

1. **Declared choice.** An answer outside `choices` is rejected, never coerced — an undeclared choice would otherwise flow into `$steps.<step>.output.choice` and read as though the author had allowed it.
2. **No blanket approval.** An ids-free answer to a step carrying items requiring consent is refused. A *clean* step (empty `itemIds`) answers ids-free — nothing was withheld. Explicit `consentAll: true` bypasses and is **flagged** (`consentAllUsed`), recorded on the row and logged, so a bulk clear is auditable rather than invisible.
3. **Cross-check.** Every named id must be one the run produced, or invented ids could be smuggled through to clear a gate nobody reviewed.

The guard is deliberately **choice-agnostic** — a workflow's `choices` are author-defined strings, so the executor cannot know which means "approve", and guessing would be a consent bypass the first time someone wrote `choices: [ship, hold]`. The requirement keys on the *parked step* instead: if it carries items, every answer names what it acted on, whichever choice it picked.

### The three answer surfaces

Ported invariant 7 is *three views over one store, one guard* — and what makes each a real surface is that it clears `answerApproval`, not where it is painted:

| Surface | Where | Per-item consent |
|---|---|---|
| **Inbox** — `/workflows/approvals` | a page you go to | yes |
| **Hub action** — `workflow-approvals-hub-page.ts` | the extension Hub tab | **no**, on purpose: a page action's payload admits only flat values, so a ticked list cannot ride in one, and a button sending none (refused) or all (consent laundering) is worse than a pointer to the inbox |
| **Tray card** — `PendingDecisionsTray` / `PendingApprovalCard` | pushed to you, app-wide | yes, up to `TRAY_ITEM_LIMIT` (6) |

The tray card is **push, not pull**, and that is the whole reason it is a tray and not a message in a conversation. A run parks minutes or hours after whatever started it (the agent steps that decide what the human is even being asked about run first), on no conversation the client can map — `workflowScopeKey()` mints a synthetic `workflow-run:<id>` precisely so every conversation-keyed lookup fails closed — and a durable run outlives the tab. So the executor emits `workflow:approval_request` when the row lands, the SSE filter scopes it **fail-closed on the run's owner** (an unowned run emits no `userId` and the event is dropped: the payload carries the prompt and the consent item ids, which name what is about to be done and to what), and the tray renders it wherever the user happens to be.

`trayConsentPlan` decides whether the card may take the decision at all. Past `TRAY_ITEM_LIMIT` items it renders a count and a link to the inbox instead of a truncated list — a **consent rule, not a layout preference**: a tray that showed 6 of 40 and took the answer would let someone send a complete, valid, server-accepted consent to a set they were never shown.

### Reading a parked approval from an extension (`op: "approvals"`)

`ctx.workflows.run()` is fire-and-forget — it returns the moment the run *starts* and deliberately carries no run id — so the tool result that started a workflow cannot report a gate that appears long afterwards. `ctx.workflows.pendingApprovals()` is that read: the decisions **this extension's** workflows are waiting on, for the **acting user**, each carrying `formatGateRelay(...)` so an LLM cannot be handed the items without the "relay verbatim, do not pre-judge, STOP" directive. Scoped twice and structurally — the owner-scoped inbox join (no admin flag, so an unowned run is invisible) and the granted names, namespaced host-side. It reuses the `workflows` grant (a read of approvals for workflows you may already run is strictly narrower than the trigger) and does **not** consume the hourly run quota, because a status poll that exhausted the run budget would take away the capability it is reporting on. It does share the instantaneous rate limit.

An extension can **read** a parked approval; it cannot answer one. Answering stays a deliberate human act on one of the three surfaces above.

### Answering an approval — one chokepoint (`workflow-answer-approval.ts`)

`answerApproval` is the **only** path by which a parked approval is answered. Every surface (REST, the Hub tab, the chat card) calls it, and everything it does — authorization, the consent guard, the CAS, the resume — is non-exported below it, so a fourth surface cannot plausibly reimplement the sequence. The order is the contract:

> exists → still pending → **authorized** → consent guard → record → resume

The first four are **read-only**: nothing mutates until every check passes, so the run is never touched on a denied answer, rather than being rolled back afterwards (`src/runtime/workflow-answer-approval.ts:20-28`).

#### Authorization — two branches (security)

**This is the rule to get right.** An approval carries no owner of its own; the *run* does.

| The step declares… | Who may answer |
|---|---|
| an `rbacScope` | whoever holds that scope — **and ownership is not also required** |
| **no** `rbacScope` | the **run's owner** (`workflow_runs.user_id`), or an admin |
| no `rbacScope`, and the run's `user_id` is NULL | **admin only** |

A declared `rbacScope` decides **alone**. That is deliberate: an approval can be raised precisely so that someone *other* than the run's owner — a reviewer — answers it, so requiring ownership on top would break the feature (`src/runtime/workflow-answer-approval.ts:142-177`).

With no scope declared, the run's owner decides. **This branch used to be missing entirely.** An approval that declared no scope — the default, and what every `approval` step without an `rbacScope:` produces — was answerable by **any authenticated caller on any run**: the scope check simply did not run and nothing else consulted the run, so a stranger could clear another user's consent gate through either answer surface. A NULL `user_id` run (CLI, extension trigger) is admin-only, matching `workflow-run-control.ts:79-82` and the inbox query: *"unowned" must never read as "anyone's"*.

The scope check is **fail-closed by construction**: a throw inside it is caught and treated as a DENY, never as a silent allow, and it is logged (`src/runtime/workflow-answer-approval.ts:158-169`). The REST surface asks at the strictest coordinates — NULL project, NULL extension — matching how a workflow run's own synthetic scope key resolves (`web/src/routes/api/workflows/approvals/[id]/+server.ts:55-59`).

#### The rest of the sequence

- **The run must actually be resumable.** `answerApproval` refuses (`run-unavailable`) if the row is not `suspended`, if the runtime is unavailable, or if the workflow is no longer defined — and it refuses **before recording**, because an answer written against a run that cannot then be resumed would leave the approval `answered` and the run parked forever, with no surface able to try again.
- **Recording is a CAS** on `status='pending'`, so two humans answering at once produce exactly one winner and the loser gets a clean `lost-race` rather than an overwrite.
- **A resume that comes back `error` is not a successful answer.** It returns `resume-failed` (HTTP 409, not 200) with a message that says both things: the answer *was* recorded — the human really did decide — but the run could not continue.
- Refusals are **typed codes**, never exceptions, so each surface maps them to its own conventions without re-deriving the reason: `not-found` `not-pending` `forbidden` `invalid-answer` `run-unavailable` `resume-failed` `lost-race`.

#### The verbatim relay (`workflow-approval-relay.ts`)

A parked approval is a question for a **human**. When it reaches an LLM — a workflow driven from chat, or an agent summarising a run — the model must relay it, not answer it, not paraphrase it, and not decide on the human's behalf which items are worth mentioning.

The mechanism is structural, not advisory: `formatGateRelay` is the only thing that renders a relay and it **always** prepends `RELAY_DIRECTIVE`, so the items cannot be formatted without the instruction. `directive` is non-null **iff** `stop` is true — they travel together by construction, because a relay carrying the items but not the directive is exactly an LLM-readable list of pending decisions with nothing telling it to stop.

Verbatim means verbatim: item text is never truncated, re-cased, re-ordered or de-duplicated (an approval asking about `a.ts` and `A.ts` is asking about two things). The only transformation is **fencing** — with a backtick run longer than anything inside — so untrusted prompt or item text cannot restructure the surrounding message (`src/runtime/workflow-approval-relay.ts:79-84`).

### Resuming a parked run (`resumeWorkflow` + `workflow-run-control.ts`)

`resumeWorkflow(workflow, row)` continues from the recorded cursor. It emits **no `workflow:start`** — that event *prepends* a run to the client store, so re-emitting it would render one parked job as two — only `workflow:step` and a terminal event. It returns a run-shaped result for every expected refusal rather than throwing, so a daemon driving many resumes is not written around exceptions.

Its refusals come in **two kinds, and conflating them destroys runs** (`src/runtime/workflow-executor.ts:436-474`):

- **Terminal** — the run is genuinely dead: it was never `suspended` (`not-resumable`), its definition changed under it (`definition-changed`), or a completed step's output is gone (`step-output-unavailable`). Recorded through the **strict** path, because a fail-closed decision written by a swallowable call is not fail-closed — the row would stay `suspended` and the next tick would resume it anyway, forever.
- **Transient** — the run is healthy and waiting. Today that is one case: `approval-pending`. It writes **nothing** and emits **nothing**, because the row is already exactly right. Terminalizing it instead would turn a *blocked* bypass into permanent denial of service on the very run being protected — an attacker who could not get past the consent gate could destroy every approval-parked run, one direct call each.

**The consent boundary is enforced here, not by convention.** `resumeWorkflow` is exported, so without the `hasPendingApproval` check any caller could resume a run parked at an approval and step straight over the gate — and spy-counting the known answer surfaces would prove nothing about that caller. `answerApproval` records the answer *before* it resumes, so the check is transparent to the sanctioned path and refuses every other one (`src/runtime/workflow-executor.ts:483-502`).

**Drift** is guarded by `definition_hash`, compared **unconditionally** against a fresh `workflowDefinitionHash(workflow)`; the refusal names both truncated hashes so it is actionable rather than a bare "changed".

`workflow-run-control.ts` is the operator lever on top: `resumeParkedRun` and `cancelParkedRun`.

- They are **not** an approval-answering path. `resumeParkedRun` takes no choice, never touches `workflow_approvals`, and relies on `resumeWorkflow`'s guard rather than re-deriving it — a second opinion about when consent is satisfied is exactly the drift the chokepoint exists to prevent.
- `resumeParkedRun` branches on **`run.result.error !== undefined`, not on `status`**. A transient refusal comes back `status: "suspended"` *with* an error, so checking the status would report the single most important refusal in the module as a success — 200 and a run object to a caller trying to step over a consent gate (`src/runtime/workflow-run-control.ts:129-146`).
- `cancelParkedRun` marks the **row** cancelled; it does not reach into an in-flight batch to stop it. A daemon-held run stops at its next boundary because the row is no longer `running` for it to advance. Its CAS makes a double-cancel a clean `already-terminal`.
- Both use the same owner check: admins may act on any run, everyone else only on their own, and a NULL `user_id` run is **admin-only** (`src/runtime/workflow-run-control.ts:79-82`).

### The WorkflowRunner daemon (`workflow-runner.ts`)

The daemon that resumes parked runs, modelled on `ScheduleDaemon` so anyone who has read one has read both. Wired in `src/startup/background-timers.ts:264-284`, gated by **`EZCORP_DISABLE_WORKFLOW_RUNNER=1`**.

- **Claim by CAS, never `FOR UPDATE SKIP LOCKED`.** PGlite does not honor that identically and this must behave the same on both drivers — the multi-instance / external-Postgres topology is the entire reason a lease exists. Winning the CAS **is** the `suspended → running` transition, so there is no window in which two workers both believe they own a run. Of N instances racing one row exactly one UPDATE matches; the losers match zero and skip, which is the *normal* outcome, not an error (`src/db/queries/workflow-runs.ts:536-558`).
- **It only ever claims `status='suspended'`.** That is the structural guard against double-executing a synchronous run: an HTTP-driven run is `running` from insert to terminal, so it is never claimable, and the two paths need no coordination.
- **Candidates are deliberately not filtered on `resumable`.** That flag is the sweep's verdict on a *crashed* run; a deliberately parked run never carries it, so filtering would make the daemon ignore every approval-parked run — the entire population it exists to serve. Served by `idx_workflow_runs_claimable` (`src/db/queries/workflow-runs.ts:487-519`).
- **The lease detects a dead process, not a slow step.** `WORKFLOW_LEASE_MS = 60_000`, renewed every `WORKFLOW_LEASE_RENEW_MS = 20_000` (a third, so two consecutive misses are survivable) by a heartbeat that is per **daemon**, not per run — a 30-minute agent step keeps its claim for as long as this process is alive. Renewal is scoped to `claimed_by = me AND status = 'running'`.
- **Caps, and they are only meaningful because the work overlaps.** 5 concurrent resumes per project, 20 host-wide (defaults). `tick()` launches resumes **concurrently and does not await them** — awaiting each in turn would make both caps inert and serialize every parked run behind the slowest. Runs with no project share one bucket keyed by a sentinel spelled with a NUL character, so they are capped rather than exempt (`src/runtime/workflow-runner.ts:106-120,245-315`).
- **Single writer per host** — PID lockfile at `.ezcorp/workflow-runner.pid`. Distributed scheduling is out of scope; the **lease** is what makes a second *host* safe, not the lockfile. `start()` returns `false` without starting when a live sibling holds it, and anything that fails after the lockfile is taken gives it back.
- **Graceful shutdown releases claims** rather than waiting out the lease, so a rolling restart does not stall every parked run for a full lease period. Only runs still at `run_phase='boundary'` are released — `in-batch` means side effects may be mid-flight, and the recovery sweep owns that judgement (`src/db/queries/workflow-runs.ts:583-613`).
- **No crash recovery of its own.** A run left `running` by a dead process is `terminalizeOrphanedWorkflowRuns`'s business, which reads `run_phase` to decide whether continuing is even safe. Duplicating that judgement is how two mechanisms start disagreeing.
- **No registered runtime ⇒ a no-op tick**, not a crash. The live executor and workflow cache are built in the web layer, which `src/` may not import; `workflow/runtime-registry.ts` is the sanctioned seam and `getWorkflows()` there is a **thunk**, because the cache array is replaced on every workflow CRUD write and a daemon holding a snapshot would resume against a stale list.

### Conditional skip (`when` / `skipDependents`)

`condition` is gate-only and a false gate **fails** the run. `when` is the other
answer: evaluated **before dispatch**, in the same `WorkflowCondition` grammar,
through the **unchanged** `evaluateCondition`, against the same ref context the
step's `input` would have used. False ⇒ the step is `skipped` and **the run
still succeeds**. That is the whole distinction from a gate.

- **Legal on every kind**, including `workflow`. On a step that also declares
  `loop` it is evaluated **once, before the loop** — a per-iteration guard is
  `loop.until`.
- **Transitive by default.** A step is also skipped when any step it
  `dependsOn` was skipped. `skipDependents: false` **on the skipped step** opts
  its dependents back in; the flag is read off the *producer*, never off the
  consumer, because only the producer knows whether its absence is survivable.
- **A skipped step explains itself.** `WorkflowStepRun.skippedReason` names
  either the guard (`its "when" was not met: …`) or the dependency
  (`step "draft" was skipped`), so the trace never shows a skipped step with no
  explanation. It rides the `workflow:step` SSE frame.
- **An unresolvable ref inside `when` FAILS the step.** Reading it as "run it"
  or as "skip it" would decide a branch by accident; loud failure is the rule.

#### The skip/ref rule — the sharp edge

`$steps.<name>` is **strict on the step**, and a skipped step produces no
result. Two facts make that dangerous rather than merely inconvenient:

1. `dependsOn` and refs are **independent** today. Nothing requires a step
   reading `$steps.X` to declare `dependsOn: [X]`, and the resolver never
   consults the graph. So `skipDependents` alone does not protect an
   *undeclared* reader: it would run, hit the strict ref, and throw — failing a
   run this feature promises succeeds.
2. Substituting `undefined` instead would hand a downstream step a broken value,
   which is precisely the silent breakage design constraint 3 forbids.

So three rules, in order:

- **A skipped step is recorded in a second map, never in `stepResults`.** A
  sentinel *inside* `stepResults` would make `has()` true and make a bare
  `$steps.<skipped>` resolve to it. Kept apart, the strict throw still fires,
  and `RefContext.skippedSteps` only changes the **message**.
- **That message names the skip and the fix** — `step "draft" was SKIPPED (…).
  Declare dependsOn: ["draft"] so this step is skipped too, or guard it with its
  own "when".` — instead of the misleading "has not run yet".
- **`validateWorkflow` makes it unreachable.** Every step that reads
  `$steps.<X>` where X **can be skipped** must declare `dependsOn: [X]`. The
  skippable set is computed to a **fixpoint** over `dependsOn` (so a
  transitively-skippable step's reader is caught too), and the scan covers
  `input`, `output` — **including `{{…}}` templates** — `condition`, `when`,
  `loop.until`, `itemsRef` and `model`. A graph with no `when` anywhere is
  completely unaffected, so nothing that predates this feature can start
  failing.

A skipped step is **not** added to `cursor.completedSteps` (nothing completed);
its persisted step row carries `status = 'skipped'`, and `loadStepResults`
rehydrates it into `skippedSteps` — **not** into `stepResults` — so a resumed run
suppresses the same dependents the first process did.

### Composition — `kind: "workflow"` (`runNestedWorkflow`)

A `workflow` step runs a nested definition as a **first-class child run**: its
own `workflow_runs` row, its own cursor, its own `definition_hash`, and
`parent_run_id` pointing at the step's run. The child's terminal `result`
becomes the step's result, so `$steps.<step>.output.…` addresses the nested
graph's final output through the unchanged ref grammar. A child that fails
throws in the parent, exactly like a failed agent step.

#### The target name is static, and that is load-bearing

`workflow` is a **literal name** — bare, or namespaced `<ext>:<name>`. It is
**never** a ref: `runNestedWorkflow` uses the string verbatim as its lookup key
and deliberately does not run it through `resolveMapping`, and
`validateWorkflow` rejects anything that is not a well-formed name
(`isResolvableWorkflowName`, `src/runtime/workflow-name.ts`).

The ref language could resolve one — this step already resolves `input` that
way — so refusing is a choice. Three things depend on it, and each breaks
differently:

- **The cycle check and the depth cap are DEFINITION-time checks.** Neither is
  computable against a name that is not known until the run, so a cycle would be
  caught only by hitting the cap — after three real nested runs had already had
  their side effects.
- **The definition hash and version pinning** claim "this is the graph that
  ran". That is untrue if the graph can pick its own children.
- **C3's delegated-execution consent hashes the transitive closure** of nested
  workflows. A runtime-resolved target means a human consenting to a graph that
  decides later what it calls.

The predicate is the LOOSER twin of `isValidWorkflowName` and deliberately not a
replacement for it: that one guards what an extension may **declare**, where the
`:` separator must stay illegal or an extension could forge another's namespace;
this one guards what a caller may **look up**, where a namespaced name is the
legitimate case.

- **Depth is capped at 3** levels below the root
  (`MAX_WORKFLOW_NESTING_DEPTH`), enforced at **run time** by a counter threaded
  through the child's execution context *and* at **definition time** wherever the
  chain is statically visible.
- **Cycles are a definition-time error naming the loop**
  (`Nested workflow cycle: a -> b -> a`). A workflow nesting *itself* is caught
  with no resolver at all, because the walk seeds its path with the root's name.
- **An unresolved nested name is deliberately NOT a definition-time error.** A
  resolver only sees the world as it is right now, and rejecting a forward
  reference would make "create the parent, then the child" impossible. The
  run-time lookup reports it when it matters.
- **`loop` is legal on a `workflow` step, and only there among the kinds the
  `tool` ban covers.** What a looped nested run repeats is a graph with an LLM or
  a gate in it (fix → re-validate); the nested graph may itself contain a tool
  step, but the *loop* wraps a decision, not a bare install/write/shell call.
  **Each iteration is its own child run**, which is what makes the trace read
  "3 attempts, here is each".
- **The child is executed by the SAME `WorkflowExecutor` instance** —
  `this.runWorkflow`, never `new WorkflowExecutor`. That is what makes a dry
  run's guarantees hold at any depth: a tool step three levels down hits the same
  throwing `toolRunnerFactory`, because `getToolRunner` closes over it. A
  refactor that constructs its own executor here evaporates that guarantee
  silently.

#### Suspend, resume, and why re-entrancy is the whole design

A nested graph may contain an `approval`, so a **child can park**. When it does,
the step throws `WorkflowSuspendedError` and the parent parks alongside it, at
its own batch, with its already-finished siblings recorded — the mechanism an
`approval` step in a parallel batch already uses. Parent and child are then two
independent suspended runs: the child is resumed by answering its approval (or by
the daemon), the parent by the daemon.

The parent's resume **re-enters the same step**. Without a lookup it would
dispatch a second child and duplicate every side effect the first one applied —
the failure the durable cursor exists to prevent, reintroduced one level down.
So each nested dispatch derives an `idempotency_key`:

```
nested:<parentRunId>:<stepName>#<iteration>
```

and looks it up first. `success` ⇒ return the recorded result; `suspended` or
`running` ⇒ park again (the child is alive, and waiting is the only
non-destructive answer); anything else ⇒ throw. The **partial unique index** on
`(workflow_name, idempotency_key)` makes that an invariant rather than a
convention. It also makes a replayed loop cheap: iterations 1..n−1 are served
from their recorded child results and only the parked one continues.

#### Authorization

Nesting **is** a run of another workflow, so it asks the same question the run
route asks. `WorkflowExecutorOptions.workflowResolver` carries the run's
principal, and the server wires it through `resolveWorkflowForCaller(…, "run")`.
Without that, anyone who could author a workflow could nest someone else's
`private` one and read its behaviour back through `$steps`.

The role is clamped to `member`: a run carries a principal id, not a role (a CLI
or scheduled run has neither), and the safe reading of "we do not know" is the
lower privilege. A denial and a missing name produce the **same** message, so a
nested step is not an existence oracle for private names.

### Loops (`runLoop`)

A step with a `loop` repeats up to `clampMaxIterations(loop.maxIterations)` (1..25) times, evaluating `until` **after** each iteration:

- Allowed on **agent**, **transform** and **workflow** steps; invalid on a **gate**, a **tool** (repeating a side-effecting install/write/shell call with no LLM in the middle is deliberately out of scope) and an **approval**. `workflow` joined the allow list in C7 and the `tool` ban did **not** loosen — see **Composition**. `loop` and `retries` are **mutually exclusive** (definition-time error) so the worst-case cost stays bounded.
- Step-input refs gain `$loop.iteration` (1-based) and `$loop.last.<path>` (previous iteration's result). On iteration 1 the `$loop.last` mapping key is **omitted**, never passed as `undefined` — the single documented lenient exception to strict refs.
- Each iteration re-emits **`workflow:step`**; `WorkflowStepRun.iterations` records the final count.
- `until` satisfied ⇒ the step succeeds with that iteration's result. No `until` ⇒ a fixed-count loop that always passes. Budget exhausted with `until` unmet obeys `onExhausted`: `"fail"` (default) throws `Step "<name>" exhausted <max> iterations without meeting its until-condition`; `"pass"` succeeds with the last result and `iterations = max`.
- Abort/cancel is checked **between** iterations; a cancelled iteration ends the run `cancelled`.

### Per-step model bindings (`workflow-model.ts`)

An `agent` step may name the model it runs on, so one workflow can mix a
cheap extractor with an expensive validator instead of paying top-tier
prices for every step:

```yaml
name: docs-factory
defaultModel: { provider: anthropic, model: claude-sonnet-5 }
steps:
  - { name: extract, agent: factory-extractor, model: { model: claude-haiku-4-5-20251001 } }
  - { name: draft,   agent: factory-writer, dependsOn: [extract] }          # inherits defaultModel
  - name: verify
    agent: factory-validator
    dependsOn: [draft]
    model: { provider: anthropic, model: claude-opus-5, maxTokens: 8000, effort: high }
```

- **Resolution order** is `step.model ?? definition.defaultModel ?? none`
  — a whole-bundle `??`, **not** a field-by-field merge. A step naming
  `model` replaces the default outright, so it can drop back to the
  provider's own sampling defaults without inheriting a `maxTokens` it
  never asked for.
- **Absent on both ⇒ nothing changes.** `runAgent`'s 5th argument is
  omitted, `createPiLlmAdapter()` is built with no override, and the
  agent config's own binding (or the `__current__` inherit sentinel)
  reaches the router exactly as before.
- **Fields.** `provider`, `model`, `temperature` (0..2), `maxTokens`
  (integer 1..1,000,000), `effort` (one of `minimal` `low` `medium`
  `high` `xhigh` `max` — pi-ai's `ThinkingLevel`; there is no `"off"`
  because no reasoning is the default on this path). An **unknown field
  is rejected**, so `maxtokens:` is a definition-time error, not a
  silently-ignored typo.
- **Refs work.** `provider` / `model` / `effort` accept the same ref
  language as a step's `input` (`{ model: "$input.verifyModel" }`),
  resolved through the shared `resolveMapping` with the **same ref
  context as that step's input** — so a looped step re-resolves per
  iteration (`$loop.last.…` can escalate the model on a retry) while a
  retried step resolves once (a retry re-runs the agent, it does not
  re-pick the model). `temperature`/`maxTokens` are numbers and are
  therefore never refs. A `$input.x` ref whose field is unset means "no
  override for that field"; a ref resolving to a non-string, or an
  `effort` outside the vocabulary, **fails the run loudly** naming the
  step.
- **Where it is applied.** The binding is threaded
  `workflow-executor → AgentExecutor.runAgent(name, input, projectId, userId, override) → createPiLlmAdapter(override)`
  — one chokepoint, so no `AgentDefinition` knows about it and the
  override cannot be half-applied. `effort` routes the call through
  pi-ai's `completeSimple`/`streamSimple` (the entrypoints that normalize
  reasoning per provider); every other call keeps the raw
  `complete`/`stream` path. A nested `ctx.run(...)` spawn inherits the
  parent's **identity**, never its model binding.
- **What is recorded.** `workflow_step_runs.provider` / `.model` store
  the binding the call actually **resolved** to (post-`resolveModel`), not
  what was requested — so a `$input` ref, an agent-config binding and the
  router's own pick all read the same way. NULL for a step that ran no LLM.
  `/workflows/[name]` renders the declared binding on the step card and
  the resolved one (`on anthropic/claude-opus-5`) in the run history.

**Definition-time validation is shape-only for `provider`/`model`** — see
the long comment on `validateModelOverride`. In short: `validateWorkflow`
is synchronous and runs in the YAML loader at boot, while the host's real
model universe needs I/O (`provider:customModels` /
`provider:discoveredModels:*` settings rows); pi-ai's sync static catalog
is incomplete (no `ollama`, no `ezcorp-mock`, no discovered models), so
checking against it would reject working setups; and a ref has no value
to check at all. An unresolvable model still fails at the provider with
that provider's own error, exactly as a mistyped agent-config binding
does today.

### Reference language (`workflow-refs.ts`)

One module defines the ref grammar for all three callers (step inputs, transform templates, conditions), so it lives in exactly one place (DRY). Each mapping value is a string interpreted by prefix:

| Prefix | Resolves to | Strictness |
|---|---|---|
| `$input.<field>` | the workflow's top-level input field | lenient (may be `undefined`) |
| `$prev.<path>` | dotted path into the previous batch's last result | strict |
| `$steps.<name>[.path]` | a named earlier step's result (whole, or a dotted path) | strict on the step; strict on the field for inputs, lenient for conditions |
| `$loop.iteration` | 1-based iteration number (looped step inputs) | — |
| `$loop.last[.path]` | previous iteration's result (looped step inputs; omitted on iteration 1) | strict field, lenient omit on iter 1 |
| `$result[.path]` / `$iteration` | current iteration's result / number — **loop `until` only** | strict root |
| _anything else_ | a **literal** string value | — |

A `$steps.<name>` naming a **skipped** step still throws — `RefContext.skippedSteps`
changes only the message, never the strictness. See **The skip/ref rule**.

**Template interpolation** (transform `output` only): any value containing `{{ ref }}` has each placeholder resolved as a strict ref and string-interpolated (objects are `JSON.stringify`-ed; `null`/`undefined`/omit render empty). A value with no `{{…}}` is resolved as a direct ref instead.

### Conditions (`workflow-condition.ts`)

`evaluateCondition(cond, ctx)` returns `{ passed, reason }`; `reason` names the decisive leaf so a failing gate explains itself. `all`/`any`/`not` compose leaves. Leaf operators: `eq`/`neq` (deep-equal for objects), numeric `gt`/`gte`/`lt`/`lte` (a comparison on a **non-number evaluates false**, never throws), `contains` (string-substring or array-includes), `exists` (not `undefined`/`null`), `truthy`. Only an **unresolvable strict root ref** (`$prev` with no previous result, `$steps.<unknown>`) throws.

### Definition-time validation (`workflow-validator.ts`)

`validateWorkflow(def)` returns a list of human-readable errors (empty ⇒ valid). It is the **single shared validator** used by both the API (400 with the first message) and the YAML loader (warn-and-skip). It rejects: duplicate step names; `dependsOn` naming an unknown step; `agent` kind without `agent`; `tool` without `tool`; `tool` that also names an `agent`; `transform` without `output`; `gate` without `condition`; an `approval` without a `prompt` or without a non-empty `choices` array, with an empty/non-string or duplicate choice, that also names an `agent`/`tool`, that sets `requireItemConsent` without an `itemsRef`, whose `timeoutMs` is not a positive integer, whose `onTimeout` is outside `abort|approve|skip`, that sets `onTimeout: approve` with no `timeoutMs` (deciding on a human's behalf must be bounded by a clock the author named), or that sets `onTimeout: approve|skip` without declaring that same string in its `choices` (the sweep answers with the policy name, and an undeclared choice is rejected rather than coerced); `retries` on an approval (a human decision is not retryable); a `loop` on a gate, a tool or an approval; `loop` + `retries` together; a missing / non-integer `maxIterations`; a `model` binding on a **non-agent** step; a `workflow` step without a `workflow`, one that also names an `agent`/`tool`, or one whose `workflow` is not a literal name (a ref or `{{…}}` template is rejected — the nested graph must be knowable from the definition); a malformed `when`; a non-boolean `skipDependents`; a **nesting cycle** (named: `a -> b -> a`) and a nest deeper than 3 levels; a step reading `$steps.<X>` where X can be **skipped** without declaring `dependsOn: [X]` (see **The skip/ref rule**); and a malformed `model` / `defaultModel` (unknown field, non-string provider/model/effort, an `effort` outside the vocabulary, an out-of-range `temperature`/`maxTokens`). Out-of-range **integer** loop budgets are **not** errors — they are clamped at run time. `defaultModel` is checked **before** the "at least one step" early-return, so a bad binding is not hidden behind an unrelated step error. `PUT /api/workflows/[name]` is a *partial* update with no `steps` to hand the whole-definition validator, so it calls the same `validateModelOverride` directly for a `defaultModel`-only body.

### Eventing & the client store

The four `workflow:*` events ride the same `AgentEvents` bus that streams to the browser over SSE (canonical names in `web/src/lib/runtime-event-names.ts`; the `@ezcorp/ai-kit` and `@ezcorp/harness-client` event lists mirror them). `web/src/lib/stores.svelte.ts` handles them: `workflow:start` prepends the new run to `store.workflowRuns`; `workflow:step`/`:complete`/`:error` replace the matching run by `id`. Because the run is also returned synchronously by `POST …/run`, the `/workflows/[name]` page shows live per-step status (and loop iteration counts) plus a session-local run history.

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/workflows` | `read` | List the merged workflows **the caller may see**. **Behaviour change:** this used to return the whole cache to any `read`-scoped caller; it is now filtered by the ownership ladder, so a `read` key with no project sees `system` workflows plus what its principal owns — a shorter array, same shape (plus additive provenance fields). |
| `POST /api/workflows` | `chat` | Create a DB workflow. Body `{ name, description?, inputSchema?, defaultModel?, steps }`; `validateWorkflow` drives a **400** with the first error message. Returns the row; reloads the cache. |
| `GET /api/workflows/[name]` | `read` | Fetch one by name; returns the definition **plus** provenance (`source`, `visibility`, `projectId`, `userId`, `forkedFrom`, `canEdit`). **404 (not 403) when unauthorized**, so the endpoint is not an existence oracle. |
| `PUT /api/workflows/[name]` | `chat` | Partial update — merges `name`/`description`/`inputSchema`/`defaultModel`/`steps`. **DB-only**. Gated on the `edit` rung, so a `system` workflow is admin-only. A rename onto a taken name is a **409** (it used to be an unhandled 500). Mints a version only if the executable content changed. Reloads the cache. |
| `DELETE /api/workflows/[name]` | `chat` | Delete a DB workflow. **DB-only**, `edit` rung. Reloads the cache. |
| `POST /api/workflows/[name]/dry-run` | `chat` | Simulate. Body `{ input?, projectId?, definition? }` — `definition` dry-runs the **unsaved draft** on screen. Gated on `run`. A draft that would fail `validateWorkflow` is a 400, so the editor cannot report green for a graph the save rejects. |
| `POST /api/workflows/[name]/fork` | `chat` | Clone into an editable project-scoped copy owned by the caller. Body `{ projectId? }` — taken from the body because there is no server-side "active project". Returns `{ name, id, forkedFrom }` with the **final** name. |
| `GET /api/workflows/[name]/versions` | `read` | Version history (no `steps` blob). Same ladder; a YAML/extension workflow returns `[]`, not a 404. |
| `POST /api/workflows/[name]/claim` | `admin` | Assign an explicit owner to a workflow. Audited (`workflow.claim`, with the before-values). |
| `POST /api/workflows/[name]/run` | `chat` | Run it. `projectId` is split off the body; **every other field is the workflow input** (Zod `.loose()`). 404 `Workflow not found`; a non-object body ⇒ **400 `Invalid request body`**. Execution errors (unknown agent, circular deps, gate/loop failure) surface **inside** the returned `WorkflowRun` (`status:"error"`, HTTP 200), not as a 400. Returns the `WorkflowRun`. **`X-EZ-Workflow-Async: 1`** (exactly `"1"`) starts the run without waiting and returns **202** `{ id, workflowName, status: "running" }`; follow it on the `workflow:*` SSE frames or by reading the row. Absent — the default, and every existing caller — the handler is byte-identical to what it was. The async branch runs the **authorized** definition, not a re-resolved one, so opting out of waiting does not opt out of the ownership ladder. |
| `GET /api/workflows/approvals` | `read` | The approvals **inbox**: pending decisions this caller may act on. `read`, not `chat` — it lists decisions, it does not make any. Scoped **by the query**, not the route: an approval has no owner of its own, so it is a join against the run's `user_id`; admins see everything. |
| `POST /api/workflows/approvals/[id]` | `chat` | Answer a parked approval and resume its run. Body `{ choice, form?, itemIds?, consentAll? }` — boundary validation only; every consent rule lives behind `answerApproval`. Codes map `not-found`→404, `forbidden`→403, `not-pending`/`lost-race`/`run-unavailable`/`resume-failed`→409, `invalid-answer`→400. |
| `GET /api/workflows/runs` | `read` | Run history, newest first. Filters `workflowName`, `status`, `projectId`, `since`, `until`; **keyset** pagination on `(started_at, id)` via `cursorStartedAt` + `cursorId` (both or neither — half a cursor cannot disambiguate two runs in the same millisecond). Page size 50, cap 200. A non-admin sees only runs **they initiated**, scoped in the WHERE rather than filtered after, so pages never come back short. The summary deliberately omits `input` and `result`. |
| `GET /api/workflows/runs/[id]` | `read` | One run's **trace**: the run row, its steps with per-step model/tokens/duration/`resolved_input`/`output`, and each step's loop iterations (inlined — a step is bounded to a few dozen iterations, so a lazy-load round-trip costs more than it saves). Per-run totals are **computed at read time**, never stored: a stored rollup drifts the moment a step row is corrected. **404, not 403, when unauthorized** — see below. |
| `POST /api/workflows/runs/[id]/resume` | `chat` | Continue a `suspended` run. **Not** an approval-answering surface — it takes no choice and cannot clear a pending consent gate; a run parked on an unanswered approval comes back **409** and stays answerable. |
| `POST /api/workflows/runs/[id]/cancel` | `chat` | Cancel a `running` or `suspended` run. Returns `{ cancelled: true }`; a run already terminal is a **409**, never a success that changed nothing. |

Every route above **except create/update/delete** is registered in `src/api-registry.ts` (category `workflows`, lines 196-214) — create/update/delete are not (parity with `main`'s pipelines registration). All routes gate on `requireScope` + `requireAuth`; the by-name routes additionally gate on the ownership ladder via `resolveWorkflowOr`, and the run-control and approvals routes on their own owner/scope rules (above). None is marked `harness: { controllable: true }` yet — that flag asserts a matching `@ezcorp/harness-client` method exists, and claiming it while shipping none would make the registry lie about the remote surface.

The `.strict()` body schema shared by `POST` and `PUT` (`web/src/routes/api/workflows/schema.ts`) has **no `source` key** on purpose. `source` is server-derived provenance served by `GET`; echoing a fetched definition straight back into a `PUT` would be rejected as an unknown top-level field.

### UI entry points

- `/workflows` — list, fed by `store.workflows`.
- `/workflows/new` — `WorkflowBuilder.svelte` form (with `WorkflowStepForm.svelte` per-step editor, including kind, transform output pairs, gate condition JSON, loop config, dependsOn) → `createWorkflow` → `POST /api/workflows`.
- `/workflows/[name]` — step list (each agent step showing its effective **model binding**, whether declared on the step or inherited from `defaultModel`), a raw JSON-textarea run form (`triggerWorkflowRun`), Edit / Fork / Delete actions, and a live run-history panel (`store.workflowRuns`) rendering per-step status, `(N iterations)` for looped steps, and `on <provider>/<model>` for the model a step actually resolved to.
- `/workflows/[name]/edit` — the editor: a **form tab** over the shared `WorkflowBuilder`, a **raw-YAML tab** (same `yaml` package the server loader uses), a **dry-run panel** that simulates whatever is on screen including an unsaved draft, and the version history. `canEdit` comes from the server; a workflow the caller cannot edit says so up front rather than failing on save.
- `/workflows/approvals` — the **approvals inbox**. Fetches `GET /api/workflows/approvals` and renders each pending decision with its prompt, age, deadline and choices. Item-consent approvals render a checkbox per item; the submit button is **disabled** until something is ticked, so the reason is visible before the click rather than after it. The decision rules are pure and live in `web/src/lib/workflow-approvals-logic.ts`: `buildAnswerBody` sends `itemIds` **only** for a consent-required approval and only the items the human actually ticked — echoing the offered list back would turn "consent to these three" into "consent to whatever you asked about". `describeOutcome` reads the **run's** status, not merely the 200, so an answer that was recorded while the run failed to continue never reads as clean; `suspended` after an answer means the run parked again on the *next* approval, which is progress.
- **The Hub approvals tab** — the second answer surface (`src/runtime/workflow-approvals-hub-page.ts`, registered at `web/src/lib/server/context.ts:215`). Renders **only the caller's own** pending approvals: `HubPageContext` carries a `userId` and nothing else, and inferring admin reach from another source would be deriving an authorization decision in a render path. It **cannot answer an item-consent approval** — a page action's payload admits only flat string/number/boolean values, so a ticked item list cannot ride in one, and a button that sent *none* (refused, an error the user cannot act on) or *all* of them (consent laundering) are both worse than pointing at the inbox. It never forwards `itemIds` even if a crafted request supplies them, and it cannot pass `consentAll`.
- `/workflows/runs/[id]` — the **run trace**. A DAG, a timeline, and a per-step table of status, model, tokens, cost, duration; each step expands to its `resolved_input`, `output`, linked agent transcript and loop iterations, with **Retry from here** on a step a resume could reach. The pure logic is `web/src/lib/workflow-trace-logic.ts`, and its governing rule is that **"not reported" never renders as a number**: every formatter maps NULL to `—` and none defaults to zero, because a `0` would turn a gap into a measurement with no way for the reader to tell. Cost is a dash on every row today, with the reason in a `title` rather than left as a mystery. The DAG is drawn from **execution order**, not from the definition — the definition may have been edited or deleted since the run, and a graph drawn from today's steps over yesterday's run would be a confident lie; steps that started at the same instant share a rank, because the executor dispatches a batch with `Promise.all`. **Retry from here** resumes the run at its cursor (the platform has no per-step re-entry, and inventing one in the UI would either re-run completed steps or claim a precision the executor does not have), so it is offered on a `suspended` run and never on a step that already succeeded — a resume serves that one from its persisted output. It deliberately does **not** consult `resumable`; see the gotcha below.
- `/pipelines` (the exact path only) → a permanent **308 redirect** to `/workflows` for one release. Legacy deep links (`/pipelines/<name>`, `/pipelines/new`) are **not** redirected — they 404.

### Client helpers (`web/src/lib/api.ts`)

`fetchWorkflows`, `fetchWorkflow`, `createWorkflow`, `updateWorkflow`, `deleteWorkflow`, `forkWorkflow`, `dryRunWorkflow`, `fetchWorkflowVersions`, `triggerWorkflowRun(name, input, projectId?)`. **Trap (unchanged from pipelines):** `triggerWorkflowRun` folds `projectId` **into** the input body (`{ ...input, projectId }`); the run route's `.loose()` schema splits it back out, so a workflow input field literally named `projectId` would be swallowed.

### Extension-triggered runs (`ezcorp/workflows`)

An extension can trigger a run of a workflow **it ships** through the `ezcorp/workflows` reverse-RPC (`ctx.workflows.run(name, input)` — the `Workflows` class in `@ezcorp/sdk/runtime`). Host side: `src/extensions/workflows-handler.ts`.

- **Permission** — `permissions.workflows: { names: string[], maxRunsPerHour?: number }`. `names` are **bare** workflow names; `maxRunsPerHour` is optional in the manifest and **required** on the grant (clamp default 20, ceiling 500) because a run can fan out into `agent` steps that cost real LLM spend. Clamped by `clampWorkflowsPermission`; an empty intersection drops the grant rather than leaving a `{names: []}` husk.
- **Capability** — `ezcorp:workflows:run`, emitted **per granted name** (`value = <bare name>`) by `grantsToCapabilitySet`, so holding one name does not authorize another. Deliberately **not** in `SENSITIVE_KINDS` — a run's own tool steps re-enter the PDP under the non-interactive scope, so anything genuinely sensitive still fails closed inside the run; the trigger grants nothing the extension could not already reach, and always-prompt would make the capability unusable for its only purpose. The real bound is the per-hour quota.
- **Namespacing is structural** — the wire carries only the bare name (a name containing `:` is rejected outright) and the host applies the `<extensionName>:` prefix itself from the registry-resolved manifest name. There is therefore **no way to express** a host workflow's or another extension's workflow name over the wire.
- **Enforcement ladder** — provenance (caller, host-issued `_meta.ezCallId`) → kill-switch → grant check → name → manifest allowlist (defense-in-depth: a stale grant against a narrowed manifest is not exploitable) → grant allowlist → PDP → owner bound → conversation wiring → rate limit → payload → hourly quota → resolve → dispatch. Every outcome, **accept and reject**, writes an `sdk_capability_calls` row (`capability: "workflows"`, `action: "run"`) with a typed `errorCode`.
- **Ownerless fires are REFUSED, not attributed.** A cron/webhook fire has no `onBehalfOf`; `runWorkflow`'s SSE scoping is fail-closed on `userId`, so such a run would execute unattributed AND invisible. Inventing an owner (e.g. the installing user) would bill their provider credits for work they did not initiate and push the run's stream at them. `resolveReverseRpcMeta` already rejects ownerless fires (`-32106`) and the handler re-asserts it so the bound is testable in isolation. That one rung audits to `audit_log` (`ext:workflow-trigger-no-owner`, nullable `user_id`) rather than `sdk_capability_calls`, whose `on_behalf_of` is NOT NULL + FK — otherwise the rejection class that most needs a trail would be the only one without one.
- **Non-blocking** — `runWorkflow` awaits the entire graph and routinely outlives the 20s host reverse-RPC budget, so the handler starts the run and returns `{v: 1, workflow: "<ext>:<name>", started: true}` immediately. **No run id** is returned: the handler cannot learn it without awaiting the graph, and a host-minted correlation id would match no `workflow_runs` row. Correlate on `workflow:start` (it carries both `workflowRun.id` and the name) or on the run history keyed by `workflow_name`.

### CLI (`src/cli.ts`)

`ezcorp workflow list` prints the merged YAML+DB workflows; `ezcorp workflow run <name>` constructs its own `WorkflowExecutor` over a fresh run harness, prints `run.result` as JSON, and **exits 0 only when the run's terminal status is `success`, 1 otherwise** (error/cancelled — loud-failure semantics, scriptable in CI). `ezcorp pipeline …` is a **hidden alias** (kept out of help text) that dispatches to the same `workflow:*` commands for one deprecation release. There is **no** auth/scope check on this path (a local operator tool, not an HTTP endpoint).

### Env vars

- `EZCORP_AGENTS_DIR` — overrides where YAML workflows (and agents) are discovered. Default: the repo's `src/agents/`.
- `EZCORP_DISABLE_WORKFLOW_RUNNER=1` — do not start the `WorkflowRunner` daemon. Parked runs then stay `suspended` until something resumes them explicitly (`POST …/runs/:id/resume`, or answering the approval on a host whose daemon *is* running).

### Demo workflows (`src/agents/`)

Three committed demos double as executable documentation and test fixtures:

- `demo-deterministic.workflow.yaml` — zero-LLM `transform` → `gate` → `transform`: a compose step reshapes the input, a gate asserts the composed fields, and a final `publish` transform re-emits the composed object so the run result carries meaningful content. Identical input ⇒ byte-identical output.
- `demo-loop-counter.workflow.yaml` — a `transform` loop that counts to 3 (`iterations: 3`) using `$loop.iteration` / `$loop.last`; passing `neverStop: true` makes the until-condition unreachable and exercises the loud `onExhausted: "fail"` path.
- `demo-mixed.workflow.yaml` — an `agent` step (`summarizer`) → `transform` reshape → `gate` assertion.

### The authoring chain (`src/agents/extension-author.workflow.yaml`)

The extension-authoring chain shipped as a real workflow — the reference example of a mixed `tool` + `gate` graph, and of a run that **parks at a consent boundary**:

`scaffold` (tool) → `scaffolded` (gate) → `validate` (tool) → `verified` (gate) → `handoff` (transform) → `request-install` (tool).

- The two gates assert real things: `$steps.scaffold.output.draftId` must `exist` **and** be `truthy`; `$steps.validate.output.pass` must `eq true` (not `truthy`, so a missing or non-boolean `pass` fails closed). Both come from `parseToolOutput`-projected JSON, and a failure names the decisive ref and its actual value.
- The final step deliberately attempts `extension-author__install_draft` and is deliberately **refused** when the chain runs non-interactively (REST / CLI / extension trigger): `ezcorp:extension:install` always prompts and is never persisted as an always-allow grant, and a non-interactive run has no conversation on which to render that card. The run terminalizes **`awaiting_approval`** — never `success` (which would misleadingly imply the extension is live) and never `error` (nothing went wrong). Started from a chat via `run_workflow` the same step instead renders a real consent card: approving proceeds, declining fails the step and the run ends `error`.
- A parked run's `result.output` carries the **last successful result**, i.e. the `handoff` payload (`{draftId, userId, verifyResult, openUrl, nextStep}`), so the human who completes the install out-of-band has what they need. (Before this it was `null` and the payload died with the run.) `result.success` stays `false` and the `awaiting_approval` error code is unchanged.
- A human completes it via the owner-scoped `POST /api/extensions/author/install`, or by re-running `install_draft` in a chat where the card can actually be shown. The chain calls the extension's **gated tool**, never the exported `installAuthoredDraft` function — that function performs no consent of its own, and calling it from a step would be the hand-rolled bypass `drafts-handler.ts` warns about.
- `userId` is an input, and it is a **display hint only** — not an authorization input. The install endpoint derives the owner from the session and the draft directory is already owner-scoped by the run's acting user, so a forged value buys nothing.

## Key files

- `src/types.ts` — `WorkflowDefinition`, `WorkflowStep` (incl. `when` / `skipDependents` / `workflow`), `WorkflowStepKind`, `WorkflowCondition`, `WorkflowConditionOp`, `LoopConfig`, `WorkflowRun`, `WorkflowStepRun`, the four `workflow:*` events on `AgentEvents`.
- `src/runtime/workflow-executor.ts` — `WorkflowExecutor`: `runWorkflow`, `resumeWorkflow`, `resolveExecutionOrder`, `runStep`/`runAgentStep`/`runToolStep`/`runLoop`/`runNestedWorkflow`, `skipDecision` + `nestedOutcome`, transform/gate helpers, retry + abort/cancel plumbing, `workflowScopeKey`, `nestedRunKey`, `WorkflowApprovalRequiredError` / `WorkflowSuspendedError`, run/step persistence.
- `src/runtime/workflow-tool-runner.ts` — `WorkflowToolRunner` (the narrow `ToolExecutor` slice a tool step uses) + `createWorkflowToolRunner` (cold-start registry/PDP wiring).
- `src/runtime/tools/permissions.ts` — `beginNonInteractiveScope`, gate `timeoutMs`/`signal`, `NonInteractiveApprovalRequiredError` / `PermissionGateAbortedError` / `PermissionGateTimeoutError`.
- `src/db/queries/workflow-runs.ts` — `insertWorkflowRun` (incl. `parent_run_id` / `idempotency_key`), `findWorkflowRunByIdempotencyKey` (the nested re-entrancy lookup), `workflowRunNestingDepth` (derives a resumed run's depth from the parent chain), `upsertWorkflowStepRun`, `finalizeWorkflowRunRow` (CAS over `running`+`suspended`), `terminalizeOrphanedWorkflowRuns` (the `run_phase`-branching boot sweep), `markWorkflowRunInBatch` / `advanceWorkflowRunCursor` (the strict, throw-on-failure cursor writes), `suspendWorkflowRun`, `loadStepResults` (fails closed on a lost output; rehydrates `skipped` steps into a parallel map, never into `stepResults`), read helpers — **plus the daemon's half**: `WORKFLOW_LEASE_MS` / `WORKFLOW_LEASE_RENEW_MS`, `listClaimableWorkflowRuns`, `claimWorkflowRun` (the CAS), `renewWorkflowRunLeases`, `releaseWorkflowRunClaims`. The daemon owns the policy and none of the SQL.
- `src/runtime/workflow-runner.ts` — `WorkflowRunner`: the resume daemon. Lockfile + wake loop + lease heartbeat, per-project / host caps, `tick()` (public so tests need not wait out an interval), `drain()` (test seam), graceful `stop()` that hands claims back.
- `src/runtime/workflow-answer-approval.ts` — `answerApproval`: the ONE answer path. Authorization (the two-branch rule), consent guard, CAS, resume — everything below it non-exported. Typed `AnswerApprovalRefusal` codes.
- `src/runtime/workflow-approval-guard.ts` — the pure consent rules: `requireItemConsent` (the only function an answer path may call), `enforceNamedApproval`, `crossCheckItemIds`.
- `src/runtime/workflow-approval-relay.ts` — `formatGateRelay` + `RELAY_DIRECTIVE`: the verbatim ask-user relay; fencing, and `directive` non-null iff `stop`. Rendered by the `op: "approvals"` read so an LLM cannot be handed the items without the stop directive. **Not** rendered by the tray card — that string is addressed to a model.
- `web/src/lib/components/tool-cards/PendingDecisionsTray.svelte` / `PendingApprovalCard.svelte` — the third answer surface. One bottom-right stack shared with the run-less permission tray (two `fixed` containers at one corner would overlap); the card answers through the same REST route, so the chokepoint holds by construction.
- `src/runtime/workflow-approvals-hub-page.ts` — the Hub approvals tab (the second answer surface); `createWorkflowApprovalsHubPageProvider`, `registerWorkflowApprovalsHubPage`.
- `src/runtime/workflow-run-control.ts` — `resumeParkedRun` / `cancelParkedRun` + the exported `mayControlRun` (NULL `user_id` ⇒ admin-only); typed `RunControlCode`s. The ONE opinion about who a run belongs to — the trace read shares it.
- `src/runtime/workflow-run-trace.ts` — the authorized read: `getWorkflowRunTrace` (run + steps + iterations, `undefined` for both "absent" and "not yours"), `listWorkflowRunsForCaller`, `RUN_PAGE_DEFAULT` / `RUN_PAGE_MAX`.
- `src/db/queries/workflow-step-iterations.ts` — `upsertWorkflowStepIteration` (looks the parent up rather than being handed its id, and reports a not-yet-visible parent instead of throwing), `listWorkflowStepIterations`.
- `web/src/lib/workflow-trace-logic.ts` — the trace page's pure logic: `formatTokens` / `formatDuration` / `formatCost` (NULL ⇒ `—`, never 0), `statusLabel`, `isLiveRun`, `canRetryFrom`, `payloadView`, `timelineBars`, `dagRanks`.
- `src/db/queries/workflow-approvals.ts` — `parkWorkflowApproval` (upsert-in-place, clears the previous answer), `getWorkflowApproval(ById)`, `recordWorkflowApprovalAnswer` (CAS on `pending`), `hasPendingApproval` (what makes the chokepoint structural), `listPendingWorkflowApprovalsForUser` (the owner-scoped inbox join) vs. the **unscoped, host-side-only** `listPendingWorkflowApprovals`, `listExpiredWorkflowApprovals` / `expireWorkflowApproval` (both CAS on `pending`; the timeout sweep is their caller).
- `src/runtime/workflow-approval-timeout-sweep.ts` — `sweepExpiredWorkflowApprovals`: applies `onTimeout` to every parked approval past its deadline. Driven by the `HostMaintenanceDaemon`'s injected clock on **every** tick (its two sibling sub-ticks are modulo-gated; a deadline is a promise to a human, not housekeeping). Owns the system actor and the three fail-closed refusals.
- `src/runtime/workflow-step-output.ts` — `prepareStepOutput`, `prepareResolvedInput`, `MAX_STEP_OUTPUT_BYTES` (256 KiB), `MAX_RESOLVED_INPUT_BYTES` (64 KiB), `isTruncatedStepOutput`: **one** redact-then-measure path behind both payload columns.
- `src/runtime/workflow-definition-hash.ts` — `workflowDefinitionHash`: the drift fingerprint a resume compares unconditionally.
- `web/src/lib/workflow-approvals-logic.ts` — the inbox's pure logic: `buildAnswerBody`, `canSubmit`, `toggleItem`, `describeOutcome`, `describeDeadline`, `describeAge`.
- `src/startup/background-timers.ts` — starts the `WorkflowRunner` behind `EZCORP_DISABLE_WORKFLOW_RUNNER`, clearing the singleton on a refused or thrown `start()` so shutdown never releases a lockfile this process did not own.
- `src/runtime/workflow-refs.ts` — the shared ref grammar: `resolveMapping`, `resolveOutputMapping` (template interpolation), `resolveConditionRef`, `getNestedValue`, `templateRefs` (the read-only twin of the interpolator, so the validator's scan cannot see a different set of refs than the resolver), the `OMIT` sentinel, `RefContext.skippedSteps`.
- `src/runtime/workflow-condition.ts` — `evaluateCondition` (leaf operators + `all`/`any`/`not`, non-number-safe comparisons, explanatory reasons).
- `src/runtime/workflow-validator.ts` — `validateWorkflow` (shared by route + loader; optional `resolve` for the nesting walk, defaulting to the runtime registry), `validateCondition`, the skip/ref rule + its fixpoint `skippableSteps`, `clampMaxIterations` (1..25), `clampRetries` (0..2), `stepKind`.
- `src/runtime/workflow-closure.ts` — `collectWorkflowClosure`, `nestedWorkflowNames`, `MAX_WORKFLOW_NESTING_DEPTH`: ONE walk over `kind: "workflow"` edges, shared by the validator's cycle/depth check and (by design) C3's transitive capability hash. Cycles are detected against the current path rather than followed; expansion is memoized on `depth:name` so a shared subtree is re-checked from the deeper path.
- `src/runtime/workflow-model.ts` — the per-step model binding: `validateModelOverride` (definition-time shape + bounds + the `effort` vocabulary), `effectiveModelOverride` (step ?? definition), `resolveModelOverride` (refs → a concrete `ModelOverride`, loud on a bad value), `VALID_MODEL_EFFORTS`.
- `src/runtime/executor-helpers.ts` — `createPiLlmAdapter(overrides?)`: the ONE place a binding reaches the LLM; reports `lastResolved` back so a run can record what actually served it, and accumulates `usage` across every call it serves (undefined — never zeroed — until one actually reports).
- `src/runtime/workflow-loader.ts` — `loadYamlWorkflows`: globs `*.workflow.yaml` + legacy `*.pipeline.yaml` (deprecation warn), validates via `validateWorkflow`.
- `src/runtime/workflow-extension-loader.ts` — `loadExtensionWorkflows` / `collectExtensionWorkflowSources`: extension-shipped assets, namespaced + validated + warn-and-skip.
- `src/runtime/workflow-name.ts` — the ONE shared name grammar: `WORKFLOW_NAME_RE`, `EXTENSION_WORKFLOW_SEPARATOR`, `namespacedWorkflowName`, `isValidWorkflowName` (what an extension may DECLARE — separator illegal), `isResolvableWorkflowName` (what a caller may LOOK UP — bare or `<ext>:<name>`; what makes a C7 nested target statically knowable).
- `src/runtime/tools/run-workflow.ts` — the `run_workflow` built-in: two-field schema, authorization gate, DB-read role, 10-minute watchdog budget, run projection. Not in `getBuiltinToolDefs()`.
- `src/runtime/workflow-tools-host.ts` — `wireRunWorkflowForTurn`: the per-turn wire that supplies the RBAC coordinates from the turn closure.
- `src/runtime/stream-chat/setup-tools.ts` — `wireRunWorkflowIfEligible`: the depth-0 and owned-conversation gates, fail-soft.
- `src/runtime/mention-wiring.ts` — `applyWorkflowExpansion`, `formatWorkflowSection` (nonce fence), `sanitizeNoteValue`, `indicesWithinJoinBudget` / `joinWithinBudget` (shared `stop`/`skip` budget helper).
- `src/runtime/workflow-authz.ts` — the run/manage entry points `canRunWorkflow` / `canManageWorkflow`, implemented over the ladder in `workflow-scope.ts`. `canRunWorkflow` additionally re-checks that a namespaced workflow's owning extension is still installed AND enabled, read live from the DB — the cache cannot answer it, because `reloadWorkflows()` never fires on extension disable.
- `src/runtime/workflow/runtime-registry.ts` — `registerWorkflowRuntime` / `getWorkflowRuntime`: the import-direction bridge letting `src/` reach the web layer's live `WorkflowExecutor` + workflow cache. `getWorkflows` is a THUNK (the cache array is replaced on every CRUD write).
- `src/extensions/workflows-handler.ts` — `handleWorkflowsRpc`: the `ezcorp/workflows` enforcement ladder + hourly trigger quota.
- `packages/@ezcorp/sdk/src/runtime/workflows.ts` — the `Workflows` SDK client (`ctx.workflows.run`).
- `src/db/queries/workflows.ts` — `list/get/getByName/create/update/delete/claim/loadDbCachedWorkflows/loadDbWorkflows` against `workflow_definitions`, plus `WorkflowNameConflictError` (the 409 for a create or rename onto a taken name).
- `src/db/queries/workflow-versions.ts` — `ensureWorkflowVersion` (the ONE writer; mints only on an executable-content change), `versionStepsHash`/`versionMaterialKey`, `getLatest/list/get`, `getRunVersionLabel`, `backfillWorkflowDefinitionVersions` (the migration's one guarded backfill), `sweepWorkflowDefinitionVersions` (+ the `pinnedVersionIds` C3 extension point).
- `src/runtime/workflow-scope.ts` — `CachedWorkflow`, `resolveWorkflowForCaller`, `authorizeWorkflow`, `visibleWorkflows`, `isProjectMember`, `denialStatus`/`denialMessage`, `systemCachedWorkflow`, `callerFromUser`.
- `src/runtime/workflow-dry-run.ts` — `dryRunWorkflow`, `dryRunStub` (the path-answering Proxy), `dryRunAgentExecutor` (throws), `isPureDryRunKind` (an ALLOW list), `WorkflowDryRunViolation`.
- `src/runtime/workflow-fork.ts` — `bareWorkflowName`, `pickForkName` (bare name, then `-2`/`-3`/…).
- `web/src/lib/server/workflow-access.ts` — the ONE route↔ladder adapter: `resolveWorkflowOr`, `listVisibleWorkflows`, `toWire`.
- `web/src/lib/workflow-yaml.ts` — the editor's YAML tab: `parseWorkflowYaml`, `workflowToYaml`, `definitionFields`.
- `web/src/routes/api/workflows/{approvals,approvals/[id],runs/[id]/resume,runs/[id]/cancel}/+server.ts` — the inbox, the answer surface, and the two run-control levers. All four are boundary-only: they re-derive none of the rules behind `answerApproval` / `resumeParkedRun` / `cancelParkedRun`, they only map typed codes to HTTP.
- `web/src/routes/(app)/workflows/approvals/+page.svelte` — the approvals inbox UI.
- `src/db/schema.ts` — `workflowDefinitions` (+ `project_id`/`user_id`/`visibility`/`forked_from`), `workflowDefinitionVersions`, `workflowRuns` (+ `definition_version_id`, `cursor`, `run_phase`, `suspended_reason`, `resumable`, `claimed_by`, `lease_expires_at`, the `idx_workflow_runs_claimable` partial index), `workflowStepRuns` (+ `output`), `workflowApprovals`; `src/db/migrate.ts` renames `pipeline_definitions` → `workflow_definitions` in place, creates the run-history tables, and adds the ownership columns + versions table **next to the run-history block, not next to the `workflow_definitions` DDL** — `users` is not created until ~370 lines later, so an ALTER beside the original DDL would fail on a FRESH install only.
- `src/api-registry.ts` — the seven `workflows`-category route entries.
- `web/src/routes/api/workflows/**` — list/create, get/put/delete, run, dry-run, fork, versions, claim.
- `web/src/lib/api.ts` — `Workflow`/`WorkflowRun` client types + `fetch/create/delete/triggerWorkflowRun` helpers.
- `web/src/lib/workflow-builder-logic.ts` — framework-free builder logic (mirrors the server rules for client-side form UX).
- `web/src/lib/stores.svelte.ts` — `workflows` / `workflowRuns` state + the four `workflow:*` SSE handlers.
- `web/src/routes/(app)/workflows/{+page,[name]/+page,[name]/edit/+page,new/+page}.svelte` — list / detail+run+fork / editor+dry-run / create UI; `web/src/routes/(app)/pipelines/+page.server.ts` — the 308 redirect.
- `web/src/lib/components/{WorkflowBuilder,WorkflowStepForm}.svelte` — the create form, reused by the editor. Models all four step kinds and both model-binding levels because the editor LOADS: a form that could not represent a `tool` step or a `model` override would silently delete them on save (`definitionToDrafts` is the asserted inverse of `stepToPayload`).
- `src/cli.ts` — `workflow:list` / `workflow:run` commands + hidden `pipeline` alias.
- `src/agents/demo-{deterministic,loop-counter,mixed}.workflow.yaml` — the shipped demo workflows.
- `src/agents/extension-author.workflow.yaml` — the authoring chain (tool + gate steps, parks `awaiting_approval`).

## Features it touches

- [[agents]] — every `agent` step invokes one agent by name via `AgentExecutor.runAgent`; agent orchestration is one of the three step kinds.
- [[runs-lifecycle]] — each agent step produces a real `AgentRun` (its `runId`/status copied onto the step run); transform/gate steps mint no run. The `AgentStatus` union is shared.
- [[streaming-runtime]] — the `workflow:*` events ride the same `AgentEvents` bus / SSE channel that streams agent runs to the browser.
- [[teams]] — the sibling multi-agent subsystem; workflows are the **declarative-graph** alternative (no per-member tool-scoping, no roster). Both are now chat-reachable: a team via `![team:…]`, a workflow via `![workflow:…]` + `run_workflow`.
- [[projects]] — `projectId` threads through to each `runAgent` call, though workflows themselves are not project-listed.
- [[api-security]] — every route is gated by `requireScope` + `requireAuth`; the by-name routes add the ownership ladder, and `…/run` adds the extension-liveness re-check on top.
- [[rbac-and-permission-modes]] — an `approval` step's `rbacScope` is checked through `hasExtensionScope` at the strictest coordinates (NULL project, NULL extension), fail-closed: a throw is a DENY.
- [[ask-user]] — the verbatim relay is how a parked approval reaches a human through an LLM without being answered on their behalf.
- [[hub-pages]] — the Hub's approvals tab is the second answer surface, registered as a host-side page provider.
- [[developer-api-keys]] — the `read`/`chat` scope checks make workflows callable by scoped API keys, not just session users.
- [[database-and-migrations]] — DB workflows persist in `workflow_definitions` (migrated in place from `pipeline_definitions`).

## Related docs

None yet — this is the primary reference.

## Notes & gotchas

- **`awaiting_approval` is not success and not error.** A run that completed its automatable steps and then hit one needing human consent terminalizes `awaiting_approval`, with `result.output` set to the LAST SUCCESSFUL step's output (the handoff payload) so the parked run is actionable. Anything branching on `status === "success"` (the CLI exit code, the client store) treats it as non-success for free — but code that branches on `status === "error"` will NOT match it.
- **The parked capability name is collapsed.** `executeToolCall` maps all four `SENSITIVE_KINDS` onto the two the always-allow layer keys on (`shell` / `fs.write`) before opening the gate, so an `ezcorp:extension:install` park reports `…requires interactive approval for capability fs.write…`. The message reports what the gate was given, not the PDP's true capability.
- **Never gate a resume-shaped affordance on `resumable`.** It reads like the obvious condition and it is the wrong one: `resumable` is the recovery sweep's verdict on a **crashed** run, and `suspendWorkflowRun` pointedly never sets it, so every *deliberately* parked run — which is every approval-parked run — carries `false`. `listClaimableWorkflowRuns` documents this for the daemon; `canRetryFrom` made exactly the mistake anyway and hid the button on the entire population it exists for. The authority is `resumeParkedRun`, which gates on `status = 'suspended'` alone. What let it through was a **mocked e2e fixture that set `resumable: true`** — a value the production path never produces — so the mock agreed with the bug; it is now pinned by a real parked run driven through the real trace read (`src/__tests__/workflow-run-trace.test.ts`).
- **A step's `durationMs` is NOT on the `workflow:step` SSE payload**, and must not be put there. `WorkflowStepRun` is a published payload and is compared byte-for-byte by the demo determinism test — "a transform/gate-only workflow is a pure function — no LLM, no I/O, no clock" — so a wall-clock reading on it makes two identical runs differ whenever they straddle a millisecond (observed: 4 failures in 20 runs). It lives in the executor's per-step closure and goes straight to the column, the same treatment `output` and `resolved_input` get for the separate reason that they carry payloads.
- **A run trace is 404 for a stranger, while a run CANCEL is 403.** Deliberate, not an inconsistency: by the time a caller cancels a run they have already been told it exists, whereas a trace carries `resolved_input` and `output` and a 403 would make the endpoint an existence oracle. `workflow-scope.ts` draws the same read/edit line for workflows themselves.
- **The trace read does NOT use C6's `resolveWorkflowForCaller`, and that is the tighter choice.** The C6 ladder answers a question about the *workflow*, and for `visibility: "system"` its `read` answer is "anyone" — and every row that existed at C6's migration is `system`. Routing a run trace through it would let any authenticated caller read any other user's payloads for a shared workflow. A run's payload belongs to whoever fired it, not to whoever may see the graph, so workflow visibility can only ever narrow `mayControlRun`, never widen it.
- **Workflow spend does NOT reach the observability dashboard, and cannot without a change there.** `obs:turn` is emitted in exactly one place (`src/runtime/stream-chat/finalize.ts`) and a workflow `agent` step never traverses it — `configToAgent` calls `ctx.llm.complete` directly. Even if it did, `insertObservabilityEvent` requires a `conversationId` and `observability_events.conversation_id` is `NOT NULL` FK to `conversations`, which the synthetic `workflow-run:<id>` scope key has no row for. This is the same structural fact as the `tool_calls` gotcha below. `workflow_step_runs` is the authoritative per-step cost record; a dashboard that wants factory spend must learn to read it as a second source rather than the events table being widened.
- **A NON-INTERACTIVE workflow tool step writes no `tool_calls` row.** `tool_calls.conversation_id` is an FK to `conversations`, and the synthetic `workflow-run:<id>` id has no row, so `persistToolCall` (which never throws by contract) silently drops it; the PDP's own audit row and `workflow_step_runs` carry the trail instead. In **interactive** mode (a run started by the `run_workflow` tool) the scope key IS a real conversation id, the FK resolves, and the row is written normally — so the same step audits differently depending on which path started the run.
- **The builder models all four step kinds and both model-binding levels.** It has to: the editor LOADS a saved definition into the same form, so a form that could not represent a `tool` step or a `model` override would silently DELETE them the moment the user pressed Save. `definitionToDrafts` is the asserted inverse of `stepToPayload`, per step kind.
- **A model binding on a non-agent step is an error, not a no-op.** `transform`/`gate`/`tool` steps run no LLM, so a binding there would be silently ignored — the validator rejects it instead.
- **`workflow_step_runs.provider`/`model` are NULL for pre-existing rows** and for the `running` write (the agent has not resolved anything yet); the terminal write fills them in. NULL therefore means "no LLM ran, or this row predates the columns" — it never means "unknown model".
- **An agent config's own `temperature`/`maxTokens` are still not forwarded on the `runAgent` path.** `createPiLlmAdapter` only sends sampling options that an explicit override supplied — this is unchanged pre-existing behaviour, deliberately left alone so the no-override path stays byte-identical. A workflow step that wants a temperature must say so in its `model` binding.
- **`awaiting_approval` and `suspended` are different states — do not conflate them.** `awaiting_approval` is **terminal**: a `tool` step hit a consent gate a workflow structurally cannot satisfy, so the run is parked AND dead. `suspended` is **not terminal**: an `approval` step parked deliberately, the cursor records where to pick up, and a resume continues it in place. Reusing `awaiting_approval` for the second would retroactively make every historical row of that status look resumable. Only `suspended` runs are claimable, resumable or answerable.
- **The clock can only ever `abort` a gate a human was required to clear.** The timeout sweep answers through `answerApproval` as a system actor (`{ userId: null, isAdmin: true }`) — that admin flag is load-bearing, because with no `rbacScope` declared the run's OWNER answers and an unowned run is admin-only, so a sweep answering as nobody is refused on every row. What it deliberately does **not** get is a `checkScope`, and it will not send `consentAll` or echo the offered `itemIds` back. So a **scope-gated** approval and one with **outstanding consent items** cannot be auto-answered at all: both fail closed to `abort`, the run is `cancelled`, and the reason is logged. `onTimeout: approve` on either is therefore an elaborate way of writing `abort`.
- **The sweep never expires a row without also applying its policy.** An `expired` approval deliberately **re-parks** when the step is re-entered (`workflow-executor.ts:1494-1499`), with a fresh `expires_at`. A sweep that only flipped the status would hand the run back to the executor to park again, then expire it again — forever. Every path either applies a policy or leaves the row exactly as it found it, which is also why an unresolvable policy (no registered runtime, a deleted definition, a renamed step) **defers** rather than defaulting to `abort`: guessing there would cancel every parked run on a backend-only boot.
- **`onTimeout: approve|skip` must declare that string in `choices`.** The sweep answers with the policy NAME as the choice, and the consent guard rejects an undeclared choice rather than coercing it — so `onTimeout: approve` over `choices: [ship, hold]` could only ever fail. The validator rejects it at definition time; a definition stored before that rule still falls back to `abort` at run time.
- **`POST …/run` is synchronous by default.** It awaits the whole graph before responding. `X-EZ-Workflow-Async: 1` is the opt-in, and only exactly `"1"` counts — a header that accepted `"0"`/`"false"` as async is the sort of thing nobody notices until a workflow they expected to have finished has not. The 202 carries an id the route mints itself; deriving it from the `workflow:start` frame would be a race against a response with no ordering guarantee.
- **The async branch swallows nothing that matters, and logs what is left.** Executor-level failures land in the run row; only a bug can escape, and that is logged rather than left as an unhandled rejection which would take the process — and every other run in flight — down.
- **A workflow's `rbacScope` on an approval decides *alone*.** It does **not** additionally require ownership. If you want "the owner, and only the owner", declare no scope. Getting this backwards in either direction is a security bug: adding an ownership requirement breaks reviewer-answers-someone-else's-gate, and dropping the owner branch re-opens "any authenticated caller may answer any unscoped approval".
- **The per-turn tool-call budget resets across a suspend.** The teardown that runs when a run parks is otherwise identical to a terminal one — scope deregistered, listeners removed, `toolCallsThisTurn` cleared. It is a runaway-loop guard, not an accounting ledger; persisting it would make a long-parked run un-resumable for a reason no operator could diagnose (`src/runtime/workflow-executor.ts:1008-1042`).
- **A `success` step whose output never landed makes the run unresumable, by design.** `persistStep()` is fire-and-forget and never throws, and `completedSteps` is appended *before* it. `loadStepResults` refuses rather than rehydrating an empty `$steps` — a loud refusal instead of a silent wrong answer. Do not "fix" the loader to be lenient.
- **A step output over 256 KiB is not resumable.** `prepareStepOutput` replaces it with a truncation sentinel, and a resume that needs it refuses by name.
- **Cancelling a `running` run marks the row, not the work.** The executor owns its own abort signal; `cancelParkedRun` does not reach into an in-flight batch. A daemon-held run stops at its next boundary.
- **`resumable` is the sweep's flag, not a general one.** It is set only by `terminalizeOrphanedWorkflowRuns` on a crashed run it judged safe to continue. A deliberately parked run never carries it, and nothing filters candidates on it.
- **Ownership authorizes; it does not namespace.** `workflow_definitions.name` is still **globally unique** and deliberately not composite with `project_id`: the cache is a flat array and lookup is `find(w => w.name === name)`, so a composite key would let two rows share a name and hand a caller in project B project A's graph. The cost is real and stated: two projects cannot both own `deploy`, and the second create is a **409**. Fork auto-suffixes.
- **Every pre-existing row is `system`, and that is what makes the upgrade safe.** `visibility TEXT NOT NULL DEFAULT 'system'` is the whole migration — no backfill, no inference — and `system` authorizes exactly the callers who could run a workflow before the ladder existed.
- **Non-admins lose EDIT access to workflows they created.** A deliberate, known regression: those rows are all `system`, and `system` is admin-only to edit. Ownership is **not** inferred from `workflow_runs.user_id` — that is a guess, and guessing ownership is how you hand someone's workflow to the wrong person. The remedy is the audited admin `POST …/claim` action, which states the owner explicitly and is reversible.
- **The list route returns fewer entries than it used to.** A `read`-scoped API key with no project context sees `system` workflows only. Anything scripted against the full list gets a shorter array (same shape, plus additive provenance fields).
- **A skipped step is `skipped`, and a run is never `skipped`.** `WorkflowRunStatus` is shared by runs and step rows, but only a *step* takes this value. Code branching on `status === "error"` will not match it, and neither will code branching on `"success"` — which is the point: a skipped step is neither.
- **`skipDependents` is read off the SKIPPED step, never off the dependent.** Only the producer knows whether its absence is survivable; a consumer cannot opt itself into running against a value nobody produced. Declaring `skipDependents: false` on the *dependent* does nothing.
- **`$steps.<skipped>` still throws — the skip changes the message, not the strictness.** Substituting `undefined` would hand a downstream step a broken value. `validateWorkflow` makes the throw unreachable by requiring the reader to declare the dependency, but a definition that predates the check still hits it at run time, with a message naming the fix.
- **A skipped step never becomes `$prev`, and a fully skipped batch leaves `$prev` alone.** `prevResult` and `cursor.prevStepName` are taken from the same index — the last EXECUTED slot — so a resumed run rebuilds the same `$prev` the straight-through run saw.
- **`workflow_step_runs.skipped_reason` is C5's column and does not exist yet.** The reason is in memory and on the `workflow:step` SSE frame; the persisted row carries `status = 'skipped'` alone, so a resume rehydrates a generic reason (`REHYDRATED_SKIP_REASON`). Wiring the column is a one-line change at the `upsertWorkflowStepRun` call site once phase 3 lands.
- **A nested workflow target cannot be a ref.** `workflow: "$input.child"` is a definition-time error, not a clever feature. If you need to choose between graphs at run time, branch with `when` over two `kind: "workflow"` steps — the reachable set stays statically knowable, which is what the cycle check, the depth cap, the definition hash and C3's consent closure all read.
- **A nested workflow step is not available without a `workflowResolver`.** The executor has no registry of its own, so composition is wired, not assumed. The server wires it; the **CLI deliberately does not** — a CLI run carries no principal, and resolving a nested workflow without one would bypass the authorization the server-side resolver applies. A `kind: "workflow"` step under `ezcorp workflow run` therefore fails loudly rather than running unauthorized.
- **The nesting depth cap is enforced at run time, and the run-time check is the authoritative one.** A chain can be formed across sources (a YAML workflow naming a DB row that names an extension asset) that no single `validateWorkflow` call can see whole. The definition-time check is an early, better-worded copy — not a replacement.
- **A parent whose child parks is `suspended` with reason `nested-suspended`, and neither run resumes the other.** The daemon picks each up independently. Answering the child's approval resumes the *child*; the parent continues on the daemon's next tick, finds the child by its derived `idempotency_key`, and returns its result. A parent that could not find its child would dispatch a second one and duplicate its side effects.
- **`idempotency_key` is now load-bearing for nesting.** It had no writer before C7. A caller that starts using it for its own correlation must not collide with the `nested:<parent>:<step>#<n>` shape, and the partial unique index on `(workflow_name, idempotency_key)` is what enforces the nested invariant.
- **A racing duplicate insert is swallowed, by the standing persistence contract.** `insertWorkflowRun` runs through the never-throwing `persistWrite`, so if two processes somehow raced past the re-entrancy lookup, the unique index would reject the second row and the second child would execute with no row. The lookup makes the window narrow; it does not close it.
- **The nested closure walk has one caller today.** `collectWorkflowClosure` was built as the single shared walk for the validator *and* C3's transitive capability hash; C3 has not landed, so the second caller does not exist yet. Reach for this function rather than writing a second walk.
- **`$prev` is order-fragile in parallel batches.** Within a batch, `prevResult` is the last **successful** result in array order (the last declared step of that batch), not a graph-deterministic "previous". Prefer explicit `$steps.<name>` for parallel graphs.
- **Fail-fast is loud.** The first non-`success` step (or a thrown gate, or an exhausted loop) fails the run; still-dispatched siblings are cancelled and no later batch starts. Retries (agent, ≤2) and loops are the only bounded re-execution.
- **YAML vs DB asymmetry.** YAML workflows are read-only via the API (only DB workflows can be PUT/DELETE'd). Editing a YAML workflow means editing the file and reloading.
- **Name collisions aren't de-duped.** The merged cache is `[...extension, ...yaml, ...db]`; `find(w => w.name === …)` returns the first match. The DB enforces `name` unique only within the table. Extension entries are namespaced (`<ext>:<name>`) and ordered first, so they can neither shadow nor be shadowed — but a YAML and a DB workflow sharing a bare name still both appear (YAML first).
- **An extension-shipped workflow is visible to anyone, and runnable by anyone while its extension is live.** Namespacing bounds *naming*, not *access*, and extension/YAML assets are `system` — they ship with the install, so any authenticated `chat`-scoped caller can run `<ext>:<name>` with arbitrary input — but only while that extension is still installed and `enabled`, which the run path re-checks against the DB on every call. There is no per-user scoping on extension workflows (an extension asset has no author). `permissions.workflows` gates only the extension-code trigger path. Fork one to get a scoped copy you own.
- **Disabling an extension does not evict its workflows from the cache.** `reloadWorkflows()` fires on workflow CRUD only — never on extension install, uninstall or disable. So a disabled extension's workflows keep appearing in `GET /api/workflows` and on `/workflows` until a workflow is written or the process restarts. They are no longer *runnable* (the liveness re-check fires at run time), but the listing is stale and the refusal is the only signal.
- **`projectId` field-name collision.** The client helper folds `projectId` into the input object and the route splits it back out, so a workflow needing an input field literally named `projectId` cannot receive it through the standard path.
- **`inputSchema` is advisory.** It is stored and surfaced but not enforced at run time.
- **Legacy compatibility is one release only.** The `*.pipeline.yaml` glob, the `ezcorp pipeline` CLI alias, and the `/pipelines` redirect all warn/deprecate and are slated for removal.

### Out of scope (deliberately not built)

**Resuming an `awaiting_approval` run** — that status stays terminal; only `suspended` runs resume (and note it can only arise on the non-interactive path). **Enforcing the approval timeout** — the columns and the validation exist, the sweep does not (above). A read API or UI over the persisted run history; looped tool steps; arbitrary-code (JS) steps; a UI YAML editor; distributed scheduling for the runner (the lease makes a second host *safe*, it does not coordinate them). Per-step **cost** telemetry (tokens, USD) is also still out of scope — only the resolved provider/model is recorded.

Async / background runs and resuming a **parked** run are no longer out of scope — see the async header, `WorkflowRunner`, and the two run-control routes above.

**Nested sub-workflows** exist as a `kind: "workflow"` step (C7). What stays actively blocked is reaching a workflow through the `run_workflow` TOOL from inside one: it is not wired at `orchestrationDepth > 0`, so a workflow's `agent` step cannot start another workflow that way (see **The chat path** for why the always-allow blast radius, not just the recursion, is the reason).

The **chat path is no longer out of scope** — it was, until `![workflow:…]` and `run_workflow` landed. What remains deliberately absent there is any way to run a workflow from a mention alone: referencing and executing stay separate.
