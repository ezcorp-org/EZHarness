# Loop SDK primitive — design & implementation plan

**Status:** Draft for review
**Date:** 2026-06-18
**Scope:** Add a reusable `defineLoop({ trigger, contract, act, log })` primitive to the
EZCorp extension SDK so the bundled autonomous loops collapse onto one
abstraction instead of N bespoke implementations.

---

## 1. Verdict on the thesis

**Adopt, with three refinements.** The duplication is real and the extraction is
worth it, but the naïve framing — "four extensions collapse onto one
abstraction" — does not survive contact with the code. Three findings reshape
the design:

### Finding A — Only three of the four are extensions; `daily-briefing` is a host daemon.

`daily-briefing` is **not** an SDK extension. It is a host-internal daemon
(`src/runtime/briefing/daemon.ts`, `run.ts`), backed by its own table
(`briefing_configs`), wired into `src/startup/background-timers.ts` alongside the
other five daemons. It never imports `@ezcorp/sdk/runtime`. A primitive that
lives in the *extension* SDK cannot, by itself, absorb a host daemon.

**Consequence:** the primitive must be factored as a **shared loop-runtime core**
that two facades wrap — an extension-facing `defineLoop()` *and* a host-side
adapter — or `daily-briefing` must first be migrated to an extension. We
recommend the shared-core split (§9) and treat the `daily-briefing` migration as
an explicit, separable phase, not an assumed freebie.

### Finding B — There are two `act` shapes, not one. The primitive must model both.

| Shape | Members | `act` body | Completion |
|---|---|---|---|
| **Synchronous capture/generate** | `lessons-distiller`, `memory-extractor`, `daily-briefing` | read context → call LLM → write artifact | terminal within the fire |
| **Deferred dispatch/track** | `ez-code` | `spawnAssignment(...)` a long-lived sub-agent run, then return | completion arrives **later** via `task:assignment_update`, re-entering the loop |

`ez-code` is "the most fully-realized loop" precisely because its `act` is
*deferred*: a fire kicks off an external run and the loop's state machine is then
driven by inbound events (`index.ts` `handleAssignmentUpdate`,
`applyAssignmentUpdate`). The three capture loops are *terminal*: the fire fully
resolves before it returns (`distill()` / `extract()` return a discriminated
`Outcome`).

**Consequence:** `act` must support returning either a **terminal outcome** or a
**deferred handoff** (`{ deferred: { runId, awaitEvent } }`) whose later event
transitions a still-open run record. A primitive that only models terminal `act`
would force `ez-code` to keep its bespoke machinery — defeating the purpose.

### Finding C — The cron run-state machinery already exists. Don't rebuild it.

`extension_schedules` (`src/db/schema.ts:1089–1104`) and
`extension_schedule_fires` (`:1110–1125`) already provide, for cron-triggered
extensions: claim-before-dispatch (`SELECT … FOR UPDATE SKIP LOCKED`),
`nextFireAt` advancement, per-fire audit rows with status/duration/error,
`consecutiveErrors`, and **auto-disable after 5** — driven by the host
`ScheduleDaemon` (`src/extensions/schedule-daemon.ts`). The SDK already exposes
`Schedule.on(cron, handler)` (`packages/@ezcorp/sdk/src/runtime/schedule.ts`).

**Consequence:** `defineLoop` is **mostly a composition/convention layer**, not
new infrastructure. The duplication being eliminated is the *glue around* these
primitives — settings resolution, the run-record schema, the status state
machine, idempotency, retention caps, error classification, dashboard rendering —
**not** the scheduler. The implementation reuses `extension_schedules`/`_fires`
for the cron path and adds one new run-record store for the deferred/dispatch
path. Inventing a parallel scheduler would be a regression.

---

## 2. What the four loops actually share (and where they diverge)

Evidence-backed inventory. ✔ = present, — = absent/bespoke.

