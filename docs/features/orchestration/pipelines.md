# Pipelines

> _Declarative DAG workflows that orchestrate sequential or parallel agent runs — each step invokes one agent, wires its inputs from the pipeline input or upstream step outputs, and the executor topo-sorts steps into parallel batches with fail-fast semantics._

## Intent

A pipeline is a named, reusable graph of agent invocations. Where a single `@agent` run answers one prompt, a pipeline chains several agents: step B can depend on step A and consume A's output. Pipelines exist as a **separate subsystem from teams** — there is no chat-mention sigil, no per-member tool-scoping, no conversation. They are defined (in YAML or the DB), listed, and fired through a small REST surface and a dedicated `/pipelines` UI. The runner is intentionally thin: topo-sort, fan out each batch with `Promise.all`, thread prior outputs into dependents, emit SSE events, halt on the first failure.

## How it works

### Data model (`src/types.ts`)

- `PipelineDefinition` = `{ name, description, inputSchema?, steps }`.
- `PipelineStep` = `{ name, agent, input?, dependsOn? }` — `agent` is an agent name resolved by `AgentExecutor`; `input` is a `Record<string,string>` of **input mappings** (see below); `dependsOn` is a list of upstream step names.
- `PipelineRun` = `{ id, pipelineName, projectId?, status, startedAt, finishedAt?, steps: PipelineStepRun[], result? }`; `PipelineStepRun` = `{ stepName, runId, status }`. `status` reuses the agent `AgentStatus` union.
- The DB table `pipeline_definitions` (`src/db/schema.ts`) stores `id` (UUID PK), `name` (unique), `description`, `inputSchema` (jsonb), `steps` (jsonb), `createdAt`/`updatedAt`. It has **no** owner/user/project column — pipelines are global (see gotchas).

### Loading & the in-memory cache (`pipeline-loader.ts` + `context.ts`)

Pipelines come from **two sources, merged into one in-memory array** at boot:

1. **YAML** — `loadYamlPipelines(dir)` globs `*.pipeline.yaml` in the agents dir (`resolveAgentsDir()`, overridable via `EZCORP_AGENTS_DIR`, default `src/agents/`), parses each with the `yaml` package, and skips any file missing `name` or a non-empty `steps` array (warn-and-continue, never throws).
2. **DB** — `loadDbPipelines()` (`src/db/queries/pipelines.ts`) maps every `pipeline_definitions` row to a `PipelineDefinition`.

`context.ts` concatenates them: `pipelines = [...yamlPipelines, ...dbPipelines]`. `getPipelines()` returns this array; `reloadPipelines()` re-globs + re-queries and replaces it. **Every CRUD write calls `reloadPipelines()`** so the cache and the routes never drift. There is no de-duplication — a YAML and a DB pipeline sharing a name would both appear (YAML first); `getPipelines().find(p => p.name === …)` resolves to the YAML one.

### Execution (`pipeline-executor.ts`)

`PipelineExecutor` is constructed once in `context.ts` with the singleton `AgentExecutor` + the `AgentEvents` `EventBus`. `runPipeline(pipeline, input, projectId?, userId?)`:

1. Mints a `PipelineRun` (`crypto.randomUUID()`, `status: "running"`) and emits **`pipeline:start`**.
2. **`resolveExecutionOrder(steps)`** computes batches:
   - If **no** step has `dependsOn`, steps run strictly **sequentially** — one step per batch, in declared order.
   - Otherwise a **topological sort** groups steps whose deps are all already resolved into the same batch; an empty batch with steps remaining ⇒ **`Circular dependency detected`** thrown.
3. For each batch, all steps run **in parallel** (`batch.map(async …)` + `Promise.all`). Per step:
   - Push a `PipelineStepRun` (`status: "running"`), emit **`pipeline:step`**.
   - **`resolveStepInput(step.input, pipelineInput, stepResults, prevResult)`** builds the agent input (see mappings below).
   - `await agentExecutor.runAgent(step.agent, resolvedInput, projectId, userId)` — copies `agentRun.id`/`status` onto the step run.
   - If the agent result is **not `success`**, throw `Step "<name>" failed: <error>` — this **halts the whole pipeline** (the `catch` sets `status:"error"`, emits **`pipeline:error`**).
   - Otherwise record the result in `stepResults` keyed by step name.
4. After each batch, `prevResult` is set to the **last result in that batch** (array order, *not* deterministic by dep-graph) — this is what `$prev.*` reads in the next batch.
5. On clean completion: `status:"success"`, `result = prevResult`, emit **`pipeline:complete`**.

`runPipeline` is **fully awaited and synchronous from the caller's view** — it returns the terminal `PipelineRun` (the run route blocks until the whole DAG finishes). Runs are **never persisted**; they exist only in the returned object + the SSE-fed client store.

### Input mappings (`resolveStepInput`)

Each `input` value is a string interpreted by prefix:

