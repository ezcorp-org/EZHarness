# Workflows

> _Declarative graphs that orchestrate a mix of **agent** steps (invoke one agent), **transform** steps (pure, declarative data reshapes — no LLM, no I/O), and **gate** steps (assert a declarative condition). Any agent/transform step may **loop** with a bounded until-condition. The executor topo-sorts steps into parallel batches with fail-fast, loud-failure semantics._

## Intent

A workflow is a named, reusable graph of steps. Where a single `@agent` run answers one prompt, a workflow chains steps: step B can depend on step A and consume A's output. Workflows are the renamed, extended successor to the old **pipelines** subsystem — they exist as a **separate subsystem from teams** (no chat-mention sigil, no per-member tool-scoping, no conversation). They are defined (in YAML or the DB), listed, and fired through a small REST surface and a dedicated `/workflows` UI. The runner is intentionally thin: topo-sort, fan out each batch with `Promise.all`, thread prior outputs into dependents, emit SSE events, halt loudly on the first failure.

Three design constraints are load-bearing (not stylistic):

1. **Hard rename, no API aliases.** This is a self-hosted, versioned product, so every in-repo caller was updated. The only compatibility kept is a hidden CLI alias (`ezcorp pipeline …` → `ezcorp workflow …`) and a legacy YAML glob (`*.pipeline.yaml` still loads, with a deprecation warning) — both for one release.
2. **No arbitrary code steps.** DB workflows are creatable by any `chat`-scoped caller, so deterministic steps must be **declarative** (a mapping/condition DSL), never evaluated JS. This is a security constraint.
3. **Loud failure.** Loop exhaustion fails the run by default, gates throw with a descriptive message, and nothing silently truncates.

`kind` defaults to `"agent"`, so **every legacy pipeline definition (YAML or DB row) remains valid with zero edits.**

## How it works

### Data model (`src/types.ts`)

- `WorkflowDefinition` = `{ name, description, inputSchema?, steps }`.
- `WorkflowStep` = `{ name, kind?, agent?, input?, retries?, output?, condition?, dependsOn?, loop? }`. `kind` is one of `"agent" | "transform" | "gate"` (default `"agent"`).
  - **agent** — `agent` is an agent name resolved by `AgentExecutor`; `input` is a `Record<string,string>` of input mappings; `retries` is a per-step retry budget (clamped 0..2).
  - **transform** — `output` is a `Record<string,string>` output mapping (same ref language as inputs, plus `{{…}}` template interpolation). Pure: no LLM, no I/O, no clock.
  - **gate** — `condition` is a `WorkflowCondition` tree.
- `WorkflowCondition` = a leaf `{ ref, op, value? }` or a composite `{ all: [] } | { any: [] } | { not: … }`. Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `exists`, `truthy`.
- `LoopConfig` = `{ maxIterations, until?, onExhausted? }` — `maxIterations` is **required** (server-clamped 1..25); `until` is a `WorkflowCondition` evaluated after each iteration; `onExhausted` is `"fail"` (default) or `"pass"`.
- `WorkflowRun` = `{ id, workflowName, projectId?, status, startedAt, finishedAt?, steps: WorkflowStepRun[], result? }`; `WorkflowStepRun` = `{ stepName, runId, status, iterations? }` (`iterations` is the final count for a looped step). `status` reuses the agent `AgentStatus` union.
- The DB table `workflow_definitions` (`src/db/schema.ts`) stores `id` (UUID PK), `name` (unique), `description`, `inputSchema` (jsonb), `steps` (jsonb), `createdAt`/`updatedAt`. A migration renames the legacy `pipeline_definitions` table in place (data preserved). It has **no** owner/user/project column — workflows are global (see gotchas).

### Loading & the in-memory cache (`workflow-loader.ts` + `context.ts`)

Workflows come from **two sources, merged into one in-memory array** at boot:

