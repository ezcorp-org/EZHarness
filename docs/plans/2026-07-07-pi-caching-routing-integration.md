# pi-ai Prompt Caching + Model Routing — Integration Plan

**Branch:** `feat/pi-cache-routing` · **Worktree:** `worktrees/pi-cache-routing` · **Date:** 2026-07-07
**Decision basis:** LLM Council verdict (5 advisors + 3 peer reviewers), 2026-07-07.

---

## 0. TL;DR of the council verdict (why this plan is shaped the way it is)

- **Lean native (pi-ai), gateway ruled out.** OAuth subscription-model BYOK (Claude Pro/Max)
  cannot be proxied through LiteLLM/Portkey/Helicone/Cloudflare AI Gateway, and a gateway
  breaks the single-container promise. Native is the *only* option that respects our constraints.
- **This is NOT "just config."** Three different maturity levels are dressed up as one ask:
  caching already *fires* but is unmeasured; routing failover is **dead code**; quality-tier
  routing is **not native at all** (no classifier exists).
- **The load-bearing risk:** context-compaction (`TrimStrategy`) and prompt caching are at war.
  Trim evicts oldest turns and injects a marker at the **front** of the message array; Anthropic's
  cache is prefix-matched, so on long threads we get guaranteed cache misses **+ a 25% cache-write
  surcharge every turn** → a possible net cost *increase*. Nobody is measuring it.
- **Sequence, don't parallel-blast:** observability-first, then stable cache prefix, then
  pre-stream failover, then quality routing. Do not let the "platform vision" front-run measurement.

**Goals in scope:** (a) cut token $ cost, (b) provider failover/reliability, (c) latency,
(d) quality routing (hard→powerful, easy→cheap/fast).

---

## 1. Verified ground truth (as of HEAD `720f763a`)

| Area | State today | Evidence |
|---|---|---|
| Anthropic caching | **Auto-on.** pi-ai injects `cache_control` on system prompt + last tool + last user/assistant block; retention defaults to `"short"` (~5min) unless `"none"`. | `node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js` `resolveCacheRetention`/`getCacheControl`/`buildParams` |
| OpenAI caching | Prompt-cache key clamping handled by pi-ai. | `providers/openai-prompt-cache.js` |
| App cache config | **None.** No `cacheRetention`, no `PI_CACHE_RETENTION`, no `cacheControlFormat` set anywhere in `src/`/`web/`. | grep: zero hits |
| Cache usage telemetry | `cacheRead`/`cacheWrite` **already parsed** from the stream and flow through `ctx.totalUsage` + the `run:usage` bus event. | `src/runtime/stream-chat/subscribe-bridge.ts` (~259–260) |
| Compaction vs cache | `TrimStrategy` trims oldest turns + injects a front marker → mutates the cached prefix. | `src/runtime/stream-chat/context-compaction.ts` |
| Initial model routing | Works: tier (`fast`/`balanced`/`powerful`) + preference order, called once at `setup-tools.ts:840`. | `src/providers/router.ts::resolveModel` |
| Reactive failover | **DEAD CODE.** `recordFailure`/`recordSuccess` called only in tests; `ProviderUnavailableError` never thrown (handled in `finalize.ts:153`); circuit breakers never open. | grep: no prod callers |
| OpenRouter | Registered provider; its native multi-model fallback is unused. | `router.ts` DEFAULT_PREFERENCE_ORDER |
| Quality classifier | Does not exist. | — |

**Constraints that shape every task:**
- Single-container self-hosted deploy; **BYOK per provider** incl. OAuth subscription models.
- Hard CI gate: 100% coverage on new files (+ `scripts/coverage-thresholds.json` key), patch-coverage,
  Playwright e2e, `@evidence` visual spec for any frontend-visual change. Gate files are CODEOWNERS-owned.
- **No real provider keys in CI** → cache-hit and failover assertions must be driven by the
  `ezcorp-mock` determinism harness, not live calls. (This is first-class scope — see WS-H.)

---

## 2. BYOK caveats the plan must handle explicitly