| Concern | ez-code | daily-briefing | lessons-distiller | memory-extractor | Shared? |
|---|---|---|---|---|---|
| **Trigger: cron** | ✔ `["0 * * * *","0 9 * * *"]` | ✔ per-user cron+tz | — | ✔ 1/3/6/12/24h | partial |
| **Trigger: event** | ✔ `task:assignment_update` | — | ✔ `run:complete` | ✔ `run:complete` | partial |
| **Trigger: manual tool / page-action** | ✔ `dispatch_run`, cancel/steer | — | ✔ `distill_now` | — | partial |
| **Settings read + fallback to `{}`** | ✔ | ✔ (row) | ✔ | ✔ | **yes** |
| **Run-record + status state machine** | ✔ `RunRecord`, `mapStatus` | ✔ `lastFireStatus` | ✔ `Outcome` union | ✔ `Outcome` union | **yes (shape)** |
| **Fire bookkeeping (claim/advance/audit)** | hand-rolled in Storage | hand-rolled (`claimDueBriefingConfigs`) | via `extension_schedule_fires` | via `extension_schedule_fires` | **yes** |
| **Idempotency / dedup** | retention cap only | new conversation each fire | slug-collision (host) | content+category dedup (host) | divergent |
| **Retention caps** | `MAX_RUNS=100`, `MAX_EVENTS=50` | — | — | — | divergent |
| **Error classification** | — | `consecutiveErrors`→disable@5 | `classifyLlmError` + warn-once | flat | divergent |
| **Auto-disable after N errors** | — | ✔ @5 | via daemon | — | divergent |
| **LLM provider/model defaults** | — | (agent) | ✔ duplicated map | ✔ duplicated map | **yes** |
| **last-20-message slice + format** | — | — | ✔ | ✔ (verbatim copy) | **yes** |
| **Dashboard (Hub page)** | ✔ full `buildDashboard` | — | — | — | opt-in |
| **Test RPC seam (`_setRuntimeApiForTests`)** | ✔ | ✔ (deps override) | ✔ | ✔ | **yes** |
| **State substrate** | Storage (`user`/`global`) + DB | DB (`briefing_configs`) | DB + Storage | DB + Storage | **all DB/Storage — none use a FS queue** |

The "yes" rows are the extraction target. The "divergent" rows are why the
primitive must be **configurable, not opinionated** about idempotency, retention,
and error policy — it supplies defaults and hooks, never a hard-coded strategy.

---

## 3. Design opinion #1, affirmed with evidence — DB/Storage state, not a filesystem queue

The locked opinion holds, and the codebase already lives by it. **Not one of the
four loops uses a file-move inbox/backlog/done queue for durable state.** They use:

- `extension_schedules` / `extension_schedule_fires` (cron fire-state, atomic
  claim via `FOR UPDATE SKIP LOCKED`),
- the `extension_storage` KV table via the `Storage` API (`ez-code` run records
  under scopes `user`/`global`; 1 MB/key, optional TTL/encryption,
  `storage.ts`),
- bespoke domain tables (`briefing_configs`, `lessons`, `memories`).

The filesystem appears only in two **non-state** roles, which we keep:

1. **Human-editable config input** — `ez-code` reads
   `.ezcorp/extension-data/ez-code/triggers.json` via host-mediated `fsRead`
   (fail-soft to `[]`). This is git-legible operator input, not durable run-state.
2. **Human-/agent-readable artifacts** — the actual outputs (a briefing
   conversation, a distilled lesson, a memory) plus, where useful, a mirrored log.

We formalize this split as a primitive-level invariant (§7):

> **Durable state is transactional (DB/Storage). The `.ezcorp/extension-data/<loop>/`
> tree holds only (a) human-editable config and (b) human-readable artifact/log
> mirrors — never the source of truth.**

This preserves the file-move pattern's *good* property (explicit, inspectable,
git-legible transitions) while getting transactions, RBAC/ownership, quotas, and
per-conversation scoping from Storage/DB — exactly the rejection rationale, now
backed by the existing implementation.

---

## 4. The primitive: `defineLoop({ trigger, contract, act, log })`

