/**
 * kokoro-tts-bridge — main-thread façade over the kokoro-tts worker.
 *
 * Owns:
 *   - Lazy worker instantiation (singleton; the first `synthesize()` call
 *     spawns the Worker, subsequent calls reuse it so the model stays
 *     warm across multiple synthesis requests).
 *   - Request → response correlation by `id`. Multiple in-flight
 *     `synthesize()` calls don't collide because each carries its own
 *     id and the worker echoes it back on every response.
 *   - Translation: ArrayBuffer (transferable, cheap to ship) on the
 *     wire → Blob (what the <audio> element + uploadWav() expect) on
 *     the main side.
 *
 * The card calls `synthesize(text, voice?)` and gets a Promise<Blob>.
 * Optional `onLoading(phase)` / `onReady()` callbacks expose the
 * intermediate worker progress events so the card can surface a
 * "Loading model…" state during the first (slow) synthesis.
 *
 * Tests substitute `setWorkerFactoryForTests(...)` to inject a stub
 * Worker — jsdom doesn't ship a real Worker implementation, and even
 * if it did, we don't want kokoro-js running in unit tests.
 */

import type { WorkerRequest, WorkerResponse } from "./kokoro-tts-worker";

export type LoadingPhase = "model" | "voice";

export interface SynthesizeOptions {
  voice?: string;
  /** Playback speed multiplier; 1.0 = natural. Forwarded to kokoro-js. */
  speed?: number;
  /** Fired when the worker reports a long-running phase has begun. */
  onLoading?: (phase: LoadingPhase) => void;
  /** Fired when the model is loaded and inference is about to start. */
  onReady?: () => void;
}

/**
 * Minimal Worker-like interface — what the bridge actually uses.
 * Lets the test harness pass a `MessageChannel`-backed stub that
 * speaks the same protocol without needing a real Worker runtime.
 */
export interface WorkerLike {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  addEventListener: (
    type: "message" | "error" | "messageerror",
    listener: (ev: MessageEvent | ErrorEvent) => void,
  ) => void;
  removeEventListener: (
    type: "message" | "error" | "messageerror",
    listener: (ev: MessageEvent | ErrorEvent) => void,
  ) => void;
  terminate: () => void;
}

type WorkerFactory = () => WorkerLike;

// ── Singleton state ────────────────────────────────────────────────
// Lazy: zero cost until the first synthesize() call. Reusing a single
// Worker across the page's lifetime is a deliberate optimization —
// model load is the expensive step (~80MB of weights + WASM compile),
// so a single warm worker means the first synthesis pays the cost and
// every subsequent one is fast.
let workerInstance: WorkerLike | null = null;
let messageListener: ((ev: MessageEvent | ErrorEvent) => void) | null = null;
let pending = new Map<
  string,
  {
    resolve: (blob: Blob) => void;
    reject: (err: Error) => void;
    onLoading?: (phase: LoadingPhase) => void;
    onReady?: () => void;
  }
>();

let workerFactory: WorkerFactory = defaultWorkerFactory;

function defaultWorkerFactory(): WorkerLike {
  // `new URL(..., import.meta.url)` is the Vite-canonical way to
  // declare a module worker — Vite picks it up at build time and
  // bundles `kokoro-tts-worker.ts` (plus its kokoro-js dynamic
  // import) as a separate worker entry. `type: "module"` is required
  // for the worker's top-level `import "kokoro-js"`.
  const w = new Worker(
    new URL("./kokoro-tts-worker.ts", import.meta.url),
    { type: "module" },
  );
  return w as unknown as WorkerLike;
}

function ensureWorker(): WorkerLike {
  if (workerInstance) return workerInstance;
  console.info("[kokoro-tts-flow][bridge] spawning worker");
  const w = workerFactory();
  messageListener = (ev: MessageEvent | ErrorEvent) => {
    if ("error" in ev || ev.type === "error" || ev.type === "messageerror") {
      // Worker-level error (uncaught throw). Reject every pending
      // promise so callers don't hang forever.
      const errEv = ev as ErrorEvent;
      const message =
        errEv.message ?? "kokoro-tts worker crashed";
      console.info("[kokoro-tts-flow][bridge] worker error", { message });
      for (const [, slot] of pending) {
        slot.reject(new Error(message));
      }
      pending.clear();
      return;
    }
    const msg = (ev as MessageEvent).data as WorkerResponse;
    if (!msg || typeof msg !== "object" || !("type" in msg) || !("id" in msg)) {
      return;
    }
    const slot = pending.get(msg.id);
    if (!slot) return;
    switch (msg.type) {
      case "loading":
        slot.onLoading?.(msg.phase);
        return;
      case "ready":
        slot.onReady?.();
        return;
      case "audio":
        pending.delete(msg.id);
        slot.resolve(new Blob([msg.wav], { type: "audio/wav" }));
        return;
      case "error":
        pending.delete(msg.id);
        slot.reject(new Error(msg.message));
        return;
    }
  };
  w.addEventListener("message", messageListener);
  w.addEventListener("error", messageListener);
  w.addEventListener("messageerror", messageListener);
  workerInstance = w;
  return w;
}

let nextId = 0;
function makeId(): string {
  nextId++;
  return `kts-${Date.now().toString(36)}-${nextId}`;
}

/**
 * Synthesize `text` to a WAV Blob via the kokoro-tts worker. The
 * worker is spawned on first call and reused thereafter. Each call
 * gets its own correlation id so concurrent calls don't collide.
 */
export function synthesize(
  text: string,
  opts: SynthesizeOptions = {},
): Promise<Blob> {
  const w = ensureWorker();
  const id = makeId();
  const promise = new Promise<Blob>((resolve, reject) => {
    pending.set(id, {
      resolve,
      reject,
      onLoading: opts.onLoading,
      onReady: opts.onReady,
    });
  });
  const req: WorkerRequest = {
    type: "synthesize",
    id,
    text,
    voice: opts.voice,
    speed: opts.speed,
  };
  console.info("[kokoro-tts-flow][bridge] synthesize", {
    id,
    textLength: text.length,
    voice: opts.voice,
    speed: opts.speed,
  });
  w.postMessage(req);
  return promise;
}

/**
 * Tear down the worker (for tests + page-unload cleanup). Workers
 * auto-terminate on tab close anyway, so this is mostly here to
 * reset state between unit tests.
 */
export function shutdownWorker(): void {
  if (workerInstance) {
    if (messageListener) {
      workerInstance.removeEventListener("message", messageListener);
      workerInstance.removeEventListener("error", messageListener);
      workerInstance.removeEventListener("messageerror", messageListener);
    }
    workerInstance.terminate();
    workerInstance = null;
    messageListener = null;
  }
  for (const [, slot] of pending) {
    slot.reject(new Error("worker shut down"));
  }
  pending.clear();
}

// ── Test hooks ─────────────────────────────────────────────────────
// Exported under a deliberately ugly name so production code never
// reaches for it by accident.
export function setWorkerFactoryForTests(factory: WorkerFactory | null): void {
  workerFactory = factory ?? defaultWorkerFactory;
  shutdownWorker();
}
