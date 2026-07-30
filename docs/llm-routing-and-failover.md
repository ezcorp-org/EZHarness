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
3. **The active mode's `preferred_tier`** — the mode task binding below.
4. **Heuristic** — complex tools (write/shell/orchestration) → `powerful`;
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

### The mode task binding — "this KIND of task wants that model"

A **mode** is EZCorp's task-type concept, and it can bind its kind of task to a
model or a quality class: `modes.preferred_model` (+ `preferred_provider`) pins
an exact model, `modes.preferred_tier` pins the class and lets the ladder pick.
`resolveTurnModelBinding` (`src/runtime/routing/mode-binding.ts`) resolves the
full chain, most specific first:

```
per-turn UI pin → conversation pin → mode preferred model → mode preferred tier → classifier
```

The first two are already folded into the turn's `model` option, so the binding
is only consulted on a **fresh thread** — a mode preference is a pin applied at
thread start and inherited afterwards, never a per-turn re-route (same cache
protection as above; a pinned turn doesn't even read the mode row). It is wired
server-side at the routing decision point
(`stream-chat/setup-tools.ts#resolveModelTierAndCredential`) rather than in the
composer, so API, agent and extension callers get it too.

Every named preference is validated against the models the deployment can
actually run, independently: a mode naming a retired model, a model on the
wrong provider, a provider that's gone, or an unrecognized tier **degrades to
the next level** rather than failing the turn. `preferred_tier` NULL means "no
preference" — route per turn, exactly as before the column existed. The
selector lives in the mode form (Settings → Personalization → Modes).

### The tier ladder — which model a tier actually gets

A tier is a *quality class*, not a model. `provider:tierModels` is the ordered
list that turns one into the other: per tier, per provider, the models a routed
turn may be served by, best first.

```json
{ "fast":     [{ "provider": "anthropic", "model": "claude-haiku-4-5" }],
  "balanced": [{ "provider": "anthropic", "model": "claude-sonnet-4-5" }],
  "powerful": [{ "provider": "anthropic", "model": "claude-opus-4-1" }] }
```

`findModelForProviderInTier` (`src/providers/registry.ts`) consults the ladder
first and takes the first entry for that provider whose model the provider's
catalog currently lists. Everything about it degrades:

- **Unset** → the heuristic scan runs exactly as it did before the setting
  existed (first catalog model whose inferred tier matches, plus the one
  built-in rung: openrouter → `openrouter/auto`, because openrouter's 300+
  models are listed alphabetically and the scan is meaningless there).
- **Names an unavailable model** (retired id, provider not connected) → that
  entry is skipped, in order, then the scan.
- **Malformed row** → ignored. Validation is enforced at WRITE time
  (`PUT /api/settings/provider:tierModels` → 400), never at read time, because
  a settings row must not be able to fail a turn.
- **A rung can name a model whose inferred tier differs.** The ladder is the
  operator's decision; the heuristic is only the fallback.

The ladder's `fast` rung is also the **single source of the host-internal cheap
model per provider** — the `/goal` evaluator's credential fallback chain walks
it in order (`resolveEvaluatorModel`), and the memory-compaction merge reads the
same rung via `src/lib/cheap-models.ts`. Reordering the `fast` rung reorders
those chains with it. An empty/absent `fast` rung falls back to the built-in
default, so no misconfiguration can silently disable goal evaluation.

### Routed by default (and how to revert)

Routing only fires for a turn with **no model pinned**, so what the composer
defaults to decides whether the engine runs at all. A user with **no saved
selection** defaults to **Auto**, which puts the explicit
`model: null, provider: null` sentinel on the wire and hands the first turn of a
fresh thread to the classifier. (Before this, an unset user was auto-pinned to
the first model in the picker list, and a pinned model is never routed — the
engine sat idle.)

An explicit saved pick always wins over the default, and there are three of
them, in this order: the conversation's stored `provider`+`model` (which is also
where the server pins the SERVED model after a routed turn), the user's
localStorage last-used model, and a deliberate in-session Auto. So the default
applies to genuinely fresh state only, and route-once is unaffected: once a
thread has a served model, the client re-sends that pair instead of the null
sentinel.

`provider:defaultSelection` is the revert. Setting it to `"first"` restores the
pre-routing default (pin the first available model) with no deploy:

```
PUT /api/settings/provider:defaultSelection   { "value": "first" }
```

The value is read back by every user through the read-scoped
`GET /api/models/default-selection` — deliberately **not** the admin-only
`GET /api/settings/:key`, because a revert that only reached admins would leave
members on routed turns. An absent or malformed row degrades to `"auto"`, and
the composer holds off on applying any default until the read lands, so a
revert can never lose a race with the model-list fetch.

