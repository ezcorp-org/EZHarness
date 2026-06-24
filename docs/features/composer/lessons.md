# Lessons Keeper

> _Auto-captured, reusable insights distilled from completed runs, surfaced in future turns via the `%[lesson:slug]` composer sigil and curated through a user → project → global visibility ladder._

## Intent

The Lessons Keeper turns the durable "what we learned" residue of a conversation into a reusable asset. When a chat run finishes, a bundled extension (`lessons-distiller`) decides whether the run produced a generally-applicable lesson, asks a cheap LLM to distill exactly one, and persists it scoped to the user. Lessons are then injected into later prompts on demand via the `%[lesson:slug]` mention sigil (the fifth composer sigil), and a curation UI lets owners delete or promote them up a monotonic visibility ladder (`user` → `project` → `global`). It exists so the assistant's hard-won corrections and recovery patterns survive across sessions without the user re-explaining them.

## How it works

The feature splits into three independent paths: **capture** (distillation), **recall** (mention expansion), and **curation** (the API + UI).

### Capture — auto-distill on `run:complete`

1. `lessons-distiller` is a bundled, **event-subscribed** extension wired in `src/extensions/bundled.ts` (`name: "lessons-distiller"`, `path: "extensions/lessons-distiller"`). It subscribes to `run:complete` and is `bootSpawn: true` / `persistent: true` so its subprocess is alive to receive the event (without bootSpawn, `run:complete` is silently dropped before the subprocess starts). It also declares a single `distill_now` tool for the manual `!EZ:distill` path (so it is not strictly event-*only*, despite a stale "no tools" comment in `bundled.ts`).
2. Auto-distill is driven by a `defineLoop` act (`defineDistillLoop`, `trigger.kind: "event"`, `event: "run:complete"`) in `extensions/lessons-distiller/index.ts`. `distillRunComplete` gates first: it skips unless `settings.enabled !== false`, the run's `agentName === "chat"`, and `run.status === "success"`.
3. The extension then calls the **host-side trigger gate** over reverse-RPC: `ctx.invoke("runtime.lessons.triggerGate", …)` routes to `handleTriggerGate` in `src/extensions/runtime-invoke-handler.ts`, which runs the pure heuristics in `src/runtime/lessons/triggers.ts`. `shouldDistill` is an **OR-of-flags**: `toolCallCount >= 5` (`TOOL_CALL_THRESHOLD`), `errorRecoveryObserved` (an `error` event followed by a later `ok`), `userCorrectionObserved` (a user message matched a correction regex like `\bno,`, `\bactually\b`, `\binstead\b`), or `explicitlyTagged` (user wrote `[lesson]`). Any single signal is enough.
4. If the gate passes, `distill` fetches the last-20-message window (`runtimeApi.getMessages` → `runtime.conversations.getMessages`), formats it, and asks a small model (`DISTILLATION_SYSTEM_PROMPT`, `temperature: 0`, `maxTokens: 1024`) for **at most one** lesson as JSON.
5. The parsed lesson is written via `ctx.lessons.write` → the host handler `handlePiLessons` (`src/extensions/lessons-handler.ts`). Writes are stamped server-side: `authorExtensionId` from the actor (never RPC meta), `ownerId` from `onBehalfOf`, `source: "extension"`, and `visibility` **clamped** to the grant's `maxVisibility` (`"user"` for the distiller — extensions cannot self-grant `global`). A slug collision (partial-unique index) is a **soft outcome**: the existing row is returned with `created: false` rather than an error.

### Recall — `%[lesson:slug]` expansion at prompt-build time

1. The composer recognizes `%` as the lesson sigil (`web/src/lib/mention-logic.ts`); the popover hits `GET /api/mentions/search?type=lesson`, which calls `searchLessons(projectId, user.id, q)` — ILIKE on title+slug, ranked by visibility-priority then `lastFiredAt DESC` then `firedCount DESC`, slug-deduped (most-specific scope wins) before the limit cut.
2. At prompt build (`src/runtime/stream-chat/build-prompt.ts`), `applyLessonExpansion` (in `src/runtime/mention-wiring.ts`) walks `%[lesson:slug]` tokens, dedupes by slug, and resolves each via `getLessonBySlug(projectId, ownerId, slug)` (`src/db/queries/lessons.ts`). Resolution applies the **visibility ladder** with a SQL `CASE` priority: a user-owned row beats a project-shared row beats a global row at the same slug.
3. Each resolved lesson becomes a `**Lesson: <title>**\n<body>` block. **Hard caps**: at most `MAX_LESSON_EXPANSIONS_PER_TURN` = 5 blocks, and the joined text may not exceed `MAX_LESSON_EXPANDED_CHARS` = 8 KiB (UTF-16 units); excess is dropped whole (no mid-body truncation). The cap is applied after dedupe and the resolver is `Promise.all`'d over only the first ≤5 slugs, so a paste-bomb of 100 tokens still triggers exactly 5 lookups.
4. Expansion is **literal** — bodies are emitted verbatim; any other mention sigil inside a body is left untouched (no double-expansion). The user-visible message is never modified; only the LLM-facing prompt gains the prepended note. This block runs **after** feature expansion so lesson notes land at the **top** of the prompt (persistent guidance vs. turn-specific context).
5. Each successfully included lesson fires `onFired(lessonId)`, which fire-and-forget calls `incrementFiredCount` (atomic `fired_count + 1`, `last_fired_at = now`). Unknown/deleted slugs are silent no-ops, mirroring `@[file:…]`.

