/**
 * Bridge unit tests. The bridge owns the request/response correlation
 * for the kokoro-tts worker — these tests pin its contract without
 * spinning up a real Worker (jsdom doesn't ship one, and we don't
 * want kokoro-js running in unit tests anyway).
 *
 * Strategy: inject a stub `WorkerLike` via `setWorkerFactoryForTests`.
 * The stub keeps a single `messageListener` reference and offers a
 * `respond(...)` helper so each test scripts the worker's reply in
 * line with the assertion. This is the same shape as the real
 * `Worker` for the surface the bridge actually exercises
 * (`postMessage`, `addEventListener`, `removeEventListener`,
 * `terminate`).
 *
 * Coverage:
 *   - `synthesize` resolves with the audio Blob from the worker reply
 *   - Multiple concurrent `synthesize` calls are correlated by id
 *   - Worker error response rejects only the matching promise
 *   - Worker is instantiated once and reused across calls
 *   - Bridge posts the audio buffer as a transferable
 *   - `onLoading` / `onReady` callbacks fire on intermediate events
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  synthesize,
  setWorkerFactoryForTests,
  shutdownWorker,
  type WorkerLike,
} from "../kokoro-tts-bridge";

// ── Stub Worker ────────────────────────────────────────────────────

type Listener = (ev: MessageEvent | ErrorEvent) => void;

interface StubWorker extends WorkerLike {
  /** Last `postMessage` payload, for assertions. */
  lastPosted: { message: unknown; transfer?: Transferable[] }[];
  /** Synthetically deliver a message FROM the worker TO the bridge. */
  respond: (data: unknown) => void;
  /** Synthetically deliver an error event. */
  raiseError: (message: string) => void;
  /** True once `terminate()` has been called. */
  terminated: boolean;
  /** Counter — instances created via the factory. */
}

let stubInstancesCreated: number;
let currentStub: StubWorker | null;