- **Caching benefit is uneven.** `cache_control` is Anthropic-specific; OpenAI caches server-side;
  other providers vary. The meter (WS0) must **segment cache stats by provider**, and cost claims
  must never assume all users are on Anthropic.
- **Failover can be structurally impossible per user.** A user holding only one provider's key has
  nowhere to fail over. WS2 must degrade gracefully (surface a clear "no fallback available"
  outcome, not a crash) and only advertise reliability where ≥2 usable providers exist.
- **OAuth subscription cost math differs.** Claude Pro/Max is rate-limited, not dollar-priced, so
  "$ saved via cache" is meaningless for those keys — the meter should show *tokens* cached, and
  the routing story for subscription keys is quota-preservation, not cost.

---

## 3. The sub-agent team

Every sub-agent works in **its own stacked worktree** off `feat/pi-cache-routing`
(project isolation rule). Each ships a self-contained PR that stacks on the prior. The
orchestrator (lead) sequences, rebases the stack as parents merge, and runs the gate.

```
Lead / PM (orchestrator)
├── WS0  Instrumentation & Observability   ── FIRST, blocks everything
├── WS-H Mock / Determinism harness         ── parallel w/ WS0, blocks WS2+WS3 tests
├── WS1  Cache-stable prefix + retention    ── after WS0
├── WS2  Pre-stream provider failover       ── after WS0 + WS-H
├── WS3  Quality-tier routing               ── after WS0 (parallel w/ WS1/WS2)
└── WS-V Adversarial validator              ── after each WS lands (own worktree, mutate→run→revert)
```

**Dependency graph:** `WS0 → {WS1, WS2, WS3}`; `WS-H → {WS2 tests, WS3 tests}`; `WS-V` gates each.
WS0 and WS-H start together. WS1/WS2/WS3 fan out once WS0 lands.

---

### WS0 — Instrumentation & Observability  *(agent: `general-purpose`, effort S–M, FIRST)*

**Why first:** The council's "one thing to do first." We cannot prove savings, or that compaction
hurts, without a meter. This is also the acceptance metric for WS1.

**Scope**
- Aggregate `cacheRead`/`cacheWrite` (already on `run:usage`) into a per-turn + per-conversation
  **cache hit-rate** and **cached-token count**, segmented **by provider + model**.
- Persist per-turn cache usage (extend the existing usage persistence path; do **not** invent a new
  store if one exists — DRY).
- Surface it: a minimal cache/cost pill in the chat UI (hit-rate + cached tokens this turn) and a
  numeric field in the usage payload the UI already consumes.
- Emit an `info` once-per-turn summary via the correct logger; `debug` for per-block detail.

**Files (likely):** `src/runtime/stream-chat/subscribe-bridge.ts`, `finalize.ts`, usage
persistence query under `src/db/queries/`, `web/src/lib/components/ChatMessage.svelte` or usage
component. New pure helper (e.g. `src/runtime/usage/cache-stats.ts`) for the aggregation math.

**Tests / gate**
- 100% coverage on the new `cache-stats` helper (+ thresholds key). Unit-test the aggregation math
  with fixture `run:usage` events.
- Playwright e2e that drives a mock turn and asserts the cache pill renders; **`@evidence`** visual
  spec (frontend-visual change) calling `captureEvidence`.

**Acceptance:** run one long real conversation locally → read hit-rate. If Anthropic hit-rate is
low on turn N>3, WS1 is confirmed necessary (expected).

---

### WS-H — Mock / Determinism harness  *(agent: `general-purpose`, effort M, parallel w/ WS0)*

**Why:** No real keys in CI. WS2 (failover) and WS3 (routing) e2e assertions need deterministic
provider failures + synthetic cache usage.

**Scope**
- Extend `ezcorp-mock` / test-surface (`isTestSurfaceEnabled()` gated, fail-closed per harness
  contract) to:
  - emit configurable synthetic `cacheRead`/`cacheWrite` in mock usage, and
  - simulate provider failure modes (429/5xx/connection-refused) on demand so a retry loop can be
    exercised deterministically.
