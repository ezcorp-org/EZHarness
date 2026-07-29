# Workflows

> _Declarative graphs that orchestrate a mix of **agent** steps (invoke one agent), **tool** steps (invoke one deterministic extension tool), **transform** steps (pure, declarative data reshapes — no LLM, no I/O), and **gate** steps (assert a declarative condition). Any agent/transform step may **loop** with a bounded until-condition. The executor topo-sorts steps into parallel batches with fail-fast, loud-failure semantics._

## Intent

A workflow is a named, reusable graph of steps. Where a single `@agent` run answers one prompt, a workflow chains steps: step B can depend on step A and consume A's output. Workflows are the renamed, extended successor to the old **pipelines** subsystem — they exist as a **separate subsystem from teams** (no chat-mention sigil, no per-member tool-scoping, no conversation). They are defined (in YAML or the DB), listed, and fired through a small REST surface and a dedicated `/workflows` UI. The runner is intentionally thin: topo-sort, fan out each batch with `Promise.all`, thread prior outputs into dependents, emit SSE events, halt loudly on the first failure.

Three design constraints are load-bearing (not stylistic):

1. **Hard rename, no API aliases.** This is a self-hosted, versioned product, so every in-repo caller was updated. The only compatibility kept is a hidden CLI alias (`ezcorp pipeline …` → `ezcorp workflow …`) and a legacy YAML glob (`*.pipeline.yaml` still loads, with a deprecation warning) — both for one release.
2. **No arbitrary code steps.** DB workflows are creatable by any `chat`-scoped caller, so deterministic steps must be **declarative** (a mapping/condition DSL), never evaluated JS. This is a security constraint.
3. **Loud failure.** Loop exhaustion fails the run by default, gates throw with a descriptive message, and nothing silently truncates.

`kind` defaults to `"agent"`, so **every legacy pipeline definition (YAML or DB row) remains valid with zero edits.**

## How it works

### Data model (`src/types.ts`)

- `WorkflowDefinition` = `{ name, description, inputSchema?, defaultModel?, steps }`.
- `WorkflowStep` = `{ name, kind?, agent?, tool?, input?, retries?, output?, condition?, model?, dependsOn?, loop? }`. `kind` is one of `"agent" | "tool" | "transform" | "gate"` (default `"agent"`).
  - **agent** — `agent` is an agent name resolved by `AgentExecutor`; `input` is a `Record<string,string>` of input mappings; `retries` is a per-step retry budget (clamped 0..2); `model` is a per-step model binding (see **Per-step model bindings**).
  - **tool** — `tool` is a runtime-namespaced extension tool (`<extension>__<tool>`, e.g. `extension-author__create_extension`) dispatched through `ToolExecutor.executeToolCall`. `input` uses the **same** ref language as an agent step (there is deliberately no second grammar). `agent` is forbidden; `loop` is forbidden (see gotchas).
  - **transform** — `output` is a `Record<string,string>` output mapping (same ref language as inputs, plus `{{…}}` template interpolation). Pure: no LLM, no I/O, no clock.
  - **gate** — `condition` is a `WorkflowCondition` tree.
- `WorkflowCondition` = a leaf `{ ref, op, value? }` or a composite `{ all: [] } | { any: [] } | { not: … }`. Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `exists`, `truthy`.
- `LoopConfig` = `{ maxIterations, until?, onExhausted? }` — `maxIterations` is **required** (server-clamped 1..25); `until` is a `WorkflowCondition` evaluated after each iteration; `onExhausted` is `"fail"` (default) or `"pass"`.
- `WorkflowRun` = `{ id, workflowName, projectId?, status, startedAt, finishedAt?, steps: WorkflowStepRun[], result? }`; `WorkflowStepRun` = `{ stepName, runId, status, iterations?, provider?, model? }` (`iterations` is the final count for a looped step; `provider`/`model` are the binding the step's LLM call **resolved** to). `status` is `WorkflowRunStatus` = the agent `AgentStatus` union **plus `awaiting_approval`** (see below).
- `ModelOverride` = `{ provider?, model?, temperature?, maxTokens? }` — a model binding. The four fields are exactly the ones `ctx.llm.complete` accepts, so every field a user sets demonstrably takes effect. `provider`/`model` may be refs in a definition; `resolveModelOverride` makes them concrete.
- The DB table `workflow_definitions` (`src/db/schema.ts`) stores `id` (UUID PK), `name` (unique), `description`, `inputSchema` (jsonb), `defaultModel` (jsonb, nullable), `steps` (jsonb), `createdAt`/`updatedAt`. A migration renames the legacy `pipeline_definitions` table in place (data preserved). It has **no** owner/user/project column — workflows are global (see gotchas).

### Loading & the in-memory cache (`workflow-loader.ts` + `context.ts`)

Workflows come from **three sources, merged into one in-memory array** at boot:

1. **Extension assets** — `loadExtensionWorkflows()` (`workflow-extension-loader.ts`) globs `*.workflow.yaml` at the root of each installed extension's **own install path** (`ExtensionRegistry.getInstallPath` — deliberately NOT the host's agents dir) and renames every definition to **`<extensionName>:<declaredName>`**. See **Extension-shipped workflows** below.
2. **YAML** — `loadYamlWorkflows(dir)` globs both `*.workflow.yaml` and the legacy `*.pipeline.yaml` (deprecation warning on the latter) in the agents dir (`resolveAgentsDir()`, overridable via `EZCORP_AGENTS_DIR`, default `src/agents/`), parses each with the `yaml` package, and runs the shared `validateWorkflow`; any invalid file is skipped with a warning (warn-and-continue, never throws).
3. **DB** — `loadDbWorkflows()` (`src/db/queries/workflows.ts`) maps every `workflow_definitions` row to a `WorkflowDefinition`.

