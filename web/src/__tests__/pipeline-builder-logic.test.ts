import { test, expect, describe } from "bun:test";

// ---------------------------------------------------------------------------
// Plain-JS recreation of PipelineBuilder.svelte + PipelineStepForm.svelte logic
// Covers: step ordering, pipeline validation, step config validation,
// dependency management (add/remove/toggle), cycle detection,
// and input-pair sync.
// ---------------------------------------------------------------------------

type StepData = {
	name: string;
	agent: string;
	input: Record<string, string>;
	dependsOn: string[];
};

// ── Pipeline validation (handleSubmit) ───────────────────────────────────────
// Mirrors PipelineBuilder.svelte handleSubmit exactly.

function validatePipeline(
	name: string,
	steps: StepData[],
): { error: string } | { error: null; payload: Record<string, unknown> } {
	if (!name.trim()) return { error: "Pipeline name is required" };
	if (steps.length === 0) return { error: "At least one step is required" };
	for (const step of steps) {
		if (!step.name.trim() || !step.agent) {
			return { error: "Each step needs a name and agent" };
		}
	}

	return {
		error: null,
		payload: {
			name: name.trim(),
			steps: steps.map((s) => ({
				name: s.name,
				agent: s.agent,
				...(Object.keys(s.input).length > 0 ? { input: s.input } : {}),
				...(s.dependsOn.length > 0 ? { dependsOn: s.dependsOn } : {}),
			})),
		},
	};
}

describe("PipelineBuilder validation", () => {
	const validStep: StepData = { name: "step-1", agent: "my-agent", input: {}, dependsOn: [] };

	test("rejects empty pipeline name", () => {
		const result = validatePipeline("", [validStep]);
		expect(result.error).toBe("Pipeline name is required");
	});

	test("rejects whitespace-only pipeline name", () => {
		const result = validatePipeline("   ", [validStep]);
		expect(result.error).toBe("Pipeline name is required");
	});

	test("rejects empty steps array", () => {
		const result = validatePipeline("my-pipeline", []);
		expect(result.error).toBe("At least one step is required");
	});

	test("rejects step with empty name", () => {
		const step: StepData = { name: "", agent: "agent-a", input: {}, dependsOn: [] };
		const result = validatePipeline("pl", [step]);
		expect(result.error).toBe("Each step needs a name and agent");
	});

	test("rejects step with whitespace-only name", () => {
		const step: StepData = { name: "  ", agent: "agent-a", input: {}, dependsOn: [] };
		const result = validatePipeline("pl", [step]);
		expect(result.error).toBe("Each step needs a name and agent");
	});

	test("rejects step with no agent selected", () => {
		const step: StepData = { name: "step-1", agent: "", input: {}, dependsOn: [] };
		const result = validatePipeline("pl", [step]);
		expect(result.error).toBe("Each step needs a name and agent");
	});

	test("passes with valid name and steps", () => {
		const result = validatePipeline("my-pipeline", [validStep]);
		expect(result.error).toBeNull();
	});

	test("name is validated before steps", () => {
		const result = validatePipeline("", []);
		expect(result.error).toBe("Pipeline name is required");
	});

	test("steps count validated before per-step check", () => {
		const result = validatePipeline("pl", []);
		expect(result.error).toBe("At least one step is required");
	});
});

// ── Payload construction ─────────────────────────────────────────────────────

describe("PipelineBuilder payload construction", () => {
	test("trims pipeline name", () => {
		const result = validatePipeline("  my-pipeline  ", [
			{ name: "s1", agent: "a", input: {}, dependsOn: [] },
		]);
		expect((result as any).payload?.name).toBe("my-pipeline");
	});

	test("omits input from step when empty", () => {
		const result = validatePipeline("pl", [{ name: "s1", agent: "a", input: {}, dependsOn: [] }]);
		const step = (result as any).payload?.steps[0];
		expect("input" in step).toBe(false);
	});

	test("includes input when non-empty", () => {
		const result = validatePipeline("pl", [
			{ name: "s1", agent: "a", input: { query: "$input.q" }, dependsOn: [] },
		]);
		const step = (result as any).payload?.steps[0];
		expect(step.input).toEqual({ query: "$input.q" });
	});

	test("omits dependsOn from step when empty", () => {
		const result = validatePipeline("pl", [{ name: "s1", agent: "a", input: {}, dependsOn: [] }]);
		const step = (result as any).payload?.steps[0];
		expect("dependsOn" in step).toBe(false);
	});

	test("includes dependsOn when non-empty", () => {
		const result = validatePipeline("pl", [
			{ name: "s1", agent: "a", input: {}, dependsOn: [] },
			{ name: "s2", agent: "b", input: {}, dependsOn: ["s1"] },
		]);
		const steps = (result as any).payload?.steps;
		expect(steps[1].dependsOn).toEqual(["s1"]);
	});

	test("multiple steps are all included in payload", () => {
		const steps: StepData[] = [
			{ name: "s1", agent: "a", input: {}, dependsOn: [] },
			{ name: "s2", agent: "b", input: {}, dependsOn: ["s1"] },
			{ name: "s3", agent: "c", input: { x: "$s2.out" }, dependsOn: ["s1", "s2"] },
		];
		const result = validatePipeline("pl", steps);
		expect((result as any).payload?.steps).toHaveLength(3);
	});
});

