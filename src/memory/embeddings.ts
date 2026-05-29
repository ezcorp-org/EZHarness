// Local embedding generation using Transformers.js (all-MiniLM-L6-v2)
import { pipeline, type FeatureExtractionPipeline, type PreTrainedTokenizer } from "@huggingface/transformers";
import { EMBEDDING_DIMENSIONS } from "./types";

/**
 * Single source of truth for embedder identity. Encodes both the model and
 * its 384-dim vector width so a future model/dim swap is a plain string
 * compare (IDX-03). Later plans import this — never re-literal the id.
 */
export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2@384";

let _extractor: FeatureExtractionPipeline | null = null;
let _initPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(onProgress?: (message: string) => void): Promise<FeatureExtractionPipeline> {
  if (_extractor) return _extractor;
  if (!_initPromise) {
    onProgress?.("Initializing embedding model...");
    _initPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
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
        // on the extractor call options in @huggingface/transformers v3, so the
        // type-safe, input-only way to enforce the 256-token cap is to set
        // model_max_length on the loaded tokenizer once, here. This repairs the
        // prior silent over-length truncation that degraded both memories and
        // knowledge_base_chunks. Input-only — we never touch model.maxTokens or
        // char-slice the string (CLAUDE.md context-compaction invariant).
        _extractor.tokenizer.model_max_length = 256;
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
  // tokenizer.model_max_length = 256 (IDX-06); the extractor's internal
  // tokenize call honors it. The call options below are the only ones the
  // FeatureExtractionPipeline accepts.
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
