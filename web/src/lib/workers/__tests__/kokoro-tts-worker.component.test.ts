/**
 * Worker-module unit tests. The kokoro-tts worker is normally loaded
 * inside a `Worker` runtime, but its body is just a module that:
 *   1. Listens for `message` events on `self`.
 *   2. Lazy-loads `kokoro-js` via `import("kokoro-js")`.
 *   3. Posts replies through `self.postMessage(msg, [transfer])`.
 *
 * jsdom provides a `self` global and a `MessageEvent` constructor, so
 * we can exercise the module by importing it (which registers the
 * `message` listener), stubbing `self.postMessage` to capture replies,
 * and dispatching synthetic events. `kokoro-js` is replaced with a
 * vitest mock so we never actually load the ONNX model.
 *
 * Why a `.component.test.ts` extension: vitest's include pattern is
 * gated on it (see vitest.config.ts) and we need the jsdom environment
 * for `self` + `MessageEvent`.
 *
 * Coverage:
 *   - `synthesize` request emits the full sequence:
 *       loading(model) → ready → loading(voice) → audio
 *   - Audio buffer is transferred (passed as the second arg to
 *     postMessage).
 *   - Empty `text` short-circuits to an `error` reply.
 *   - kokoro-js load failure emits an `error` AND clears the cached
 *     promise so a retry actually re-imports.
 *   - `voice` option is forwarded to `tts.stream(...)` (default
 *     `af_bella` when omitted).
 *   - Long multi-sentence input concatenates every stream chunk
 *     (regression: `generate()` truncated at the model's token
 *     ceiling, ~16s of audio).
 *   - Model is loaded ONCE across multiple synthesize calls
 *     (`from_pretrained` mock is invoked exactly once).
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";

// ── kokoro-js mock ────────────────────────────────────────────────
// Bound through closure variables so each test can re-script the
// `from_pretrained` / `stream` behaviour without redefining the
// mock module (vi.mock is hoisted, single-shot per file).

const SAMPLE_RATE = 24_000;

interface StreamChunk {
	text: string;
	phonemes: string;
	audio: { audio: Float32Array; sampling_rate: number };
}

/**
 * Faithful stand-in for kokoro-js's `TextSplitterStream`. This mirrors
 * the real library's async-iterator contract precisely: it only
 * terminates once `close()` is called; while open and drained it
 * awaits a resolver that never fires. That fidelity is the whole
 * point — if the worker regresses (passes a raw string, or forgets to
 * `close()`), draining this never completes and the test fails fast
 * via the `waitForPost` deadline instead of passing trivially.
 */
class FakeSplitter {
	pushed = "";
	closed = false;
	private _sentences: string[] = [];
	private _resolver: (() => void) | null = null;

	push(...texts: string[]): void {
		const joined = texts.join("");
		this.pushed += joined;
		for (const s of joined.split(/(?<=[.!?])\s+/)) {
			const t = s.trim();
			if (t) this._sentences.push(t);
		}
		this._wake();
	}
	close(): void {
		this.closed = true;
		this._wake();
	}
	private _wake(): void {
		const r = this._resolver;
		this._resolver = null;
		r?.();
	}
	async *[Symbol.asyncIterator](): AsyncGenerator<string, void, void> {
		for (;;) {
			if (this._sentences.length > 0) {
				yield this._sentences.shift()!;
				continue;
			}
			if (this.closed) break;
			await new Promise<void>((res) => {
				this._resolver = res;
			});
		}
	}
}

let fromPretrainedImpl: () => Promise<unknown> = async () => makeFakeTts();
// Maps the sentences drained from the (closed) splitter → the audio
// chunks stream() yields. Default: one 100-sample chunk per sentence.
// Tests that pin multi-chunk concatenation re-script this.
let streamImpl: (sentences: string[], opts: { voice: string }) => StreamChunk[] =
	(sentences) => sentences.map(() => makeFakeChunk(new Float32Array(100)));
const fromPretrainedSpy = vi.fn();
const streamSpy = vi.fn();

function makeFakeChunk(samples: Float32Array): StreamChunk {
	// Mirrors @huggingface/transformers RawAudio shape: `audio` is the
	// mono float PCM, `sampling_rate` the rate kokoro-js emits (24kHz).
	return {
		text: "fake",
		phonemes: "feɪk",
		audio: { audio: samples, sampling_rate: SAMPLE_RATE },
	};
}