// ── Step ordering (addStep / removeStep) ────────────────────────────────────

function addStep(steps: StepData[]): StepData[] {
	return [...steps, { name: `step-${steps.length + 1}`, agent: "", input: {}, dependsOn: [] }];
}

function removeStep(steps: StepData[], idx: number): StepData[] {
	const removedName = steps[idx]!.name;
	const filtered = steps.filter((_, i) => i !== idx);
	// Clean up dependsOn references — mirrors PipelineBuilder.svelte removeStep
	for (const step of filtered) {
		step.dependsOn = step.dependsOn.filter((d) => d !== removedName);
	}
	return filtered;
}

describe("PipelineBuilder step ordering", () => {
	test("addStep appends a step with auto-generated name", () => {
		const steps = addStep([]);
		expect(steps).toHaveLength(1);
		expect(steps[0]?.name).toBe("step-1");
	});

	test("addStep increments name based on current length", () => {
		let steps: StepData[] = [];
		steps = addStep(steps); // step-1
		steps = addStep(steps); // step-2
		steps = addStep(steps); // step-3
		expect(steps[2]?.name).toBe("step-3");
	});

	test("addStep initializes with empty agent, input, and dependsOn", () => {
		const steps = addStep([]);
		expect(steps[0]?.agent).toBe("");
		expect(steps[0]?.input).toEqual({});
		expect(steps[0]?.dependsOn).toEqual([]);
	});

	test("removeStep removes by index", () => {
		const steps: StepData[] = [
			{ name: "s1", agent: "a", input: {}, dependsOn: [] },
			{ name: "s2", agent: "b", input: {}, dependsOn: [] },
			{ name: "s3", agent: "c", input: {}, dependsOn: [] },
		];
		const result = removeStep(steps, 1);
		expect(result).toHaveLength(2);
		expect(result[0]?.name).toBe("s1");
		expect(result[1]?.name).toBe("s3");
	});

	test("removeStep cleans up dependsOn references in remaining steps", () => {
		const steps: StepData[] = [
			{ name: "s1", agent: "a", input: {}, dependsOn: [] },
			{ name: "s2", agent: "b", input: {}, dependsOn: ["s1"] },
			{ name: "s3", agent: "c", input: {}, dependsOn: ["s1", "s2"] },
		];
		const result = removeStep(steps, 0); // remove s1
		expect(result[0]?.dependsOn).toEqual([]); // s2 had ["s1"] -> now []
		expect(result[1]?.dependsOn).toEqual(["s2"]); // s3 had ["s1","s2"] -> now ["s2"]
	});

	test("removeStep on only step returns empty array", () => {
		const steps: StepData[] = [{ name: "s1", agent: "a", input: {}, dependsOn: [] }];
		expect(removeStep(steps, 0)).toEqual([]);
	});

	test("removeStep does not affect steps that don't reference the removed step", () => {
		const steps: StepData[] = [
			{ name: "s1", agent: "a", input: {}, dependsOn: [] },
			{ name: "s2", agent: "b", input: {}, dependsOn: [] },
		];
		const result = removeStep(steps, 0);
		expect(result[0]?.dependsOn).toEqual([]);
	});
});

// ── Step name derivation (allStepNames / otherStepNames) ─────────────────────

