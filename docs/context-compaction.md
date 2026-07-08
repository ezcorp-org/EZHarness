# Context-Window Compaction

EZCorp trims long conversation history per-model so chats never
dead-end on a provider context-window error
(`context_length_exceeded`). Compaction is automatic, input-only, and
its algorithm is a swappable strategy you can configure at runtime.

---

## Why this exists

Every turn, the full branch history (all prior turns + every persisted
tool output + re-expanded `@file`/`$feature` mentions) is sent to the
model. With no context management, once a thread crosses the model's
input limit the provider rejects **every** subsequent send:

```
Error: Codex error: {"type":"error","error":{"code":"context_length_exceeded",
"message":"Your input exceeds the context window of this model."}}
```

The failed turn never shrinks anything, so each retry resends the same
oversized payload — a permanently stuck chat. Compaction proactively
fits the history to a per-model budget *before* it reaches the
provider, so long chats keep working instead of dead-ending.

---

## The harness

This section describes only the mechanism. Configuration and switching
are covered later.

**Seam.** Compaction runs through pi-agent-core's
`transformContext(messages)` hook, wired in
`src/runtime/stream-chat/build-pi-agent.ts`. The hook runs **before
every LLM call** — the initial turn, *every* agentic tool-loop
iteration, and retries — not just the first send. This is why a tool
loop that balloons mid-turn is also kept in budget.

**Per-model budget.** For the model resolved for the turn:

```
responseReserve = clamp(model.maxTokens, floor, cap)
inputBudget     = model.contextWindow
                  − responseReserve
                  − ceil(model.contextWindow × safetyFraction)
```

`responseReserve` is headroom held back for the model's output and
reasoning. `safetyFraction` absorbs token-estimator error (estimation
is a char-based heuristic; pi-ai exposes no tokenizer). If the
estimated history already fits `inputBudget`, the hook is a no-op and
the message array is returned untouched.

