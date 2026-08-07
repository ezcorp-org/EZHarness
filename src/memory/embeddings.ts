// Local embedding generation using Transformers.js (all-MiniLM-L6-v2)
import { pipeline, type FeatureExtractionPipeline, type PreTrainedTokenizer } from "@huggingface/transformers";
import { EMBEDDING_DIMENSIONS } from "./types";
import { CHUNK_TOKENS } from "./message-chunker";

/**
 * Single source of truth for embedder identity. Encodes both the model and
 * its 384-dim vector width so a future model/dim swap is a plain string
 * compare (IDX-03). Later plans import this — never re-literal the id. The
 * bare model name passed to pipeline() is DERIVED from this constant
 * (suffix stripped), so the loaded model can never drift from the id we
 * record in the `embedding_model_id` column.
 */
export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2@384";

/** Model name (no `@dim` suffix) actually handed to pipeline(). */
const EMBEDDING_MODEL_NAME = EMBEDDING_MODEL_ID.split("@")[0]!;

let _extractor: FeatureExtractionPipeline | null = null;
let _initPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(onProgress?: (message: string) => void): Promise<FeatureExtractionPipeline> {
  if (_extractor) return _extractor;
  if (!_initPromise) {
    onProgress?.("Initializing embedding model...");
    _initPromise = pipeline("feature-extraction", EMBEDDING_MODEL_NAME, {
      dtype: "fp32",
      progress_callback: (event: { status: string; progress?: number }) => {
        if (event.status === "download" && event.progress != null) {
          onProgress?.(`Downloading embedding model... ${Math.round(event.progress)}%`);
        } else if (event.status === "initiate") {
          onProgress?.("Initializing embedding model...");
        }
      },
    }).then(
      (ext) => {
        _extractor = ext as FeatureExtractionPipeline;
        // IDX-06 input cap: the FeatureExtractionPipeline tokenizes internally
        // as tokenizer(texts, { padding: true, truncation: true }), truncating
        // at the tokenizer's model_max_length. There is NO max_length/truncation
        // on the extractor call options, so the input-only way to enforce the
        // cap is to lower model_max_length on the loaded tokenizer once, here.
        //
        // Why we write through `.config` and not the property itself: since
        // @huggingface/transformers v4, model_max_length is a GETTER with no
        // setter anywhere in the package — it reads
        // `this._tokenizerConfig.model_max_length` live on every tokenize call.
        // The constructor also publishes that same object as `this.config`
        // (`this._tokenizerConfig = tokenizerConfig; … this.config =
        // tokenizerConfig`), and `config` is public in the types, so writing
        // through it is the only supported way to move the cap. The aliasing
        // itself is undocumented, so this is deliberate coupling to an internal
        // detail — src/__tests__/memory-embeddings-token-cap.test.ts pins it
        // against the REAL tokenizer class and fails if a release breaks it.
        //
        // This write is version-EXCLUSIVE, not merely version-compatible. On v3
        // model_max_length was a plain writable field the constructor copied the
        // value into, so `.config.model_max_length = …` there would set a
        // property nothing reads and leave the effective cap at the model's 512.
        // Never ship this line without the v4 dependency bump — the two belong
        // in the same commit.
        //
        // The cap is CHUNK_TOKENS — the SAME budget the chunker windows to — so
        // a future tune to the chunk size moves both in lockstep and can't
        // silently re-introduce the over-length truncation this fix repaired
        // (which degraded both memories and knowledge_base_chunks). Input-only —
        // we never touch model.maxTokens or char-slice (context-compaction
        // invariant).
        _extractor.tokenizer.config.model_max_length = CHUNK_TOKENS;
        return _extractor;
      },
      (err) => {
        _initPromise = null; // Reset so next call retries
        throw err;
      },
    );
  }
  return _initPromise;
}

export async function generateEmbedding(text: string, onProgress?: (message: string) => void): Promise<number[]> {
  const extractor = await getExtractor(onProgress);
  // Input truncation to 256 tokens is enforced by getExtractor() setting
  // tokenizer.config.model_max_length = 256 (IDX-06); the extractor's internal
  // tokenize call reads it back through the model_max_length getter. The call
  // options below are the only ones the FeatureExtractionPipeline accepts.
  const output = await extractor(text, { pooling: "mean", normalize: true });
  const raw = Array.from(output.data as Float32Array);

  if (raw.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS}-dim embedding, got ${raw.length}`,
    );
  }

  // Manual normalization — normalize: true may not work in all runtimes
  const norm = Math.sqrt(raw.reduce((sum: number, val: number) => sum + val * val, 0));
  return norm > 0 ? raw.map((v) => v / norm) : raw;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await generateEmbedding(text));
  }
  return results;
}

/**
 * Accessor for the tokenizer held by the already-loaded feature-extraction
 * pipeline. Reuses the singleton — does NOT load a second tokenizer via
 * AutoTokenizer. Consumed by the message-chunker.
 */
export async function getTokenizer(): Promise<PreTrainedTokenizer> {
  const extractor = await getExtractor();
  return extractor.tokenizer;
}

/** Check if the embedding model is initialized (ready to generate embeddings) */
export function isEmbeddingReady(): boolean {
  return _extractor !== null;
}

/** Pre-warm the embedding model so it's ready when needed. Safe to call multiple times. */
export function warmupEmbeddings(): void {
  if (!_extractor && !_initPromise) {
    getExtractor().catch(() => {}); // fire-and-forget
  }
}

/** Reset singleton — for testing only */
export function resetEmbeddingProvider(): void {
  _extractor = null;
  _initPromise = null;
}