describe("PipelineBuilder step name utilities", () => {
	function allStepNames(steps: StepData[]): string[] {
		return steps.map((s) => s.name);
	}

	function otherStepNames(steps: StepData[], currentStepName: string): string[] {
		return allStepNames(steps).filter((n) => n !== currentStepName);
	}

	test("allStepNames returns names in order", () => {
		const steps: StepData[] = [
			{ name: "s1", agent: "a", input: {}, dependsOn: [] },
			{ name: "s2", agent: "b", input: {}, dependsOn: [] },
		];
		expect(allStepNames(steps)).toEqual(["s1", "s2"]);
	});

	test("otherStepNames excludes current step", () => {
		const steps: StepData[] = [
			{ name: "s1", agent: "a", input: {}, dependsOn: [] },
			{ name: "s2", agent: "b", input: {}, dependsOn: [] },
			{ name: "s3", agent: "c", input: {}, dependsOn: [] },
		];
		expect(otherStepNames(steps, "s2")).toEqual(["s1", "s3"]);
	});

	test("otherStepNames on single step returns empty array", () => {
		const steps: StepData[] = [{ name: "s1", agent: "a", input: {}, dependsOn: [] }];
		expect(otherStepNames(steps, "s1")).toEqual([]);
	});
});

// ── Dependency toggle (PipelineStepForm.toggleDep) ───────────────────────────

function toggleDep(dependsOn: string[], depName: string): string[] {
	if (dependsOn.includes(depName)) {
		return dependsOn.filter((d) => d !== depName);
	} else {
		return [...dependsOn, depName];
	}
}

describe("PipelineStepForm dependency toggle", () => {
	test("adds a dependency when not present", () => {
		expect(toggleDep([], "s1")).toEqual(["s1"]);
	});

	test("removes a dependency when already present", () => {
		expect(toggleDep(["s1", "s2"], "s1")).toEqual(["s2"]);
	});

	test("toggles back and forth correctly", () => {
		let deps = toggleDep([], "s1");
		expect(deps).toEqual(["s1"]);
		deps = toggleDep(deps, "s1");
		expect(deps).toEqual([]);
	});

	test("adding multiple dependencies accumulates them", () => {
		let deps: string[] = [];
		deps = toggleDep(deps, "s1");
		deps = toggleDep(deps, "s2");
		deps = toggleDep(deps, "s3");
		expect(deps).toEqual(["s1", "s2", "s3"]);
	});

	test("does not mutate the original array", () => {
		const original = ["s1"];
		toggleDep(original, "s2");
		expect(original).toEqual(["s1"]);
	});
});

// ── Cycle detection ──────────────────────────────────────────────────────────
// PipelineStepForm.otherStepNames already prevents a step depending on itself.
// This block tests a topological-sort cycle detector for deeper cycle analysis.

function hasCycle(steps: StepData[]): boolean {
	const nameSet = new Set(steps.map((s) => s.name));
	const adj: Map<string, string[]> = new Map();
	for (const s of steps) adj.set(s.name, s.dependsOn.filter((d) => nameSet.has(d)));

	const WHITE = 0, GRAY = 1, BLACK = 2;
	const color: Map<string, number> = new Map(steps.map((s) => [s.name, WHITE]));

	function dfs(node: string): boolean {
		color.set(node, GRAY);
		for (const neighbor of adj.get(node) ?? []) {
			if (color.get(neighbor) === GRAY) return true; // back-edge → cycle
			if (color.get(neighbor) === WHITE && dfs(neighbor)) return true;
		}
		color.set(node, BLACK);
		return false;
	}

	for (const s of steps) {
		if (color.get(s.name) === WHITE && dfs(s.name)) return true;
	}
	return false;
}

describe("Pipeline cycle detection", () => {
	test("no dependencies → no cycle", () => {
		const steps: StepData[] = [
			{ name: "s1", agent: "a", input: {}, dependsOn: [] },
			{ name: "s2", agent: "b", input: {}, dependsOn: [] },
		];
		expect(hasCycle(steps)).toBe(false);
	});

	test("linear chain → no cycle", () => {
		const steps: StepData[] = [
			{ name: "s1", agent: "a", input: {}, dependsOn: [] },
			{ name: "s2", agent: "b", input: {}, dependsOn: ["s1"] },
			{ name: "s3", agent: "c", input: {}, dependsOn: ["s2"] },
		];
		expect(hasCycle(steps)).toBe(false);
	});

	test("diamond dependency → no cycle", () => {
		const steps: StepData[] = [
			{ name: "s1", agent: "a", input: {}, dependsOn: [] },
			{ name: "s2", agent: "b", input: {}, dependsOn: ["s1"] },
			{ name: "s3", agent: "c", input: {}, dependsOn: ["s1"] },
			{ name: "s4", agent: "d", input: {}, dependsOn: ["s2", "s3"] },
		];
		expect(hasCycle(steps)).toBe(false);
	});

	test("direct cycle (s1 ↔ s2) → cycle detected", () => {
		const steps: StepData[] = [
			{ name: "s1", agent: "a", input: {}, dependsOn: ["s2"] },
			{ name: "s2", agent: "b", input: {}, dependsOn: ["s1"] },
		];
		expect(hasCycle(steps)).toBe(true);
	});

	test("indirect cycle (s1 → s2 → s3 → s1) → cycle detected", () => {
		const steps: StepData[] = [
			{ name: "s1", agent: "a", input: {}, dependsOn: ["s3"] },
			{ name: "s2", agent: "b", input: {}, dependsOn: ["s1"] },
			{ name: "s3", agent: "c", input: {}, dependsOn: ["s2"] },
		];
		expect(hasCycle(steps)).toBe(true);
	});

	test("dangling dependency reference (to removed step) is ignored", () => {
		// s2 depends on "s1" but s1 is not in the list
		const steps: StepData[] = [
			{ name: "s2", agent: "b", input: {}, dependsOn: ["s1"] },
		];
		expect(hasCycle(steps)).toBe(false);
	});

	test("single step with no deps → no cycle", () => {
		const steps: StepData[] = [{ name: "s1", agent: "a", input: {}, dependsOn: [] }];
		expect(hasCycle(steps)).toBe(false);
	});
});