**Trimming (the `trim` strategy).** History is split into *turn
blocks* — a `user` message plus every following assistant / toolResult
message up to the next `user` message. The **last block (the active
turn) is always kept intact**, so the user's current prompt and its
in-flight tool loop are never broken and no toolCall/toolResult pair is
orphaned. The `trim` strategy is **cache-aware** (see [Cache-aware trim
+ retention](#cache-aware-trim--retention)): it keeps a byte-stable
prefix of the OLDEST turns (the "cache anchor") plus the most RECENT
turns, and evicts the **middle**, laying out the compacted history as:

```
[ …oldest anchor turns… ][ marker ][ …recent turns… ][ active turn ]
  └── byte-stable prefix ┘           └──── shifts (uncached) ────┘
```

The single ephemeral marker is placed **after the anchor** (not at the
front of the array), so its per-turn-changing text can't shift the
cached region:

```
[Context note: 23 earlier messages omitted to fit this model's
~234240-token context window.]
```

Degenerate case (only the active turn remains and it alone is too big):
the oldest oversized `toolResult` contents are truncated with a
`…[truncated to fit context]…` mark, leaving the stable anchor
untouched. The user's own prompt text is never silently truncated — a
precise overflow error is better than a mangled question.

**Input-only invariant.** Compaction never mutates the model. In
particular it does **not** shrink `model.maxTokens`:

- For the Codex / ChatGPT-OAuth path, pi-ai sends no `max_output_tokens`
  at all — `model.maxTokens` is metadata only there, so clamping it
  would do nothing.
- For other providers (`openai-responses`, `anthropic`, `google`)
  pi-ai already derives a sane output cap from `model.maxTokens`;
  shrinking it would be a cross-provider output-truncation regression.

So `responseReserve` is used **only** to size the input budget. It is
never written back to the model and never changes generation.

**Marker is ephemeral.** The `[Context note: …]` message exists only in
the array sent to the provider for that one call. It is never persisted
and never rendered in the chat UI — there is no new user-visible
artifact. It sits **after** the stable cache anchor (never at index 0
when an anchor exists), so trimming does not invalidate the cached
prefix.

**Backstop.** If a request still overflows (e.g. strategy `none`, or an
estimate that undershot), pi-ai's `isContextOverflow` detection
surfaces a precise error instead of an opaque provider failure.

**Config resolution.** `src/runtime/executor.ts`'s
`resolveCompactionConfig()` reads the settings keys (below) once per
turn — mirroring the `provider:defaultTier` pattern — and passes the
overrides into `buildPiAgent`. Missing/invalid keys fall back to
`DEFAULTS`. Changes take effect on the next turn; no restart.

---

## Strategies

Compaction is a pluggable strategy resolved by name from a
process-global registry (`src/runtime/stream-chat/context-compaction.ts`).

| Strategy | Behavior |
|----------|----------|
| `trim` (default) | Evict oldest whole turn blocks + insert the ephemeral marker. Deterministic, zero extra cost, cannot itself fail or overflow. |
| `none` | Passthrough — disables trimming. The budget is still computed and the `isContextOverflow` backstop still applies, so overflow surfaces as a precise error rather than being silently ignored. |

An LLM-based `summarize` strategy is intentionally not shipped; the
registry seam makes it (or any custom algorithm) a drop-in addition
with no rewiring — see [Custom strategies](#custom-strategies).

---

## Switching the strategy / configuration

Compaction is configured through the generic settings store (the same
mechanism as `provider:defaultTier`). All keys are optional; unset or
malformed keys fall back to the defaults.

| Setting key | Type | Default | Meaning |
|-------------|------|---------|---------|
| `compaction:strategy` | string | `trim` | Registered strategy name. `none` disables trimming. |
| `compaction:responseReserveCap` | number | `16000` | Upper bound on output headroom reserved from the context window. |
| `compaction:responseReserveFloor` | number | `1024` | Lower bound on that reservation. |
| `compaction:safetyFraction` | number (0–1) | `0.08` | Fraction of the context window held back to absorb estimator error. |
| `compaction:cacheAnchorFraction` | number (0–1) | `0.5` | Fraction of the input budget the `trim` strategy reserves for a byte-stable prefix of the OLDEST turns (the cache anchor). `0` disables the anchor (recent-only trim, marker at the front). |
| `compaction:cacheRetention` | string | `long` | Prompt-cache TTL for the stable prefix: `long` (~1h), `short` (~5 min), or `none` (disable caching). Anthropic-only; other providers ignore it. |

`responseReserve = clamp(model.maxTokens, floor, cap)`, so a model
advertising a huge `maxTokens` (e.g. Codex's 128k) is reserved at most
`cap`; a tiny model is reserved at least `floor`.

### Setting a key

Settings are written via the admin-only generic settings API
(`PUT /api/settings/<key>` with `{ "value": … }`). Examples:

```bash
# Disable compaction entirely (overflow then surfaces as a precise error)
curl -X PUT https://your-host/api/settings/compaction:strategy \
  -H 'Content-Type: application/json' --cookie "$ADMIN_SESSION" \
  -d '{"value":"none"}'

# Re-enable the default
curl -X PUT https://your-host/api/settings/compaction:strategy \
  -H 'Content-Type: application/json' --cookie "$ADMIN_SESSION" \
  -d '{"value":"trim"}'

# Give reasoning-heavy models more output headroom (raise the cap)
curl -X PUT https://your-host/api/settings/compaction:responseReserveCap \
  -H 'Content-Type: application/json' --cookie "$ADMIN_SESSION" \
  -d '{"value":32000}'

# Inspect / revert to default
curl https://your-host/api/settings/compaction:strategy --cookie "$ADMIN_SESSION"
curl -X DELETE https://your-host/api/settings/compaction:strategy --cookie "$ADMIN_SESSION"
```

`GET` returns `{ "value": … }` (404 if unset → the default applies);
`DELETE` removes the override (reverts to default). All three require an
admin session. There is no dedicated settings-page UI for these keys —
the API is the supported switch.

### Tuning guidance

- **Reasoning models** can emit large reasoning + answer token counts.
  If long answers get cut off, raise `compaction:responseReserveCap`
  (e.g. `32000`).
- **Estimator undershoot** (lots of code / CJK underestimates with the
  char heuristic) → raise `compaction:safetyFraction` (e.g. `0.12`).
- **Maximize usable input** on a trusted, text-light workload → lower
  `safetyFraction` toward `0.03`.
- **Diagnosing** — when trimming fires, the backend logs a single
  `warn`: `context compaction applied` with `strategy`, `model`,
  `budget`, `before`, `after`, `droppedCount`, `droppedTokens`.

---

## Cache-aware trim + retention

Anthropic's prompt cache is **prefix-matched**: the provider serves back
the longest byte-identical *leading* run of a request that a recent
request already cached, and charges a **25% surcharge** to *write* any
uncached prefix into the cache. On a long thread that is compacted every
turn, a naive trim that evicts the oldest turns and prepends a
per-turn-changing marker at index 0 mutates that prefix on **every**
compacted turn — a guaranteed cache miss on the whole conversation body
*plus* the write surcharge, i.e. a possible net cost **increase**.

`trim` avoids this by keeping a **byte-stable prefix**:

- **Cache anchor.** The oldest whole turn blocks are kept up to
  `cacheAnchorFraction × inputBudget`. That bound depends only on the
  (per-model, per-cfg) budget and the *immutable* oldest history, so the
  anchor is byte-identical every turn and its prefix stays warm in the
  provider's cache even as newer turns are evicted.
- **Recent window.** The remaining budget is filled from the NEWEST
  turns, so recent context is preserved; the **middle** is what gets
  evicted.
- **Marker placement.** The single ephemeral omission marker is inserted
  *after* the anchor, so its changing text never shifts the cached
  region. With `cacheAnchorFraction: 0` (or a single oversized oldest
  block) the anchor is empty and the marker falls at the front — the
  cache can't be helped there anyway.

Two outer, always-stable breakpoints sit ahead of the conversation body:
pi-ai places `cache_control` on the **system prompt** (system + memory +
RBAC preamble) and on the **last tool** (the tool/extension/EZ-action
schemas). Compaction never touches `systemPrompt` or `tools`, so those
breakpoints — the largest fixed prefix — are always cache-stable; the
anchor extends stability into the front of the conversation itself.

**Retention.** `compaction:cacheRetention` (default `long`) controls the
TTL. Because the anchored prefix is reused for many turns, a `long`
(~1h) TTL keeps it warm across inter-turn pauses that would expire a
`short` (~5 min) entry. Retention is applied per-request in
`build-pi-agent.ts`'s `onPayload` hook (`cache-retention.ts`): the
**stable prefix** (system + last tool) gets the long TTL while the
**conversation tail** — the last-message breakpoint, re-written every
turn — is left short so it isn't charged the higher 1h write price. This
is Anthropic-specific; other providers carry no `cache_control` blocks
and the hook is a no-op for them. Operators can also set pi-ai's native
`PI_CACHE_RETENTION=long` env var as a process-wide fallback.

> **pi-ai caveat.** pi-agent-core's `Agent` does not forward
> `cacheRetention` to the provider stream options, so retention is shaped
> in `onPayload` rather than threaded through the Agent. The TTLs written
> there are a strict subset of what pi-ai's own `"long"` path emits, so
> the wire shape is never novel.

## Custom strategies

The registry is a process-global map. Implement `CompactionStrategy`
and register it at boot:

```ts
import {
  registerCompactionStrategy,
  type CompactionStrategy,
} from "../runtime/stream-chat/context-compaction";

const headOnly: CompactionStrategy = {
  name: "head-only",
  async compact(messages, ctx) {
    // ctx: { model, budget, cfg, estimateTokens, splitTurnBlocks }
    const blocks = ctx.splitTurnBlocks(messages);
    const kept = blocks.slice(-1).flat(); // keep just the active turn
    return {
      messages: kept,
      droppedCount: messages.length - kept.length,
      droppedTokens: ctx.estimateTokens(messages) - ctx.estimateTokens(kept),
      strategy: "head-only",
    };
  },
};

registerCompactionStrategy(headOnly);
```

Then select it: `PUT /api/settings/compaction:strategy {"value":"head-only"}`.

Notes:

- The module must be imported during server boot so the registration
  runs before the first turn. An unknown `compaction:strategy` value
  falls back to `trim` with a warning.
- `makeCompactionTransform` already short-circuits when the history is
  under budget, so `compact()` is only called when trimming is needed.
- Reuse the shared helpers on `ctx` (`estimateTokens`,
  `splitTurnBlocks`) rather than reimplementing them.

---

## Source & test coverage

| Concern | Location |
|---------|----------|
| Algorithm, budget math, registry, cache-aware `trim`/`none` | `src/runtime/stream-chat/context-compaction.ts` |
| Cache-retention TTL shaping (stable prefix long, tail short) | `src/runtime/stream-chat/cache-retention.ts` |
| `transformContext` + `onPayload` wiring (input-only; model not mutated) | `src/runtime/stream-chat/build-pi-agent.ts` |
| Settings resolution per turn | `src/runtime/executor.ts` (`resolveCompactionConfig`) |
| Unit tests (estimation, budget, registry, cache-anchor `trim` invariants) | `src/__tests__/context-compaction.test.ts` |
| Cache-prefix-survives-compaction proof (WS-H usage → WS0 stats) | `src/__tests__/context-compaction-cache-prefix.test.ts` |
| Retention shaping unit tests | `src/__tests__/cache-retention.test.ts` |
| Integration (wiring, model untouched, retention onPayload) | `src/__tests__/build-pi-agent-compaction.test.ts` |
| E2E regression guard (Docker harness) | `web/e2e/chat-context-compaction.spec.ts` |
