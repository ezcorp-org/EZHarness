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
 *   - `voice` option is forwarded to `tts.generate(...)` (default
 *     `af_bella` when omitted).
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
// `from_pretrained` / `generate` behaviour without redefining the
// mock module (vi.mock is hoisted, single-shot per file).

let fromPretrainedImpl: () => Promise<unknown> = async () => makeFakeTts();
let generateImpl: (text: string, opts: { voice: string }) => Promise<unknown> =
	async (_text, _opts) => makeFakeRawAudio();
const fromPretrainedSpy = vi.fn();
const generateSpy = vi.fn();

function makeFakeRawAudio(): {
	toBlob: () => Blob;
} {
	// 8-byte fake WAV — enough to verify bytes round-trip into a
	// transferable ArrayBuffer.
	const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
	return {
		toBlob: () => new Blob([bytes], { type: "audio/wav" }),
	};
}

function makeFakeTts(): {
	generate: (text: string, opts: { voice: string }) => Promise<unknown>;
} {
	return {
		generate: (text, opts) => {
			generateSpy(text, opts);
			return generateImpl(text, opts);
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
	generateSpy.mockReset();
	fromPretrainedImpl = async () => makeFakeTts();
	generateImpl = async () => makeFakeRawAudio();
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

	test("voice option is forwarded to tts.generate(text, { voice })", async () => {
		await loadWorker();
		dispatchSynthesize({ id: "req-5", text: "hi", voice: "af_sarah" });
		await waitForPost(
			(m) => (m.message as { type: string }).type === "audio",
		);
		expect(generateSpy).toHaveBeenCalledTimes(1);
		expect(generateSpy.mock.calls[0]?.[0]).toBe("hi");
		expect((generateSpy.mock.calls[0]?.[1] as { voice: string }).voice).toBe(
			"af_sarah",
		);
	});

	test("voice defaults to 'af_bella' when omitted", async () => {
		await loadWorker();
		dispatchSynthesize({ id: "req-6", text: "hi" });
		await waitForPost(
			(m) => (m.message as { type: string }).type === "audio",
		);
		expect((generateSpy.mock.calls[0]?.[1] as { voice: string }).voice).toBe(
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
		// Generate was called once per synthesize.
		expect(generateSpy).toHaveBeenCalledTimes(2);
	});
});