function makeFakeTts(): {
	stream: (
		input: unknown,
		opts: { voice: string },
	) => AsyncGenerator<StreamChunk, void, void>;
} {
	return {
		stream: (input, opts) => {
			streamSpy(input, opts);
			return (async function* (): AsyncGenerator<StreamChunk, void, void> {
				if (typeof input === "string") {
					// kokoro-js's broken path: a raw string makes it build a
					// splitter it never closes → the real async iterator
					// hangs. Model that as a generator that never yields so
					// the regression fails fast (test deadline) rather than
					// hanging the whole run.
					await new Promise<void>(() => {});
					return;
				}
				const sentences: string[] = [];
				// Draining only completes once the worker closed the
				// splitter — exactly the production termination condition.
				for await (const s of input as AsyncIterable<string>) {
					sentences.push(s);
				}
				for (const chunk of streamImpl(sentences, opts)) {
					yield chunk;
				}
			})();
		},
	};
}

vi.mock("kokoro-js", () => {
	return {
		KokoroTTS: {
			from_pretrained: (model: string, opts: { dtype: string; device: string }) => {
				fromPretrainedSpy(model, opts);
				return fromPretrainedImpl();
			},
		},
		TextSplitterStream: FakeSplitter,
	};
});

// ── self.postMessage capture ──────────────────────────────────────

interface CapturedPost {
	message: unknown;
	transfer?: Transferable[];
}

let posted: CapturedPost[];
let originalPostMessage: typeof self.postMessage;
let originalAddEventListener: typeof self.addEventListener;
// Track the listeners the worker module registers so we can remove
// them between tests — otherwise each fresh `import("../kokoro-tts-worker")`
// stacks another handler on `self`, and a single dispatched message
// fans out across every previously-loaded copy of the worker module.
let trackedListeners: Array<{
	type: string;
	listener: EventListenerOrEventListenerObject;
}>;

