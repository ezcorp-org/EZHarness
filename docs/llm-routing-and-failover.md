# LLM Routing & Failover — native layer vs OpenRouter

EZCorp ships a deliberately **lean, native** routing and failover layer built
directly on pi-ai — no gateway, no extra hop, works with OAuth-subscription
credentials. Operators whose routing needs outgrow it can point the app at
**OpenRouter** (already a supported BYOK provider) and get a much richer
routing engine upstream, at the cost of a third party in the request path.
This page explains what the native layer does, what it deliberately does not
do, and when OpenRouter is the better tool.

---

## The native layer

### Quality-tier routing (route once, per conversation)

When a turn arrives with **no model pinned**, a pure heuristic classifier
(`src/runtime/tier-classifier.ts`, `chooseTurnTier`) picks a quality tier —
`fast` / `balanced` / `powerful` — and `resolveModel` routes to the best model
in that tier along the provider preference order. Signals, in precedence
order:

1. **Declared tier** — an extension wired into the conversation can declare
   `routing: { tier }` in its manifest (validated at admit time); EZ actions
   carry a parallel `tier` declaration. The strongest declared tier wins
   (correctness requirement — e.g. an orchestration extension that needs a
   powerful model).
2. **Explicit tier hint** — a caller-supplied `tier` option.
3. **Heuristic** — complex tools (write/shell/orchestration) → `powerful`;
   estimated prompt ≥ 8 000 tokens → `powerful`; any tool present → at least
   `balanced`; ≤ 500 tokens and tool-less → `fast`; else `balanced`. The
   estimate is `chars / 4` — no LLM pre-call, zero added latency.

**Route-once-per-conversation.** The turn's `model` option folds in both the
per-turn UI pin *and* the conversation's established model, so classification
only ever fires on a **fresh thread**. Once a thread has a model it is honored
verbatim — never re-routed, even on a strong signal. This is deliberate cache
protection: Anthropic's prompt cache is prefix-matched per provider+model, so
switching models mid-conversation discards the warm prefix (guaranteed miss
plus the cache-write surcharge on the next turn). Tier routing is also
best-effort: if classification fails, the turn falls back to the configured
default tier (`provider:defaultTier`, default `balanced`) and proceeds.

`resolveModel` (`src/providers/router.ts`) resolves in three levels:
explicit provider+model → passthrough (pins are never re-routed); provider
only → best model in the tier; neither → walk `provider:preferenceOrder`,
skipping providers whose circuit breaker is open.

### Pre-stream failover

`runWithFailover` (`src/runtime/stream-chat/failover.ts`) wraps the LLM call
inside `AgentExecutor.streamChat`. When the provider fails **before the first
token reaches the client**, the loop:

1. **Retries the same provider first** — exactly one rebuild+reprompt after a
   jittered 150–300 ms backoff (`SAME_PROVIDER_RETRIES = 1`,
   `RETRY_BACKOFF_MS = 150`). A transient 429/5xx often clears in a few
   hundred ms, and staying on the same provider preserves Anthropic
   prompt-cache locality and avoids a cross-model quality discontinuity.
2. **Records one breaker failure** for that provider (one per provider per
   turn, not one per attempt) and asks `suggestFallback(provider, tier,
   scope)` for a **tier peer** on the next healthy provider in the preference
   order. The tier is the turn's *effective* tier from model resolution — a
   pinned Opus fails over to a `powerful`-tier peer, never silently to a
   mid-tier model; a routed turn fails over within the classifier's tier.
3. **Rebuilds the pi-agent** on the fallback model (each attempt closes over
   its own model, so compaction budgets and cache-retention shaping stay
   correct) and re-prompts. All listeners from the previous attempt are
   detached first.

Boundaries and guarantees:

- **Pre-stream only.** Retries happen only while nothing has streamed to the
  client (`ctx.emittedToClient === false`). Once a token, thinking delta, or
  tool card is visible, the error is rendered as-is — transparent mid-stream
  failover (partial-output re-emission + dedup) is a documented follow-up,
  not attempted.
- **Availability failures only.** HTTP 429/500/502/503/504/529 and
  connection-class errors are retryable; bad requests, auth failures, content
  filters, and tool bugs rethrow unchanged — a different provider would not
  help.
- **Per-user circuit breakers.** Breaker state is keyed per
  `(provider, scope)` where the scope is the conversation owner's user id
  (`src/providers/circuit-breaker.ts`) — one user exhausting their own key's
  rate limit never degrades routing for other users of the same provider.
  Standard closed/open/half-open machine: 3 failures → open, 60 s reset; the
  breaker map is bounded (512 entries, oldest-inserted evicted).
- **Bounded.** At most `MAX_FAILOVER_ATTEMPTS = 4` distinct providers per
  turn, each tried at most once (plus its same-provider retry).
- **Graceful single-provider degradation.** A BYOK user with only one
  provider's key (or every alternative's breaker open) gets a clean,
  structured `provider_unavailable` error — never a crash.
