/**
 * Unit tests for the /settings/models dedupe partition (locked
 * decision 6 — no model id may appear twice on the merged page).
 */
import { describe, test, expect } from "vitest";
import { partitionCustomModels, type CustomModelEntry } from "./settings-models";

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
