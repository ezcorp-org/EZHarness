import { test, expect, describe } from "bun:test";
import type { PreTrainedTokenizer } from "@huggingface/transformers";
import {
  chunkByTokens,
  isEmbedEligible,
  EMBED_ELIGIBLE_ROLES,
  CHUNK_TOKENS,
  OVERLAP_TOKENS,
} from "../memory/message-chunker";

// A FAKE tokenizer: token ids map 1:1 to whitespace-delimited word positions,
// so window boundaries are deterministically assertable. Encode splits on
// whitespace and yields one id per word (the word's index). Decode joins the
// words back. The fake records the opts passed to encode/decode so the test
// can assert add_special_tokens:false / skip_special_tokens:true.
function makeFakeTokenizer() {
  let lastWords: string[] = [];
  const encodeOpts: Array<unknown> = [];
  const decodeOpts: Array<unknown> = [];
  const tokenizer = {
    encode(text: string, opts?: { add_special_tokens?: boolean }) {
      encodeOpts.push(opts);
      lastWords = text.split(/\s+/).filter((w) => w.length > 0);
      return lastWords.map((_, i) => i);
    },
    decode(ids: number[], opts?: { skip_special_tokens?: boolean }) {
      decodeOpts.push(opts);
      return ids.map((id) => lastWords[id]).join(" ");
    },
  } as unknown as PreTrainedTokenizer;
  return { tokenizer, encodeOpts, decodeOpts, getWords: () => lastWords };
}

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
}

describe("chunkByTokens", () => {
  test("≤256-token input returns exactly [text] (single chunk)", () => {
    const { tokenizer } = makeFakeTokenizer();
    const text = words(256);
    expect(chunkByTokens(tokenizer, text)).toEqual([text]);
  });

  test("exactly-256-token input is a single chunk equal to input", () => {
    const { tokenizer } = makeFakeTokenizer();
    const text = words(256);
    const chunks = chunkByTokens(tokenizer, text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  test(">256-token input returns multiple chunks; each window ≤256 tokens", () => {
    const { tokenizer } = makeFakeTokenizer();
    const text = words(600);
    const chunks = chunkByTokens(tokenizer, text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const tokenCount = chunk.split(/\s+/).filter((w: string) => w.length > 0).length;
      expect(tokenCount).toBeLessThanOrEqual(CHUNK_TOKENS);
    }
  });

  test("stride is 224 (256 - 32 overlap); consecutive windows share 32-token overlap", () => {
    const { tokenizer } = makeFakeTokenizer();
    const text = words(600);
    const chunks = chunkByTokens(tokenizer, text);
    const stride = CHUNK_TOKENS - OVERLAP_TOKENS; // 224
    expect(stride).toBe(224);

    // First window = w0..w255, second window starts at stride=224 (w224..)
    const first = chunks[0]!.split(/\s+/);
    const second = chunks[1]!.split(/\s+/);
    expect(first[0]).toBe("w0");
    expect(first[first.length - 1]).toBe("w255");
    expect(second[0]).toBe("w224");

    // Overlap: last 32 tokens of window 1 == first 32 tokens of window 2
    const overlapFromFirst = first.slice(first.length - OVERLAP_TOKENS);
    const overlapFromSecond = second.slice(0, OVERLAP_TOKENS);
    expect(overlapFromSecond).toEqual(overlapFromFirst);
  });

  test("final window covers the tail of the input (no tokens dropped)", () => {
    const { tokenizer } = makeFakeTokenizer();
    const text = words(600);
    const chunks = chunkByTokens(tokenizer, text);
    const last = chunks[chunks.length - 1]!.split(/\s+/);
    expect(last[last.length - 1]).toBe("w599");
  });

  test("encode called with {add_special_tokens:false}, decode with {skip_special_tokens:true}", () => {
    const { tokenizer, encodeOpts, decodeOpts } = makeFakeTokenizer();
    chunkByTokens(tokenizer, words(600));
    expect(encodeOpts[0]).toEqual({ add_special_tokens: false });
    expect(decodeOpts.length).toBeGreaterThan(0);
    for (const opt of decodeOpts) {
      expect(opt).toEqual({ skip_special_tokens: true });
    }
  });
});

describe("isEmbedEligible", () => {
  test("user/assistant non-empty content → true", () => {
    expect(isEmbedEligible("user", "hi")).toBe(true);
    expect(isEmbedEligible("assistant", "hi")).toBe(true);
  });

  test("every non-allowlisted role → false", () => {
    expect(isEmbedEligible("system", "x")).toBe(false);
    expect(isEmbedEligible("extension", "x")).toBe(false);
    expect(isEmbedEligible("ez-action-result", "x")).toBe(false);
    expect(isEmbedEligible("capability-event", "x")).toBe(false);
  });

  test("empty/whitespace content → false even for allowlisted roles", () => {
    expect(isEmbedEligible("user", "   ")).toBe(false);
    expect(isEmbedEligible("assistant", "")).toBe(false);
  });

  test("EMBED_ELIGIBLE_ROLES contains exactly user and assistant", () => {
    expect(EMBED_ELIGIBLE_ROLES.has("user")).toBe(true);
    expect(EMBED_ELIGIBLE_ROLES.has("assistant")).toBe(true);
    expect(EMBED_ELIGIBLE_ROLES.size).toBe(2);
  });
});