- **Honest provenance.** Every attempt persists the provider/model that
  actually **served** the turn; `messages.usage` additionally records
  `requestedProvider`/`requestedModel` (the user's pin, `null` when routed),
  `routedTier`, and `failover: true` when a fallback served the turn — so the
  cache/usage meter segments by the serving model, not the requested one.

### Cache-aware caveats

- **The prompt cache does not follow a failover.** Caches are per
  provider+model, so a cross-provider fallback abandons the warm prefix; the
  first turn on the fallback pays a full cache write (and the stable-prefix
  region is written at 1h retention, which Anthropic bills at 2× the base
  input rate). This is why the same-provider retry runs *first*, and why
  routed threads are never re-routed once established.
- **The cached region is kept small and stable on purpose.** On Anthropic,
  the cached region-1 prefix is the **system prompt + tool schemas only**;
  per-turn memory/KB recall is query-dependent and rides as a separate
  **uncached trailing system block** so it can vary per turn without busting
  the prefix. See [context-compaction](context-compaction.md) and the
  [cache-anchor decision record](decisions/2026-07-08-compaction-cache-anchor.md).
- EZCorp's Anthropic-specific cache shaping (1h retention on the stable
  prefix, the memory-tail split) applies only to direct `anthropic-messages`
  payloads — traffic routed through OpenRouter (or any non-Anthropic API
  shape) does not get it.

### Operator knobs

| Setting key | Default | Meaning |
|---|---|---|
| `provider:defaultTier` | `balanced` | Tier used when routing fires and no stronger signal applies (`fast` / `balanced` / `powerful`). |
| `provider:preferenceOrder` | `[anthropic, openai, google, openrouter]` | Provider walk order for routing and fallback suggestions. Stored orders self-heal: newly known providers are appended (`mergePreferenceOrder`). |
| `compaction:cacheRetention` | `long` | Prompt-cache TTL shaping for the stable prefix (Anthropic only) — see [context-compaction](context-compaction.md). |

Settings are written via the admin-only `PUT /api/settings/<key>` API.
Extensions opt into tier needs via the manifest `routing: { tier }` block.

### What the native layer deliberately does NOT do

- No mid-stream (post-first-token) failover.
- No LLM-based prompt classification (latency).
- No re-routing of an established thread (cache + pin-honoring).
- No per-request price/latency marketplace optimization across dozens of
  upstreams.
- No cross-provider cache portability (impossible — caches are per
  provider/model).

---

## The OpenRouter alternative

EZCorp already supports **OpenRouter as a BYOK provider**: add an API key
under **Settings → Models** (or `POST /api/providers` with
`{ provider: "openrouter", apiKey }`), and OpenRouter's catalog is discovered
via its `/api/v1/models` endpoint. It also sits in the default provider
preference order, so the native failover can fail over *to* OpenRouter when a
key is present — the two layers compose.

For operators with heavy routing needs, pinning conversations to OpenRouter
moves routing upstream at **zero app-side cost**:

- **Auto-router** — pin the `openrouter/auto` model and OpenRouter picks a
  model per request based on the prompt. (It is not a pi-ai built-in: run
  **refresh models** for the provider — `POST
  /api/providers/openrouter/refresh-models` — to pull OpenRouter's live
  catalog, including `openrouter/auto`, into the picker.)
- **Provider fallback** — OpenRouter transparently retries/falls back across
  the upstream providers serving a model, and supports multi-model fallback
  chains, far beyond the native layer's one-shot tier-peer fallback.
- **Usage dashboard** — per-key activity, spend, and model breakdowns on
  openrouter.ai, without building anything app-side.

### Trade-offs

- **A third party sees your traffic.** Prompts and completions transit
  OpenRouter's infrastructure. For self-hosted deployments chosen for data
  control, that is a real change in trust boundary.
- **No OAuth-subscription support.** Subscription credentials (Claude
  Pro/Max OAuth) cannot be proxied through a gateway — Anthropic's terms of
  service ban proxying subscription OAuth. Subscription users must stay on
  the native path; OpenRouter is credit/API-key billing only.
- **Cache shaping differs.** EZCorp's Anthropic cache optimizations (stable
  region-1 prefix at 1h retention, uncached memory tail) apply to the direct
  Anthropic path only; caching behavior through OpenRouter is whatever
  OpenRouter's upstream mediation provides.

### Choosing

| You need… | Use |
|---|---|
| OAuth subscription credentials (Claude Pro/Max) | **Native** (only option) |
| Strict data control — no third party in the request path | **Native** |
| Prompt-cache cost optimization on Anthropic | **Native** |
| Tier-appropriate model choice + pre-stream failover across your own keys | **Native** (default, zero config) |
| Per-request auto model selection, deep fallback chains, price/latency optimization | **OpenRouter** (`openrouter/auto` or per-model) |
| One key for many providers + a spend dashboard | **OpenRouter** |

---

## Related docs

- [context-compaction.md](context-compaction.md) — the cache regions,
  retention TTLs, and the compaction/caching interaction.
- [decisions/2026-07-08-compaction-cache-anchor.md](decisions/2026-07-08-compaction-cache-anchor.md)
  — why the cached prefix is system+tools only and the history anchor is
  opt-in.
- [features/chat/providers-and-models.md](features/chat/providers-and-models.md)
  — credential resolution, the model registry, and `resolveModel` in detail.
- [plans/2026-07-07-pi-caching-routing-integration.md](plans/2026-07-07-pi-caching-routing-integration.md)
  — the original integration plan and its post-audit addendum.

## Key files

- `src/runtime/tier-classifier.ts` — the pure tier classifier (`chooseTurnTier`, thresholds, `RoutingTier`).
- `src/runtime/stream-chat/setup-tools.ts` — `resolveModelTierAndCredential`: route-once wiring + the turn's `effectiveTier`.
- `src/providers/router.ts` — `resolveModel` (3 levels), `suggestFallback`, `getDefaultTier`, preference-order handling.
- `src/runtime/stream-chat/failover.ts` — `runWithFailover`: same-provider retry, cross-provider pre-stream failover, breaker feeding.
- `src/providers/circuit-breaker.ts` — per-`(provider, scope)` breakers, bounded map.
- `src/runtime/executor.ts` — threads `effectiveTier` + the per-user breaker scope + served-model provenance into the loop.
