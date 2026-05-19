import { test, expect, describe } from "bun:test";
import {
	LAST_MODEL_KEY,
	persistLastModel,
	restoreLastModel,
	type StorageLike,
} from "$lib/last-model.js";

/** Tiny in-memory Storage stub for tests. */
function memStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
	const data = { ...initial };
	return {
		data,
		getItem: (k) => (k in data ? data[k] : null),
		setItem: (k, v) => {
			data[k] = v;
		},
	};
}

describe("restoreLastModel", () => {
	test("returns null when storage is unavailable", () => {
		expect(restoreLastModel(null)).toBeNull();
		expect(restoreLastModel(undefined)).toBeNull();
	});

	test("returns null when the key is missing", () => {
		expect(restoreLastModel(memStorage())).toBeNull();
	});

	test("returns null for malformed JSON", () => {
		expect(restoreLastModel(memStorage({ [LAST_MODEL_KEY]: "not-json" }))).toBeNull();
	});

	test("returns null when provider or model is missing", () => {
		expect(
			restoreLastModel(memStorage({ [LAST_MODEL_KEY]: JSON.stringify({ provider: "anthropic" }) })),
		).toBeNull();
		expect(
			restoreLastModel(memStorage({ [LAST_MODEL_KEY]: JSON.stringify({ model: "claude-opus-4-6" }) })),
		).toBeNull();
	});

	test("returns null when provider or model is an empty string", () => {
		expect(
			restoreLastModel(
				memStorage({ [LAST_MODEL_KEY]: JSON.stringify({ provider: "", model: "x" }) }),
			),
		).toBeNull();
		expect(
			restoreLastModel(
				memStorage({ [LAST_MODEL_KEY]: JSON.stringify({ provider: "x", model: "" }) }),
			),
		).toBeNull();
	});

	test("returns null when fields are the wrong type", () => {
		expect(
			restoreLastModel(
				memStorage({ [LAST_MODEL_KEY]: JSON.stringify({ provider: 1, model: "x" }) }),
			),
		).toBeNull();
	});

	test("returns the saved selection when well-formed", () => {
		const storage = memStorage({
			[LAST_MODEL_KEY]: JSON.stringify({ provider: "anthropic", model: "claude-opus-4-6" }),
		});
		expect(restoreLastModel(storage)).toEqual({
			provider: "anthropic",
			model: "claude-opus-4-6",
		});
	});

	test("ignores extra unknown fields", () => {
		const storage = memStorage({
			[LAST_MODEL_KEY]: JSON.stringify({
				provider: "openai",
				model: "gpt-5",
				costTier: "high",
				extra: true,
			}),
		});
		expect(restoreLastModel(storage)).toEqual({ provider: "openai", model: "gpt-5" });
	});
});

describe("persistLastModel", () => {
	test("writes JSON under LAST_MODEL_KEY", () => {
		const storage = memStorage();
		persistLastModel(storage, { provider: "anthropic", model: "claude-opus-4-6" });
		expect(storage.data[LAST_MODEL_KEY]).toBe(
			JSON.stringify({ provider: "anthropic", model: "claude-opus-4-6" }),
		);
	});

	test("is a no-op when storage is unavailable", () => {
		expect(() => persistLastModel(null, { provider: "a", model: "b" })).not.toThrow();
		expect(() => persistLastModel(undefined, { provider: "a", model: "b" })).not.toThrow();
	});

	test("round-trips through restoreLastModel", () => {
		const storage = memStorage();
		const sel = { provider: "google", model: "gemini-2-5-pro" };
		persistLastModel(storage, sel);
		expect(restoreLastModel(storage)).toEqual(sel);
	});

	test("overwrites a previous value", () => {
		const storage = memStorage();
		persistLastModel(storage, { provider: "anthropic", model: "claude-sonnet-4-5" });
		persistLastModel(storage, { provider: "anthropic", model: "claude-opus-4-6" });
		expect(restoreLastModel(storage)).toEqual({
			provider: "anthropic",
			model: "claude-opus-4-6",
		});
	});
});

