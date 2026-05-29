// Token-aware chunker + embed-eligibility predicate for chat indexing.
//
// PURE-logic module: no I/O, no DB, no embeddings import beyond the
// PreTrainedTokenizer type. This is the token-aware replacement for chat
// messages; src/memory/chunking.ts stays as the char-based KB-file chunker
// (DRY — do not duplicate that logic here).
import type { PreTrainedTokenizer } from "@huggingface/transformers";

export const CHUNK_TOKENS = 256;
export const OVERLAP_TOKENS = 32;

/** Roles whose non-empty content is eligible for embedding. */
export const EMBED_ELIGIBLE_ROLES = new Set(["user", "assistant"]);

/**
 * A message is embed-eligible iff its role is on the allowlist AND its
 * content has non-whitespace text. Every other role, and empty/whitespace
 * content, is excluded.
 */
export function isEmbedEligible(role: string, content: string): boolean {
  return EMBED_ELIGIBLE_ROLES.has(role) && content.trim().length > 0;
}

/**
 * Split `text` into ≤256-token windows with a 32-token overlap (stride 224).
 *
 * A message that encodes to ≤256 content tokens (the common chat case)
 * returns exactly `[text]`. Longer text is windowed; the final window always
 * covers the tail so no tokens are dropped.
 *
 * PITFALL (research Pitfall 2): encode with add_special_tokens:false so
 * CLS/SEP do not consume the 256 budget — the extractor adds them back at
 * embed time. Decode with skip_special_tokens:true.
 */
export function chunkByTokens(tokenizer: PreTrainedTokenizer, text: string): string[] {
  const ids = tokenizer.encode(text, { add_special_tokens: false });
  if (ids.length <= CHUNK_TOKENS) return [text];
  const chunks: string[] = [];
  const stride = CHUNK_TOKENS - OVERLAP_TOKENS; // 224
  for (let i = 0; i < ids.length; i += stride) {
    const window = ids.slice(i, i + CHUNK_TOKENS);
    chunks.push(tokenizer.decode(window, { skip_special_tokens: true }));
    if (i + CHUNK_TOKENS >= ids.length) break;
  }
  return chunks;
}