`context.ts`'s `buildWorkflowCache()` concatenates them: `workflows = [...extensionWorkflows, ...yamlWorkflows, ...dbWorkflows]` (ONE definition, shared by boot and by every CRUD-triggered `reloadWorkflows()`). There is still no de-duplication — lookup is `find(w => w.name === name)`, so the **first** entry wins a name. Extension entries go first so a `workflow_definitions` row a `chat`-scoped user deliberately named `some-extension:deploy` cannot hijack that extension's asset.

### Extension-shipped workflows (`workflow-extension-loader.ts`)

An installed extension may ship `*.workflow.yaml` files at the root of its install directory; they appear in `GET /api/workflows`, on `/workflows`, and run through the same `POST /api/workflows/[name]/run` route as everything else. Shipping one is an **asset**, not a permission (like declaring a tool) — *triggering* one from extension code is the privileged act, gated by `permissions.workflows`.

Namespacing is the load-bearing security property. Without it an extension could ship a workflow named `demo-deterministic` and silently shadow the host's in the un-de-duplicated cache. Two rules make that impossible:

- Every definition is renamed `<extensionName>:<declaredName>` before it enters the cache — the declared name is never used verbatim.
- A declared name carrying the `:` separator is **rejected** (warn + skip), so an extension can neither forge another extension's namespace nor produce an ambiguous prefix.

Extension names are admit-time-validated against `/^[a-z0-9][a-z0-9-_.]{0,63}$/` (no `:`), so a namespaced name always carries exactly one separator and can never equal a bare host name. The grammar for both halves lives in exactly one place — `src/runtime/workflow-name.ts` (`WORKFLOW_NAME_RE`, `EXTENSION_WORKFLOW_SEPARATOR`, `namespacedWorkflowName`, `isValidWorkflowName`) — shared by the loader, the manifest validator, the permission clamp and the reverse-RPC handler so they cannot drift.

Each file is validated with the same shared `validateWorkflow`; invalid files, unparseable YAML, bad names, unreadable install dirs and intra-extension duplicate names are all **warn-and-skip**. The loader never throws — a broken asset in one extension must not take down boot or block a later extension.

### Execution (`workflow-executor.ts`)

`WorkflowExecutor` is constructed once with the singleton `AgentExecutor` + the `AgentEvents` `EventBus`. `runWorkflow(workflow, input, projectId?, userId?, signal?)`:

1. Mints a `WorkflowRun` (`crypto.randomUUID()`, `status: "running"`) and emits **`workflow:start`**.
2. **`resolveExecutionOrder(steps)`** computes batches:
   - If **no** step has `dependsOn`, steps run strictly **sequentially** — one step per batch, in declared order.
   - Otherwise a **topological sort** groups steps whose deps are all resolved into the same batch; an empty batch with steps remaining ⇒ **`Circular dependency detected`** thrown.