// Simulates the race that caused the bug: ModelSelector finishes loading
// /api/models before loadMessages finishes fetching the conversation. The fix
// is that loadMessages synchronously preloads from localStorage at the top,
// so `selected` is non-null by the time ModelSelector's fetch settles — which
// suppresses its auto-select (and therefore the spurious DB overwrite).
describe("loadMessages preload vs ModelSelector auto-select race", () => {
	/** Mirrors the relevant parent-side state transitions. */
	function simulate(opts: {
		storedInDb: { provider: string; model: string } | null;
		lastModelInStorage: { provider: string; model: string } | null;
		availableModels: { provider: string; model: string }[];
		/**
		 * If true, ModelSelector's fetch resolves before fetchConversation —
		 * the timing window where the original bug fired.
		 */
		autoSelectWinsRace: boolean;
	}) {
		let selectedModel: { provider: string; model: string } | null = null;
		let dbModel = opts.storedInDb ? { ...opts.storedInDb } : null;
		const storage = memStorage(
			opts.lastModelInStorage
				? { [LAST_MODEL_KEY]: JSON.stringify(opts.lastModelInStorage) }
				: {},
		);
		let currentConversation: { provider?: string; model?: string } | null = null;

		// --- loadMessages top: synchronous preload (the fix) ---
		if (!selectedModel) {
			const preload = restoreLastModel(storage);
			if (preload) selectedModel = preload;
		}

		// --- ModelSelector's /api/models fetch finishes in some order ---
		const fireAutoSelect = () => {
			if (selectedModel) return; // guarded — preload suppresses this
			const m = opts.availableModels[0];
			if (!m) return;
			selectedModel = m;
			// The guarded DB write (post-fix): only persist when convo is loaded
			// AND had no stored model.
			if (currentConversation && !currentConversation.model) {
				dbModel = m;
			}
		};

		if (opts.autoSelectWinsRace) {
			fireAutoSelect();
		}

		// --- loadMessages continues after awaits ---
		currentConversation = opts.storedInDb ?? {};
		if (currentConversation.provider && currentConversation.model) {
			selectedModel = {
				provider: currentConversation.provider,
				model: currentConversation.model,
			};
		}

		if (!opts.autoSelectWinsRace) {
			// Late arrival — selectedModel is already populated, so this is a no-op.
			fireAutoSelect();
		}

		return { selectedModel, dbModel };
	}

	const claudeOpus = { provider: "anthropic", model: "claude-opus-4-6" };
	const claudeSonnet = { provider: "anthropic", model: "claude-sonnet-4-5" };
	const haiku = { provider: "anthropic", model: "claude-haiku-4-5" };

	test("existing conversation with stored model survives when auto-select wins the race", () => {
		// Before the fix: auto-select would overwrite dbModel to `haiku` here.
		const { selectedModel, dbModel } = simulate({
			storedInDb: claudeOpus,
			lastModelInStorage: claudeSonnet,
			availableModels: [haiku],
			autoSelectWinsRace: true,
		});
		expect(selectedModel).toEqual(claudeOpus);
		expect(dbModel).toEqual(claudeOpus);
	});

	test("existing conversation with stored model survives when loadMessages wins the race", () => {
		const { selectedModel, dbModel } = simulate({
			storedInDb: claudeOpus,
			lastModelInStorage: claudeSonnet,
			availableModels: [haiku],
			autoSelectWinsRace: false,
		});
		expect(selectedModel).toEqual(claudeOpus);
		expect(dbModel).toEqual(claudeOpus);
	});

	test("new conversation with no stored model falls back to localStorage preference", () => {
		const { selectedModel, dbModel } = simulate({
			storedInDb: null,
			lastModelInStorage: claudeSonnet,
			availableModels: [haiku],
			autoSelectWinsRace: true,
		});
		expect(selectedModel).toEqual(claudeSonnet);
		// No DB overwrite because preload suppressed auto-select entirely.
		expect(dbModel).toBeNull();
	});

	test("new conversation with no stored model and no localStorage falls back to auto-select (auto-select wins race)", () => {
		const { selectedModel, dbModel } = simulate({
			storedInDb: null,
			lastModelInStorage: null,
			availableModels: [haiku],
			autoSelectWinsRace: true,
		});
		expect(selectedModel).toEqual(haiku);
		// DB write is guarded on currentConversation being loaded. When auto-select
		// wins the race, it hasn't loaded yet — so we intentionally skip the write.
		// Correctness over symmetry: the user's explicit pick (handleModelChange)
		// or a later send will persist. Never clobber.
		expect(dbModel).toBeNull();
	});

	test("new conversation with no stored model and no localStorage falls back to auto-select (loadMessages wins race)", () => {
		const { selectedModel, dbModel } = simulate({
			storedInDb: null,
			lastModelInStorage: null,
			availableModels: [haiku],
			autoSelectWinsRace: false,
		});
		expect(selectedModel).toEqual(haiku);
		// loadMessages finished first, so auto-select sees an empty convo and
		// safely persists the default pick.
		expect(dbModel).toEqual(haiku);
	});

	test("brand-new conversation with no models available leaves selection null", () => {
		const { selectedModel, dbModel } = simulate({
			storedInDb: null,
			lastModelInStorage: null,
			availableModels: [],
			autoSelectWinsRace: true,
		});
		expect(selectedModel).toBeNull();
		expect(dbModel).toBeNull();
	});
});
