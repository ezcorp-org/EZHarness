import { test, expect, describe, beforeEach, afterEach } from "bun:test";

/**
 * Tests for the quickstart wizard step detection and persistence.
 *
 * Following the streaming-store.test.ts pattern: replicate step logic
 * as plain functions. localStorage mock from shortcuts.test.ts pattern.
 * These tests define the behavioral contract for the quickstart module.
 */

// --- Interfaces matching planned quickstart module ---

interface StepInput {
	hasProvider: boolean;
	hasConversations: boolean;
	hasExtensions: boolean;
	hasAgents: boolean;
}

interface Step {
	id: string;
	label: string;
	done: boolean;
}

interface QuickStartState {
	dismissed: boolean;
}

// --- Replicated logic ---

function computeSteps(input: StepInput): Step[] {
	return [
		{ id: "provider", label: "Set up a provider", done: input.hasProvider },
		{ id: "chat", label: "Start your first chat", done: input.hasConversations },
		{ id: "extension", label: "Install an extension", done: input.hasExtensions },
		{ id: "agent", label: "Create an agent", done: input.hasAgents },
	];
}

function computeProgress(steps: Step[]): number {
	return steps.filter((s) => s.done).length;
}

const QUICKSTART_KEY = "pi-quickstart";

function saveDismissed(dismissed: boolean): void {
	try {
		const state: QuickStartState = { dismissed };
		localStorage.setItem(QUICKSTART_KEY, JSON.stringify(state));
	} catch {
		// Silently fail if localStorage unavailable
	}
}

function loadDismissed(): boolean {
	try {
		const raw = localStorage.getItem(QUICKSTART_KEY);
		if (!raw) return false;
		const state: QuickStartState = JSON.parse(raw);
		return state.dismissed === true;
	} catch {
		return false;
	}
}

// --- Mock localStorage ---

let storage: Map<string, string>;

function setupStorage() {
	storage = new Map();
	(globalThis as any).localStorage = {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	};
}

function teardownStorage() {
	delete (globalThis as any).localStorage;
}

// --- Tests ---

describe("quickstart steps", () => {
	test("all steps incomplete when no data", () => {
		const steps = computeSteps({
			hasProvider: false,
			hasConversations: false,
			hasExtensions: false,
			hasAgents: false,
		});

		expect(steps).toHaveLength(4);
		expect(steps.every((s) => s.done === false)).toBe(true);
	});

	test("provider step done when hasProvider", () => {
		const steps = computeSteps({
			hasProvider: true,
			hasConversations: false,
			hasExtensions: false,
			hasAgents: false,
		});

		const provider = steps.find((s) => s.id === "provider");
		expect(provider!.done).toBe(true);

		// Others remain incomplete
		expect(steps.filter((s) => s.done)).toHaveLength(1);
	});

	test("all steps done when all data present", () => {
		const steps = computeSteps({
			hasProvider: true,
			hasConversations: true,
			hasExtensions: true,
			hasAgents: true,
		});

		expect(steps.every((s) => s.done === true)).toBe(true);
	});

	test("progress count matches done steps", () => {
		const steps = computeSteps({
			hasProvider: true,
			hasConversations: true,
			hasExtensions: false,
			hasAgents: false,
		});

		expect(computeProgress(steps)).toBe(2);
	});

	test("steps have correct labels", () => {
		const steps = computeSteps({
			hasProvider: false,
			hasConversations: false,
			hasExtensions: false,
			hasAgents: false,
		});

		expect(steps[0].label).toBe("Set up a provider");
		expect(steps[1].label).toBe("Start your first chat");
		expect(steps[2].label).toBe("Install an extension");
		expect(steps[3].label).toBe("Create an agent");
	});

	test("steps have correct ids", () => {
		const steps = computeSteps({
			hasProvider: false,
			hasConversations: false,
			hasExtensions: false,
			hasAgents: false,
		});

		expect(steps.map((s) => s.id)).toEqual(["provider", "chat", "extension", "agent"]);
	});

	test("mixed completion states are tracked independently", () => {
		const steps = computeSteps({
			hasProvider: false,
			hasConversations: true,
			hasExtensions: false,
			hasAgents: true,
		});

		expect(steps[0].done).toBe(false);
		expect(steps[1].done).toBe(true);
		expect(steps[2].done).toBe(false);
		expect(steps[3].done).toBe(true);
		expect(computeProgress(steps)).toBe(2);
	});
});