Lives at `packages/@ezcorp/sdk/src/runtime/loop.ts`, exported from
`runtime/index.ts` as a peer of `Schedule`. It is a thin orchestrator that
composes the existing SDK primitives (`Schedule`, `Storage`, `registerEventHandler`,
`createToolDispatcher`, `definePage`/`pushPage`, `spawnAssignment`/`cancelRun`).

```ts
defineLoop({
  id: "distill",                       // unique per extension; namespaces state
  trigger,                             // §4.1 — how a fire is induced
  contract,                            // §4.2 — run-state schema + invariants
  act,                                 // §4.3 — the loop body (terminal | deferred)
  log,                                 // §4.4 — durable record + artifact + dashboard
});
```

### 4.1 `trigger` — how a fire is induced

A loop declares one or more triggers. All are validated at install time against
the manifest (cron crons must be in `permissions.schedule.crons`; event names must
be subscribed in `permissions.eventSubscriptions`).

```ts
type LoopTrigger =
  | { kind: "cron";   cron: string; timezone?: string }            // → Schedule.on
  | { kind: "event";  event: SubscribableEvent; filter?: (p) => boolean } // → registerEventHandler
  | { kind: "manual"; tool?: string; pageAction?: string }         // → createToolDispatcher / page action
  | { kind: "interval"; ms: number };                              // → host loop-runner (rare)
```

Mapping to existing wiring (no new scheduler):
- `cron` → `new Schedule().on(cron, fire)`; fire-bookkeeping rides on
  `extension_schedules`/`_fires` (the `ScheduleHandlerContext` already carries
  `cron/firedAt/fireId/catchUp/attempt`).
- `event` → `registerEventHandler(event, …)`; `filter` replaces each loop's
  hand-rolled "is this the right agent/status?" gate (e.g. memory-extractor's
  `wrong_agent_or_status` decline).
- `manual` → a generated tool handler via `createToolDispatcher`, and/or a Hub
  page-action handler — covers `dispatch_run`/`distill_now` and the
  cancel/steer/open-pr row actions.

### 4.2 `contract` — run-state schema + invariants

The `contract` is the heart of the abstraction: it declares the **shape and rules
of a run**, so the primitive owns the state machine the four loops each hand-roll.

```ts
interface LoopContract<Outcome> {
  states: readonly string[];        // e.g. ["dispatched","running","completed","failed","cancelled"]
  terminal: readonly string[];      // subset considered "done"

  // Idempotency: stable key for a unit of work. Duplicate keys in a non-terminal
  // run are no-ops (replaces ez-code dedup, distiller slug-collision intent).
  idempotencyKey?: (input) => string;

  retention?: { maxRuns?: number; maxEventsPerRun?: number }; // ez-code: 100 / 50

  // Failure policy — generalizes briefing's "disable @5" + distiller warn-once.
  failure?: {
    classify?: (err) => "transient" | "permanent";
    autoDisableAfter?: number;      // consecutive permanent errors (briefing: 5)
    onAutoDisable?: (ctx) => Promise<void>;
  };

  concurrency?: { maxConcurrent?: number; maxPerDay?: number }; // mirrors spawnAgents/schedule quotas
}
```

The primitive uses `states`/`terminal` + the inbound `task:assignment_update`
event to drive deferred runs (§4.3), replacing `ez-code`'s `mapStatus`,
`applyAssignmentUpdate`, `isLive`, and retention trimming.

### 4.3 `act` — the loop body (terminal **or** deferred)

```ts
type ActResult<Outcome> =
  | { kind: "terminal"; status: string; outcome: Outcome }     // capture loops
  | { kind: "deferred"; runId: string; status: string;         // ez-code dispatch
      awaitEvent: "task:assignment_update" }
  | { kind: "skip"; reason: string };                          // decline (gate/disabled/empty)

type LoopAct<Input, Outcome> = (ctx: LoopActContext<Input>) => Promise<ActResult<Outcome>>;

interface LoopActContext<Input> {
  fire: { id: string; firedAt: string; trigger: LoopTrigger; catchUp: boolean };
  input: Input;                       // event payload | tool args | cron tick
  state: LoopRunState;                // current run record (open run for deferred)
  llm: Llm;                           // SDK Llm — with shared provider/model defaults
  log(msg, level?): void;             // → fire audit + optional artifact mirror
  spawn: typeof spawnAssignment;      // deferred dispatch
}
```

