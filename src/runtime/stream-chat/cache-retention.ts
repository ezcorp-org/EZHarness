/**
 * Prompt-cache RETENTION policy for the stable prefix (WS1).
 *
 * Anthropic caches the system prompt + tool/RBAC schemas + the
 * conversation prefix and serves them back on the next turn — but each
 * cache entry has a TTL. pi-ai's default is `"short"` (~5 min); a
 * `"long"` entry lives ~1h. On a long thread whose STABLE prefix (system
 * prompt + tools + the oldest anchored turns, see `context-compaction.ts`)
 * is reused every turn, a 5-minute TTL expires between turns whenever the
 * user pauses to think, forcing a full cache re-write. A 1h TTL keeps that
 * expensive-to-build prefix warm across those gaps.
 *
 * pi-ai applies ONE retention to every cache breakpoint of a request via
 * `options.cacheRetention` / `PI_CACHE_RETENTION`, and the pi-agent-core
 * `Agent` does not forward `cacheRetention` to the stream options. So we
 * shape retention per-request in `build-pi-agent.ts`'s `onPayload` hook,
 * which pi-ai calls with the fully-built provider params. This lets us do
 * what the single-retention API can't: keep the STABLE PREFIX long (1h)
 * while leaving the conversation TAIL short (5 min) — the tail is
 * re-written every turn, so paying the higher 1h write price for it would
 * be pure waste.
 *
 * The mutation is a strict SUBSET of what pi-ai itself emits in its native
 * `"long"` path (it sets `ttl: "1h"` on every breakpoint when
 * `supportsLongCacheRetention`), so it never produces a wire shape pi-ai
 * wouldn't. Non-Anthropic payloads carry no `cache_control` blocks, so the
 * adjuster is a no-op for them. This module is PURE — no I/O, no secrets.
 */

/** Retention policy for a request's cache breakpoints. */
export type CacheRetention = "short" | "long" | "none";

/**
 * Default: keep the stable prefix warm for ~1h. Unset threads a `"long"`
 * retention onto the prefix while the tail stays short (see `applyCacheRetention`).
 *
 * Why `"long"` is the shipped default (break-even math): with a stable
 * prefix of R tokens, a 1h write costs 2.0R (2× input price) once, and
 * every reused turn reads at 0.1R — total `2.0R + (N−1)·0.1R` over N
 * turns. A 5m retention re-writes at 1.25R whenever the >5m TTL lapses
 * between turns — worst case `N·1.25R`. Long wins from the 2nd reused
 * turn (break-even N* ≈ 1.65): a single >5-minute pause (any human-paced
 * thread) repays the 1h surcharge. Rapid-loop operators whose turns
 * always land inside the 5m TTL should set the `compaction:cacheRetention`
 * setting to `"short"`; the 1h write premium is observable per-turn via
 * the cache-stats `cacheWrite1hTokens` field, so the choice is
 * data-driven, not faith-based.
 */
export const DEFAULT_CACHE_RETENTION: CacheRetention = "long";

/**
 * Validate a raw settings value (`compaction:cacheRetention`) into a
 * {@link CacheRetention}. Returns `undefined` for anything unrecognized so
 * the caller falls back to {@link DEFAULT_CACHE_RETENTION}.
 */
export function resolveCacheRetentionSetting(raw: unknown): CacheRetention | undefined {
  return raw === "short" || raw === "long" || raw === "none" ? raw : undefined;
}

/** Anthropic's `cache_control` object (only `ttl` is retention-relevant). */
interface CacheControl {
  type: string;
  ttl?: string;
}

/** A payload block that may carry a `cache_control` breakpoint. */
interface Cacheable {
  cache_control?: CacheControl;
}

/** The subset of an Anthropic request body this module inspects. */
interface AnthropicLikePayload {
  system?: unknown;
  tools?: unknown;
  messages?: unknown;
}

/** Coerce an unknown field into an array of cacheable blocks (else empty). */
function asBlocks(x: unknown): Cacheable[] {
  return Array.isArray(x) ? (x as Cacheable[]) : [];
}

/**
 * The STABLE-PREFIX cache holders pi-ai marks: every system-prompt block
 * plus the LAST tool. These are byte-stable across turns and are the ones
 * worth a long TTL.
 */
function prefixCacheableBlocks(p: AnthropicLikePayload): Cacheable[] {
  const blocks = [...asBlocks(p.system)];
  const tools = asBlocks(p.tools);
  const lastTool = tools[tools.length - 1];
  if (lastTool) blocks.push(lastTool);
  return blocks;
}

/**
 * The conversation-TAIL cache holder pi-ai marks: the content blocks of
 * the last message (the breakpoint that shifts every turn).
 */
function tailCacheableBlocks(p: AnthropicLikePayload): Cacheable[] {
  const messages = asBlocks(p.messages) as Array<{ content?: unknown }>;
  const lastMsg = messages[messages.length - 1];
  return lastMsg ? asBlocks(lastMsg.content) : [];
}

/**
 * Shape the cache-retention TTLs of an already-built provider payload.
 *
 * - `"short"`: leave pi-ai's default (5-minute TTL everywhere) untouched.
 * - `"none"`: strip every `cache_control` so nothing is cached.
 * - `"long"`: set a 1h TTL on the STABLE PREFIX (system + last tool) and
 *   leave the TAIL short — but only when the model supports 1h retention.
 *
 * Mutates the payload in place and returns it (matching the `onPayload`
 * contract). No-op for any payload lacking Anthropic's `cache_control`
 * blocks (i.e. every non-Anthropic provider).
 */
export function applyCacheRetention(
  payload: unknown,
  supportsLongRetention: boolean,
  retention: CacheRetention,
): unknown {
  if (retention === "short") return payload;
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as AnthropicLikePayload;

  if (retention === "none") {
    for (const block of [...prefixCacheableBlocks(p), ...tailCacheableBlocks(p)]) {
      delete block.cache_control;
    }
    return payload;
  }

  // retention === "long"
  if (!supportsLongRetention) return payload;
  for (const block of prefixCacheableBlocks(p)) {
    if (block.cache_control) {
      block.cache_control = { type: "ephemeral", ttl: "1h" };
    }
  }
  return payload;
}
