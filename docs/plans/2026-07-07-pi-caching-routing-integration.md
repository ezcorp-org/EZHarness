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
- Mid-stream (post-first-token) failover — hard; separate issue.
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