- **Terminal** loops `return { kind:"terminal", … }` and the primitive writes the
  record + artifact + advances fire bookkeeping in one transaction.
- **Deferred** loops `return { kind:"deferred", runId, … }`; the primitive opens a
  non-terminal run record and registers an internal `task:assignment_update`
  handler that maps the inbound status onto `contract.states` and closes the run —
  exactly `ez-code`'s flow, now owned by the SDK.
- **Skip** is a first-class decline (replaces the four loops' `decline` unions:
  `trigger_gate_blocked`, `settings_disabled`, `empty_conversation`, …) and is
  logged but not counted as an error.

Shared helpers the SDK provides so `act` bodies shrink (the §2 "yes" rows):
`resolveSettings(defaults)` (read + fallback-to-`{}`), `recentMessages(convId, n=20)`
(the duplicated last-20 slice/format), and provider/model defaults baked into `Llm`.

### 4.4 `log` — durable record + artifact + dashboard

```ts
interface LoopLog<Outcome> {
  // Map an outcome to a human-readable artifact mirrored under
  // .ezcorp/extension-data/<loop>/  (NEVER the source of truth — §3)
  artifact?: (run: LoopRunState, outcome: Outcome) => { path: string; body: string } | null;

  // Optional Hub dashboard — opt-in, declarative. Reuses PageBuilder.
  dashboard?: {
    pageId: string;
    render: (runs: LoopRunState[]) => HubPageTree;   // ez-code buildDashboard, generalized
    rowActions?: Record<string, (e: PageActionEvent) => Promise<void>>; // cancel/steer/open-pr
  };
}
```

Durable writes (run record + fire audit) are automatic and transactional. The
`log` block only declares the *human-facing* projections: the artifact mirror and
the optional dashboard, with content-free SSE invalidation on state change
(reusing the existing `pushPage` / `ext:page-state` path).

---

## 5. State model

Two stores, both already-existing substrates — **no new scheduler, one new table.**

1. **Fire bookkeeping (cron/interval): reuse `extension_schedules` + `extension_schedule_fires`** as-is. Claim-before-dispatch, `nextFireAt`, `consecutiveErrors`, auto-disable, per-fire audit already implemented and tested via `ScheduleDaemon`.

2. **Run records (the unit the dashboard shows; required for deferred/dispatch): one new table** `extension_loop_runs`, modeled on `ez-code`'s `RunRecord` (`index.ts:155–167`) so the dispatch loop maps 1:1:

   ```
   extension_loop_runs(
     id, extension_id, loop_id, scope,            -- scope: user | global | conversation
     idempotency_key,                             -- nullable; unique per (loop, non-terminal)
     status, input_json, outcome_json,
     external_run_id, external_assignment_id, sub_conversation_id, -- deferred handoff
     events_json,                                 -- capped append-log (retention.maxEventsPerRun)
     created_at, updated_at
   )
   ```

   Indexed on `(extension_id, loop_id, status)`; retention trimming is a DELETE of
   oldest terminal rows beyond `retention.maxRuns`. For loops that need *no* run
   record (pure stateless capture like memory-extractor compaction), the row is
   optional — the fire audit alone suffices.

> Why a table and not Storage-KV like ez-code? ez-code packs all runs into a
> single `"runs"` key (`storageBackedRunStore`), capped at 100, read-modify-write
> on every mutation. That races under concurrent fires and can't be queried. A
> table gives per-row atomic transitions, the `FOR UPDATE SKIP LOCKED` claim the
> rest of the system already uses, and indexable dashboard reads. This is a
> deliberate upgrade over the most-realized loop, justified by the same rationale
> as design opinion #1.

State machine (owned by the primitive, driven by `contract.states`):