describe("quickstart persistence", () => {
	beforeEach(() => {
		setupStorage();
	});

	afterEach(() => {
		teardownStorage();
	});

	test("saves dismissed state to localStorage", () => {
		saveDismissed(true);

		const raw = storage.get(QUICKSTART_KEY);
		expect(raw).toBeDefined();
		expect(JSON.parse(raw!)).toEqual({ dismissed: true });
	});

	test("loads dismissed state from localStorage", () => {
		storage.set(QUICKSTART_KEY, JSON.stringify({ dismissed: true }));

		expect(loadDismissed()).toBe(true);
	});

	test("defaults to not dismissed when no localStorage", () => {
		expect(loadDismissed()).toBe(false);
	});

	test("defaults to not dismissed on corrupt data", () => {
		storage.set(QUICKSTART_KEY, "invalid{json");
		expect(loadDismissed()).toBe(false);
	});

	test("saves false dismissal correctly", () => {
		saveDismissed(false);
		expect(loadDismissed()).toBe(false);
	});

	test("round-trips dismiss state", () => {
		saveDismissed(true);
		expect(loadDismissed()).toBe(true);

		saveDismissed(false);
		expect(loadDismissed()).toBe(false);
	});

	test("does not crash when localStorage is unavailable", () => {
		teardownStorage();
		expect(() => saveDismissed(true)).not.toThrow();
		expect(loadDismissed()).toBe(false);
	});
});

describe("quickstart auto-dismiss pattern", () => {
	test("all steps complete should trigger auto-dismiss", () => {
		const steps = computeSteps({
			hasProvider: true,
			hasConversations: true,
			hasExtensions: true,
			hasAgents: true,
		});
		const allDone = steps.every((s) => s.done);
		// When all steps are done, the UI should auto-dismiss
		expect(allDone).toBe(true);
		expect(computeProgress(steps)).toBe(4);
	});

	test("not all steps complete should NOT auto-dismiss", () => {
		const steps = computeSteps({
			hasProvider: true,
			hasConversations: true,
			hasExtensions: false,
			hasAgents: false,
		});
		const allDone = steps.every((s) => s.done);
		expect(allDone).toBe(false);
	});
});

describe("quickstart edge cases", () => {
	test("empty settings object defaults all steps to false", () => {
		// Simulating what happens when settings = {} — all hasX flags would be false
		const input: StepInput = {
			hasProvider: false,
			hasConversations: false,
			hasExtensions: false,
			hasAgents: false,
		};
		const steps = computeSteps(input);
		expect(steps.every((s) => !s.done)).toBe(true);
		expect(computeProgress(steps)).toBe(0);
	});

	test("progress percentage calculation", () => {
		const totalSteps = 4;

		// 0 done = 0%
		expect((computeProgress(computeSteps({
			hasProvider: false, hasConversations: false, hasExtensions: false, hasAgents: false,
		})) / totalSteps) * 100).toBe(0);

		// 1 done = 25%
		expect((computeProgress(computeSteps({
			hasProvider: true, hasConversations: false, hasExtensions: false, hasAgents: false,
		})) / totalSteps) * 100).toBe(25);

		// 2 done = 50%
		expect((computeProgress(computeSteps({
			hasProvider: true, hasConversations: true, hasExtensions: false, hasAgents: false,
		})) / totalSteps) * 100).toBe(50);

		// 3 done = 75%
		expect((computeProgress(computeSteps({
			hasProvider: true, hasConversations: true, hasExtensions: true, hasAgents: false,
		})) / totalSteps) * 100).toBe(75);

		// 4 done = 100%
		expect((computeProgress(computeSteps({
			hasProvider: true, hasConversations: true, hasExtensions: true, hasAgents: true,
		})) / totalSteps) * 100).toBe(100);
	});

	test("computeProgress with empty steps array returns 0", () => {
		expect(computeProgress([])).toBe(0);
	});

	test("computeSteps always returns exactly 4 steps regardless of input", () => {
		const inputs: StepInput[] = [
			{ hasProvider: false, hasConversations: false, hasExtensions: false, hasAgents: false },
			{ hasProvider: true, hasConversations: true, hasExtensions: true, hasAgents: true },
			{ hasProvider: true, hasConversations: false, hasExtensions: true, hasAgents: false },
		];
		for (const input of inputs) {
			expect(computeSteps(input)).toHaveLength(4);
		}
	});

	test("step ids are stable across different inputs", () => {
		const a = computeSteps({ hasProvider: false, hasConversations: false, hasExtensions: false, hasAgents: false });
		const b = computeSteps({ hasProvider: true, hasConversations: true, hasExtensions: true, hasAgents: true });
		expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
	});
});