### Manual capture — the `!EZ:distill` action

`!EZ:distill` is intercepted in the send pipeline as an EZ action and forwarded by `web/src/routes/api/ez-actions/[name]/+server.ts` to the bundled `lessons-distiller:distill_now` tool (the legacy `"distill"` alias is preserved in `src/runtime/ez-actions/resolve-bundled.ts` / `registry.ts`). `distill_now` calls `distill(…)` with `skipTriggerGate: true` — the heuristic gate is bypassed because the user explicitly opted in. The result is mapped through the `__ezDistillerOutcome` envelope into an `ez-action-result` chat card (success / decline / error).

### Curation — the `/memories → Lessons` tab

- `GET /api/lessons?projectId=` (`web/src/routes/api/lessons/+server.ts`) returns the same visibility-deduped set as the popover, but with full body + counters + an `ownedByMe` flag. Internal fields (`ownerId`, `sourceSha256`, `projectId`) are stripped. The list MAY surface lessons the user doesn't own (project/global); mutations re-check ownership.
- `DELETE /api/lessons/[id]` and `PATCH /api/lessons/[id]` (`web/src/routes/api/lessons/[id]/+server.ts`) are **owner-gated**. Delete is a hard delete (204; 404 collapses "not found" and "not owned" to defeat id enumeration). PATCH promotes visibility, **monotonic only** (`user → project|global`, `project → global`) — a backward transition by the actual owner returns **409**, everything else collapses to **404**.

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/lessons?projectId=…` | `read` | Curation list: full body + `firedCount`/`lastFiredAt`/`dismissedCount` + `ownedByMe`. `projectId` required (400 if missing). |
| `DELETE /api/lessons/[id]` | `read` | Owner-gated hard delete. 204 success; 404 not-found-or-not-owned. |
| `PATCH /api/lessons/[id]` | `read` | Owner-gated monotonic visibility promotion. Body `{ "visibility": "user"｜"project"｜"global" }`. 200 applied/no-op; 400 invalid; 404 missing/not-owned; **409** backward transition. |
| `GET /api/mentions/search?type=lesson&projectId=…&q=…` | `read` | `%`-popover search (ILIKE title+slug, recency-ranked, slug-deduped, ≤10). |
| `POST /api/ez-actions/distill` | (EZ action) | Force-distill the active conversation, bypassing the trigger gate. Maps to `lessons-distiller:distill_now`. |

### Composer / UI entry points

- **Mention:** type `%` in the composer → lesson popover → inserts a `%[lesson:slug]` token. The raw token is persisted; the LLM sees the expanded body.
- **Manual distill:** type `!EZ:distill` (the `!` EZ-action sigil) → force-captures a lesson from the current conversation.
- **Curation:** `web/src/routes/(app)/memories/+page.svelte` → **Lessons** tab → `web/src/lib/components/LessonsTab.svelte` (delete + promote affordances).

### Extension SDK surface (`ctx.lessons.*`)

Reverse-RPC capability handled by `handlePiLessons`: `list`, `get`, `write`, `update`, `archive`, `recordFired`, `recordDismissed`. Gated by the extension's `lessons` permission (`access: "read"｜"write"`, `maxVisibility`, `maxWritesPerDay`). Writes consume a per-extension daily quota (`extension_lessons_writes_daily`); over-quota returns JSON-RPC error `-32103`.

### Settings (per the `lessons-distiller` extension manifest)

`enabled` (bool, default true), `provider` (select: google/openai/anthropic/ollama, default google), `model` (text override). Defined in `extensions/lessons-distiller/ezcorp.config.ts`; legacy `global:lessonDistillerEnabled` migrates into the per-extension `enabled` setting.

## Key files

- `src/runtime/lessons/triggers.ts` — pure `shouldDistill` heuristics (`TOOL_CALL_THRESHOLD`, user-correction regex, error-recovery, explicit `[lesson]` tag).
- `extensions/lessons-distiller/index.ts` — the bundled distiller: `distill`, `distillRunComplete`, `defineDistillLoop`, `distill_now` tool, `DISTILLATION_SYSTEM_PROMPT`, JSON parsing → `ctx.lessons.write`.
- `extensions/lessons-distiller/ezcorp.config.ts` — manifest: `run:complete` subscription, `llm` + `lessons` (write, `maxVisibility: "user"`) permissions, settings.
- `src/extensions/lessons-handler.ts` — `ctx.lessons.*` reverse-RPC host handler; host-side `authorExtensionId`/`ownerId` stamping, visibility clamp, slug-collision soft outcome, write-quota.
- `src/extensions/runtime-invoke-handler.ts` — `runtime.lessons.triggerGate` + `runtime.conversations.getMessages` host invoke handlers feeding the distiller.
- `src/runtime/mention-wiring.ts` — `applyLessonExpansion`, `LESSON_TOKEN_RE`, the 5-token / 8 KB caps, `onFired` callback.
- `src/runtime/stream-chat/build-prompt.ts` — wires `applyLessonExpansion` into the prompt (after feature expansion, top-of-prompt) with `getLessonBySlug` + `incrementFiredCount`.
- `src/db/queries/lessons.ts` — visibility-ladder queries: `getLessonBySlug`, `listVisibleLessons`, `searchLessons`, `incrementFiredCount`, `incrementDismissedCount`, and v1.5 owner-gated `deleteLessonAsOwner` / `updateLessonVisibilityAsOwner` / `getLessonByIdForOwnerCheck`.
- `web/src/routes/api/lessons/+server.ts` — `GET` curation list (visibility-deduped, fields stripped).
- `web/src/routes/api/lessons/[id]/+server.ts` — `DELETE` (hard) + `PATCH` (monotonic promote, 404/409 disambiguation).
- `web/src/routes/api/mentions/search/+server.ts` — `type=lesson` branch → `searchLessons`.
- `web/src/lib/mention-logic.ts` — the `%` sigil trigger/tokenize (`PERCENT_TRIGGER_RE`, `kind: "lesson"`).
- `web/src/lib/components/LessonsTab.svelte` — curation UI (delete + promote).
- `web/src/routes/(app)/memories/+page.svelte` — hosts the **Lessons** tab.
- `src/runtime/ez-actions/resolve-bundled.ts`, `src/runtime/ez-actions/registry.ts` — `!EZ:distill` → `lessons-distiller:distill_now` legacy-alias forwarding.
- `web/src/routes/api/ez-actions/[name]/+server.ts` — forwards the EZ action to the bundled tool, maps the `__ezDistillerOutcome` envelope to a chat card.
- `src/db/schema.ts` — `lessons`, `lessonsAuditLog`, `extensionLessonsWritesDaily` tables; `source` enum (`distiller｜user｜extension`); counters.
- `src/db/migrations/add-lessons.ts` — table + partial unique indexes (`idx_lessons_user_slug_unique WHERE visibility='user'`, `idx_lessons_shared_slug_unique WHERE visibility IN ('project','global')`).

## Features it touches

- [[mention-grammar]] — `%[lesson:slug]` is the fifth composer sigil; shares the pure `mention-logic.ts` module and the `/api/mentions/search?type=` endpoint.
- [[ez-concierge-and-actions]] — `!EZ:distill` is an EZ action intercepted in the send pipeline and forwarded to `distill_now`.
- [[streaming-runtime]] — lesson expansion happens in `build-prompt.ts` on the way into `streamChat`; the prompt the model sees carries the expanded bodies.
- [[runs-lifecycle]] — auto-distill triggers on the `run:complete` event; only successful `chat` runs distill.
- [[context-compaction]] — lesson notes are prepended to the prompt input (subject to the 5/8 KB caps) and then to the trim budget.
- [[persistent-memory]] — sibling auto-capture surface; both share the `/memories` page and the bundled event-driven extraction pattern (`memory-extractor`).
- [[knowledge-base]] — the third tab on the `/memories` page alongside Memories and Lessons.
- [[bundled-catalog]] — `lessons-distiller` is one of the boot-wired bundled extensions.
- [[permissions-and-grants]] — `ctx.lessons` writes are bounded by the grant's `maxVisibility` and `maxWritesPerDay`.
- [[audit-and-observability]] — lesson writes/updates land in `lessons_audit_log`; clamps emit `ext:sdk-lessons-visibility-clamped` audit rows; per-call rows hit `sdk_capability_calls`.
- [[runtime-and-rpc]] — the distiller reaches host data via `runtime.lessons.triggerGate` / `runtime.conversations.getMessages` reverse-RPC.
- [[feature-index]] — `$[feature:…]` expansion runs just before lesson expansion in the same `build-prompt.ts` pass; same "literal, no double-expansion" contract.
- [[scheduling-and-loops]] — auto-capture uses the `defineLoop` event-trigger primitive.
- [[projects]] — every lesson is project-scoped; `projectId` is required on all list/search/distill paths.

## Related docs

None yet — this is the primary reference. (See [mention-grammar](../composer/mention-grammar.md) for the shared sigil machinery and [ez-concierge-and-actions](../composer/ez-concierge-and-actions.md) for the `!EZ:` action pipeline that backs `!EZ:distill`. Design notes live in `tasks/lessons-keeper-v1.md` and `tasks/lessons-keeper-v1.5-admin.md`.)

## Notes & gotchas

- **Five sigils, not four.** The composer grammar has five active sigils in code — `!` `@` `/` `$` `%` (plus the `EZ` kind nested under `!`). `%[lesson:slug]` is the lesson sigil. CLAUDE.md's mention table predates `%` and lists only four; the code (`web/src/lib/mention-logic.ts`) is authoritative.
- **Distiller is bundled, not an example.** `lessons-distiller` lives at `extensions/lessons-distiller/` and is wired at boot via `BUNDLED_EXTENSIONS` — it is not under `docs/extensions/examples/`. Don't conflate the boot-bundled set with the example/test-fixture dirs on disk.
- **Visibility clamp ≠ promotion.** The SDK `ctx.lessons.write` path clamps to the grant ceiling (distiller can only write `user`). Promotion to `project`/`global` happens only through the **owner-gated** `PATCH /api/lessons/[id]` curation route, and is **monotonic** — you cannot demote (409). Rationale: a project lesson's `firedCount` accrues across members; demoting would orphan that shared signal. Bad project lessons are hard-deleted, not demoted.
- **404 collapses ownership.** `DELETE` and `PATCH` return 404 for both "row missing" and "not owned by caller" (no 403) to prevent id enumeration. `PATCH` does a second owner-ignoring read (`getLessonByIdForOwnerCheck`) purely to disambiguate the legitimate-owner backward-transition (409) from a 404.
- **`GET /api/lessons` is intentionally broad.** It returns full bodies of project-shared and global lessons the requester doesn't own — by spec, that's the curation surface, not a leak. Only mutations are owner-gated.
- **Hard caps fail closed.** A turn expands at most 5 `%[lesson:]` tokens and 8 KB of joined bodies; excess blocks are dropped whole. A paste-bomb of lesson tokens cannot DoS the context window. The 8 KB is JS string length (UTF-16 units), so multi-byte text produces a larger downstream payload than the number implies.
- **`fired_count` vs `dismissed_count`.** A successful expansion bumps `fired_count` + `last_fired_at` (promotes the row in recency-ranked search). A dismissal bumps only `dismissed_count` and deliberately does **not** touch `last_fired_at` — the inverse signal must not promote the row.
- **Slug collisions are soft.** `ctx.lessons.write` returns the existing row with `created: false` on a partial-unique collision instead of throwing; the distiller maps that to a `slug_collision` decline (no duplicate lesson, no error card).
- **Auto-distill needs the subprocess alive.** `lessons-distiller` must be `bootSpawn: true` + `persistent: true`; otherwise the `run:complete` event is dropped before the handler ever runs, or the subprocess idles out after 5 min and silently stops capturing.
- **Legacy distiller is gone (Stage 2 deleted it).** During Phase 53 Stage 1 a legacy host-side distiller (`src/runtime/lessons/distiller.ts`) shipped alongside the bundled port under a parity test (`distiller-port-parity.test.ts`); Stage 2 **deleted both** — neither file exists in the tree today (`src/runtime/lessons/` now contains only `triggers.ts`). Some code comments in `bundled.ts` / the extension manifest still narrate the Stage-1 parity scaffolding, but they are stale; the bundled extension's `defineDistillLoop` is the sole live auto-distill path. `src/runtime/lessons/triggers.ts` is the surviving shared heuristic module, still invoked by the host trigger-gate (`runtime.lessons.triggerGate`).
- **Global visibility is a forward-compat surface.** `getLessonBySlug`/`listVisibleLessons` already rank `global` rows in the per-project table, but `global` is documented as a v2 surface — the v1 blast radius for distiller-captured lessons is `user` only.