```
            act()=deferred          task:assignment_update
 (none) ──► dispatched ──► running ─────────────────────────► completed | failed | cancelled
   │                                                                  ▲
   └── act()=terminal ────────────────────────────────────────────────┘ (one transition)
   └── act()=skip ───► (no run row; fire audit only)
```

---

## 6. What stays bespoke (anti-over-abstraction)

The primitive deliberately does **not** absorb:

- **System prompts & parsing** — each loop's LLM contract (briefing sections,
  one-lesson JSON, fact arrays) stays in the extension.
- **Dedup *policy*** — the *mechanism* (idempotency key, "duplicate = no-op") is
  shared; *what counts as duplicate* (slug vs content+category vs "always new
  conversation") is a `contract.idempotencyKey` the extension supplies.
- **The sandboxed git/PR flow** — `ez-code`'s worktree materialization +
  jailed `git/gh` (`openPrForRun`, `makeProductionShell`) is a security-critical,
  ez-code-specific concern. It stays in ez-code, invoked from a `manual` trigger /
  row action. The Loop primitive must not grow a "git" surface.
- **Cross-extension authorization scope** (memory-extractor's `selfOnly:false`)
  stays a manifest permission, untouched.

If a concept appears in only one loop, it does not enter the primitive.

---

## 7. Invariants the primitive enforces

1. **Durable state is transactional (DB/Storage).** `.ezcorp/extension-data/<loop>/`
   is artifacts + config only, never source of truth (§3).
2. **Input-only / no host-table writes from extension `act`.** Extensions touch
   only their `extension_loop_runs` rows + `extension_storage` + their own domain
   capability (lessons/memory) via existing gated RPC. (Consistent with the
   context-compaction "input-only" discipline and the fs-provenance gating.)
3. **Idempotent fires.** A duplicate `idempotencyKey` on a non-terminal run is a
   no-op — safe under cron catch-up (`catchUp:true`) and double-delivered events.
4. **Fail-soft.** Missing config / settings / messages degrade to skip, never
   throw (matches every existing loop's behavior).
5. **Declared triggers only.** Crons/events not in the manifest are dropped by the
   host (existing `Schedule`/event-registry behavior) — the primitive never
   widens the permission surface.

---

## 8. Migration mapping (proof the abstraction fits)

| Extension | trigger | contract | act | log | Net change |
|---|---|---|---|---|---|
| **lessons-distiller** | `event:run:complete` (+ `manual:distill_now`) | states `[done]`; `idempotencyKey = slug`; `failure.classify = classifyLlmError`, warn-once | terminal: `recentMessages(20)` → `llm` → return outcome | artifact = lesson md mirror; no dashboard | deletes settings-fallback, last-20, provider map, RPC seam, outcome plumbing |
| **memory-extractor** | `event:run:complete` + `cron:compaction` | two loops, one ext: capture (no run row) + compaction (stateless) | terminal × N facts; compaction = `invoke(memory.compact)` | none | deletes the same boilerplate; cron stays on `extension_schedules` |
| **ez-code** | `cron` (triggers.json) + `manual` (dispatch/cancel/steer/open-pr) + `event:task:assignment_update` (internal) | states `[dispatched,running,completed,failed,cancelled]`; retention 100/50; `idempotencyKey = agentRunId` | **deferred**: `spawn(...)` → `{deferred}` | dashboard = `buildDashboard`; row actions cancel/steer/open-pr | deletes RunStore, mapStatus, applyAssignmentUpdate, retention trim, dual-scope plumbing; **keeps** git/PR flow |
| **daily-briefing** | `cron` per-user | states `[ok,error,skipped]`; `failure.autoDisableAfter=5`, `onAutoDisable=notify` | terminal: build conv + `streamChat` | artifact = the conversation | **host-side via shared core (§9)**, not the extension facade — separate phase |

All four fit. The dispatch shape (`ez-code`) and the host daemon
(`daily-briefing`) are the two that *stress* the design and are why §1's
refinements exist.

---

## 9. Architecture: shared core + two facades

```
packages/@ezcorp/sdk/src/runtime/loop.ts        ── defineLoop()  (extension facade)
        │  composes Schedule, Storage, Events, Page, spawnAssignment
        ▼
src/runtime/loop/loop-core.ts                    ── pure state machine + contract eval
        ▲                                            (no I/O; 100%-unit-testable, mirrors
        │                                             ez-code's exported pure helpers)
src/runtime/loop/host-loop-adapter.ts            ── host facade for daily-briefing
        │  drives loop-core from BriefingDaemon's per-user fan-out
        ▼
extension_schedules / extension_schedule_fires (reuse)  +  extension_loop_runs (new)
```

- **`loop-core`** is pure (state transitions, idempotency, retention,
  classify/auto-disable decisions). It is the testable heart — same discipline as
  ez-code's exported `appendRun`/`applyAssignmentUpdate`/`buildDashboard` pure
  functions, now shared.
- **`loop.ts`** (SDK) is the extension-facing facade running in the extension
  subprocess; it wires triggers to host RPC and persists via the gated Storage/run
  RPC.
- **`host-loop-adapter.ts`** lets the existing `BriefingDaemon` reuse `loop-core`
  without becoming an extension — closing Finding A without a risky migration.

---

## 10. Implementation plan (phased)

Each phase ships with **100% unit + integration + e2e coverage on new paths**
(CI-gated per-file — project bar) and **atomic commits**. Phases 1–3 are the
primitive; 4–7 are migrations, each independently revertable.

### Phase 0 — Spike & contract freeze (no prod code)
- Validate the `extension_loop_runs` schema against ez-code's `RunRecord` and the
  dispatch flow end-to-end on paper. Confirm `task:assignment_update` carries
  enough to drive the deferred transition (it does — `applyAssignmentUpdate` keys
  on `agentRunId|assignmentId|taskId`).
- **Decision gate:** confirm "new table vs Storage-KV" (§5) and the host-core
  split (§9) with the user (open questions §12).

### Phase 1 — `loop-core` (pure) + `extension_loop_runs` table
- `src/runtime/loop/loop-core.ts`: state machine, idempotency, retention,
  failure-classify/auto-disable — pure, ported from ez-code's helpers.
- Migration in `src/db/migrate.ts` (hand-written SQL, `IF NOT EXISTS`) for
  `extension_loop_runs`; Drizzle table in `src/db/schema.ts`.
- Tests: exhaustive unit tests on `loop-core`; migration idempotency test.
- **Risk:** none external; pure module.

### Phase 2 — SDK `defineLoop` facade + run-record RPC
- `packages/@ezcorp/sdk/src/runtime/loop.ts`; export from `runtime/index.ts`.
- Host RPC handlers for run-record CRUD (claim/transition/list/trim) +
  shared helpers (`resolveSettings`, `recentMessages`, provider/model defaults
  centralized off the duplicated maps).
- Wire `trigger` kinds to existing `Schedule.on` / `registerEventHandler` /
  `createToolDispatcher`.
- Tests: integration test spawning the **real `--preload` subprocess** (per the
  "extensions: test real subprocess" lesson — `node:fs`/RPC poisoning makes
  in-process mocks lie); cover cron, event, manual, deferred, skip.
- **Risk:** RPC surface; mitigate with the route-contract meta-test pattern.

### Phase 3 — `log`: artifact mirror + opt-in dashboard
- Artifact writer via host-mediated `fsWrite` under
  `.ezcorp/extension-data/<loop>/` (provenance-gated; **host-side** for any
  watcher/daemon path per the fs-provenance constraints).
- Dashboard helper generalizing `buildDashboard` + row-action dispatch + push.
- Tests: e2e (Playwright) for a sample loop dashboard incl. a row action.

### Phase 4 — Migrate `lessons-distiller` (simplest terminal loop)
- Re-express on `defineLoop`; delete the absorbed boilerplate (settings fallback,
  last-20, provider map, RPC seam, outcome plumbing).
- **Verification:** diff behavior vs `main` — same triggers fire, same
  slug-collision decline, same warn-once. Existing distiller tests must stay green
  (or be migrated 1:1).

### Phase 5 — Migrate `memory-extractor` (event + cron, two loops/ext)
- Proves multi-loop-per-extension and the stateless-compaction path.
- Watch the **`background-timers.test.ts` mock requirement** if any daemon wiring
  changes (known gotcha: new/changed daemon → stub or `intervalCalls` assertions
  break + stray `.pid`).

### Phase 6 — Migrate `ez-code` (deferred dispatch + dashboard)
- The acid test. Re-express dispatch/track/cancel/steer + dashboard on the
  primitive; **keep** the git/PR sandbox flow as a row-action handler outside the
  primitive (§6).
- Move run storage from the single Storage `"runs"` key to `extension_loop_runs`
  (the §5 upgrade). Preserve user/global scope split via the `scope` column.
- **Verification:** the headline ez-code e2e (dispatch → status transitions →
  dashboard push → cancel) green pre/post.

### Phase 7 (stretch / separable) — `daily-briefing` onto `loop-core`
- Route `BriefingDaemon` through `host-loop-adapter` so it shares the state
  machine + auto-disable, keeping its per-user fan-out and host concurrency cap.
- Only proceed if Phases 1–6 prove the core; otherwise leave briefing as-is and
  document the shared-convention parity. **Not a blocker for declaring the thesis
  delivered.**

---

## 11. Testing & coverage strategy

- **`loop-core` pure** → trivial 100% unit coverage; the file that carries the
  state machine must stay ≥95% (coverage-gate mechanics) — keep it logic-only.
- **Subprocess integration** → spawn the real preloaded extension subprocess;
  never assert against in-process mocks for fs/RPC paths.
- **Deferred path** → simulate `task:assignment_update` and assert the run-record
  transition + dashboard push.
- **e2e** → one representative loop end-to-end (trigger → act → log → dashboard)
  under the Docker harness for send-flow specs.
- **Regression** → each migration phase diffs behavior against `main` before merge;
  existing per-extension suites migrate 1:1, not rewritten.

---

## 12. Open questions (decisions for the user)

1. **Run-record substrate** — new `extension_loop_runs` table (recommended, §5)
   vs. keep ez-code's Storage-KV style for SDK-side simplicity? (Trade: query-able
   + race-free + indexable vs. zero migrations.)
2. **`daily-briefing` scope** — include the Phase-7 host-core migration in this
   effort, or ship the extension-facing primitive (Phases 1–6) and leave briefing
   on shared *conventions* only?
3. **Multi-loop-per-extension** — confirm one extension may declare N loops
   (memory-extractor needs 2). Affects manifest schema (`loops[]` vs single).
4. **Manifest surface** — declare loops in the manifest (`loops:[…]`, validated
   at install like `schedule.crons`) or purely at runtime via `defineLoop()`?
   Manifest declaration buys install-time validation + the permission gate;
   recommended.

---

## 13. Non-goals

- A filesystem inbox/backlog/done queue for durable state (explicitly rejected, §3).
- A new scheduler — `extension_schedules`/`ScheduleDaemon` are reused.
- Absorbing domain logic (prompts, parsing, git/PR, cross-ext auth) into the
  primitive (§6).
- Cross-extension loop chaining / DAGs — out of scope; loops compose via existing
  events, not a new orchestration graph.

---

## 14. Bottom line

The thesis is sound but undersells the work in one place and oversells it in
another. **Undersells:** the genuine win is eliminating the *glue* — settings
resolution, run-record + status machine, fire bookkeeping, idempotency, retention,
error policy, dashboard — which is duplicated four ways. **Oversells:** "four
collapse onto one" ignores that `daily-briefing` is a host daemon and that
`ez-code`'s deferred-dispatch `act` is a second shape. A `defineLoop` built around
a **pure `loop-core` + two facades**, reusing the existing scheduler and adding a
single run-record table, lets all three extensions collapse cleanly and lets the
host daemon share the core — delivering the thesis's intent without pretending the
four are the same animal.