- Keep it behind the three-flag gate (`EZCORP_ALLOW_TEST_SURFACE=1` + `PI_E2E_REAL=1` +
  non-prod `NODE_ENV`); register any new `/api/__test/**` route per the route-contract meta-test.

**Files (likely):** `src/**/test-surface*`, mock LLM provider module, `src/api-registry.ts` if a
new test route is added.

**Tests / gate:** self-covered; route-contract meta-test stays green.

---

### WS1 — Cache-stable prefix + retention  *(agent: `general-purpose`, effort M–L, after WS0)*

**Highest value, highest risk. Touches the compaction invariant — expect CODEOWNERS review.**

**Scope**
- Restructure the assembled prompt so the **stable block** (system prompt + memory + tool/RBAC
  schemas + extension/EZ-action registry) forms a contiguous **prefix** that is byte-stable across
  turns, and place the cache breakpoint at its end.
- Make `TrimStrategy` **preserve that prefix**: trim from the *tail/middle* of the conversation
  body, and **stop injecting the compaction marker at the front of the array** (move it after the
  stable prefix, or represent it so it doesn't shift the cached region). This directly resolves the
  cache/compaction war.
- Wire **retention config**: default the stable prefix to **1h** (`cacheRetention: "long"` /
  `PI_CACHE_RETENTION`), tail to short/none. Make it a `compaction:`-adjacent setting, documented.
- Respect the context-compaction **input-only invariant** (never mutate `model.maxTokens`).

**Files (likely):** `src/runtime/stream-chat/build-prompt.ts`, `context-compaction.ts`,
`build-pi-agent.ts` (thread `cacheRetention` into Agent/stream options), settings keys +
`docs/context-compaction.md` update.

**Tests / gate**
- 100% coverage on changed executable lines (patch gate) + any new file.
- **Proof test:** using WS-H synthetic usage + a multi-turn thread that triggers compaction, assert
  the cached prefix survives a trim (hit-rate does not collapse to 0 on the compacted turn). This is
  the test that would have caught the bug.
- Update `docs/context-compaction.md`.

**Risk note:** this is the change most likely to regress context behavior. WS-V audits it in a
separate worktree (mutate→run→revert) to avoid the shared-worktree race (see lessons).

---

### WS2 — Pre-stream provider failover  *(agent: `general-purpose`, effort M, after WS0 + WS-H)*

**Scope (explicitly PRE-stream only):**
- Feed the circuit breaker in prod: on a provider error, call `getCircuitBreaker(p).recordFailure()`;
  on success, `recordSuccess()`.
- Wrap the initial LLM call so that a provider failure **before the first token** throws/handles
  `ProviderUnavailableError`, calls `suggestFallback(failedProvider, tier)`, rebuilds the Agent via
  `buildPiAgent` on the fallback model, and retries. Bounded retries; honor circuit-breaker open state.
- Graceful "no fallback available" outcome for single-provider-key (BYOK) users.
- **Out of scope (documented as follow-up):** mid-stream failover after tokens have streamed to the
  client — the council flagged this as genuinely hard (partial-output re-emission + dedup). File a
  follow-up issue; do not attempt here.

**Files (likely):** `src/runtime/stream-chat/` entry (retry loop around the stream),
`setup-tools.ts` (resolve/rebuild path), `router.ts`, `circuit-breaker.ts`, `finalize.ts`.

**Tests / gate**
- 100% patch coverage. Using WS-H simulated failures, assert: failure recorded → breaker opens →
  fallback provider selected → Agent rebuilt → turn completes on fallback. Assert single-key user
  gets the clean "no fallback" path.
- e2e that drives a mock provider failure end-to-end.

---

#### WS2 — as built (implementation notes)

**Retry loop location.** The pre-stream failover loop is a dedicated pure-ish
module at **`src/runtime/stream-chat/failover.ts`** (`runWithFailover`), wired
into `src/runtime/stream-chat`'s owner, **`AgentExecutor.streamChat`
(`src/runtime/executor.ts`, the `await runWithFailover({...})` call ~L659)**.
It replaced the old inline `buildPiAgent` → `activeAgents.set` →
`subscribeBridge` → `piAgent.prompt()` → `if (state.errorMessage) throw`
block. The executor passes injectable seams (`buildAgent`, `subscribe`,
`runPrompt`, `suggestFallback`, `resolveAttempt`) so the loop is unit-testable
in isolation AND drives the real path in prod. The module lives under the
enforced `src/runtime/**` tree (not `src/providers/**`, which is a
coverage-gate EXCLUDE) so its 100% threshold is real; new thresholds key
`"src/runtime/stream-chat/failover.ts": 100`.

**Pre/post-first-token boundary.** A new explicit context flag
`StreamChatContext.emittedToClient` (context.ts) is set `true` by
`subscribe-bridge.ts` the instant ANY client-visible output streams — a text
`text_delta`, a `thinking_delta`, or a `tool_execution_start` (a tool card).
`runWithFailover` resets it to `false` at the top of every attempt and, on a
failure, retries ONLY while it is still `false`. Once something has streamed
the error is rethrown unchanged and the executor's existing `catch →
finalizeError` renders it — **mid-stream failover is out of scope** (see §5).

**Circuit-breaker prod wiring.** Previously dead: `recordFailure`/
`recordSuccess` had no prod callers. Now `runWithFailover` calls the REAL
`getCircuitBreaker(provider).recordFailure()` on each provider-availability
failure and `.recordSuccess()` on the turn that completes cleanly. The router's
`resolveModel`/`suggestFallback` already skip open breakers, so a provider that
trips its threshold (3 failures) is transparently avoided on the next turn.

**Failure classification.** `classifyProviderAvailabilityError(msg)` decides
retryable-vs-not from the flattened pi-ai `stopReason:"error"` message text
(pi-agent-core keeps only `.message`). Retryable = an HTTP `429/500/502/503/
504/529` marker OR a connection-class signature (reused `isProviderConnection
Error`: ECONNREFUSED/reset/DNS-miss/socket-closed/timeout/fetch-failed).
Everything else (400 bad request, 401/403 auth, content filter, tool bug) is
NON-availability and rethrows unchanged — a different provider wouldn't help.

**Single-provider graceful path.** When `suggestFallback` returns `null`
(single-provider BYOK, every alternative's breaker open, or the suggestion
loops back to an already-tried provider), `runWithFailover` throws the existing
`ProviderUnavailableError` (suggestion `null`). `finalize.ts` already renders it
into the structured `provider_unavailable` payload — the run ends in `error`,
never a crash. Bounded by an `attempted` provider set + `MAX_FAILOVER_ATTEMPTS`
(4) cap.

**Tests.** `src/__tests__/failover.test.ts` (100% unit coverage) drives the
real loop with fakes: classifier truth table; initial success; fault→fallback
success (asserts the fallback's output is delivered + the previous
subscription is detached); no-fallback → `ProviderUnavailableError`;
already-tried loop-back; mid-stream boundary (no retry); non-availability
passthrough; budget exhaustion; and **failure→breaker-opens-after-threshold on
the REAL breaker**. `src/__tests__/executor-failover.integration.test.ts`
drives the ACTUAL `executor.streamChat` retry loop (pi-agent-core + router
mocked, everything between real): asserts `run.result.output.fullText ===
"served by fallback"` after a pre-token 429, the clean no-fallback payload, and
the mid-stream boundary (fallback never consulted once a token streamed).

**Harness limitation (why not a live-server Playwright e2e).** The real mock
LLM (`ezcorp-mock`) is only reachable via a Level-1 pin, and the real router's
`suggestFallback` only proposes the real preference-order providers (which have
no CI credentials) — so a genuine cross-provider failover can't complete
end-to-end against the live server until the mock is made routing-reachable as
a fallback (a WS-H follow-up, same gap WS3 documented). The real-executor
integration test above therefore stands in for the live e2e (explicitly
permitted by the feature contract), exercising the actual retry loop wired into
`streamChat`.

---

### WS3 — Quality-tier routing  *(agent: `general-purpose`, effort M, after WS0; parallel w/ WS1/WS2)*

**Scope**
- A **heuristic** request→tier classifier (NOT an LLM pre-call — that re-adds the latency we're
  cutting). Signals: prompt token length, presence/kind of tools, explicit tier hint, extension/
  EZ-action declared tier need. Map → `fast`/`balanced`/`powerful`, feed `resolveModel(tier)`.
- Let extensions / EZ-actions **declare a tier requirement** (small manifest/config field) so
  routing becomes an extension capability (the Expansionist's contained upside).
- Interaction rule with WS1: switching model **discards the cache** — the classifier must prefer
  tier-stability within a conversation unless the signal is strong (document the per-turn tradeoff).

**Files (likely):** new `src/providers/tier-classifier.ts` (pure, 100% coverage), wiring at the
`resolveModel` call site, extension manifest schema + `clamp-permissions`/spawn path if extensions
declare tiers, a settings toggle + UI.

**Tests / gate**
- 100% coverage on the classifier (pure function — ideal). e2e for the routing decision.
- `@evidence` visual spec if a tier indicator is shown in the UI.

---

#### WS3 — as built (implementation notes)

**Classifier location (deviation from the file plan above).** The pure
classifier ships at **`src/runtime/tier-classifier.ts`**, NOT
`src/providers/tier-classifier.ts`. Reason: the whole `src/providers/**`
tree is a coverage-gate EXCLUDE (`scripts/coverage-config.ts`), so a file
placed there is skipped by check-coverage, the new-file gate, AND the patch
gate — it could never be enforced at 100% and any `coverage-thresholds.json`
key for it would be inert. The feature contract requires REAL 100%
enforcement, so the file lives in the enforced `src/runtime/**` tree,
co-located with its only consumer (`stream-chat/setup-tools.ts`). The tier
vocabulary (`RoutingTier`) is owned there and `src/providers/router.ts`
type-imports it (type-only → erased, zero runtime coupling). New thresholds
key: `"src/runtime/tier-classifier.ts": 100`.

**Classifier signals + thresholds (heuristic only — no LLM pre-call).**
Precedence: (1) an extension/EZ-action **declared tier** (correctness
requirement) → (2) an explicit caller **tier hint** → (3) heuristic:
`hasComplexTools` (write/shell/orchestration) → `powerful`; est. tokens
(`chars/4`) `≥ 8000` → `powerful`; any tool present → `≥ balanced`; est.
tokens `≤ 500` and tool-less → `fast`; else `balanced`. Tool signals are
derived synchronously from the turn `options` (project/agent-config/
restriction/orchestration-depth) so the decision adds zero latency and never
waits on the racing tool-load phase.

**Wiring / where.** `src/runtime/stream-chat/setup-tools.ts` — the model
resolution IIFE (the `resolveModel(options.provider, options.model)` site).
`resolveModel` gains an optional 3rd param `tier?: RoutingTier`; when passed
it routes by that tier instead of `getDefaultTier()`, and explicit
provider+model pins (Level-1) ignore it entirely (passthrough unchanged).

**Extension / EZ-action tier declaration.** Extensions declare
`routing: { tier }` in their manifest (validated at admit time by
`validateRoutingBlock` in `src/extensions/manifest.ts`); the classifier
reads the strongest declared tier across the extensions wired into the
conversation (via the conversation's `extensionTools` map → the in-memory
registry `getManifest`, no extra DB round-trip). EZ actions carry the
parallel `EzAction.tier` declaration surface (`strongestTier` combines
both); threading a mixed EZ+content turn's declared tier into chat routing
is a documented follow-up (v1 EZ actions are code-defined and mostly
action-only).

**Cache interaction / tier-stability (the per-turn tradeoff).** WS1 gives
the prompt a byte-stable, prefix-cached block; the Anthropic cache is
prefix-matched, so SWITCHING models mid-conversation discards it (guaranteed
miss + a 25% cache-write surcharge next turn). Because `options.model`
already folds in BOTH the per-turn UI pin AND the conversation's established
model (`web/.../conversations/[id]/messages/+server.ts`), the wiring only
classifies a tier when there is NO established model (a fresh thread) — once
a thread has a model it is honored verbatim. This is deliberate
**tier-stability**: route once, at thread start; never re-route an
established thread. The strong-signal escape (a declared/hint tier) still
applies at thread start; we intentionally do NOT bust an established model
even on a strong signal, because at the routing layer `options.model` cannot
be distinguished from a user's explicit per-turn pin (honoring pins wins).

**e2e / harness limitation.** The routing DECISION is a backend concern and
the mock LLM is only reachable via a Level-1 pin (`provider: "ezcorp-mock"`),
which is exactly the passthrough path — so the no-model tier-classification
path cannot be completed end-to-end in CI (no real keys) until the mock is
made routing-reachable (a WS-H follow-up). `web/e2e/real-auth/tier-routing-
flow.spec.ts` therefore asserts the pinned-model passthrough end-to-end (the
invariant this change most risks); the classification logic itself is proven
by the pure unit tests (100%) + a real-executor integration test that drives
a model-less turn through `setupTools`.

---

### WS-V — Adversarial validator  *(agent: `general-purpose`, own worktree, after each WS)*

- Runs in a **fresh detached worktree at the WS's SHA** (never shares the builder's tree — avoids
  the false-PASS race; capture exit via `cmd >log; echo $?`, not `| tail`).
- Verifies for each WS: `bun run typecheck && bun run lint && bun run test && bun run test:coverage`
  green; new-file thresholds present; e2e + visual-evidence specs present and real (no
  `.skip/.only/.todo`, no assertion-free tests); gate-integrity untouched.
- **Behavioral proof, not just green:** cache actually hits (WS0 meter on a long thread post-WS1);
  failover actually fires (WS-H simulated outage); classifier routes as specified.
- Reports CONFIRMED/PLAUSIBLE findings back to the lead; lead dispatches fixes.

---

## 4. Milestones / merge order

1. **WS0 + WS-H** land first (WS0 is the gate metric; WS-H unblocks later tests).
2. **WS1** lands next and is measured against WS0's meter (hit-rate must materially improve on
   compacted turns). This is the cost win.
3. **WS2** and **WS3** land in either order after WS0/WS-H (they're independent of each other).
4. Each PR: stacked on `feat/pi-cache-routing`, rebased `--onto` as parents merge, non-author
   review, all required checks green. Squash-merge; release via `app-vX.Y.Z` tag when the set is done.

## 5. Explicit non-goals / follow-ups
- **Mid-stream (post-first-token) failover — FOLLOW-UP (WS2).** Once a text
  token, thinking token, or tool card has streamed to the client
  (`StreamChatContext.emittedToClient === true`), `runWithFailover` deliberately
  does NOT retry — it rethrows and the existing error path renders the failure.
  Transparent mid-stream failover needs partial-output re-emission + client-side
  dedup (re-issuing the prompt on a fallback would replay already-streamed text
  unless the bridge can suppress the overlap), which the council flagged as
  genuinely hard. File as a separate issue; do not attempt inside WS2. Code
  markers: `src/runtime/stream-chat/failover.ts` (module header + the
  `emittedToClient` throw) and the `runWithFailover` call in
  `src/runtime/executor.ts`.
- **Failover provenance — FOLLOW-UP (WS2).** After a failover the turn is served
  by the fallback provider/model; `runWithFailover` threads the effective
  provider/model into `subscribeBridge` so persisted `tool_calls`/assistant
  messages + the WS0 cache meter are segmented by the SERVING provider (not the
  user's original pick). The `run.provider` field is likewise updated in
  `resolveAttempt`. Any residual UI copy that says "you picked X" on a
  failed-over turn is a cosmetic follow-up.
- **Mock LLM not routing-reachable as a fallback — FOLLOW-UP (WS-H).** The
  deterministic `ezcorp-mock` provider is only reachable via a Level-1 pin, and
  the real `suggestFallback` only proposes real preference-order providers (no
  CI credentials) — so a genuine cross-provider failover can't be driven end-to-
  end against the live server yet. WS2 proves failover through a real-executor
  integration test (pi-agent-core + router mocked) instead; a WS-H change that
  makes the mock selectable as a fallback candidate would unlock a full
  live-server Playwright e2e. Same gap WS3 documented for tier classification.
- An external gateway — ruled out (OAuth-BYOK + single-container).
- LLM-based prompt classification for tiering — rejected (latency).
- Cross-provider cache portability — impossible (cache is per-provider/per-model).

## 6. Risks
- **R1 (High):** WS1 regresses context behavior. Mitigation: WS-V isolated audit + the compaction
  proof test + `docs/context-compaction.md` update; CODEOWNERS review on the invariant.
- **R2 (Med):** CI can't exercise real caching/failover → WS-H must faithfully simulate; risk of
  "green theater." Mitigation: WS-V behavioral proof on a real local run before merge.
- **R3 (Med):** BYOK single-provider users derive no failover / uneven cache benefit. Mitigation:
  §2 graceful degradation + provider-segmented meter; honest UI copy.

---

## 7. Post-audit addendum (2026-07-09)

A 4-agent audit of the PR built from this plan found the architecture right but
the first implementation partial. The following fixes landed on the same
branch. §1's ground-truth table and the "as built" notes above are **left
as-written** — they were accurate at their stated SHAs; this addendum is the
delta.

- **Cache prefix (CRITICAL, fixed).** Per-turn memory/KB recall was
  concatenated into `ctx.system`, re-writing (busting) the cached region-1
  prefix on every memory/KB turn — with the shipped `long` (2× write price)
  retention, caching was cost-negative exactly where the memory feature is
  used. Fixed by splitting it out: `ctx.system` stays byte-stable (region-1 =
  **system + tools only**) and the injected block rides as a separate
  **uncached trailing system block** on Anthropic
  (`src/runtime/stream-chat/system-cache-split.ts`; stash:
  `ctx.systemMemoryTail` in `setup-tools.ts`; non-Anthropic providers get it
  merged into the plain `systemPrompt`). See the
  [cache-anchor decision record](../decisions/2026-07-08-compaction-cache-anchor.md).
- **1h cache-write visibility (fixed).** `cacheWrite1h` was parsed by pi-ai
  but dropped app-side, so the meter couldn't see the 2× 1h-write surcharge.
  Now threaded compute → persist (`messages.usage.cacheWrite1hTokens`) →
  `run:usage` → the chat cache pill (`… @1h (2×)` segment).
- **Failover tier hardcode (fixed).** The failover loop hardcoded tier
  `"balanced"`, so a pinned Opus could silently fail over to a mid-tier
  model. `setup-tools.ts` now computes an `effectiveTier` per turn (a pinned
  model's own inferred tier; the classifier/default tier when routed) and
  `executor.ts` passes `tier: resolvedModel.effectiveTier` — fallbacks are
  tier peers, including chained ones.
- **Routed-turn provenance (fixed).** Routed turns persisted `null`
  provider/model (metered as "unknown"). Every attempt now passes the
  **served** provider/model into `subscribeBridge`, and `messages.usage`
  records `requestedProvider`/`requestedModel` (null ⇒ routed), `routedTier`,
  and `failover`.
- **Failover hardening (fixed).** Circuit breakers were process-global per
  provider (one user's 429s degraded everyone); now keyed per
  `(provider, scope)` with the conversation owner's userId as the scope
  (bounded map, context-free callers keep the shared scope). A failing
  provider gets one same-provider jittered-backoff retry **before**
  cross-provider fallback (preserves cache locality; exactly one
  `recordFailure` per provider per turn), and the per-attempt
  `unsubAgentActivity` bus listener is detached on every rebuild (leak fix).
- **Proof honesty.** The WS1 "0 → 0.40 hit-rate" proof ran at
  `cacheAnchorFraction = 0.5`, not the shipped default `0`; tests were
  relabeled as opt-in proofs and shipped-default assertions added, plus a
  real-Anthropic-SSE usage-shape test (the mock's `cache_write_tokens` field
  is synthetic — no real provider emits it).

Operator-facing docs for the resulting behavior:
[docs/llm-routing-and-failover.md](../llm-routing-and-failover.md) (native
routing/failover vs the OpenRouter alternative) and
[docs/context-compaction.md](../context-compaction.md) (cache regions +
retention).
