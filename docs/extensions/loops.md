# Loops — `defineLoop`

A **loop** is an autonomous, recurring unit of work an extension runs in
the background: distill a lesson when a chat finishes, sweep memories on a
cron, dispatch a coding-agent run and track it to completion. The
`defineLoop` primitive collapses the boilerplate every such loop hand-rolls
— settings resolution, the run-record + status state machine, idempotency,
retention caps, failure policy, fire logging, and an optional Hub dashboard
— into **one declarative call**. You write only `act` (what to do) + a
small `contract`.

`defineLoop` is built entirely from existing SDK runtime primitives
(`Schedule`, `Storage`, `registerEventHandler`, `createToolDispatcher`,
`definePage`/`pushPage`, `spawnAssignment`). It adds **no host table and no
new scheduler** — run-state lives in the SDK `Storage` KV.

The runnable reference example is
[`examples/sample-loop`](examples/sample-loop/index.ts).

---

## Build a loop in 20 lines

```ts
import { createToolDispatcher, defineLoop, getChannel, getLoopTools } from "@ezcorp/sdk/runtime";

defineLoop({
  id: "summarize",
  trigger: { kind: "event", event: "run:complete" },
  contract: { states: ["done"], scope: "user", idempotencyKey: (i) => i.conversationId },
  act: async (ctx) => {
    const cid = ctx.input.conversationId;
    if (!cid || ctx.settings.enabled === false) return { kind: "skip", reason: "gated" };
    const recent = await ctx.recentMessages(cid);           // formatted last-20 slice
    const { content } = await ctx.llm.complete({             // host-brokered; token never crosses
      provider: "google", model: "gemini-2.0-flash-lite",
      systemPrompt: "Summarize in one sentence.",
      messages: [{ role: "user", content: ctx.formatMessages(recent) }],
    });
    return { kind: "terminal", status: "done", outcome: { summary: content.trim() } };
  },
  log: { artifact: (run, o) => ({ path: `summaries/${run.id}.md`, body: o.summary }) },
});

createToolDispatcher({ ...getLoopTools() });
getChannel().start();
```

The primitive resolves the user's settings (with a `{}` fallback), fetches
+ slices the last 20 messages, persists a run record, trims retention, and
mirrors the summary to `.ezcorp/extension-data/summarize/summaries/<id>.md`
— none of which appears above.

---

## The four fields

```ts
defineLoop({ id, trigger, contract, act, log });
```

### `id` — unique per extension

