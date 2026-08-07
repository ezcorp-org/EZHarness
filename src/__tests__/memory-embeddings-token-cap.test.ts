// IDX-06 regression pin: prove the 256-token INPUT cap is actually in effect,
// not merely assigned.
//
// The other embeddings suites mock the tokenizer as a plain writable object, so
// they can only observe that getExtractor() *wrote* a number somewhere. That is
// exactly the assertion that stayed green while the write was a no-op: on
// @huggingface/transformers v3 `tokenizer.config.model_max_length = 256` sets a
// property nothing reads (v3 copies model_max_length into an own field at
// construction), and on v4 `tokenizer.model_max_length = 256` throws, because v4
// made it a getter with no setter. Both failure modes type-check clean.
//
// So this file asserts on OBSERVED TRUNCATION using the REAL PreTrainedTokenizer
// class from the installed package: the fake pipeline carries a genuine
// tokenizer and tokenizes exactly the way FeatureExtractionPipeline does
// (`tokenizer(texts, { padding: true, truncation: true })`). If a future release
// drops the `config` → `_tokenizerConfig` aliasing, removes the getter, or
// someone reverts the write to the bare property, the observed input_ids length
// stops being CHUNK_TOKENS and this fails.
import { test, expect, describe, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { CHUNK_TOKENS } from "../memory/message-chunker";
import { EMBEDDING_DIMENSIONS } from "../memory/types";

/**
 * The package's bare specifier resolves to the bundle, which pulls in
 * onnxruntime-node and sharp — native libraries that are unavailable in this
 * container (which is why every other suite mocks the module wholesale). The
 * tokenizer source module has no native dependency, so load it by absolute path
 * and get the real class without the real runtime.
 */
function realTokenizerModuleUrl(): string {
  const entry = Bun.resolveSync("@huggingface/transformers", import.meta.dir);
  const distIndex = entry.lastIndexOf("/dist/");
  if (distIndex === -1) {
    throw new Error(
      `Unexpected @huggingface/transformers layout: resolved to "${entry}", expected a dist/ entry point alongside src/tokenization_utils.js.`,
    );
  }
  return `${entry.slice(0, distIndex)}/src/tokenization_utils.js`;
}

type RealTokenizer = {
  (text: string, opts: { padding: boolean; truncation: boolean }): { input_ids: { dims: number[] } };
  config: { model_max_length: number };
  model_max_length: number;
};
type RealTokenizerCtor = new (tokenizerJSON: unknown, tokenizerConfig: unknown) => RealTokenizer;

const { PreTrainedTokenizer } = (await import(realTokenizerModuleUrl())) as {
  PreTrainedTokenizer: RealTokenizerCtor;
};

/** The cap the model itself ships with — what we fall back to if our write misses. */
const MODEL_DEFAULT_MAX_LENGTH = 512;
/** Long enough to be truncated by both the cap and the model default, and to tell them apart. */
const LONG_INPUT_WORDS = 400;

/**
 * A real tokenizer over a tiny offline word-level vocab. Whitespace
 * pre-tokenization makes the token count exactly the word count, so the
 * truncation assertions below are exact rather than approximate.
 */
function makeRealTokenizer(): RealTokenizer {
  const vocab: Record<string, number> = { "[UNK]": 0, "[PAD]": 1 };
  for (let i = 0; i < 64; i++) vocab[`w${i}`] = i + 2;
  return new PreTrainedTokenizer(
    {
      version: "1.0",
      truncation: null,
      padding: null,
      added_tokens: [],
      normalizer: null,
      pre_tokenizer: { type: "Whitespace" },
      post_processor: null,
      decoder: null,
      model: { type: "WordLevel", vocab, unk_token: "[UNK]" },
    },
    { model_max_length: MODEL_DEFAULT_MAX_LENGTH, pad_token: "[PAD]", unk_token: "[UNK]" },
  );
}

const longInput = Array.from({ length: LONG_INPUT_WORDS }, (_, i) => `w${i % 64}`).join(" ");

/** input_ids lengths the fake pipeline actually produced, newest last. */
const observedInputIdLengths: number[] = [];
let pipelineTokenizer: RealTokenizer | null = null;

mock.module("@huggingface/transformers", () => ({
  pipeline: async () => {
    const tokenizer = makeRealTokenizer();
    pipelineTokenizer = tokenizer;
    const extractor = async (text: string) => {
      // Mirrors FeatureExtractionPipeline._call: this is the ONLY tokenize the
      // real pipeline performs, and the only place the cap can take effect.
      const modelInputs = tokenizer(text, { padding: true, truncation: true });
      observedInputIdLengths.push(modelInputs.input_ids.dims[modelInputs.input_ids.dims.length - 1]!);
      const data = new Float32Array(EMBEDDING_DIMENSIONS);
      for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) data[i] = (i + 1) * 0.001;
      return { data };
    };
    (extractor as unknown as { tokenizer: RealTokenizer }).tokenizer = tokenizer;
    return extractor;
  },
  env: { backends: { onnx: {} } },
}));