1. **YAML** — `loadYamlWorkflows(dir)` globs both `*.workflow.yaml` and the legacy `*.pipeline.yaml` (deprecation warning on the latter) in the agents dir (`resolveAgentsDir()`, overridable via `EZCORP_AGENTS_DIR`, default `src/agents/`), parses each with the `yaml` package, and runs the shared `validateWorkflow`; any invalid file is skipped with a warning (warn-and-continue, never throws).
2. **DB** — `loadDbWorkflows()` (`src/db/queries/workflows.ts`) maps every `workflow_definitions` row to a `WorkflowDefinition`.

`context.ts` concatenates them: `workflows = [...yamlWorkflows, ...dbWorkflows]`. Every CRUD write reloads the cache so the routes never drift. There is no de-duplication — a YAML and a DB workflow sharing a name would both appear (YAML first).

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
   - **gate** — evaluate `condition`; `true` ⇒ `{ success: true, output: { passed: true } }`; `false` ⇒ throw `Gate "<name>" failed: <human-readable explanation of the decisive leaf>`.
   - The first failure records the batch error and **cancels still-running siblings** via the abort plumbing.
4. After each batch, `prevResult` is set to the **last successful result in that batch** (array order) — this is what `$prev.*` reads next.
5. On clean completion: `status:"success"`, `result = prevResult`, emit **`workflow:complete`**. On failure: `status:"error"` (or `"cancelled"` for an external abort), emit **`workflow:error`**.

`runWorkflow` is **fully awaited** — it returns the terminal `WorkflowRun` (the run route blocks until the whole graph finishes). Runs are **never persisted**; they live only in the returned object + the SSE-fed client store.

### Loops (`runLoop`)

A step with a `loop` repeats up to `clampMaxIterations(loop.maxIterations)` (1..25) times, evaluating `until` **after** each iteration:

