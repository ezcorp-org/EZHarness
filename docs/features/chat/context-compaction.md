# Context-Window Compaction

> _Per-model history trimming that runs before every LLM call so a long chat fits the model's context window instead of dead-ending on `context_length_exceeded`._

## Intent

EZCorp re-sends the **full branch history** to the provider on every LLM call — the initial turn and every agentic tool-loop iteration. Once a thread crosses the resolved model's context window, the provider rejects every subsequent send (`context_length_exceeded`) and, because the failed turn never shrinks anything, each retry resends the same oversized payload — a permanently stuck chat. Context compaction computes a per-model input-token budget from the model's own `contextWindow` and trims history to fit **before** it reaches the provider, so long chats keep working. The trimming algorithm is a swappable strategy (`trim` default, `none` to disable); trimming is strictly **input-only** — the model object is never mutated.

## How it works

The whole mechanism lives in `src/runtime/stream-chat/context-compaction.ts` and is wired in `src/runtime/stream-chat/build-pi-agent.ts` via pi-agent-core's `transformContext` hook.

1. **Resolve config (per turn).** `executor.streamChat` calls `resolveCompactionConfig()` (`src/runtime/executor.ts`), which reads the `compaction:*` settings keys once per turn (mirroring the `provider:defaultTier` pattern). Each key is optional and falls back to module `DEFAULTS`; the partial override is passed into `buildPiAgent` as `options.compaction`.
2. **Build the transform.** `buildPiAgent` calls `makeCompactionTransform(model, options.compaction)` and assigns the returned async function to the `Agent`'s `transformContext`. `makeCompactionTransform` resolves the strategy from the registry, computes the input budget **once** for the turn's model, and returns a closure.
3. **Run before every LLM call.** pi-agent-core invokes `transformContext(messages, signal)` ahead of each provider send — the first turn, *every* tool-loop iteration, and retries — so a tool loop that balloons mid-turn is also kept in budget. If `estimateTokens(messages) <= budget`, the hook is a **no-op** and returns the array untouched.
4. **Compute the budget** (`computeInputBudget`): `contextWindow − responseReserve − ceil(contextWindow × safetyFraction)`, floored at 1. `responseReserve = clamp(model.maxTokens, floor, cap)` (`computeResponseReserve`) is headroom held back for output/reasoning; the safety margin absorbs token-estimator error (estimation is a char-based heuristic — pi-ai exposes no tokenizer). `contextWindow` defaults to `128_000` when the model advertises none.
5. **Estimate tokens** (`estimateTokens` / `estimateMessageTokens`): per LLM-visible message (`user` / `assistant` / `toolResult` — mirroring the `convertToLlm` filter), `PER_MESSAGE_OVERHEAD(4) + ceil(chars / charsPerToken) + images × imageTokens`. Non-LLM messages count zero.
6. **Trim** (`TrimStrategy`): drop any prior `[Context note: …]` markers, split history into **turn blocks** via `splitTurnBlocks` (a `user` message + every following assistant/toolResult up to the next `user`). The **last block — the active turn — is always kept intact**, so the current prompt and its in-flight tool loop are never broken and no `toolCall`/`toolResult` pair is orphaned. Oldest whole blocks are evicted (accounting for the marker's own token cost) until the result fits, then a single ephemeral marker is **prepended**.
7. **Degenerate fallback** (`truncateOversizedToolResults`): if only the active turn remains and it alone exceeds budget, the oldest oversized `toolResult` text contents are truncated to `…[truncated to fit context]…`, oldest-first. User-prompt and assistant text are **never** silently truncated — a precise overflow error is better than a mangled question.
8. **Marker is ephemeral.** The `[Context note: N earlier messages omitted …]` message exists only in the array sent for that one call; it is never persisted and never rendered in the chat UI.
9. **Backstop.** If a request still overflows (strategy `none`, or an estimate that undershot), pi-ai's own `isContextOverflow` detection surfaces a precise error instead of an opaque provider failure.

### Strategies & registry

Strategies are resolved by name from a process-global `Map` (`registerCompactionStrategy` / `getCompactionStrategy` / `listCompactionStrategies`). Two are registered at module load:

| Strategy | Behavior |
|----------|----------|
| `trim` (default) | Evict oldest whole turn blocks + prepend the ephemeral marker; degenerate `toolResult` truncation as a last resort. Deterministic, zero extra cost, cannot itself fail or overflow. |
| `none` | Passthrough — disables trimming. The budget is still computed and the `isContextOverflow` backstop still applies. |

An unknown `compaction:strategy` value logs a `warn` and falls back to `trim`. A future LLM `summarize` strategy is intentionally not shipped but drops in via `registerCompactionStrategy` with no rewiring — the `CompactionStrategy` interface receives `ctx` (`{ model, budget, cfg, estimateTokens, splitTurnBlocks }`) plus the abort `signal`.

## Usage

Compaction is fully automatic — no chat-time invocation. It is configured through the generic admin-only settings store. All keys are optional; unset/malformed keys fall back to `DEFAULTS`, and changes take effect on the **next turn** (no restart).

| Setting key | Type | Default | Meaning |
|-------------|------|---------|---------|
| `compaction:strategy` | string | `trim` | Registered strategy name. `none` disables trimming. |
| `compaction:responseReserveCap` | number ≥ 0 | `16000` | Upper bound on output headroom reserved from the context window. |
| `compaction:responseReserveFloor` | number ≥ 0 | `1024` | Lower bound on that reservation. |
| `compaction:safetyFraction` | number ≥ 0 | `0.08` | Fraction of the context window held back to absorb estimator error. |

`charsPerToken` (4) and `imageTokens` (1200) live in `DEFAULTS` but are **not** wired to settings keys — `resolveCompactionConfig` only reads `strategy` + the three numeric keys above.

### Settings API (admin only)

State is the generic settings store, accessed via `web/src/routes/api/settings/[key]/+server.ts`, each method gated by `requireRole(locals, "admin")`:

- `GET /api/settings/<key>` → `{ "value": … }`, or **404** when unset (→ default applies).
- `PUT /api/settings/<key>` with body `{ "value": … }` — set an override.
- `DELETE /api/settings/<key>` — remove the override (revert to default).

```bash
# Disable compaction entirely (overflow then surfaces as a precise error)
curl -X PUT https://your-host/api/settings/compaction:strategy \
  -H 'Content-Type: application/json' --cookie "$ADMIN_SESSION" \
  -d '{"value":"none"}'

# Give reasoning-heavy models more output headroom
curl -X PUT https://your-host/api/settings/compaction:responseReserveCap \
  -H 'Content-Type: application/json' --cookie "$ADMIN_SESSION" \
  -d '{"value":32000}'
```

There is **no dedicated settings-page UI** for these keys — the API is the supported switch.

### Diagnostics

When trimming fires, the backend logs a single `warn` — `context compaction applied` — with `strategy`, `model`, `budget`, `before`, `after`, `droppedCount`, `droppedTokens`. Under budget there is no log line (the no-op path).

## Key files

- `src/runtime/stream-chat/context-compaction.ts` — the whole module: config + `DEFAULTS`, token estimation, `splitTurnBlocks`, budget math (`computeResponseReserve`, `computeInputBudget`), the strategy interface + process-global registry, `TrimStrategy`/`NoneStrategy`, and the `makeCompactionTransform` factory.
- `src/runtime/stream-chat/build-pi-agent.ts` — wires `makeCompactionTransform(model, options.compaction)` into the pi-agent's `transformContext`; defines `BuildPiAgentOptions.compaction`. Comment-asserts input-only (model never mutated).
- `src/runtime/executor.ts` — `resolveCompactionConfig()` reads the `compaction:*` settings keys per turn and threads the override through `buildPiAgent`.
- `web/src/routes/api/settings/[key]/+server.ts` — admin-only GET/PUT/DELETE on `/api/settings/<key>`; the supported switch for all four keys.
- `src/db/queries/settings.ts` — `getSetting` / `upsertSetting` / `deleteSetting` backing the settings store.
- `src/__tests__/context-compaction.test.ts` — unit tests: estimation, budget math, registry, `trim` invariants.
- `src/__tests__/build-pi-agent-compaction.test.ts` — integration: transform wiring + the model-untouched (input-only) guarantee.
- `web/e2e/chat-context-compaction.spec.ts` — e2e regression guard. Currently `test.describe.skip` (infra-blocked: the non-Docker Playwright `webServer` has no real executor, so server-side compaction can't run end-to-end); un-blocks by running under the Docker harness (`DOCKER_TEST=1` + seeded auth) and flipping the skip.
- `docs/context-compaction.md` — the long-form spec (full algorithm, tuning, custom-strategy recipe).

## Features it touches

- [[conversations]] — the active-path messages (minus `excluded` turns) are the history array compaction trims before each send.
- [[streaming-runtime]] — compaction is wired inside `executor.streamChat`'s pi-agent build and runs on every LLM call in the stream/tool loop.
- [[providers-and-models]] — the budget is derived from the resolved model's `contextWindow` / `maxTokens`; the OAuth model swap in `build-pi-agent.ts` decides which model object is budgeted.
- [[runs-lifecycle]] — the transform runs on each agentic tool-loop iteration within a run, keeping multi-step runs in budget.
- [[settings]] — the `compaction:*` keys live in the generic settings store and are read per turn.
- [[settings-system]] — the admin-only `/api/settings/[key]` route is the configuration surface.
- [[admin-surfaces]] — only admins can read/write the `compaction:*` keys.
- [[attachments]] — image parts are charged a flat `imageTokens` cost in the estimator; oversized `toolResult` parts are the only thing truncated in the degenerate path.
- [[persistent-memory]] — distinct, separate feature that *also* uses a `compaction:` settings prefix (see gotchas) — do not conflate.

## Related docs

- [context-compaction](../../context-compaction.md) — the primary long-form spec: full algorithm walkthrough, the input-only invariant in depth, tuning guidance, the custom-strategy recipe, and the source/test map.

## Notes & gotchas

- **Input-only invariant — never shrink `model.maxTokens`.** `responseReserve` sizes the input budget only; it is never written back to the model. For the Codex / ChatGPT-OAuth path pi-ai sends no `max_output_tokens` (`maxTokens` is metadata only there), and for other providers pi-ai derives the output cap from `maxTokens` — so clamping it would be a cross-provider output-truncation regression. `computeResponseReserve` reads `maxTokens` but the strategies only ever rewrite the **message array**.
- **Two different "compaction" features share the `compaction:` settings prefix.** This feature (context-window history trimming, `src/runtime/stream-chat/context-compaction.ts`) reads `compaction:strategy` / `:responseReserveCap` / `:responseReserveFloor` / `:safetyFraction`. The unrelated **memory-merge** feature (`src/memory/compaction.ts`, persistent-memory) uses `compaction:lastRun` as a run-lock key. They are independent; do not conflate the namespaces.
- **The marker is never persisted or rendered.** `[Context note: …]` exists only in the per-call array sent to the provider. Prior markers are stripped on every pass (`isCompactionMarker`) so they neither accumulate nor skew the estimate.
- **Token counts are heuristic.** Estimation is `chars / charsPerToken (4)` plus flat per-message and per-image costs — there is no real tokenizer. `safetyFraction` exists to absorb undershoot; code-heavy or CJK content underestimates, so raise it (e.g. `0.12`) if you still hit overflow.
- **`none` does not bypass the budget computation.** The budget is still computed and pi-ai's `isContextOverflow` backstop still surfaces a precise error — `none` only skips the trimming step.
- **The active turn is sacrosanct.** `trim` keeps the last turn block whole; if that block alone overflows, only its oversized `toolResult` contents are truncated. The user's own prompt text is never silently truncated.
- **No settings UI.** These keys are API-only (admin `PUT`/`GET`/`DELETE` on `/api/settings/<key>`); there is no Settings-page control. An unknown `compaction:strategy` value silently falls back to `trim` (with a `warn` log), so a typo will not disable compaction.
