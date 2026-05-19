/**
 * kokoro-tts-worker — runs kokoro-js (ONNX TTS) off the main thread.
 *
 * Why a Worker: `KokoroTTS.from_pretrained(...)` synchronously
 * `WebAssembly.instantiate()`s the ONNX runtime (multi-second main-
 * thread freeze on first call), and `tts.stream(...)` runs ONNX
 * inference synchronously too. Running both inside a Worker keeps the
 * page's event loop responsive — Cmd+R, scroll, click handlers all
 * keep working while synthesis is in flight.
 *
 * Protocol (request → response, all messages carry a correlation `id`):
 *   in:  { type: "synthesize"; id: string; text: string; voice?: string }
 *   out: { type: "loading"; id: string; phase: "model" | "voice" }
 *   out: { type: "ready"; id: string }
 *   out: { type: "audio"; id: string; wav: ArrayBuffer }    // transferable
 *   out: { type: "error"; id: string; message: string }
 *
 * The KokoroTTS instance is module-scoped so the model is loaded
 * exactly once for the worker's lifetime — subsequent syntheses skip
 * straight to inference.
 *
 * Synthesis uses `tts.stream(...)`, NOT `tts.generate(...)`:
 * `generate()` phonemizes the whole input and tokenizes it with
 * `{ truncation: true }`, then `generate_from_ids` hard-clamps to 509
 * tokens — the Kokoro-82M model's ~512-token context window, which is
 * only ~16s of speech. Anything longer is silently dropped. `stream()`
 * splits the text into sentences (each well under the token limit),
 * synthesizes them independently, and yields per-sentence audio; we
 * concatenate the raw PCM and encode one WAV so long inputs play in
 * full.
 */

export type WorkerRequest = {
  type: "synthesize";
  id: string;
  text: string;
  voice?: string;
  speed?: number;
};

export type WorkerResponse =
  | { type: "loading"; id: string; phase: "model" | "voice" }
  | { type: "ready"; id: string }
  | { type: "audio"; id: string; wav: ArrayBuffer }
  | { type: "error"; id: string; message: string };

// ── Model cache ────────────────────────────────────────────────────
// Lazy: only constructed on first synthesize() call. Subsequent calls
// reuse the same instance — kokoro-js's ONNX session is thread-local
// to this worker, so caching here is safe and keeps model-load cost
// to a single up-front hit.
let ttsPromise: Promise<KokoroLike> | null = null;

/**
 * One sentence's worth of synthesized audio. kokoro-js yields a
 * `@huggingface/transformers` `RawAudio` here: `audio` is the mono
 * float PCM, `sampling_rate` is 24000 for Kokoro.
 */
type StreamChunk = {
  text: string;
  phonemes: string;
  audio: { audio: Float32Array; sampling_rate: number };
};

/**
 * kokoro-js's incremental sentence splitter. Passing a raw string to
 * `tts.stream(...)` makes kokoro-js build one of these internally but
 * NEVER call `.close()` on it — its async iterator then awaits a
 * promise that's never resolved and synthesis hangs forever. So we
 * own the splitter explicitly: push the text, `close()`, iterate.
 */
type TextSplitterStreamLike = {
  push: (...texts: string[]) => void;
  close: () => void;
};

type KokoroLike = {
  stream: (
    text: string | TextSplitterStreamLike,
    opts: { voice: string; speed?: number },
  ) => AsyncGenerator<StreamChunk, void, void>;
};

// Captured from the kokoro-js module on first load (same module
// record the model came from — important so the test mock's stub is
// used, not a second import).
let TextSplitterStreamCtor: (new () => TextSplitterStreamLike) | null = null;

async function loadModel(id: string): Promise<KokoroLike> {
  if (ttsPromise) return ttsPromise;
  console.info("[kokoro-tts-flow][worker] loading model", { id });
  postLoading(id, "model");
  ttsPromise = (async () => {
    const mod = await import("kokoro-js");
    const KokoroTTS = (mod as { KokoroTTS: KokoroTtsCtor }).KokoroTTS;
    TextSplitterStreamCtor =
      (mod as { TextSplitterStream?: new () => TextSplitterStreamLike })
        .TextSplitterStream ?? null;
    if (!KokoroTTS || typeof KokoroTTS.from_pretrained !== "function") {
      throw new Error("kokoro-js exports unexpected shape");
    }
    if (typeof TextSplitterStreamCtor !== "function") {
      throw new Error("kokoro-js exports unexpected shape");
    }
    return KokoroTTS.from_pretrained(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      { dtype: "q8", device: "wasm" },
    );
  })();
  try {
    const tts = await ttsPromise;
    console.info("[kokoro-tts-flow][worker] model loaded", { id });
    return tts;
  } catch (err) {
    // Reset so a retry actually re-attempts the load instead of
    // re-throwing the cached failure forever.
    ttsPromise = null;
    throw err;
  }
}