| Prefix | Resolves to |
|---|---|
| `$input.<field>` | the pipeline's top-level input field |
| `$prev.<path>` | dotted path into the **previous batch's last** agent result (`getNestedValue`) |
| `$steps.<stepName>` | the full `AgentResult` of a named earlier step |
| `$steps.<stepName>.<path>` | a dotted path into that step's result |
| _anything else_ | a **literal** string value |

`getNestedValue` walks `.`-separated keys, returning `undefined` on any missing hop (no throw). The reference sigils are exactly `$input.`, `$prev.`, and `$steps.` (with the trailing dot) — any other value, including a bare `$prev` or `$steps` with no dot, is treated as a **literal** string.

### Eventing & the client store

The four `pipeline:*` events ride the same `AgentEvents` bus that streams to the browser over SSE. `web/src/lib/stores.svelte.ts` handles them: `pipeline:start` prepends the new run to `store.pipelineRuns`; `pipeline:step`/`:complete`/`:error` replace the matching run by `id`. Because the run is also returned synchronously by `POST …/run`, the `/pipelines/[name]` page shows live step status and a (session-local, non-persisted) run history.

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/pipelines` | `read` | List all merged (YAML + DB) pipelines. |
| `POST /api/pipelines` | `chat` | Create a DB pipeline. Body `{ name, description?, inputSchema?, steps }`; empty `name`/`steps` ⇒ **400 `name and steps required`**. Returns 201 + the row; reloads the cache. |
| `GET /api/pipelines/[name]` | `read` | Fetch one by name from the cache; 404 `Not found`. |
| `PUT /api/pipelines/[name]` | `chat` | Partial update — merges `name`/`description`/`inputSchema`/`steps`. **DB-only**: 404 `Not found (only DB pipelines can be updated)` for a YAML pipeline. Reloads the cache. |
| `DELETE /api/pipelines/[name]` | `chat` | Delete a DB pipeline (returns `{ ok: true }`). **DB-only**: 404 `Not found (only DB pipelines can be deleted)` for a YAML pipeline. Reloads the cache. |
| `POST /api/pipelines/[name]/run` | `chat` | Run it. `projectId` is split off the body; **every other field is the pipeline input** (Zod `.loose()` lets arbitrary input through). 404 `Pipeline not found` if the name is unknown; a malformed (non-object) body is **400 `Invalid request body`**. Execution errors (unknown agent, circular deps, step failure) do **not** surface as a 400 — `runPipeline` catches them internally and returns a `PipelineRun` with `status:"error"` (HTTP 200); the route's `catch → 400` only fires for failures thrown outside that internal try (e.g. an uninitialized executor). Returns the terminal `PipelineRun`. |

All routes gate on `requireScope(locals, …)` then `requireAuth(locals)`. There is **no project- or owner-scoping** beyond the scope check (see gotchas).

### UI entry points

- `/pipelines` (`web/src/routes/(app)/pipelines/+page.svelte`) — list, fed by `store.pipelines` (`refreshPipelines()` → `GET /api/pipelines`).
- `/pipelines/new` — `PipelineBuilder.svelte` form → `createPipeline` → `POST /api/pipelines`.
- `/pipelines/[name]` — step list, a **raw JSON-textarea** run form (parsed client-side, `triggerPipelineRun`), delete button, and a live run-history panel driven by `store.pipelineRuns`.

### Client helpers (`web/src/lib/api.ts`)

`fetchPipelines`, `createPipeline`, `deletePipeline`, `triggerPipelineRun(name, input, projectId?)`. **Trap:** `triggerPipelineRun` flattens `projectId` **into** the input body alongside the user fields (`{ ...input, projectId }`); the run route's `.loose()` schema then splits `projectId` back out. A pipeline input field literally named `projectId` would be swallowed by the route.

### CLI (`src/cli.ts`)

A second invocation surface bypasses the web layer entirely: `ezcorp pipeline list` prints the merged YAML+DB pipelines, and `ezcorp pipeline run <name>` constructs its own `PipelineExecutor` (over a fresh run harness) and runs the named pipeline, printing `run.result` as JSON. It re-runs the same `loadYamlPipelines` + `loadDbPipelines` merge and shares `runPipeline` — there is **no** auth/scope check on this path (it's a local operator tool, not an HTTP endpoint).

### Env vars

- `EZCORP_AGENTS_DIR` — overrides where YAML pipelines (and agents) are discovered. Default: the repo's `src/agents/`.

## Key files

- `src/types.ts` — `PipelineDefinition`, `PipelineStep`, `PipelineRun`, `PipelineStepRun`, the four `pipeline:*` events on `AgentEvents`.
- `src/runtime/pipeline-executor.ts` — `PipelineExecutor`: `runPipeline`, `resolveExecutionOrder` (topo-sort / sequential), `resolveStepInput` (`$input`/`$prev`/`$steps`/literal), `getNestedValue`.
- `src/runtime/pipeline-loader.ts` — `loadYamlPipelines`: globs `*.pipeline.yaml`, validates name + non-empty steps.
- `src/db/queries/pipelines.ts` — `list/get/getByName/create/update/delete/loadDbPipelines` against `pipeline_definitions`.
- `src/db/schema.ts` — `pipelineDefinitions` table (unique `name`, jsonb `inputSchema`/`steps`).
- `web/src/lib/server/context.ts` — constructs the `PipelineExecutor`; merges YAML + DB into the cache; exports `getPipelines`, `reloadPipelines`, `getPipelineExecutor`; the `resolveAgentsDir()` helper (module-private) computes the agents/YAML dir.
- `web/src/routes/api/pipelines/+server.ts` — list (GET) + create (POST).
- `web/src/routes/api/pipelines/[name]/+server.ts` — GET/PUT/DELETE one (PUT/DELETE are DB-only).
- `web/src/routes/api/pipelines/[name]/run/+server.ts` — run; splits `projectId`, forwards the rest as input; maps executor throws to 400.
- `web/src/lib/api.ts` — `Pipeline`/`PipelineRun` client types + `fetch/create/delete/triggerPipelineRun` helpers.
- `web/src/lib/stores.svelte.ts` — `pipelines` / `pipelineRuns` state, `refreshPipelines`, the four `pipeline:*` SSE handlers.
- `web/src/routes/(app)/pipelines/{+page,[name]/+page,new/+page}.svelte` — list / detail+run / create UI.
- `web/src/lib/components/PipelineBuilder.svelte` — the create form (with `PipelineStepForm.svelte` for per-step editing).
- `src/cli.ts` — `pipeline:list` / `pipeline:run` CLI commands (web-layer-free, no auth).

## Features it touches

- [[agents]] — every step invokes one agent by name via `AgentExecutor.runAgent`; a pipeline is purely an agent orchestrator.
- [[runs-lifecycle]] — each step produces a real `AgentRun` (with its own `runId`/status copied onto the step run); the `AgentStatus` union is shared.
- [[streaming-runtime]] — the `pipeline:*` events ride the same `AgentEvents` bus / SSE channel that streams agent runs to the browser.
- [[teams]] — the sibling multi-agent subsystem; pipelines are the **declarative-DAG** alternative (no chat mention, no tool-scoping, no conversation).
- [[projects]] — `projectId` is passed through to each `runAgent` call (drives project-scoped agent input resolution), though pipelines themselves are not project-listed.
- [[api-security]] — every route is gated by `requireScope` + `requireAuth`; note the missing owner/project scoping below.
- [[developer-api-keys]] — the `read`/`chat` scope checks make pipelines callable by scoped API keys, not just session users.
- [[database-and-migrations]] — DB pipelines persist in the `pipeline_definitions` table.

## Related docs

None yet — this is the primary reference.

## Notes & gotchas

- **Runs are ephemeral.** `runPipeline` returns the `PipelineRun` but **never persists** it. Run history exists only in the browser store (`pipelineRuns`, fed by SSE + the synchronous response) and evaporates on reload. There is no `pipeline_runs` table and no GET-run-history endpoint.
- **Synchronous / blocking.** `POST …/run` `await`s the entire DAG before responding — a long pipeline holds the request open. There is no async "started" handshake; the executor is not backgrounded.
- **No ownership or project scoping on run.** The run route checks only `requireScope(chat)` + `requireAuth` — **any** authenticated, `chat`-scoped caller can run **any** pipeline with arbitrary input. Pipelines are global, not per-user; `projectId` is caller-supplied and only threads into agent input.
- **`$prev` is order-fragile in parallel batches.** Within a batch, `prevResult` is set to `results[results.length - 1]` — the **last in array order**, which is the last *declared* step of that batch, not a graph-deterministic "previous". A dependent in the next batch reading `$prev.*` may get a sibling it didn't intend. Prefer the explicit `$steps.<name>` form for parallel graphs.
- **Fail-fast halts the whole pipeline.** The first non-`success` step throws; in-flight siblings in the same `Promise.all` batch still run to completion (they were already dispatched), but no later batch starts and the run ends `error`. There is no per-step retry or `continueOnError`.
- **YAML vs DB asymmetry.** YAML pipelines are read-only via the API — only DB pipelines can be PUT/DELETE'd. Both are listable/gettable/runnable. Editing a YAML pipeline means editing the file and restarting (or hitting any reload path) — `reloadPipelines` re-globs YAML too, but the UI offers no YAML editor.
- **Name collisions aren't de-duped.** The merged cache is `[...yaml, ...db]` with no uniqueness check across sources; `find(p => p.name === …)` returns the YAML entry first. The DB enforces `name` unique only **within** the table.
- **`projectId` field-name collision.** Because the client helper folds `projectId` into the input object and the route splits it back out, a pipeline whose `inputSchema` legitimately needs a field named `projectId` cannot receive it through the standard UI/helper path.
- **`inputSchema` is advisory.** It is stored and surfaced but **not enforced** at run time — the run route accepts any `.loose()` body; the executor maps whatever `$input.<field>` references resolve to (missing fields ⇒ `undefined`).