const { generateEmbedding, resetEmbeddingProvider } = await import("../memory/embeddings");

describe("IDX-06 effective input cap (real PreTrainedTokenizer)", () => {
  afterAll(() => {
    resetEmbeddingProvider();
    restoreModuleMocks();
  });

  test("an uncapped tokenizer truncates the same input at the model default, not CHUNK_TOKENS", () => {
    // Control arm. Without this, 256 could be an artifact of the input rather
    // than proof that getExtractor() moved the cap.
    const untouched = makeRealTokenizer();
    const encoded = untouched(longInput, { padding: true, truncation: true });
    expect(encoded.input_ids.dims[encoded.input_ids.dims.length - 1]).toBe(LONG_INPUT_WORDS);
    expect(untouched.model_max_length).toBe(MODEL_DEFAULT_MAX_LENGTH);
    expect(MODEL_DEFAULT_MAX_LENGTH).not.toBe(CHUNK_TOKENS);
  });

  test("generateEmbedding tokenizes a long input to exactly CHUNK_TOKENS ids", async () => {
    observedInputIdLengths.length = 0;
    const embedding = await generateEmbedding(longInput);

    // The cap is observed in the tokenizer's OUTPUT, so this fails if the write
    // in getExtractor() lands anywhere the getter does not read back.
    expect(observedInputIdLengths).toEqual([CHUNK_TOKENS]);
    expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  test("the cap sticks for every later call on the reused singleton", async () => {
    observedInputIdLengths.length = 0;
    await generateEmbedding(longInput);
    await generateEmbedding(longInput);
    expect(observedInputIdLengths).toEqual([CHUNK_TOKENS, CHUNK_TOKENS]);
  });

  test("short input is unaffected by the cap", async () => {
    observedInputIdLengths.length = 0;
    await generateEmbedding("w1 w2 w3");
    expect(observedInputIdLengths).toEqual([3]);
  });

  test("the getter reads the cap back through the config object getExtractor() wrote to", async () => {
    await generateEmbedding("prime the singleton");
    expect(pipelineTokenizer).not.toBeNull();
    // Not the assertion the cap rests on — the truncation tests above are. This
    // documents WHICH object the write has to land on for those to hold.
    expect(pipelineTokenizer!.config.model_max_length).toBe(CHUNK_TOKENS);
    expect(pipelineTokenizer!.model_max_length).toBe(CHUNK_TOKENS);
  });

  test("writing the bare model_max_length property throws — why the write goes through .config", () => {
    const tokenizer = makeRealTokenizer();
    // v4 made model_max_length a getter with no setter. ESM is strict mode, so
    // the pre-v4 form of this assignment is a TypeError at model-init time,
    // which would take persistent memory and KB chunking down with it.
    expect(() => {
      (tokenizer as unknown as { model_max_length: number }).model_max_length = CHUNK_TOKENS;
    }).toThrow(TypeError);
    expect(tokenizer.model_max_length).toBe(MODEL_DEFAULT_MAX_LENGTH);
  });
});