- Allowed on **agent** and **transform** steps; invalid on a **gate**. `loop` and `retries` are **mutually exclusive** (definition-time error) so the worst-case cost stays bounded.
- Step-input refs gain `$loop.iteration` (1-based) and `$loop.last.<path>` (previous iteration's result). On iteration 1 the `$loop.last` mapping key is **omitted**, never passed as `undefined` — the single documented lenient exception to strict refs.
- Each iteration re-emits **`workflow:step`**; `WorkflowStepRun.iterations` records the final count.
- `until` satisfied ⇒ the step succeeds with that iteration's result. No `until` ⇒ a fixed-count loop that always passes. Budget exhausted with `until` unmet obeys `onExhausted`: `"fail"` (default) throws `Step "<name>" exhausted <max> iterations without meeting its until-condition`; `"pass"` succeeds with the last result and `iterations = max`.
- Abort/cancel is checked **between** iterations; a cancelled iteration ends the run `cancelled`.

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

`validateWorkflow(def)` returns a list of human-readable errors (empty ⇒ valid). It is the **single shared validator** used by both the API (400 with the first message) and the YAML loader (warn-and-skip). It rejects: duplicate step names; `dependsOn` naming an unknown step; `agent` kind without `agent`; `transform` without `output`; `gate` without `condition`; a `loop` on a gate; `loop` + `retries` together; and a missing / non-integer `maxIterations`. Out-of-range **integer** loop budgets are **not** errors — they are clamped at run time.

### Eventing & the client store

The four `workflow:*` events ride the same `AgentEvents` bus that streams to the browser over SSE (canonical names in `web/src/lib/runtime-event-names.ts`; the `@ezcorp/ai-kit` and `@ezcorp/harness-client` event lists mirror them). `web/src/lib/stores.svelte.ts` handles them: `workflow:start` prepends the new run to `store.workflowRuns`; `workflow:step`/`:complete`/`:error` replace the matching run by `id`. Because the run is also returned synchronously by `POST …/run`, the `/workflows/[name]` page shows live per-step status (and loop iteration counts) plus a session-local run history.

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/workflows` | `read` | List all merged (YAML + DB) workflows. |
| `POST /api/workflows` | `chat` | Create a DB workflow. Body `{ name, description?, inputSchema?, steps }`; `validateWorkflow` drives a **400** with the first error message. Returns the row; reloads the cache. |
| `GET /api/workflows/[name]` | `read` | Fetch one by name from the cache; 404 `Workflow not found`. |
| `PUT /api/workflows/[name]` | `chat` | Partial update — merges `name`/`description`/`inputSchema`/`steps`. **DB-only** (YAML workflows are read-only). Reloads the cache. |
| `DELETE /api/workflows/[name]` | `chat` | Delete a DB workflow. **DB-only**. Reloads the cache. |
| `POST /api/workflows/[name]/run` | `chat` | Run it. `projectId` is split off the body; **every other field is the workflow input** (Zod `.loose()`). 404 `Workflow not found`; a non-object body ⇒ **400 `Invalid request body`**. Execution errors (unknown agent, circular deps, gate/loop failure) surface **inside** the returned `WorkflowRun` (`status:"error"`, HTTP 200), not as a 400. Returns the terminal `WorkflowRun`. |

All routes are registered in `src/api-registry.ts` (category `workflows`) and gate on `requireScope` + `requireAuth`. There is **no project- or owner-scoping** beyond the scope check (see gotchas).

### UI entry points

- `/workflows` — list, fed by `store.workflows`.
- `/workflows/new` — `WorkflowBuilder.svelte` form (with `WorkflowStepForm.svelte` per-step editor, including kind, transform output pairs, gate condition JSON, loop config, dependsOn) → `createWorkflow` → `POST /api/workflows`.
- `/workflows/[name]` — step list, a raw JSON-textarea run form (`triggerWorkflowRun`), delete button, and a live run-history panel (`store.workflowRuns`) rendering per-step status and `(N iterations)` for looped steps.
- `/pipelines` (and legacy deep links) → a permanent **308 redirect** to `/workflows` for one release.

### Client helpers (`web/src/lib/api.ts`)

`fetchWorkflows`, `createWorkflow`, `deleteWorkflow`, `triggerWorkflowRun(name, input, projectId?)`. **Trap (unchanged from pipelines):** `triggerWorkflowRun` folds `projectId` **into** the input body (`{ ...input, projectId }`); the run route's `.loose()` schema splits it back out, so a workflow input field literally named `projectId` would be swallowed.

### CLI (`src/cli.ts`)

`ezcorp workflow list` prints the merged YAML+DB workflows; `ezcorp workflow run <name>` constructs its own `WorkflowExecutor` over a fresh run harness and prints `run.result` as JSON. `ezcorp pipeline …` is a **hidden alias** (kept out of help text) that dispatches to the same `workflow:*` commands for one deprecation release. There is **no** auth/scope check on this path (a local operator tool, not an HTTP endpoint).

### Env vars

- `EZCORP_AGENTS_DIR` — overrides where YAML workflows (and agents) are discovered. Default: the repo's `src/agents/`.

### Demo workflows (`src/agents/`)

Three committed demos double as executable documentation and test fixtures:

- `demo-deterministic.workflow.yaml` — transforms + gate only, zero LLM. Identical input ⇒ identical output.
- `demo-loop-counter.workflow.yaml` — a `transform` loop that counts to 3 (`iterations: 3`) using `$loop.iteration` / `$loop.last`; passing `neverStop: true` makes the until-condition unreachable and exercises the loud `onExhausted: "fail"` path.
- `demo-mixed.workflow.yaml` — an `agent` step (`summarizer`) → `transform` reshape → `gate` assertion.

## Key files

- `src/types.ts` — `WorkflowDefinition`, `WorkflowStep`, `WorkflowStepKind`, `WorkflowCondition`, `WorkflowConditionOp`, `LoopConfig`, `WorkflowRun`, `WorkflowStepRun`, the four `workflow:*` events on `AgentEvents`.
- `src/runtime/workflow-executor.ts` — `WorkflowExecutor`: `runWorkflow`, `resolveExecutionOrder`, `runStep`/`runAgentStep`/`runLoop`, transform/gate helpers, retry + abort/cancel plumbing.
- `src/runtime/workflow-refs.ts` — the shared ref grammar: `resolveMapping`, `resolveOutputMapping` (template interpolation), `resolveConditionRef`, `getNestedValue`, the `OMIT` sentinel.
- `src/runtime/workflow-condition.ts` — `evaluateCondition` (leaf operators + `all`/`any`/`not`, non-number-safe comparisons, explanatory reasons).
- `src/runtime/workflow-validator.ts` — `validateWorkflow` (shared by route + loader), `clampMaxIterations` (1..25), `clampRetries` (0..2), `stepKind`.
- `src/runtime/workflow-loader.ts` — `loadYamlWorkflows`: globs `*.workflow.yaml` + legacy `*.pipeline.yaml` (deprecation warn), validates via `validateWorkflow`.
- `src/db/queries/workflows.ts` — `list/get/getByName/create/update/delete/loadDbWorkflows` against `workflow_definitions`.
- `src/db/schema.ts` — `workflowDefinitions` table; `src/db/migrate.ts` renames `pipeline_definitions` → `workflow_definitions` in place.
- `src/api-registry.ts` — the three `workflows`-category route entries.
- `web/src/routes/api/workflows/**` — list/create, get/put/delete, run.
- `web/src/lib/api.ts` — `Workflow`/`WorkflowRun` client types + `fetch/create/delete/triggerWorkflowRun` helpers.
- `web/src/lib/workflow-builder-logic.ts` — framework-free builder logic (mirrors the server rules for client-side form UX).
- `web/src/lib/stores.svelte.ts` — `workflows` / `workflowRuns` state + the four `workflow:*` SSE handlers.
- `web/src/routes/(app)/workflows/{+page,[name]/+page,new/+page}.svelte` — list / detail+run / create UI; `web/src/routes/(app)/pipelines/+page.server.ts` — the 308 redirect.
- `web/src/lib/components/{WorkflowBuilder,WorkflowStepForm}.svelte` — the create form.
- `src/cli.ts` — `workflow:list` / `workflow:run` commands + hidden `pipeline` alias.
- `src/agents/demo-{deterministic,loop-counter,mixed}.workflow.yaml` — the shipped demo workflows.

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

- **Runs are ephemeral.** `runWorkflow` returns the `WorkflowRun` but **never persists** it. Run history lives only in the browser store and evaporates on reload. There is no `workflow_runs` table.
- **Synchronous / blocking.** `POST …/run` awaits the entire graph before responding; there is no async "started" handshake.
- **No ownership or project scoping on run.** Any authenticated `chat`-scoped caller can run any workflow with arbitrary input; workflows are global.
- **`$prev` is order-fragile in parallel batches.** Within a batch, `prevResult` is the last **successful** result in array order (the last declared step of that batch), not a graph-deterministic "previous". Prefer explicit `$steps.<name>` for parallel graphs.
- **Fail-fast is loud.** The first non-`success` step (or a thrown gate, or an exhausted loop) fails the run; still-dispatched siblings are cancelled and no later batch starts. Retries (agent, ≤2) and loops are the only bounded re-execution.
- **YAML vs DB asymmetry.** YAML workflows are read-only via the API (only DB workflows can be PUT/DELETE'd). Editing a YAML workflow means editing the file and reloading.
- **Name collisions aren't de-duped.** The merged cache is `[...yaml, ...db]`; `find(w => w.name === …)` returns the YAML entry first. The DB enforces `name` unique only within the table.
- **`projectId` field-name collision.** The client helper folds `projectId` into the input object and the route splits it back out, so a workflow needing an input field literally named `projectId` cannot receive it through the standard path.
- **`inputSchema` is advisory.** It is stored and surfaced but not enforced at run time.
- **Legacy compatibility is one release only.** The `*.pipeline.yaml` glob, the `ezcorp pipeline` CLI alias, and the `/pipelines` redirect all warn/deprecate and are slated for removal.

### Out of scope (deliberately not built)

Run persistence / history table; async / background runs; arbitrary-code (JS) steps; conditional branching / skip-dependents; nested sub-workflows; per-step model overrides; a UI YAML editor.