The Auto default is scoped to the **chat composer** (the only surface that
speaks the null sentinel). Agent-config, board-default, and settings pickers
keep the first-model default, so the `"auto"` sentinel strings can never be
persisted onto them.

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
| `provider:defaultSelection` | `auto` | What a user with **no saved model pick** defaults to in the chat composer: `auto` (the Auto sentinel — the first turn of a fresh thread is routed) or `first` (pin the first available model, the pre-routing behaviour). The revert knob for routed-by-default traffic — see above. Read back by every user via `GET /api/models/default-selection`, not the admin-only settings GET. |
| `provider:defaultTier` | `balanced` | Tier used when routing fires and no stronger signal applies (`fast` / `balanced` / `powerful`). |
| `provider:tierModels` | unset | **The tier ladder** — an ORDERED `{provider, model}` preference list per tier. Editable at **Settings → Models → Tier Model Ladder**; validated on write, ignored (never thrown) on read. See below. |
| `provider:preferenceOrder` | `[anthropic, openai, google, openrouter]` | Provider walk order for routing and fallback suggestions. Stored orders self-heal: newly known providers are appended (`mergePreferenceOrder`). |
| `provider:explorationRate` | `0` (off) | **Bounded exploration** — probability that a routed turn is deliberately served ONE RUNG BELOW the classifier's tier, to gather unbiased counterfactual data. Trades a little answer quality for that data; off unless an operator turns it on. Validated on write (a value outside `[0,1]` is a 400, not a silent no-op) and treated as OFF on read. See below. |
| `provider:routingShadow` | unset (off) | **Shadow mode** — a CANDIDATE `{fastMaxTokens, powerfulMinTokens}` pair evaluated on every routed turn it could have moved, recorded into `usage.routingSignals.shadow`, and **never served**. The online half of sweep → shadow → promote. Malformed or inverted values disable it rather than failing a turn. See below. |
| `compaction:cacheRetention` | `long` | Prompt-cache TTL shaping for the stable prefix (Anthropic only) — see [context-compaction](context-compaction.md). |

Settings are written via the admin-only `PUT /api/settings/<key>` API.
Extensions opt into tier needs via the manifest `routing: { tier }` block.

### Bounded exploration, and the training substrate (WS7)

**No router model is trained or shipped.** What exists is everything a learned
router would need EXCEPT the model: the labels, the export, the threshold sweep,
and the inference seam. There is no production traffic yet, so a router fitted
today would fit noise — but each of these is cheap now and awkward to retrofit,
and the provenance they read cannot be reconstructed after the fact.

**Labels** (`src/runtime/routing/labels.ts`, pure) turn a conversation's message
tree into samples of "given these classifier inputs, did the model we picked
suffice?":

- **negative** — the user moved UP: a mid-conversation switch to a strictly
  stronger tier, an A/B retry whose continued branch used the stronger model, or
  a regeneration.
- **positive** — the thread ran on for two more assistant turns on the same
  model with no retry and no regeneration.
- **excluded** (counted as neither, and emitted with a reason so the exclusions
  are auditable): a lateral (same-tier) switch; a **capability-driven** switch;
  a single-turn abandonment; and any turn with no stamped `routingSignals` (a
  legacy row, or a pinned turn where the router never decided).

The exclusions matter more than the labels. A capability switch read as a
quality escalation would teach a router to escalate on every image attachment,
forever — and a poisoned label outlives every later fix to the model, the
features, and the thresholds. So a switch is only ever `negative` when it is
NOT explained by:

- an attachment MIME the from-model does not accept and the to-model does
  (`getCapabilities`, `src/providers/model-capabilities.ts`), or
- context pressure: the turn's estimated input was ≥ 90 % of the from-model's
  `contextWindow` AND the to-model's window is genuinely larger.

Both checks require the to-model to actually REMOVE the deficit, so "the
context window" cannot become a blanket excuse. If model facts cannot be
resolved at all, the sample is excluded rather than guessed at.

**Bounded exploration** (`src/runtime/routing/exploration.ts`) fixes the bias in
those labels. Every label derived from ordinary traffic is confounded: the
classifier chose the model, so we only ever observe a cheap model on turns the
heuristic already thought were cheap. With `provider:explorationRate` set,
that fraction of routed turns is served one rung DOWN, and the row records both
tiers — `routingSignals.tier` stays the classifier's verdict, `routedTier` is
what served — so each explored turn is a labelled counterfactual.

This trades answer quality for data. On an explored turn the user gets a weaker
model than the heuristic asked for, and some of those answers will be worse.
That is the operator's call, not ours: admin-gated, default `0`, and every
explored turn is counted in the admin **Routing** panel ("Turns Explored")
rather than silently absorbed. Exploration can never override a `declaredTier`
(a correctness requirement) or an explicit `tierHint`, and never fires on `fast`
— there is no cheaper rung.

**Shadow mode** (`src/runtime/routing/shadow.ts`) is the online counterpart of
the sweep, and closes the loop:

```
sweep (offline proposal) → shadow (online validation) → promote
```

The sweep can only score turns the CURRENT policy produced. It cannot say how
often a candidate would disagree going forward, on traffic nobody has seen yet.
Set `provider:routingShadow` to a candidate `{fastMaxTokens, powerfulMinTokens}`
pair and every routed turn is additionally classified with those numbers; the
verdict lands in `usage.routingSignals.shadow` as `{tier, agreed}` and the turn
is served exactly as it would have been anyway.

