/**
 * Deterministic browser-only Kokoro Worker seam. It replaces the ONNX audio
 * encoder only; callers still exercise the application event, upload, save,
 * authorization, and persistence routes.
 */
import type { Page } from "@playwright/test";

// Replaces `window.Worker` BEFORE the page boots so the kokoro-tts-bridge
// (which spawns its worker lazily on first synthesize() call via
// `new Worker(new URL(..., import.meta.url), { type: "module" })`) gets
// our stub instead of trying to load the real kokoro-js bundle.
//
// The stub speaks the same wire protocol as `kokoro-tts-worker.ts`:
//   request:  { type: "synthesize", id, text, voice }
//   response: { type: "loading", id, phase } | { type: "ready", id }
//             | { type: "audio", id, wav: ArrayBuffer }
//             | { type: "error", id, message }
//
// Behavior is configurable via `window.__kokoroStub`:
//   - calls            : array of { text, voice, speed, id } captured per
//                        postMessage. Specs assert on this to prove the
//                        bridge actually invoked the worker (or didn't —
//                        e.g. on reload, where the persisted attachment
//                        should bypass synthesis entirely).
//   - failNextN        : count of synthesize() calls to fail before
//                        succeeding. Drives the retry-path spec.
//   - failureMessage   : error message string. Defaults to
//                        "synthesis failed: stub".
export interface KokoroStubOptions {
  failNextN?: number;
  failureMessage?: string;
}

export async function installKokoroWorkerStub(page: Page, options: KokoroStubOptions = {}): Promise<void> {
  await page.addInitScript((initial: KokoroStubOptions) => {
    const w = window as unknown as Record<string, unknown>;
    w.__kokoroStub = {
      calls: [] as Array<{ text: string; voice: string | undefined; speed: number | undefined; id: string }>,
      failNextN: initial.failNextN ?? 0,
      failureMessage: initial.failureMessage ?? "synthesis failed: stub",
    };
    // 4-byte ArrayBuffer is enough — the card wraps it as a Blob and the
    // <audio> element doesn't try to actually decode it in this spec.
    function makeFakeWav(): ArrayBuffer {
      return new Uint8Array([0, 0, 0, 0]).buffer;
    }

    class StubWorker {
      private listeners: Record<string, Array<(e: Event) => void>> = {
        message: [],
        error: [],
        messageerror: [],
      };
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      onmessageerror: ((e: Event) => void) | null = null;

      postMessage(msg: unknown): void {
        const stub = (window as unknown as { __kokoroStub: {
          calls: Array<{ text: string; voice: string | undefined; speed: number | undefined; id: string }>;
          failNextN: number;
          failureMessage: string;
        } }).__kokoroStub;
        if (
          msg == null ||
          typeof msg !== "object" ||
          (msg as Record<string, unknown>).type !== "synthesize"
        ) return;
        const req = msg as { type: "synthesize"; id: string; text: string; voice?: string; speed?: number };
        stub.calls.push({ text: req.text, voice: req.voice, speed: req.speed, id: req.id });

        const dispatch = (data: unknown) => {
          const ev = new MessageEvent("message", { data });
          this.onmessage?.(ev);
          for (const fn of this.listeners.message ?? []) fn(ev);
        };

        // Microtask cadence: loading → ready → audio (or error). Mirrors
        // the real worker enough that the card walks through its
        // "Loading model…" → "Synthesizing…" → "audio plays" states.
        queueMicrotask(() => {
          if (stub.failNextN > 0) {
            stub.failNextN--;
            dispatch({ type: "error", id: req.id, message: stub.failureMessage });
            return;
          }
          dispatch({ type: "loading", id: req.id, phase: "model" });
          queueMicrotask(() => {
            dispatch({ type: "ready", id: req.id });
            queueMicrotask(() => {
              dispatch({ type: "audio", id: req.id, wav: makeFakeWav() });
            });
          });
        });
      }

      addEventListener(type: string, fn: (e: Event) => void): void {
        (this.listeners[type] ??= []).push(fn);
      }
      removeEventListener(type: string, fn: (e: Event) => void): void {
        const arr = this.listeners[type];
        if (arr) this.listeners[type] = arr.filter((f) => f !== fn);
      }
      terminate(): void {}
    }
    (window as unknown as { Worker: unknown }).Worker = StubWorker as unknown;
  }, options);
}

