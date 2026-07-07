/**
 * Unit tests for the /settings/models dedupe partition (locked
 * decision 6 — no model id may appear twice on the merged page).
 */
import { describe, test, expect } from "vitest";
import {
	partitionCustomModels,
	hasModelId,
	mergePreferenceOrder,
	DEFAULT_PREFERENCE_ORDER,
	type CustomModelEntry,
} from "./settings-models";

const make = (modelId: string, provider: string): CustomModelEntry => ({
	modelId,
	provider,
	tier: "balanced",
	...(provider === "ollama" ? { baseUrl: "http://localhost:11434" } : {}),
});

describe("partitionCustomModels", () => {
	test("ollama entries go to the provider card, others to the registry", () => {
		const models = [
			make("llama3", "ollama"),
			make("gpt-4-turbo", "openai"),
			make("mistral", "ollama"),
			make("claude-x", "anthropic"),
		];
		const { ollama, registry } = partitionCustomModels(models);
		expect(ollama.map((m) => m.modelId)).toEqual(["llama3", "mistral"]);
		expect(registry.map((m) => m.modelId)).toEqual(["gpt-4-turbo", "claude-x"]);
	});

	test("dedupe invariant: no model id appears in both partitions", () => {
		const models = [
			make("a", "ollama"),
			make("b", "openai"),
			make("c", "google"),
			make("d", "ollama"),
		];
		const { ollama, registry } = partitionCustomModels(models);
		const overlap = ollama.filter((o) => registry.some((r) => r.modelId === o.modelId));
		expect(overlap).toEqual([]);
		// Partition is exhaustive — every entry lands somewhere, exactly once.
		expect(ollama.length + registry.length).toBe(models.length);
	});

	test("empty input → two empty lists", () => {
		expect(partitionCustomModels([])).toEqual({ ollama: [], registry: [] });
	});

	test("all-ollama input leaves the registry empty", () => {
		const { ollama, registry } = partitionCustomModels([make("a", "ollama")]);
		expect(ollama).toHaveLength(1);
		expect(registry).toHaveLength(0);
	});

	test("preserves input order within each partition", () => {
		const models = [make("z", "openai"), make("a", "openai")];
		expect(partitionCustomModels(models).registry.map((m) => m.modelId)).toEqual(["z", "a"]);
	});
});

describe("hasModelId", () => {
	test("matches an existing id under the same provider", () => {
		expect(hasModelId([make("llama3", "ollama")], "llama3")).toBe(true);
	});

	test("cross-provider duplicate: same id under a DIFFERENT provider still blocks", () => {
		// Locked decision 6 — "llama3" registered via openai must block
		// adding "llama3" from the Ollama provider card (and vice versa),
		// otherwise the same id appears twice on the merged page.
		expect(hasModelId([make("llama3", "openai")], "llama3")).toBe(true);
		expect(hasModelId([make("llama3", "ollama")], "llama3")).toBe(true);
	});

	test("unknown id and empty list are not duplicates", () => {
		expect(hasModelId([make("llama3", "ollama")], "mistral")).toBe(false);
		expect(hasModelId([], "llama3")).toBe(false);
	});
});

describe("mergePreferenceOrder", () => {
	test("appends known defaults missing from a stored order (self-heal)", () => {
		// An admin who reordered providers before openrouter existed still gets
		// it appended, so the settings UI can show and route to it.
		expect(mergePreferenceOrder(["anthropic", "openai", "google"])).toEqual([
			"anthropic",
			"openai",
			"google",
			"openrouter",
		]);
	});

	test("preserves a full stored order unchanged (no duplicates)", () => {
		const full = ["google", "anthropic", "openai", "openrouter"];
		expect(mergePreferenceOrder(full)).toEqual(full);
	});

	test("empty stored order yields all defaults", () => {
		expect(mergePreferenceOrder([])).toEqual(DEFAULT_PREFERENCE_ORDER);
	});

	test("keeps unknown stored providers and appends missing defaults", () => {
		expect(mergePreferenceOrder(["ollama", "anthropic"])).toEqual([
			"ollama",
			"anthropic",
			"openai",
			"google",
			"openrouter",
		]);
	});

	test("accepts an explicit defaults list", () => {
		expect(mergePreferenceOrder(["b"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
	});
});

describe("DEFAULT_PREFERENCE_ORDER", () => {
	test("lists the four known providers with openrouter last", () => {
		expect(DEFAULT_PREFERENCE_ORDER).toEqual(["anthropic", "openai", "google", "openrouter"]);
	});
});
