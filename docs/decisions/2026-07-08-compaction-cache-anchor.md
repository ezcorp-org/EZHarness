# Decision: compaction cache-anchor is opt-in (default `cacheAnchorFraction = 0`)

**Date:** 2026-07-08 · **Status:** Accepted · **Area:** context-compaction / prompt caching
**Code:** `src/runtime/stream-chat/context-compaction.ts` (`TrimStrategy`, `cacheAnchorFraction`),
`src/runtime/stream-chat/cache-retention.ts` · **Feature:** [pi caching+routing](../plans/2026-07-07-pi-caching-routing-integration.md)

## Context

WS1 made context-compaction cache-aware. Two independent mechanisms came out of it:

1. **Marker relocation + 1h retention on the stable prefix (Region 1).** pi-ai places Anthropic
   `cache_control` breakpoints on the system prompt, the last tool, and the last user message.
   The system + tool/RBAC schemas + injected memory sit *before* the conversation history and are
   byte-stable, so they are cached in every case. WS1 (a) stopped the compaction marker from
   corrupting that region and (b) shapes a **1h** TTL on it (`cache-retention.ts`) so it survives
   human-paced pauses instead of expiring on pi-ai's default ~5-min TTL.

2. **The oldest-turn cache anchor (Region 2), `cacheAnchorFraction`.** On a thread long enough to
   trigger compaction, trimming the oldest turns breaks the *message-history* prefix, so history
   caching collapses to ~0. The anchor keeps up to `cacheAnchorFraction × budget` of the **oldest**
   whole turns byte-stable (evicting the **middle** instead), which lets the history prefix stay
   cached.

## The collision that forced the decision

PR **#53** (merged to `main` in parallel) added
`src/__tests__/compaction-real-agent.integration.test.ts`, which asserts the conventional recency
policy: **the oldest turns are evicted** (`historical turn 0` must be gone). WS1's default
`cacheAnchorFraction = 0.5` does the opposite — it *pins* turn 0 — so the two policies are directly
opposed.

## Quantified analysis

- **Region 1 (system + tools + memory)** — the large stable block — is cached regardless of the
  anchor. WS1's **1h retention** win applies at `cacheAnchorFraction = 0`. This is the broad,
  always-on benefit.
- **Region 2 (history)** — the anchor is the *only* thing that caches it under compaction, and only
  for threads long enough to compact (the minority). Normal-length threads cache history naturally
  (append-only) with no anchor.
- WS1's proof test (`context-compaction-cache-prefix.test.ts`) reports "hit-rate 0 → ~0.40", but its
  `bytePrefixCacheTokens` models **only the message-array leading prefix** — i.e. Region 2 in
  isolation. It does **not** include Region 1, so it is the anchor's message-history contribution on
  a compacting thread, not total cache. Real baseline hit-rate is already > 0 from Region 1.
- **Cost of the anchor:** it pins the **stalest, least-relevant** turns permanently while evicting
  the more-relevant **middle** — trading answer quality for cache spend.

## Decision

Default `cacheAnchorFraction = 0` (conventional trim-oldest). Keep the broad win (marker fix + 1h
retention on Region 1) on by default. Expose the oldest-anchor as an **opt-in** setting for
cost-sensitive operators. This also keeps #53's recency contract and conventional behavior intact.

## Pros / cons (for later revisiting)

**Pros of the default (anchor = 0):**
- Conventional, least-surprising compaction (recency-preserving); matches #53's contract.
- Keeps the highest-value, broadest cache win (Region-1 1h retention) with no relevance cost.
- No stale-context pinning; the more-relevant middle turns are retained.

**Cons of the default:**
- On long, *rapid* threads (e.g. agentic tool loops that re-call the LLM within the cache TTL),
  history-prefix caching (Region 2) is left on the table — potential extra token spend that the
  anchor would have captured.

**When to reconsider / flip to anchor > 0 (globally or per-deployment):**
- Measured (via WS0's cache meter) low hit-rate on long, high-volume threads where Region-2 caching
  would materially cut cost, AND
- the deployment tolerates keeping the oldest turns in-context (relevance cost acceptable), OR
- the anchor is scoped to agentic/tool-loop turns only (rapid re-calls within TTL, where recency of
  the oldest turn matters less).

**How to change:** set the `compaction:cacheAnchorFraction` setting (0–1) per deployment, or raise
the `DEFAULTS.cacheAnchorFraction` constant. WS1's machinery (marker relocation, anchor bound,
retention shaping) is fully retained and tested at `0.5` — only the default changed.
