/**
 * System-block cache SPLIT: frozen cached prefix vs volatile memory tail.
 *
 * Per-turn memory/KB recall is QUERY-DEPENDENT — concatenating it into the
 * system prompt busts Anthropic's region-1 prefix cache (system + tools) on
 * every memory/KB turn, which with a "long" (2× write price) retention makes
 * caching cost-negative exactly where the platform's memory feature is used.
 *
 * The fix: `ctx.system` stays memory-free (byte-stable across turns → cached),
 * and the injected memory/KB block rides as a SEPARATE trailing system block
 * with NO `cache_control`. Anthropic places cache breakpoints explicitly, so
 * an unmarked trailing block adds content without adding (or moving) a
 * breakpoint — the frozen prefix blocks before it keep their byte-identity
 * and their TTLs (`applyCacheRetention` only rewrites blocks that already
 * carry `cache_control`, so the tail is inert to retention shaping).
 *
 * Applied in `build-pi-agent.ts`'s `onPayload` hook, BEFORE
 * `applyCacheRetention`, and only for `anthropic-messages` payloads —
 * non-Anthropic providers get the tail merged into the plain systemPrompt
 * string instead (no `cache_control` concept to protect). This module is
 * PURE — no I/O, no secrets.
 */

/** A single Anthropic system text block (only the fields this module writes). */
interface SystemTextBlock {
  type: "text";
  text: string;
}

/** The subset of an Anthropic request body this module touches. */
interface SystemCarryingPayload {
  system?: unknown;
}

/**
 * Strip unpaired Unicode surrogates from the tail text.
 *
 * pi-ai sanitizes every system block it builds itself (unpaired surrogates
 * break JSON serialization at several providers); a block we append must
 * meet the same bar. The regex replicates pi-ai's `sanitizeSurrogates`
 * (node_modules/@earendil-works/pi-ai/dist/utils/sanitize-unicode.js:24)
 * verbatim: drop high surrogates not followed by a low surrogate, and low
 * surrogates not preceded by a high one. Properly paired surrogates
 * (emoji etc.) are untouched.
 */
function sanitizeTail(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/**
 * Append the volatile memory/KB tail as the LAST system block of an
 * already-built Anthropic payload — with NO `cache_control`, so it never
 * becomes (or displaces) a cache breakpoint.
 *
 * - Empty/absent tail → strict no-op (the common no-memory turn).
 * - `payload.system` is an array (pi-ai's shape) → push the tail block.
 * - `payload.system` is a non-empty string (legal Anthropic shape, not one
 *   pi-ai emits) → convert to block form, then append; the converted block
 *   carries no `cache_control`, exactly like the string it replaces.
 * - `payload.system` absent/empty → create the array. Memory must NEVER be
 *   silently dropped, even when the frozen prompt is empty.
 *
 * Mutates the payload in place and returns it (matching the `onPayload`
 * contract, mirroring `applyCacheRetention`).
 */
export function appendMemoryTailBlock(payload: unknown, tail: string | undefined): unknown {
  if (!tail) return payload;
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as SystemCarryingPayload;

  const tailBlock: SystemTextBlock = { type: "text", text: sanitizeTail(tail) };
  if (Array.isArray(p.system)) {
    p.system.push(tailBlock);
  } else if (typeof p.system === "string" && p.system.length > 0) {
    p.system = [{ type: "text", text: p.system }, tailBlock];
  } else {
    p.system = [tailBlock];
  }
  return payload;
}