3. For each batch, all steps run **in parallel** (`Promise.all`). Per step, the executor dispatches by kind (and delegates to the loop runner if the step declares a `loop`):
   - Push a `WorkflowStepRun` (`status: "running"`), emit **`workflow:step`**.
   - **agent** — resolve `input` via the ref language, run the agent (up to `1 + clampRetries(retries)` attempts; a *cancelled* run is never retried), copy `agentRun.id`/`status` onto the step run. A genuine failure after the budget throws `Step "<name>" failed: <error>`.
   - **transform** — resolve `output` (refs + `{{…}}` templates) into `{ success: true, output: <object> }`. `stepRun.runId` stays `""` (no agent run).
   - **tool** — resolve `input` via the ref language, dispatch `ToolExecutor.executeToolCall(tool, resolvedInput, <synthetic conversationId>, null)`, and return `{ success: true, output: parseToolOutput(<tool text content joined with newlines>) }`. An `isError` result or a thrown dispatch error throws `Step "<name>" failed: <text>` (the RAW text — an error message is for a human). A sensitive-capability approval prompt fails the step with `WorkflowApprovalRequiredError` — see **Tool steps & the approval guard** below.
   - **gate** — evaluate `condition`; `true` ⇒ `{ success: true, output: { passed: true } }`; `false` ⇒ throw `Gate "<name>" failed: <human-readable explanation of the decisive leaf>`.
   - The first failure records the batch error and **cancels still-running siblings** via the abort plumbing.
4. After each batch, `prevResult` is set to the **last successful result in that batch** (array order) — this is what `$prev.*` reads next.
5. On clean completion: `status:"success"`, `result = prevResult`, emit **`workflow:complete`**. On failure: `status:"error"` (or `"cancelled"` for an external abort, or `"awaiting_approval"` when a tool step needs human consent), emit **`workflow:error`**.

`runWorkflow` is **fully awaited** — it returns the terminal `WorkflowRun` (the run route blocks until the whole graph finishes).

### Tool steps & the approval guard (`workflow-tool-runner.ts` + `tools/permissions.ts`)

A tool step runs through the host's **one** tool dispatch path, so it is authorized, audited and provenance-tracked exactly like a chat-driven call. Three things make that safe without a conversation:

1. **Fail fast on `prompt`, never hang.** The PDP returns `decision: "prompt"` for any `SENSITIVE_KINDS` capability (`shell`, `fs.write`, `ezcorp:extension:install`, `ezcorp:extension:modify`) with no always-allow row. In a chat turn a modal answers it; in a workflow **nobody can**. `runWorkflow` registers its scope key via `beginNonInteractiveScope()`, so `createExtensionPermissionGate` **rejects synchronously** (`NonInteractiveApprovalRequiredError`) instead of parking a promise. The executor turns that into `Step "<n>" requires interactive approval for capability <kind> and cannot run in a workflow` and terminalizes the run `awaiting_approval`.
2. **The gate can now be torn down.** `createExtensionPermissionGate` accepts an optional `timeoutMs` and `signal`. Both default to unset, so the **chat path's behaviour is byte-identical** (block until answered). A cancelled workflow aborts its scope signal, which rejects every gate pending under its key with `PermissionGateAbortedError`.
3. **Structured output, so a tool step can be chained.** `parseToolOutput` (exported from `workflow-executor.ts`) projects the joined text into the value later steps address: a JSON **object or array** is parsed, everything else is returned verbatim. Extension tools overwhelmingly return `JSON.stringify(...)` of a result object, and leaving that opaque made a tool step permanently TERMINAL — no way to thread `draftId` into the next step's `input`, and a gate could only substring-`contains` the blob instead of asserting `pass === true`. Deliberately conservative: a bare `42` / `"true"` / `null` stays a **string** (parsing it would change the value's TYPE and silently break an existing `eq`/`contains` condition), and text that merely looks like JSON stays a string rather than becoming a silent `{}`.

4. **An honest `conversationId`.** A workflow has none, so the executor mints `workflow-run:<runId>` (`workflowScopeKey()`). An **empty string** would fail *open* — `shouldDeliverEvent` short-circuits on a missing `conversationId` and broadcasts to every SSE subscriber, and it nulls out the sec-H2 ownership check in `routes/tool-permission.ts`. The synthetic id fails *closed* everywhere instead: `getConversation()` returns null so the SSE filter denies delivery, and `resolveExtensionScopeGrant` derives `projectId = null` (the strictest RBAC coordinate). `userId` is threaded to `ToolExecutor.setCurrentUserId` so the call is not ownerless.

### Run persistence (`workflow_runs` + `workflow_step_runs`)

`new WorkflowExecutor(agentExec, bus, { persist: true })` (the server and the CLI) mirrors every run to the DB; the default is `false` so unit harnesses without a DB are unaffected. Writes never throw — a DB glitch cannot fail a workflow that otherwise succeeded.