type KokoroTtsCtor = {
  from_pretrained: (
    model: string,
    opts: { dtype: string; device: string },
  ) => Promise<KokoroLike>;
};

function postLoading(id: string, phase: "model" | "voice"): void {
  const msg: WorkerResponse = { type: "loading", id, phase };
  (self as unknown as Worker).postMessage(msg);
}

function postReady(id: string): void {
  const msg: WorkerResponse = { type: "ready", id };
  (self as unknown as Worker).postMessage(msg);
}

function postAudio(id: string, wav: ArrayBuffer): void {
  const msg: WorkerResponse = { type: "audio", id, wav };
  // Transfer the audio buffer so it's not cloned across the
  // postMessage boundary — saves a memcpy on multi-megabyte WAVs.
  (self as unknown as Worker).postMessage(msg, [wav]);
}

function postError(id: string, message: string): void {
  const msg: WorkerResponse = { type: "error", id, message };
  (self as unknown as Worker).postMessage(msg);
}

/**
 * Encode mono float PCM as a 16-bit PCM WAV. We assemble one WAV from
 * the concatenated stream chunks rather than reusing kokoro-js's
 * per-chunk `RawAudio.toWav()` — byte-concatenating multiple WAVs
 * would splice a 44-byte RIFF header into the middle of the stream.
 */
function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const frames = pcm.length;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, frames * 2, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buffer;
}

/**
 * Drive `tts.stream(...)` to completion, concatenating every
 * sentence's PCM into a single WAV. This is the crux of the
 * long-input fix: each yielded chunk is one sentence (under the
 * model's token ceiling), so nothing is truncated and the full text
 * is voiced.
 *
 * We feed an explicit `TextSplitterStream` and `close()` it up front.
 * That `close()` is load-bearing: kokoro-js's async iterator only
 * terminates once the splitter is closed — without it (e.g. passing a
 * raw string, which kokoro-js never closes internally) the loop hangs
 * forever after the last sentence.
 */
async function synthesizeToWav(
  tts: KokoroLike,
  text: string,
  opts: { voice: string; speed?: number },
): Promise<ArrayBuffer> {
  if (!TextSplitterStreamCtor) {
    throw new Error("kokoro-js TextSplitterStream unavailable");
  }
  const splitter = new TextSplitterStreamCtor();
  splitter.push(text);
  splitter.close();

  const chunks: Float32Array[] = [];
  let sampleRate = 24_000;
  for await (const part of tts.stream(splitter, opts)) {
    const ra = part?.audio;
    if (ra?.audio instanceof Float32Array && ra.audio.length > 0) {
      chunks.push(ra.audio);
      if (typeof ra.sampling_rate === "number") sampleRate = ra.sampling_rate;
    }
  }
  if (chunks.length === 0) {
    throw new Error("Synthesis produced no audio");
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return encodeWav(merged, sampleRate);
}

self.addEventListener("message", async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (!msg || msg.type !== "synthesize") return;
  const { id, text, voice = "af_bella", speed } = msg;
  console.info("[kokoro-tts-flow][worker] synthesize request", {
    id,
    textLength: text?.length ?? 0,
    voice,
    speed,
  });
  try {
    if (!text) {
      throw new Error("No text to synthesize");
    }
    const tts = await loadModel(id);
    postReady(id);
    postLoading(id, "voice");
    const wav = await synthesizeToWav(
      tts,
      text,
      typeof speed === "number" ? { voice, speed } : { voice },
    );
    console.info("[kokoro-tts-flow][worker] synthesize ok", {
      id,
      bytes: wav.byteLength,
    });
    postAudio(id, wav);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.info("[kokoro-tts-flow][worker] synthesize error", { id, message });
    postError(id, message);
  }
});
