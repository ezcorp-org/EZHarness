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
orphaned. **By default the `trim` strategy evicts the OLDEST turns**
(conventional recency), inserting the ephemeral marker at the front:

```
[ marker ][ …recent turns… ][ active turn ]
```

The strategy is also **cache-aware and can be run in an anchored mode**
(opt-in via `compaction:cacheAnchorFraction` > 0; see [Cache-aware trim
+ retention](#cache-aware-trim--retention) and the [decision
record](decisions/2026-07-08-compaction-cache-anchor.md)). When enabled,
it keeps a byte-stable prefix of the OLDEST turns (the "cache anchor")
plus the most RECENT turns and evicts the **middle**, and relocates the
marker to **after the anchor** so its per-turn-changing text can't shift
the cached region:

```
[ …oldest anchor turns… ][ marker ][ …recent turns… ][ active turn ]
  └── byte-stable prefix ┘           └──── shifts (uncached) ────┘
```

The broad prompt-cache win — 1h retention on the system + tools
prefix — is independent of the anchor and applies with the default
(anchor `0`). Per-turn memory/KB recall is deliberately **not** part of
that cached prefix (see [Cache-aware trim +
retention](#cache-aware-trim--retention)). The ephemeral marker text:

```
[Context note: 23 earlier messages omitted to fit this model's
~234240-token context window.]
```

Degenerate case (only the active turn remains and it alone is too big):
the oldest oversized `toolResult` contents are truncated with a
`…[truncated to fit context]…` mark, leaving the stable anchor
untouched. The user's own prompt text is never silently truncated — a
precise overflow error is better than a mangled question.

**Stale tool-result cap.** Independently of all of the above, and
independently of the budget, older `toolResult` messages are bounded to
`compaction:toolResultCap` characters on **every** call. That one is a
*cost* control rather than an overflow guard — see [Stale tool-result
cap](#stale-tool-result-cap).

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
| `summarize` | Replace the OLDER turns with an LLM-generated summary, keeping as much RECENT verbatim context as the budget allows. Costs one extra (cheap) LLM call when trimming fires; **fails open to `trim`** on any summarizer error/timeout. See [The `summarize` strategy](#the-summarize-strategy). |
| `none` | Passthrough — disables trimming. The budget is still computed and the `isContextOverflow` backstop still applies, so overflow surfaces as a precise error rather than being silently ignored. |

Any other algorithm is a drop-in registry addition with no rewiring — see
[Custom strategies](#custom-strategies).

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
| `compaction:cacheAnchorFraction` | number (0–1) | `0` | Fraction of the input budget the `trim` strategy reserves for a byte-stable prefix of the OLDEST turns (the cache anchor). Default `0` = conventional recent-only trim (evict oldest, marker at front). **Opt-in**: raise it to cache conversation history on long, compacting threads — at the cost of pinning the stalest turns. See [decision record](decisions/2026-07-08-compaction-cache-anchor.md). |
| `compaction:cacheRetention` | string | `long` | Prompt-cache TTL for the stable prefix: `long` (~1h), `short` (~5 min), or `none` (disable caching). Anthropic-only; other providers ignore it. |
| `compaction:summarizeMaxTokens` | number | `1024` | Output-token cap for the `summarize` strategy's summary, and the budget it reserves for the inserted summary marker. Raise it for models that need richer recall; lower it to shrink the marker. Ignored by `trim`/`none`. |
| `compaction:summarizeModel` | string | *(turn model)* | Model the `summarize` strategy uses, as `"provider/modelId"` (e.g. `anthropic/claude-haiku-4-5`). Unset, malformed, or unresolvable → the conversation's own turn model. Ignored by `trim`/`none`. |
| `compaction:toolResultCap` | number | `32000` | Max **characters** of text kept in a STALE (non-newest) `toolResult`, applied on every call whether or not the thread fits. `0` disables it (restoring the pre-cap behaviour byte-for-byte). **Strategy-independent** — `strategy: "none"` does *not* switch it off. See [Stale tool-result cap](#stale-tool-result-cap). |

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
  `budget`, `before`, `after`, `droppedCount`, `droppedTokens`. When the
  stale tool-result cap fires it logs a `debug`: `stale tool results
  capped` with `model`, `cap`, `savedTokens`.

---

## Stale tool-result cap

Fitting the context window is free; *re-sending* the same bytes is not.
A tool result is persisted once and then replayed verbatim on **every**
remaining agentic-loop iteration and every later turn of the thread, so
one runaway multi-megabyte result is billed over and over — while the
conversation may still be comfortably under budget, where every
mechanism above is a no-op by design.

`capStaleToolResults` closes that leak. On every call, before the budget
check, each `toolResult` is bounded to `compaction:toolResultCap`
characters of head **+** tail:

```
first cap/2 chars …[N chars of this older tool result elided to cut re-sent context]… last cap/2 chars
```

Head *and* tail because tool output usually carries its verdict at the
end (the failing assertion, the last log line) and its shape at the
start. Every text part of the message collapses into one capped part at
the position of the first; image parts are kept, in order.

**The newest `toolResult` is never capped.** It is the output of the
tool the agent just ran and the loop reasons over it in full. Newest
across the whole array, not per turn — whatever the agent last saw stays
whole. A result stops being newest exactly when the next one lands, so
at most one uncapped fat result is ever in flight.

**This is not the degenerate-case truncation.**
`truncateOversizedToolResults` is the emergency backstop: it fires only
once a conversation is already over budget and then destroys the content
outright. The cap is always on and retains a usable window. Both can
apply in one pass, and the backstop still wins on the newest result if
the active turn alone overflows.

**Determinism is load-bearing.** The replacement text is a pure function
of the message's own text and the cap — never of the budget, the model,
the clock, or the message's position or neighbours. So a given stale
result caps to byte-identical output on every turn for the rest of the
thread's life. That is not a nicety: Anthropic's cache is
prefix-matched, so a marker that varied per turn would rewrite the
history prefix on every send (guaranteed miss **plus** the 25%
cache-write surcharge) and cost more than the bytes it saved. It is also
what lets the cap coexist with `trim`'s [cache
anchor](#cache-aware-trim--retention) — anchored blocks cap identically
each turn, so the anchor stays byte-stable. Cuts that would land inside
a UTF-16 surrogate pair drop the orphaned half, which is deterministic
too.

Where the ordering pays off twice: capping runs **ahead** of the budget
check, so a history that only overflowed because of stale tool output
now fits and no turn is evicted at all.

Unrelated to `src/runtime/tools/output-limits.ts`. Those 8 MiB / 1 MiB
per-tool caps exist only to stay under a provider's hard string-length
error and deliberately do nothing else; this cap is about spend.

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
pi-ai places `cache_control` on the **system prompt** (the frozen
`ctx.system` — system + RBAC preamble) and on the **last tool** (the
tool/extension/EZ-action schemas). Per-turn **memory/KB recall is
deliberately excluded** from that cached region: it is query-dependent,
so concatenating it into the system prompt would re-write (bust) the
prefix on every memory/KB turn. Instead `setup-tools.ts` stashes the
injected block on `ctx.systemMemoryTail` and, on Anthropic,
`build-pi-agent.ts`'s `onPayload` appends it as a separate **trailing
system block with NO `cache_control`**
(`src/runtime/stream-chat/system-cache-split.ts`) — it varies per turn
without invalidating the cached prefix, and it is inert to retention
shaping (which only rewrites blocks that already carry `cache_control`).
Non-Anthropic providers get the tail merged into the plain
`systemPrompt` string (no `cache_control` concept to protect).
Compaction never touches `systemPrompt` or `tools`, so those
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

Model switching interacts with the cache too — routing is
route-once-per-conversation and failover retries the same provider
before falling over, both to protect the warm prefix. See
[LLM routing & failover](llm-routing-and-failover.md).

## The `summarize` strategy

Selected with `compaction:strategy = "summarize"`. Where `trim` drops the
oldest turns and leaves a `[Context note: N … omitted]` marker, `summarize`
condenses the older turns into an LLM summary and keeps the recent turns
verbatim, so the model still "remembers" the gist of what was evicted:

```
[ summary marker ][ …recent turns… ][ active turn ]
  └── LLM summary of the older body ┘  └─ kept verbatim ─┘
```

**Cut point.** It reuses the same turn-block + budget machinery as `trim`.
The active turn (current prompt + its in-flight tool loop) is always kept.
It then fills a recent window from the NEWEST turns up to
`budget − summarizeReserve − active`, and everything older than that window
is summarized. `summarizeReserve` is `compaction:summarizeMaxTokens` (plus a
small marker pad), so the summary marker is sized into the budget up front.

**Summary generation.** Runs through pi-agent-core's `generateSummary`
helper (its structured summarization prompt + conversation serialization).
The actual model call is routed through the mockable `complete` seam
(`@earendil-works/pi-ai/compat`) over a minimal `Models` shim that injects
the resolved credential — the same seam the rest of the runtime mocks in
tests. Thinking is forced off (cheap, deterministic).

**Summarizer model.** `compaction:summarizeModel` (`"provider/modelId"`)
when set and resolvable; otherwise the conversation's **own turn model**
(the zero-config default — the turn is already streaming with it, so its
credential is always available). A malformed or unresolvable setting logs a
`warn` and falls back to the turn model.

**Fail-open.** If the summary call fails, times out, aborts, or returns an
empty string, the strategy falls back to the `trim` behavior for that call.
`transformContext` therefore never throws or blocks the user's turn on a
wedged summarizer — the worst case degrades to plain trimming.

**Input-only + ephemeral.** Like `trim`, this only rewrites the array sent
to the provider for one call; `model.maxTokens` is never mutated and the
summary marker is never persisted or rendered in the UI. It shares the
`[Context note:` prefix with the trim marker so a stray marker is always
stripped before the next compaction.

**Memoization (v1).** Because `transformContext` runs before **every** LLM
call (each tool-loop iteration + retries) and the persisted history is
re-sent untrimmed each turn, the same older body would otherwise be
re-summarized repeatedly. A bounded (256-entry), in-process memo keyed by
`conversationId` + a fingerprint of the exact messages being summarized
reuses a summary across the many calls **within a turn** and across
short-term identical cut points.

> **Limitations (v1).** The memo is in-process only — it does **not**
> survive a restart, and it is **not** a durable, incrementally-updated
> conversation summary (pi's `previousSummary` threading, which belongs with
> durable session-tree compaction, is out of scope). As a thread grows the
> summarized body grows too, so a genuinely new (larger) cut point is
> re-summarized on later turns. And unlike anchored `trim`, `summarize` is
> **not** prompt-cache-friendly: the leading summary marker's text changes
> as the thread grows, shifting the cached prefix — prefer `trim` with
> `cacheAnchorFraction > 0` when cache stability on long threads matters
> more than semantic recall.

The module must be imported during boot so its registration runs before the
first turn; it is, via `build-pi-agent.ts` (which also binds the per-turn
summarizer). An unknown `compaction:strategy` value still falls back to
`trim` with a warning.

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
| Algorithm, budget math, registry, cache-aware `trim`/`none`, stale tool-result cap | `src/runtime/stream-chat/context-compaction.ts` |
| `summarize` strategy + default LLM summarizer (fail-open, memo) | `src/runtime/stream-chat/context-summarize.ts` |
| Cache-retention TTL shaping (stable prefix long, tail short) | `src/runtime/stream-chat/cache-retention.ts` |
| Memory/KB tail split (uncached trailing system block) | `src/runtime/stream-chat/system-cache-split.ts` |
| `transformContext` + `onPayload` wiring (input-only; model not mutated) | `src/runtime/stream-chat/build-pi-agent.ts` |
| Settings resolution per turn | `src/runtime/executor.ts` (`resolveCompactionConfig`) |
| Unit tests (estimation, budget, registry, cache-anchor `trim` invariants) | `src/__tests__/context-compaction.test.ts` |
| Unit tests (`summarize` cut-point/fail-open + default summarizer/memo) | `src/__tests__/context-summarize.test.ts` |
| Cache-prefix-survives-compaction proof (WS-H usage → WS0 stats) | `src/__tests__/context-compaction-cache-prefix.test.ts` |
| Retention shaping unit tests | `src/__tests__/cache-retention.test.ts` |
| Memory-tail split unit tests | `src/__tests__/system-cache-split.test.ts` |
| Integration (wiring, model untouched, retention onPayload) | `src/__tests__/build-pi-agent-compaction.test.ts` |
| E2E regression guard (Docker harness) | `web/e2e/chat-context-compaction.spec.ts` |