// ── Input pair sync (PipelineStepForm) ───────────────────────────────────────
// Mirrors the $effect that syncs inputPairs → step.input

type InputPair = { key: string; value: string };

function syncInputPairsToStepInput(inputPairs: InputPair[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const pair of inputPairs) {
		if (pair.key.trim()) result[pair.key.trim()] = pair.value;
	}
	return result;
}

describe("PipelineStepForm input pair sync", () => {
	test("syncs key-value pairs to step input", () => {
		const pairs: InputPair[] = [
			{ key: "query", value: "$input.q" },
			{ key: "limit", value: "10" },
		];
		expect(syncInputPairsToStepInput(pairs)).toEqual({ query: "$input.q", limit: "10" });
	});

	test("skips pairs with empty keys", () => {
		const pairs: InputPair[] = [
			{ key: "", value: "ignored" },
			{ key: "real", value: "val" },
		];
		expect(syncInputPairsToStepInput(pairs)).toEqual({ real: "val" });
	});

	test("skips pairs with whitespace-only keys", () => {
		const pairs: InputPair[] = [{ key: "  ", value: "ignored" }];
		expect(syncInputPairsToStepInput(pairs)).toEqual({});
	});

	test("trims key whitespace", () => {
		const pairs: InputPair[] = [{ key: "  field  ", value: "v" }];
		const result = syncInputPairsToStepInput(pairs);
		expect("field" in result).toBe(true);
		expect("  field  " in result).toBe(false);
	});

	test("empty pairs produce empty object", () => {
		expect(syncInputPairsToStepInput([])).toEqual({});
	});

	test("value is preserved as-is (no trimming)", () => {
		const pairs: InputPair[] = [{ key: "x", value: "  spaced  " }];
		expect(syncInputPairsToStepInput(pairs).x).toBe("  spaced  ");
	});

	test("last duplicate key wins", () => {
		const pairs: InputPair[] = [
			{ key: "x", value: "first" },
			{ key: "x", value: "second" },
		];
		expect(syncInputPairsToStepInput(pairs).x).toBe("second");
	});
});

function addInputPair(pairs: InputPair[]): InputPair[] {
	return [...pairs, { key: "", value: "" }];
}

function removeInputPair(pairs: InputPair[], idx: number): InputPair[] {
	return pairs.filter((_, i) => i !== idx);
}

describe("PipelineStepForm input pair management", () => {
	test("addInputPair appends blank pair", () => {
		const result = addInputPair([]);
		expect(result).toEqual([{ key: "", value: "" }]);
	});

	test("addInputPair preserves existing pairs", () => {
		const existing: InputPair[] = [{ key: "a", value: "1" }];
		const result = addInputPair(existing);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ key: "a", value: "1" });
	});

	test("removeInputPair removes by index", () => {
		const pairs: InputPair[] = [
			{ key: "a", value: "1" },
			{ key: "b", value: "2" },
			{ key: "c", value: "3" },
		];
		const result = removeInputPair(pairs, 1);
		expect(result).toHaveLength(2);
		expect(result[0]?.key).toBe("a");
		expect(result[1]?.key).toBe("c");
	});

	test("removeInputPair on last element returns empty", () => {
		expect(removeInputPair([{ key: "a", value: "1" }], 0)).toEqual([]);
	});
});