Three properties make the number trustworthy:

- **It cannot change a turn.** The shadow verdict is computed after the real one
  and discarded into provenance. There is no code path from it to `resolveModel`.
- **It runs the REAL classifier**, just with the candidate's thresholds
  (`classifyTierVerdict` is threshold-parameterised), so a disagreement is a
  genuine policy difference and never drift between two lookalike
  implementations. `scripts/routing-sweep.ts` calls the same
  `replayWithThresholds`, so the offline proposal and its online validation can
  never diverge for implementation reasons.
- **Threshold-immune turns stamp nothing.** A `declared`/`hint`/`scorer` turn
  could never have been moved by thresholds, so it is absent from the record
  rather than counted as agreement — otherwise every candidate would look good.
  The admin **Routing** panel therefore reports agreement over SHADOWED turns,
  and renders "no candidate policy configured" instead of 0% when it is off.

The same field carries a learned scorer's verdict when one exists, so promoting
a model later needs no new plumbing.

**Export + sweep**, both derived on demand from `messages` (no new table):

```
bun run scripts/routing-export.ts --days 90 --include-excluded   # labelled JSONL
bun run scripts/routing-sweep.ts  --fast 250,500,1000 --powerful 4000,8000,16000
```

The sweep replays stored `routingSignals` against candidate thresholds through
the REAL `classifyTierVerdict` (via its `thresholds` override), so today's
values are one of the candidate points and the report states whether replaying
them reproduces the tier stored on every row (`baselineMismatches`). It ranks on
**cost at a fixed escalation rate**, not accuracy: most turns produce no
escalation, so "keep the current tier" scores near-perfectly on accuracy while
saving nothing. Per-tier dollar rates come from the deployment's own observed
spend; a turn on an UNPRICED (subscription) model is reported separately rather
than counted as $0.00.

**The inference seam** ships unused. `classifyTier`/`classifyTierVerdict` accept
an optional injected `scorer`, consulted BELOW `declaredTier` and `tierHint`
(correctness and explicit intent always win) and ABOVE the heuristic; an
abstaining scorer falls through. With no scorer — which is every call today —
the output is byte-identical to the pre-seam classifier, proved in
`src/__tests__/tier-scorer-seam.test.ts` against a verbatim reimplementation
over 80k+ generated inputs. `usage.routingConfig.scorerVersion` records which
scorer decided a turn, so a scorer rollout stays distinguishable from a
threshold change when comparing rows across time.

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
- `src/runtime/routing/tier-ladder.ts` — the pure tier ladder: `validateTierLadder` (write-time), `parseTierLadder` (tolerant read), `resolveLadderEntry`, `ladderCandidates`, `DEFAULT_TIER_LADDER`.
- `src/runtime/routing/labels.ts` — the pure label definition: `labelConversation`, `countLabels`, and the capability-driven-switch exclusions.
- `src/runtime/routing/exploration.ts` — pure bounded exploration: `parseExplorationRate` (tolerant read), `validateExplorationRate` (write-time gate), `applyExploration` (injected randomness).
- `src/runtime/routing/shadow.ts` — pure shadow mode: `parseShadowThresholds` (tolerant read), `replayWithThresholds` (shared with the sweep), `evaluateShadow`, and the `THRESHOLD_IMMUNE_REASONS` both halves agree on.
- `scripts/routing-export.ts` / `scripts/routing-sweep.ts` — the labelled-JSONL export and the retroactive threshold sweep.
- `src/runtime/routing/mode-binding.ts` — the pure mode task binding: `resolveTurnModelBinding` (the whole pin → mode model → mode tier → classifier chain, with per-field availability validation).
- `web/src/lib/components/settings/TierLadderSection.svelte` + `web/src/lib/tier-ladder-view.ts` — the Settings → Models editor and its pure display logic.
- `web/src/lib/components/ModeFormModal.svelte` — the mode form, including the Model Tier selector that writes `modes.preferred_tier`.
- `web/src/lib/model-selector-logic.ts` — the client half: the Auto sentinel, `resolveDefaultSelection` (the unset-user default), `parseDefaultSelection` (tolerant read of `provider:defaultSelection`), and `resolveWireModel` (route-once on the wire).
- `web/src/routes/api/models/default-selection/+server.ts` — read-scoped read of `provider:defaultSelection` so an operator's revert reaches every user, not just admins.
- `src/runtime/stream-chat/setup-tools.ts` — `resolveModelTierAndCredential`: route-once wiring + the turn's `effectiveTier`.
- `src/providers/router.ts` — `resolveModel` (3 levels), `suggestFallback`, `getDefaultTier`, preference-order handling.
- `src/runtime/stream-chat/failover.ts` — `runWithFailover`: same-provider retry, cross-provider pre-stream failover, breaker feeding.
- `src/providers/circuit-breaker.ts` — per-`(provider, scope)` breakers, bounded map.
- `src/runtime/executor.ts` — threads `effectiveTier` + the per-user breaker scope + served-model provenance into the loop.