- `workflow_runs` — the executor's **already-minted** `id` (never a column default: it is already in the `workflow:start` payload and the scope key), `workflow_definition_id` (nullable FK — YAML workflows have no row; `SET NULL` keeps history after a delete), `workflow_name` (denormalized so history survives a rename), `project_id`, `user_id` (`SET NULL`, same IDOR-guard rationale as `runs.user_id`), `status`, `input`, `result`, `started_at`, `finished_at`.
- `workflow_step_runs` — one upserted row per step on `(workflow_run_id, step_name)`; `run_id` is a **nullable** FK to `runs.id` (transform / gate / tool steps mint no AgentRun and carry the in-memory `runId = ""` sentinel, which the query layer maps to SQL NULL).
- `finalizeWorkflowRunRow(id, status, result?)` is an idempotent CAS on `status='running'` — a retry or a racing boot sweep is a zero-row no-op and never clobbers a richer terminal state.
- `terminalizeOrphanedWorkflowRuns()` runs at boot (`web/src/lib/server/context.ts`): a fresh process owns zero in-flight workflow runs, so any row still `running` was orphaned by a crash/restart and is drained to `error`. Both shipped from day one — see the scar recorded on `queries/runs.ts:finalizeRunRow`.

### Loops (`runLoop`)

A step with a `loop` repeats up to `clampMaxIterations(loop.maxIterations)` (1..25) times, evaluating `until` **after** each iteration:

- Allowed on **agent** and **transform** steps; invalid on a **gate** and on a **tool** (repeating a side-effecting install/write/shell call with no LLM in the middle is deliberately out of scope). `loop` and `retries` are **mutually exclusive** (definition-time error) so the worst-case cost stays bounded.
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
    model: { provider: anthropic, model: claude-opus-5, temperature: 0.1, maxTokens: 8000 }
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
- **Fields — exactly four:** `provider`, `model`, `temperature` (0..2),
  `maxTokens` (integer 1..1,000,000). These are 1:1 with what
  `ctx.llm.complete` accepts (`config-to-agent.ts`), which is the whole
  rule: a binding may only carry knobs that demonstrably take effect. An
  **unknown field is rejected**, so `maxtokens:` is a definition-time
  error, not a silently-ignored typo.
- **There is deliberately NO `effort` / reasoning field.**
  `ctx.llm.complete` has no reasoning parameter, and `ctx.llm` is typed
  `any`, so an extra key would compile and silently do nothing. Reasoning
  effort is real in this codebase but lives on the other path
  (`thinkingLevel`: `streamChat` → `build-pi-agent.ts`), which an agent
  step never reaches. Supporting it means plumbing `thinkingLevel`
  through the agent execution path — a separate change to the streaming
  runtime. See the note at the top of `workflow-model.ts`.
- **Refs work.** `provider` / `model` accept the same ref
  language as a step's `input` (`{ model: "$input.verifyModel" }`),
  resolved through the shared `resolveMapping` with the **same ref
  context as that step's input** — so a looped step re-resolves per
  iteration (`$loop.last.…` can escalate the model on a retry) while a
  retried step resolves once (a retry re-runs the agent, it does not
  re-pick the model). `temperature`/`maxTokens` are numbers and are
  therefore never refs. A `$input.x` ref whose field is unset means "no
  override for that field"; a ref resolving to a non-string, or an
  a ref resolving to a non-string, **fails the run loudly** naming the
  step.
- **Where it is applied.** The binding is threaded
  `workflow-executor → AgentExecutor.runAgent(name, input, projectId, userId, override) → createPiLlmAdapter(override)`
  — one chokepoint, so no `AgentDefinition` knows about it and the
  override cannot be half-applied. A nested `ctx.run(...)` spawn inherits
  the parent's **identity**, never its model binding.
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

**Template interpolation** (transform `output` only): any value containing `{{ ref }}` has each placeholder resolved as a strict ref and string-interpolated (objects are `JSON.stringify`-ed; `null`/`undefined`/omit render empty). A value with no `{{…}}` is resolved as a direct ref instead.

### Conditions (`workflow-condition.ts`)

`evaluateCondition(cond, ctx)` returns `{ passed, reason }`; `reason` names the decisive leaf so a failing gate explains itself. `all`/`any`/`not` compose leaves. Leaf operators: `eq`/`neq` (deep-equal for objects), numeric `gt`/`gte`/`lt`/`lte` (a comparison on a **non-number evaluates false**, never throws), `contains` (string-substring or array-includes), `exists` (not `undefined`/`null`), `truthy`. Only an **unresolvable strict root ref** (`$prev` with no previous result, `$steps.<unknown>`) throws.

### Definition-time validation (`workflow-validator.ts`)