Namespaces the run store (`loop:<id>:run:<runId>`, `loop:<id>:index`,
`loop:<id>:meta`). One extension may declare **N loops** — see
[multi-loop](#multiple-loops-per-extension).

### `trigger` — how a fire is induced

One trigger or an array. All are validated against the manifest at install
time (crons must be in `permissions.schedule.crons`; events in
`permissions.eventSubscriptions`) — the primitive never widens the
permission surface.

```ts
type LoopTrigger =
  | { kind: "cron";   cron: string; timezone?: string }                  // → Schedule.on
  | { kind: "event";  event: SubscribableEvent; filter?: (p) => boolean } // → registerEventHandler
  | { kind: "manual"; tool?: string; pageAction?: string };              // → tool dispatcher / row action
```

- **cron** rides on `extension_schedules`/`_fires` — claim-before-dispatch,
  `nextFireAt`, per-fire audit. No new scheduler.
- **event**'s optional `filter` replaces each loop's hand-rolled "is this
  the right agent/status?" gate; a falsey filter is a logged `skip`.
- **manual**'s `tool` generates a tool handler. Because the SDK tool
  dispatcher is last-call-wins, the primitive accumulates every loop's
  manual tool and exposes them via [`getLoopTools()`](#mixing-loops-with-hand-written-tools).

### `contract` — the run-state schema + rules

```ts
interface LoopContract<Input> {
  states?: readonly string[];        // default ["done"]
  terminal?: readonly string[];      // subset that means "done"; default = all of states
  scope?: "global" | "user" | "conversation";  // Storage scope; default "global"
  idempotencyKey?: (input) => string | undefined; // dupe on an OPEN run = no-op
  retention?: { maxRuns?: number; maxEventsPerRun?: number };  // default 100 / 50
  failure?: {
    classify?: (err) => "transient" | "permanent"; // default: all transient
    autoDisableAfter?: number;                      // consecutive permanent errors
    onAutoDisable?: (ctx) => Promise<void>;
  };
  concurrency?: { maxConcurrent?: number; maxPerDay?: number };
}
```

The primitive owns the state machine `states`/`terminal` describe. A
duplicate `idempotencyKey` on a still-OPEN run is a no-op (safe under cron
catch-up + double-delivered events). Retention trims the oldest **terminal**
runs first — an open run is never evicted. `autoDisableAfter` consecutive
**permanent** errors disables the loop (and fires `onAutoDisable`); a
transient error or any success resets the counter.

### `act` — the loop body (terminal **or** deferred)

```ts
type ActResult<Outcome> =
  | { kind: "terminal"; status: string; outcome: Outcome }      // capture loops
  | { kind: "deferred"; runId: string; status: string;          // dispatch loops
      awaitEvent: "task:assignment_update";
      assignmentId?: string; taskId?: string; subConversationId?: string }
  | { kind: "skip"; reason: string };                           // gated / declined
```

The `ctx` the primitive hands you:

| field | what |
|---|---|
| `ctx.input` | event payload \| tool args \| cron tick |
| `ctx.settings` | resolved user settings, **`{}` fallback already applied** |
| `ctx.recentMessages(convId, n=20)` | fetch + slice + format (the duplicated last-20 code, gone) |
| `ctx.formatMessages(msgs)` | canonical `[id] role: content` join |
| `ctx.llm` | host-brokered `Llm` (the API token never reaches your code) |
| `ctx.spawn(...)` | `spawnAssignment` — for deferred dispatch |
| `ctx.fire` | `{ id, firedAt, trigger, catchUp }` |
| `ctx.state` | the current open run record (deferred re-entry) |
| `ctx.log(msg, level?)` | append a note to the fire's audit log |

- **Terminal** loops resolve in the fire: `return { kind: "terminal", … }`
  and the primitive writes the record + artifact in one shot.
- **Deferred** loops `spawn(...)` a long-lived sub-agent then
  `return { kind: "deferred", runId, … }`. The primitive opens a
  non-terminal run; the inbound `task:assignment_update` event later maps
  the host status onto `contract.states` and closes it — no per-loop
  `mapStatus`/`applyAssignmentUpdate` needed.
- **Skip** is a first-class decline (logged, **not** an error).
- A **thrown** `act` is classified by `contract.failure` (auto-disable,
  retry) — never re-thrown to the host (fire-and-forget).

### `log` — artifact mirror + opt-in dashboard

```ts
interface LoopLog<Outcome> {
  artifact?: (run, outcome) => { path: string; body: string } | null;  // mirror, fail-soft
  dashboard?: {
    pageId: string;
    render: (runs) => HubPageTree | PageBuilder;        // generalizes buildDashboard
    rowActions?: Record<string, (e: PageActionEvent) => Promise<void>>; // cancel/steer/…
  };
}
```

`artifact` writes a human-readable mirror under
`.ezcorp/extension-data/<loop>/<path>` via host-mediated `fsWrite` — it is
**fail-soft** (a write error never fails the run) and **never the source of
truth**. `dashboard` registers a Hub page whose `render` re-derives the run
list; the primitive pushes a fresh tree (content-free SSE invalidation) on
every state change, and routes `rowActions` straight through.

---

## Terminal vs deferred — which one?

| | **terminal** | **deferred** |
|---|---|---|
| shape | read context → act → return outcome | dispatch a sub-agent, return; completion arrives later |
| completion | within the fire | via `task:assignment_update` |
| examples | lessons-distiller, memory-extractor | ez-code |
| `act` returns | `{ kind: "terminal", … }` | `{ kind: "deferred", runId, … }` |

Use **terminal** for "capture/generate" work that finishes in one call. Use
**deferred** when the loop kicks off a long-running external run and its
state machine is then driven by inbound events.

---

## Invariant — durable state is transactional; the filesystem is artifacts only

> **Run state lives in the SDK `Storage` KV** (one key per run +
> an index key, all mutations under `withLock`). The
> `.ezcorp/extension-data/<loop>/` tree holds only (a) human-editable
> config and (b) human-readable artifact/log **mirrors** — **never the
> source of truth.**

This gives you transactions, RBAC/ownership, quotas, and per-conversation
scoping from Storage, while keeping the *good* property of files (explicit,
inspectable, git-legible outputs). Read/write the data dir only via
host-mediated `fsRead`/`fsWrite` — never `node:fs` (the sandbox poisons it).

---

## Multiple loops per extension

Call `defineLoop` once per loop. Each registers independently; the shared
`task:assignment_update` handler routes an inbound event to whichever loop
owns the matching open run.

```ts
defineLoop({ id: "capture",    trigger: { kind: "event", event: "run:complete" }, /* … */ });
defineLoop({ id: "compaction", trigger: { kind: "cron",  cron: "0 */6 * * *" },   /* … */ });
```

`memory-extractor` ships exactly this — an event capture loop + a cron
compaction loop in one extension.

### Mixing loops with hand-written tools

The SDK tool dispatcher replaces its `tools/call` handler wholesale on
every `createToolDispatcher` call. So when your extension has BOTH a
manual-trigger loop AND hand-written tools, register them in **one** merged
call:

```ts
createToolDispatcher({ ...getLoopTools(), my_other_tool: handler });
```

`getLoopTools()` returns the manual-trigger handlers the loops registered.

---

## What stays bespoke

The primitive deliberately does **not** absorb single-loop concerns
(design §6): your LLM system prompts + response parsing, *what counts as*
a duplicate (you supply `idempotencyKey`; the primitive supplies the
"duplicate = no-op" mechanism), domain-specific warnings, and security-
critical flows like ez-code's sandboxed `git`/`gh` PR pipeline (kept as a
`manual`/row-action handler outside the primitive). If a concept appears in
only one loop, it does not enter the primitive.

---

## See also

- [`examples/sample-loop`](examples/sample-loop/index.ts) — the runnable reference.
- [Data Storage Convention](data-storage.md) — the `.ezcorp/extension-data/` layout.
- [Pages](pages.md) — the Hub page model the dashboard reuses.
- [API Reference](api-reference.md) — `Storage`, `Schedule`, `spawnAssignment`, the fs helpers.
