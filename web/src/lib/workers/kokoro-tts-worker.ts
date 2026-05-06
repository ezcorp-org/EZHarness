/**
 * kokoro-tts-worker — runs kokoro-js (ONNX TTS) off the main thread.
 *
 * Why a Worker: `KokoroTTS.from_pretrained(...)` synchronously
 * `WebAssembly.instantiate()`s the ONNX runtime (multi-second main-
 * thread freeze on first call), and `tts.generate(...)` runs ONNX
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

type KokoroLike = {
  generate: (
    text: string,
    opts: { voice: string; speed?: number },
  ) => Promise<RawAudioLike>;
};

type RawAudioLike = {
  toBlob?: () => Blob;
  toWav?: () => ArrayBuffer | Blob;
};

async function loadModel(id: string): Promise<KokoroLike> {
  if (ttsPromise) return ttsPromise;
  console.info("[kokoro-tts-flow][worker] loading model", { id });
  postLoading(id, "model");
  ttsPromise = (async () => {
    const mod = await import("kokoro-js");
    const KokoroTTS = (mod as { KokoroTTS: KokoroTtsCtor }).KokoroTTS;
    if (!KokoroTTS || typeof KokoroTTS.from_pretrained !== "function") {
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
 * Convert kokoro-js's RawAudio to a transferable ArrayBuffer. Mirrors
 * the probing logic from the original card — kokoro-js exposes either
 * `toBlob(): Blob` or `toWav(): ArrayBuffer | Blob` depending on the
 * version, so we try both.
 */
async function rawAudioToArrayBuffer(audio: unknown): Promise<ArrayBuffer> {
  if (audio == null) throw new Error("Synthesis returned null");
  const a = audio as RawAudioLike;
  if (typeof a.toBlob === "function") {
    const b = a.toBlob();
    if (b instanceof Blob) return await b.arrayBuffer();
  }
  if (typeof a.toWav === "function") {
    const wav = a.toWav();
    if (wav instanceof Blob) return await wav.arrayBuffer();
    if (wav instanceof ArrayBuffer) return wav;
  }
  throw new Error("RawAudio shape unrecognized — cannot extract WAV");
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
    const audio = await tts.generate(
      text,
      typeof speed === "number" ? { voice, speed } : { voice },
    );
    const wav = await rawAudioToArrayBuffer(audio);
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