`validateWorkflow(def)` returns a list of human-readable errors (empty ⇒ valid). It is the **single shared validator** used by both the API (400 with the first message) and the YAML loader (warn-and-skip). It rejects: duplicate step names; `dependsOn` naming an unknown step; `agent` kind without `agent`; `tool` without `tool`; `tool` that also names an `agent`; `transform` without `output`; `gate` without `condition`; a `loop` on a gate or a tool; `loop` + `retries` together; a missing / non-integer `maxIterations`; a `model` binding on a **non-agent** step; and a malformed `model` / `defaultModel` (unknown field — including `effort`, a non-string `provider`/`model`, an out-of-range `temperature`/`maxTokens`). Out-of-range **integer** loop budgets are **not** errors — they are clamped at run time. `defaultModel` is checked **before** the "at least one step" early-return, so a bad binding is not hidden behind an unrelated step error. `PUT /api/workflows/[name]` is a *partial* update with no `steps` to hand the whole-definition validator, so it calls the same `validateModelOverride` directly for a `defaultModel`-only body.

### Eventing & the client store

The four `workflow:*` events ride the same `AgentEvents` bus that streams to the browser over SSE (canonical names in `web/src/lib/runtime-event-names.ts`; the `@ezcorp/ai-kit` and `@ezcorp/harness-client` event lists mirror them). `web/src/lib/stores.svelte.ts` handles them: `workflow:start` prepends the new run to `store.workflowRuns`; `workflow:step`/`:complete`/`:error` replace the matching run by `id`. Because the run is also returned synchronously by `POST …/run`, the `/workflows/[name]` page shows live per-step status (and loop iteration counts) plus a session-local run history.

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/workflows` | `read` | List all merged (YAML + DB) workflows. |
| `POST /api/workflows` | `chat` | Create a DB workflow. Body `{ name, description?, inputSchema?, defaultModel?, steps }`; `validateWorkflow` drives a **400** with the first error message. Returns the row; reloads the cache. |
| `GET /api/workflows/[name]` | `read` | Fetch one by name from the cache; 404 `Not found`. |
| `PUT /api/workflows/[name]` | `chat` | Partial update — merges `name`/`description`/`inputSchema`/`defaultModel`/`steps`. **DB-only** (YAML workflows are read-only). Reloads the cache. |
| `DELETE /api/workflows/[name]` | `chat` | Delete a DB workflow. **DB-only**. Reloads the cache. |
| `POST /api/workflows/[name]/run` | `chat` | Run it. `projectId` is split off the body; **every other field is the workflow input** (Zod `.loose()`). 404 `Workflow not found`; a non-object body ⇒ **400 `Invalid request body`**. Execution errors (unknown agent, circular deps, gate/loop failure) surface **inside** the returned `WorkflowRun` (`status:"error"`, HTTP 200), not as a 400. Returns the terminal `WorkflowRun`. |

Only the `GET` list, `GET` by-name and `POST …/run` routes are registered in `src/api-registry.ts` (category `workflows`) — create/update/delete are not registered (parity with `main`'s pipelines registration). All routes gate on `requireScope` + `requireAuth`. There is **no project- or owner-scoping** beyond the scope check (see gotchas).

### UI entry points

- `/workflows` — list, fed by `store.workflows`.
- `/workflows/new` — `WorkflowBuilder.svelte` form (with `WorkflowStepForm.svelte` per-step editor, including kind, transform output pairs, gate condition JSON, loop config, dependsOn) → `createWorkflow` → `POST /api/workflows`.
- `/workflows/[name]` — step list (each agent step showing its effective **model binding**, whether declared on the step or inherited from `defaultModel`), a raw JSON-textarea run form (`triggerWorkflowRun`), delete button, and a live run-history panel (`store.workflowRuns`) rendering per-step status, `(N iterations)` for looped steps, and `on <provider>/<model>` for the model a step actually resolved to.
- `/pipelines` (the exact path only) → a permanent **308 redirect** to `/workflows` for one release. Legacy deep links (`/pipelines/<name>`, `/pipelines/new`) are **not** redirected — they 404.

### Client helpers (`web/src/lib/api.ts`)

`fetchWorkflows`, `createWorkflow`, `deleteWorkflow`, `triggerWorkflowRun(name, input, projectId?)`. **Trap (unchanged from pipelines):** `triggerWorkflowRun` folds `projectId` **into** the input body (`{ ...input, projectId }`); the run route's `.loose()` schema splits it back out, so a workflow input field literally named `projectId` would be swallowed.

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

### Demo workflows (`src/agents/`)

Three committed demos double as executable documentation and test fixtures:

- `demo-deterministic.workflow.yaml` — zero-LLM `transform` → `gate` → `transform`: a compose step reshapes the input, a gate asserts the composed fields, and a final `publish` transform re-emits the composed object so the run result carries meaningful content. Identical input ⇒ byte-identical output.
- `demo-loop-counter.workflow.yaml` — a `transform` loop that counts to 3 (`iterations: 3`) using `$loop.iteration` / `$loop.last`; passing `neverStop: true` makes the until-condition unreachable and exercises the loud `onExhausted: "fail"` path.
- `demo-mixed.workflow.yaml` — an `agent` step (`summarizer`) → `transform` reshape → `gate` assertion.

### The authoring chain (`src/agents/extension-author.workflow.yaml`)

The extension-authoring chain shipped as a real workflow — the reference example of a mixed `tool` + `gate` graph, and of a run that **parks at a consent boundary**:

`scaffold` (tool) → `scaffolded` (gate) → `validate` (tool) → `verified` (gate) → `handoff` (transform) → `request-install` (tool).

- The two gates assert real things: `$steps.scaffold.output.draftId` must `exist` **and** be `truthy`; `$steps.validate.output.pass` must `eq true` (not `truthy`, so a missing or non-boolean `pass` fails closed). Both come from `parseToolOutput`-projected JSON, and a failure names the decisive ref and its actual value.
- The final step deliberately attempts `extension-author__install_draft` and is deliberately **refused**: `ezcorp:extension:install` always prompts and is never persisted as an always-allow grant, and a workflow has no conversation on which to render that card. The run terminalizes **`awaiting_approval`** — never `success` (which would misleadingly imply the extension is live) and never `error` (nothing went wrong).
- A parked run's `result.output` carries the **last successful result**, i.e. the `handoff` payload (`{draftId, userId, verifyResult, openUrl, nextStep}`), so the human who completes the install out-of-band has what they need. (Before this it was `null` and the payload died with the run.) `result.success` stays `false` and the `awaiting_approval` error code is unchanged.
- A human completes it via the owner-scoped `POST /api/extensions/author/install`, or by re-running `install_draft` in a chat where the card can actually be shown. The chain calls the extension's **gated tool**, never the exported `installAuthoredDraft` function — that function performs no consent of its own, and calling it from a step would be the hand-rolled bypass `drafts-handler.ts` warns about.
- `userId` is an input, and it is a **display hint only** — not an authorization input. The install endpoint derives the owner from the session and the draft directory is already owner-scoped by the run's acting user, so a forged value buys nothing.

## Key files

- `src/types.ts` — `WorkflowDefinition`, `WorkflowStep`, `WorkflowStepKind`, `WorkflowCondition`, `WorkflowConditionOp`, `LoopConfig`, `WorkflowRun`, `WorkflowStepRun`, the four `workflow:*` events on `AgentEvents`.
- `src/runtime/workflow-executor.ts` — `WorkflowExecutor`: `runWorkflow`, `resolveExecutionOrder`, `runStep`/`runAgentStep`/`runToolStep`/`runLoop`, transform/gate helpers, retry + abort/cancel plumbing, `workflowScopeKey`, `WorkflowApprovalRequiredError`, run/step persistence.
- `src/runtime/workflow-tool-runner.ts` — `WorkflowToolRunner` (the narrow `ToolExecutor` slice a tool step uses) + `createWorkflowToolRunner` (cold-start registry/PDP wiring).
- `src/runtime/tools/permissions.ts` — `beginNonInteractiveScope`, gate `timeoutMs`/`signal`, `NonInteractiveApprovalRequiredError` / `PermissionGateAbortedError` / `PermissionGateTimeoutError`.
- `src/db/queries/workflow-runs.ts` — `insertWorkflowRun`, `upsertWorkflowStepRun`, `finalizeWorkflowRunRow`, `terminalizeOrphanedWorkflowRuns`, read helpers.
- `src/runtime/workflow-refs.ts` — the shared ref grammar: `resolveMapping`, `resolveOutputMapping` (template interpolation), `resolveConditionRef`, `getNestedValue`, the `OMIT` sentinel.
- `src/runtime/workflow-condition.ts` — `evaluateCondition` (leaf operators + `all`/`any`/`not`, non-number-safe comparisons, explanatory reasons).
- `src/runtime/workflow-validator.ts` — `validateWorkflow` (shared by route + loader), `clampMaxIterations` (1..25), `clampRetries` (0..2), `stepKind`.
- `src/runtime/workflow-model.ts` — the per-step model binding: `validateModelOverride` (definition-time field vocabulary, shape + bounds), `effectiveModelOverride` (step ?? definition), `resolveModelOverride` (refs → a concrete `ModelOverride`, loud on a bad value), plus the note recording why there is no reasoning/effort field.
- `src/runtime/executor-helpers.ts` — `createPiLlmAdapter(overrides?)`: the ONE place a binding reaches the LLM; reports `lastResolved` back so a run can record what actually served it.
- `src/runtime/workflow-loader.ts` — `loadYamlWorkflows`: globs `*.workflow.yaml` + legacy `*.pipeline.yaml` (deprecation warn), validates via `validateWorkflow`.
- `src/runtime/workflow-extension-loader.ts` — `loadExtensionWorkflows` / `collectExtensionWorkflowSources`: extension-shipped assets, namespaced + validated + warn-and-skip.
- `src/runtime/workflow-name.ts` — the ONE shared name grammar: `WORKFLOW_NAME_RE`, `EXTENSION_WORKFLOW_SEPARATOR`, `namespacedWorkflowName`, `isValidWorkflowName`.
- `src/runtime/workflow/runtime-registry.ts` — `registerWorkflowRuntime` / `getWorkflowRuntime`: the import-direction bridge letting `src/` reach the web layer's live `WorkflowExecutor` + workflow cache. `getWorkflows` is a THUNK (the cache array is replaced on every CRUD write).
- `src/extensions/workflows-handler.ts` — `handleWorkflowsRpc`: the `ezcorp/workflows` enforcement ladder + hourly trigger quota.
- `packages/@ezcorp/sdk/src/runtime/workflows.ts` — the `Workflows` SDK client (`ctx.workflows.run`).
- `src/db/queries/workflows.ts` — `list/get/getByName/create/update/delete/loadDbWorkflows` against `workflow_definitions`.
- `src/db/schema.ts` — `workflowDefinitions`, `workflowRuns`, `workflowStepRuns` tables; `src/db/migrate.ts` renames `pipeline_definitions` → `workflow_definitions` in place and creates the two run-history tables.
- `src/api-registry.ts` — the three `workflows`-category route entries.
- `web/src/routes/api/workflows/**` — list/create, get/put/delete, run.
- `web/src/lib/api.ts` — `Workflow`/`WorkflowRun` client types + `fetch/create/delete/triggerWorkflowRun` helpers.
- `web/src/lib/workflow-builder-logic.ts` — framework-free builder logic (mirrors the server rules for client-side form UX).
- `web/src/lib/stores.svelte.ts` — `workflows` / `workflowRuns` state + the four `workflow:*` SSE handlers.
- `web/src/routes/(app)/workflows/{+page,[name]/+page,new/+page}.svelte` — list / detail+run / create UI; `web/src/routes/(app)/pipelines/+page.server.ts` — the 308 redirect.
- `web/src/lib/components/{WorkflowBuilder,WorkflowStepForm}.svelte` — the create form.
- `src/cli.ts` — `workflow:list` / `workflow:run` commands + hidden `pipeline` alias.
- `src/agents/demo-{deterministic,loop-counter,mixed}.workflow.yaml` — the shipped demo workflows.
- `src/agents/extension-author.workflow.yaml` — the authoring chain (tool + gate steps, parks `awaiting_approval`).

## Features it touches

- [[agents]] — every `agent` step invokes one agent by name via `AgentExecutor.runAgent`; agent orchestration is one of the three step kinds.
- [[runs-lifecycle]] — each agent step produces a real `AgentRun` (its `runId`/status copied onto the step run); transform/gate steps mint no run. The `AgentStatus` union is shared.
- [[streaming-runtime]] — the `workflow:*` events ride the same `AgentEvents` bus / SSE channel that streams agent runs to the browser.
- [[teams]] — the sibling multi-agent subsystem; workflows are the **declarative-graph** alternative (no chat mention, no tool-scoping, no conversation).
- [[projects]] — `projectId` threads through to each `runAgent` call, though workflows themselves are not project-listed.
- [[api-security]] — every route is gated by `requireScope` + `requireAuth`; note the missing owner/project scoping below.
- [[developer-api-keys]] — the `read`/`chat` scope checks make workflows callable by scoped API keys, not just session users.
- [[database-and-migrations]] — DB workflows persist in `workflow_definitions` (migrated in place from `pipeline_definitions`).

## Related docs

None yet — this is the primary reference.

## Notes & gotchas

- **`awaiting_approval` is not success and not error.** A run that completed its automatable steps and then hit one needing human consent terminalizes `awaiting_approval`, with `result.output` set to the LAST SUCCESSFUL step's output (the handoff payload) so the parked run is actionable. Anything branching on `status === "success"` (the CLI exit code, the client store) treats it as non-success for free — but code that branches on `status === "error"` will NOT match it.
- **The parked capability name is collapsed.** `executeToolCall` maps all four `SENSITIVE_KINDS` onto the two the always-allow layer keys on (`shell` / `fs.write`) before opening the gate, so an `ezcorp:extension:install` park reports `…requires interactive approval for capability fs.write…`. The message reports what the gate was given, not the PDP's true capability.
- **A workflow tool step writes no `tool_calls` row.** `tool_calls.conversation_id` is an FK to `conversations`, and the synthetic `workflow-run:<id>` id has no row, so `persistToolCall` (which never throws by contract) silently drops it. The PDP's own audit row and `workflow_step_runs` carry the trail instead.
- **The `/workflows/new` builder does not yet offer `tool` steps.** `web/src/lib/workflow-builder-logic.ts` still models three kinds; a tool step is creatable via `POST /api/workflows` or YAML today.
- **The builder does not offer `model` / `defaultModel` either.** A model binding is authored in YAML or through `POST`/`PUT /api/workflows`; `/workflows/[name]` **renders** it (step card + run history) but nothing creates one from the UI yet.
- **A model binding on a non-agent step is an error, not a no-op.** `transform`/`gate`/`tool` steps run no LLM, so a binding there would be silently ignored — the validator rejects it instead.
- **`workflow_step_runs.provider`/`model` are NULL for pre-existing rows** and for the `running` write (the agent has not resolved anything yet); the terminal write fills them in. NULL therefore means "no LLM ran, or this row predates the columns" — it never means "unknown model".
- **An agent config's own `temperature`/`maxTokens` are still not forwarded on the `runAgent` path.** `createPiLlmAdapter` only sends sampling options that an explicit override supplied — this is unchanged pre-existing behaviour, deliberately left alone so the no-override path stays byte-identical. A workflow step that wants a temperature must say so in its `model` binding.
- **Synchronous / blocking.** `POST …/run` awaits the entire graph before responding; there is no async "started" handshake.
- **No ownership or project scoping on run.** Any authenticated `chat`-scoped caller can run any workflow with arbitrary input; workflows are global.
- **`$prev` is order-fragile in parallel batches.** Within a batch, `prevResult` is the last **successful** result in array order (the last declared step of that batch), not a graph-deterministic "previous". Prefer explicit `$steps.<name>` for parallel graphs.
- **Fail-fast is loud.** The first non-`success` step (or a thrown gate, or an exhausted loop) fails the run; still-dispatched siblings are cancelled and no later batch starts. Retries (agent, ≤2) and loops are the only bounded re-execution.
- **YAML vs DB asymmetry.** YAML workflows are read-only via the API (only DB workflows can be PUT/DELETE'd). Editing a YAML workflow means editing the file and reloading.
- **Name collisions aren't de-duped.** The merged cache is `[...extension, ...yaml, ...db]`; `find(w => w.name === …)` returns the first match. The DB enforces `name` unique only within the table. Extension entries are namespaced (`<ext>:<name>`) and ordered first, so they can neither shadow nor be shadowed — but a YAML and a DB workflow sharing a bare name still both appear (YAML first).
- **An extension-shipped workflow is visible and runnable by anyone.** Namespacing bounds *naming*, not *access*: the merged cache is global and `POST …/run` has no owner or project scoping, so any authenticated `chat`-scoped caller can run `<ext>:<name>` with arbitrary input. `permissions.workflows` gates only the extension-code trigger path.
- **`projectId` field-name collision.** The client helper folds `projectId` into the input object and the route splits it back out, so a workflow needing an input field literally named `projectId` cannot receive it through the standard path.
- **`inputSchema` is advisory.** It is stored and surfaced but not enforced at run time.
- **Legacy compatibility is one release only.** The `*.pipeline.yaml` glob, the `ezcorp pipeline` CLI alias, and the `/pipelines` redirect all warn/deprecate and are slated for removal.

### Out of scope (deliberately not built)

Async / background runs; **resuming** an `awaiting_approval` run (it is recorded, not resumable); a read API or UI over the persisted run history; looped tool steps; arbitrary-code (JS) steps; conditional branching / skip-dependents; nested sub-workflows; a UI YAML editor. Per-step **cost** telemetry (tokens, USD) is also still out of scope — only the resolved provider/model is recorded.