function makeStubWorker(): StubWorker {
  const listeners: Record<string, Listener[]> = {
    message: [],
    error: [],
    messageerror: [],
  };
  const stub: StubWorker = {
    lastPosted: [],
    terminated: false,
    postMessage(message: unknown, transfer?: Transferable[]) {
      this.lastPosted.push({ message, transfer });
    },
    addEventListener(type: string, listener: Listener) {
      listeners[type]?.push(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      const arr = listeners[type];
      if (!arr) return;
      const idx = arr.indexOf(listener);
      if (idx >= 0) arr.splice(idx, 1);
    },
    terminate() {
      this.terminated = true;
    },
    respond(data: unknown) {
      const ev = { data, type: "message" } as unknown as MessageEvent;
      for (const l of listeners.message) l(ev);
    },
    raiseError(message: string) {
      const ev = { message, type: "error" } as unknown as ErrorEvent;
      for (const l of listeners.error) l(ev);
    },
  };
  return stub;
}

beforeEach(() => {
  stubInstancesCreated = 0;
  currentStub = null;
  setWorkerFactoryForTests(() => {
    stubInstancesCreated++;
    currentStub = makeStubWorker();
    return currentStub;
  });
});

afterEach(() => {
  shutdownWorker();
  setWorkerFactoryForTests(null);
});

// Helpers ─ unwrap the `id` the bridge generated for the latest post.
function lastPostedRequest(): {
  type: string;
  id: string;
  text: string;
  voice?: string;
} {
  const w = currentStub;
  if (!w) throw new Error("no stub worker");
  const last = w.lastPosted[w.lastPosted.length - 1];
  if (!last) throw new Error("no posted messages");
  return last.message as {
    type: string;
    id: string;
    text: string;
    voice?: string;
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("kokoro-tts-bridge", () => {
  test("synthesize resolves with a Blob built from the worker's audio buffer", async () => {
    const promise = synthesize("hello");
    const req = lastPostedRequest();
    expect(req.type).toBe("synthesize");
    expect(req.text).toBe("hello");
    expect(typeof req.id).toBe("string");

    const wav = new Uint8Array([1, 2, 3, 4]).buffer;
    currentStub!.respond({ type: "audio", id: req.id, wav });

    const blob = await promise;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/wav");
    const buf = await blob.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("multiple concurrent synthesize calls are correlated by id", async () => {
    const a = synthesize("first");
    const aReq = lastPostedRequest();
    const b = synthesize("second");
    const bReq = lastPostedRequest();
    expect(aReq.id).not.toBe(bReq.id);

    // Reply to b first to prove the bridge isn't FIFO-coupling them.
    currentStub!.respond({
      type: "audio",
      id: bReq.id,
      wav: new Uint8Array([0xb]).buffer,
    });
    currentStub!.respond({
      type: "audio",
      id: aReq.id,
      wav: new Uint8Array([0xa]).buffer,
    });

    const [aBlob, bBlob] = await Promise.all([a, b]);
    expect(new Uint8Array(await aBlob.arrayBuffer())).toEqual(
      new Uint8Array([0xa]),
    );
    expect(new Uint8Array(await bBlob.arrayBuffer())).toEqual(
      new Uint8Array([0xb]),
    );
  });

  test("worker error response rejects only the matching promise", async () => {
    const a = synthesize("first");
    const aReq = lastPostedRequest();
    const b = synthesize("second");
    const bReq = lastPostedRequest();

    currentStub!.respond({
      type: "error",
      id: aReq.id,
      message: "kokoro went boom",
    });

    await expect(a).rejects.toThrow(/kokoro went boom/);

    // b is still pending, awaiting its own response.
    currentStub!.respond({
      type: "audio",
      id: bReq.id,
      wav: new Uint8Array([1]).buffer,
    });
    const bBlob = await b;
    expect(bBlob).toBeInstanceOf(Blob);
  });

  test("worker is instantiated once and reused across calls", async () => {
    const a = synthesize("one");
    expect(stubInstancesCreated).toBe(1);
    currentStub!.respond({
      type: "audio",
      id: lastPostedRequest().id,
      wav: new Uint8Array([1]).buffer,
    });
    await a;

    const b = synthesize("two");
    expect(stubInstancesCreated).toBe(1); // still one — same worker reused
    currentStub!.respond({
      type: "audio",
      id: lastPostedRequest().id,
      wav: new Uint8Array([2]).buffer,
    });
    await b;
  });

  test("bridge posts the audio request without a transfer list (worker is the one transferring back)", () => {
    // Suppress the dangling-promise rejection — afterEach's
    // shutdownWorker() rejects every still-pending synthesize() call,
    // and we don't await this one (the test only inspects the
    // outbound message shape).
    synthesize("hello").catch(() => {});
    const w = currentStub!;
    const last = w.lastPosted[w.lastPosted.length - 1]!;
    // Inbound request has no transferables — the buffers go the other
    // direction (worker → main) on the response, where the worker
    // calls `postMessage(msg, [wav])`.
    expect(last.transfer).toBeUndefined();
  });

  test("loading + ready events fire the bridge callbacks before audio resolves", async () => {
    const phases: string[] = [];
    let readyCount = 0;
    const promise = synthesize("hello", {
      onLoading: (p) => phases.push(p),
      onReady: () => {
        readyCount++;
      },
    });
    const id = lastPostedRequest().id;

    currentStub!.respond({ type: "loading", id, phase: "model" });
    currentStub!.respond({ type: "ready", id });
    currentStub!.respond({ type: "loading", id, phase: "voice" });
    currentStub!.respond({
      type: "audio",
      id,
      wav: new Uint8Array([1]).buffer,
    });

    await promise;
    expect(phases).toEqual(["model", "voice"]);
    expect(readyCount).toBe(1);
  });

  test("worker-level error event rejects all pending promises", async () => {
    const a = synthesize("first");
    const b = synthesize("second");
    currentStub!.raiseError("worker died");

    await expect(a).rejects.toThrow(/worker died/);
    await expect(b).rejects.toThrow(/worker died/);
  });

  test("voice option is forwarded to the worker", () => {
    synthesize("hello", { voice: "af_sarah" }).catch(() => {});
    const req = lastPostedRequest();
    expect(req.voice).toBe("af_sarah");
  });

  // Regression: assistant content is raw markdown. The worker (and
  // kokoro-js) speak the literal string, so the bridge MUST strip
  // markdown here — the single chokepoint — or TTS reads "asterisk
  // asterisk", spells out URLs, and recites code fences.
  test("markdown is stripped before reaching the worker", () => {
    synthesize(
      "# Title\n\nSay **this** and see [docs](https://x.com).\n\n- one\n- two\n\n```ts\ncode();\n```",
    ).catch(() => {});
    const req = lastPostedRequest();
    // No structural markdown punctuation in what the worker receives.
    expect(req.text).not.toMatch(/[#*`]/);
    expect(req.text).not.toContain("](http");
    expect(req.text).not.toContain("x.com");
    expect(req.text).not.toContain("code()");
    // Spoken content survived.
    expect(req.text).toContain("Title");
    expect(req.text).toContain("Say this and see docs");
    expect(req.text).toContain("one");
    expect(req.text).toContain("two");
  });
});