beforeEach(() => {
	posted = [];
	trackedListeners = [];
	originalPostMessage = self.postMessage.bind(self);
	originalAddEventListener = self.addEventListener.bind(self);
	// Cast through `unknown` — jsdom's `Window.postMessage` signature
	// (targetOrigin, transfer) doesn't match the worker's
	// (message, transfer) shape, but the worker's call site is what
	// we want to capture verbatim.
	(self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage =
		(message: unknown, transfer?: Transferable[]) => {
			posted.push({ message, transfer });
		};
	// Wrap addEventListener so we can rip the handler out in afterEach.
	(self as unknown as { addEventListener: typeof self.addEventListener }).addEventListener =
		((
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: boolean | AddEventListenerOptions,
		) => {
			trackedListeners.push({ type, listener });
			return originalAddEventListener(
				type as keyof WindowEventMap,
				listener as EventListener,
				options,
			);
		}) as typeof self.addEventListener;

	// Reset mocks for a fresh fixture.
	fromPretrainedSpy.mockReset();
	streamSpy.mockReset();
	fromPretrainedImpl = async () => makeFakeTts();
	streamImpl = (sentences) =>
		sentences.map(() => makeFakeChunk(new Float32Array(100)));
	// Silence the worker's info logs — they're noise in test output.
	vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
	// Tear down handlers the worker module registered.
	for (const { type, listener } of trackedListeners) {
		self.removeEventListener(type, listener as EventListener);
	}
	(self as unknown as { postMessage: typeof originalPostMessage }).postMessage =
		originalPostMessage;
	(
		self as unknown as { addEventListener: typeof originalAddEventListener }
	).addEventListener = originalAddEventListener;
	vi.restoreAllMocks();
});

// ── helper: import the worker module fresh ────────────────────────
// The worker's module-scoped `ttsPromise` cache survives across
// tests in the same file otherwise. `vi.resetModules()` plus a
// dynamic re-import gives each test a clean slate.
async function loadWorker(): Promise<void> {
	vi.resetModules();
	await import("../kokoro-tts-worker");
}

function dispatchSynthesize(data: {
	id: string;
	text: string;
	voice?: string;
}): void {
	self.dispatchEvent(
		new MessageEvent("message", {
			data: { type: "synthesize", ...data },
		}),
	);
}

/** Wait for the worker to post a message of the given type. */
async function waitForPost(predicate: (m: CapturedPost) => boolean): Promise<CapturedPost> {
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		const found = posted.find(predicate);
		if (found) return found;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(
		`timeout waiting for post; saw types: ${posted
			.map((p) => (p.message as { type?: string }).type)
			.join(", ")}`,
	);
}

// ── Tests ─────────────────────────────────────────────────────────

describe("kokoro-tts-worker", () => {
	test("synthesize: posts loading(model) → ready → loading(voice) → audio in order", async () => {
		await loadWorker();
		dispatchSynthesize({ id: "req-1", text: "hello" });

		// Wait for the audio reply — by the time it lands, the earlier
		// progress messages must already be in the buffer (sync push).
		await waitForPost((m) => (m.message as { type: string }).type === "audio");

		const types = posted.map((p) => (p.message as { type: string }).type);
		// Expect this exact subsequence; we don't pin every reply because
		// the worker may add new diagnostic messages over time.
		expect(types[0]).toBe("loading");
		expect((posted[0]!.message as { phase: string }).phase).toBe("model");
		expect(types).toContain("ready");
		// "loading"/"voice" appears AFTER "ready".
		const readyIdx = types.indexOf("ready");
		const voiceLoadingIdx = posted.findIndex(
			(p) =>
				(p.message as { type: string; phase?: string }).type === "loading" &&
				(p.message as { phase?: string }).phase === "voice",
		);
		expect(voiceLoadingIdx).toBeGreaterThan(readyIdx);
		// Audio is last.
		expect(types[types.length - 1]).toBe("audio");
	});

	test("synthesize: audio reply transfers the WAV ArrayBuffer (second arg to postMessage)", async () => {
		await loadWorker();
		dispatchSynthesize({ id: "req-2", text: "hi" });
		const audioPost = await waitForPost(
			(m) => (m.message as { type: string }).type === "audio",
		);
		// `transfer` is the second argument to postMessage. The worker
		// must pass `[wav]` so the ArrayBuffer moves (not copies) across
		// the worker boundary.
		expect(Array.isArray(audioPost.transfer)).toBe(true);
		expect(audioPost.transfer!.length).toBe(1);
		const wav = (audioPost.message as { wav: ArrayBuffer }).wav;
		expect(wav).toBeInstanceOf(ArrayBuffer);
		expect(audioPost.transfer![0]).toBe(wav);
		// Default mock yields one 100-sample chunk → 44-byte header +
		// 16-bit mono PCM. Confirms the worker emits a real WAV.
		expect(wav.byteLength).toBe(44 + 100 * 2);
		const view = new DataView(wav);
		expect(
			String.fromCharCode(
				view.getUint8(0),
				view.getUint8(1),
				view.getUint8(2),
				view.getUint8(3),
			),
		).toBe("RIFF");
	});

	test("empty text → error reply with 'No text to synthesize'", async () => {
		await loadWorker();
		dispatchSynthesize({ id: "req-3", text: "" });
		const errPost = await waitForPost(
			(m) => (m.message as { type: string }).type === "error",
		);
		expect((errPost.message as { message: string }).message).toMatch(
			/No text to synthesize/,
		);
		expect((errPost.message as { id: string }).id).toBe("req-3");
		// from_pretrained must NOT have been called — the empty-text
		// guard runs before the lazy load.
		expect(fromPretrainedSpy).not.toHaveBeenCalled();
	});

	test("kokoro-js load failure → error + cached promise cleared so a retry re-imports", async () => {
		// First load throws; second succeeds.
		let calls = 0;
		fromPretrainedImpl = async () => {
			calls++;
			if (calls === 1) throw new Error("model unavailable");
			return makeFakeTts();
		};

		await loadWorker();
		dispatchSynthesize({ id: "req-4a", text: "hi" });
		const errPost = await waitForPost(
			(m) => (m.message as { type: string }).type === "error",
		);
		expect((errPost.message as { message: string }).message).toMatch(
			/model unavailable/,
		);

		// Retry — second call should re-attempt `from_pretrained`. If the
		// worker had cached the rejected promise, this would short-circuit
		// to the same error forever.
		dispatchSynthesize({ id: "req-4b", text: "hi" });
		await waitForPost(
			(m) =>
				(m.message as { type: string; id?: string }).type === "audio" &&
				(m.message as { id?: string }).id === "req-4b",
		);
		expect(fromPretrainedSpy).toHaveBeenCalledTimes(2);
	});

	test("text is pushed into a CLOSED splitter; voice forwarded to tts.stream", async () => {
		await loadWorker();
		dispatchSynthesize({ id: "req-5", text: "hi", voice: "af_sarah" });
		await waitForPost(
			(m) => (m.message as { type: string }).type === "audio",
		);
		expect(streamSpy).toHaveBeenCalledTimes(1);
		// The worker must hand stream() a TextSplitterStream (NOT a raw
		// string — kokoro-js never closes the latter and hangs forever).
		const splitter = streamSpy.mock.calls[0]?.[0] as FakeSplitter;
		expect(splitter).toBeInstanceOf(FakeSplitter);
		expect(splitter.pushed).toBe("hi");
		// close() is load-bearing: without it the stream never ends.
		expect(splitter.closed).toBe(true);
		expect((streamSpy.mock.calls[0]?.[1] as { voice: string }).voice).toBe(
			"af_sarah",
		);
	});

	test("voice defaults to 'af_bella' when omitted", async () => {
		await loadWorker();
		dispatchSynthesize({ id: "req-6", text: "hi" });
		await waitForPost(
			(m) => (m.message as { type: string }).type === "audio",
		);
		expect((streamSpy.mock.calls[0]?.[1] as { voice: string }).voice).toBe(
			"af_bella",
		);
	});

	test("model is loaded ONCE across multiple synthesize calls (warm cache)", async () => {
		await loadWorker();
		dispatchSynthesize({ id: "req-7a", text: "first" });
		await waitForPost(
			(m) =>
				(m.message as { type: string; id?: string }).type === "audio" &&
				(m.message as { id?: string }).id === "req-7a",
		);
		dispatchSynthesize({ id: "req-7b", text: "second" });
		await waitForPost(
			(m) =>
				(m.message as { type: string; id?: string }).type === "audio" &&
				(m.message as { id?: string }).id === "req-7b",
		);
		// `from_pretrained` was called once total — the second synthesize
		// reused the cached `ttsPromise`.
		expect(fromPretrainedSpy).toHaveBeenCalledTimes(1);
		// stream() was called once per synthesize.
		expect(streamSpy).toHaveBeenCalledTimes(2);
	});

	// ── Regression: long input must not truncate at ~16s ──────────────
	// Bug: the worker called `tts.generate(text)`, which tokenizes with
	// `{ truncation: true }` and clamps to the model's ~510-token
	// window — anything past ~16s of speech was silently dropped. Fix:
	// drive `tts.stream(...)` and concatenate every sentence's PCM into
	// one WAV. This test pins the reproduction → fix: a 3-sentence
	// input yields 3 stream chunks and the emitted WAV must contain the
	// concatenation of ALL of them, not just the first.
	test("long multi-sentence input concatenates every stream chunk (no 16s cutoff)", async () => {
		const lens = [40_000, 55_000, 33_000]; // sentence PCM sample counts
		// Distinct constant per chunk so a truncated/duplicated result
		// can't accidentally match the expected total length.
		streamImpl = () =>
			lens.map((n) => makeFakeChunk(new Float32Array(n).fill(0.25)));

		await loadWorker();
		dispatchSynthesize({ id: "req-long", text: "One. Two. Three." });
		const audioPost = await waitForPost(
			(m) => (m.message as { type: string }).type === "audio",
		);

		const wav = (audioPost.message as { wav: ArrayBuffer }).wav;
		const totalFrames = lens.reduce((a, b) => a + b, 0);
		// 44-byte RIFF header + 16-bit mono PCM for the FULL concatenation.
		expect(wav.byteLength).toBe(44 + totalFrames * 2);

		const view = new DataView(wav);
		// RIFF/WAVE magic — proves we emit one well-formed WAV, not a
		// byte-spliced concat of per-chunk WAVs.
		expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe("RIFF");
		expect(view.getUint32(40, true)).toBe(totalFrames * 2); // data chunk size
		// First chunk alone would be 44 + 40_000*2 = 80_044 bytes; the
		// emitted buffer is strictly larger, proving no early cutoff.
		expect(wav.byteLength).toBeGreaterThan(44 + lens[0]! * 2);
	});
});
