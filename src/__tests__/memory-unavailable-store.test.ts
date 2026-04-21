import { test, expect, describe } from "bun:test";

/**
 * Tests for memoryUnavailableRunId auto-recovery logic and
 * chat page warning-once-per-run behavior.
 *
 * These test the pure state-machine logic extracted from:
 *   - web/src/lib/stores.svelte.ts (lines 234-243)
 *   - web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte (lines 41-48)
 */

// Mirrors the run:status handler in stores.svelte.ts
function handleRunStatus(
	state: { memoryUnavailableRunId: string | null },
	runId: string,
	status: string,
) {
	if (status === "memory_unavailable") {
		state.memoryUnavailableRunId = runId;
	} else if (state.memoryUnavailableRunId !== null) {
		state.memoryUnavailableRunId = null;
	}
}

// Mirrors the $effect logic in +page.svelte
function shouldShowWarning(
	failedRunId: string | null,
	shownForRun: string | null,
): boolean {
	return failedRunId !== null && failedRunId !== shownForRun;
}

describe("memoryUnavailableRunId state management", () => {
	test("memory_unavailable status sets the runId", () => {
		const state = { memoryUnavailableRunId: null as string | null };
		handleRunStatus(state, "run-1", "memory_unavailable");
		expect(state.memoryUnavailableRunId).toBe("run-1");
	});

	test("non-memory_unavailable status clears the flag (auto-recovery)", () => {
		const state = { memoryUnavailableRunId: "run-1" as string | null };
		handleRunStatus(state, "run-1", "completed");
		expect(state.memoryUnavailableRunId).toBeNull();
	});

	test("null stays null when a non-memory_unavailable status arrives", () => {
		const state = { memoryUnavailableRunId: null as string | null };
		handleRunStatus(state, "run-2", "running");
		expect(state.memoryUnavailableRunId).toBeNull();
	});

	test("multiple memory_unavailable events track the latest runId", () => {
		const state = { memoryUnavailableRunId: null as string | null };
		handleRunStatus(state, "run-1", "memory_unavailable");
		expect(state.memoryUnavailableRunId).toBe("run-1");

		handleRunStatus(state, "run-2", "memory_unavailable");
		expect(state.memoryUnavailableRunId).toBe("run-2");
	});

	test("full lifecycle: fail -> recover -> fail again -> recover", () => {
		const state = { memoryUnavailableRunId: null as string | null };

		handleRunStatus(state, "run-1", "memory_unavailable");
		expect(state.memoryUnavailableRunId).toBe("run-1");

		handleRunStatus(state, "run-1", "completed");
		expect(state.memoryUnavailableRunId).toBeNull();

		handleRunStatus(state, "run-3", "memory_unavailable");
		expect(state.memoryUnavailableRunId).toBe("run-3");

		handleRunStatus(state, "run-3", "running");
		expect(state.memoryUnavailableRunId).toBeNull();
	});

	test("recovery triggered by a different runId status event", () => {
		const state = { memoryUnavailableRunId: "run-1" as string | null };
		// A status event from a different run still clears the flag
		handleRunStatus(state, "run-2", "completed");
		expect(state.memoryUnavailableRunId).toBeNull();
	});
});

describe("chat page warning-once-per-run logic", () => {
	test("shows warning when a new runId fails", () => {
		expect(shouldShowWarning("run-1", null)).toBe(true);
	});

	test("does not show warning for the same runId twice", () => {
		expect(shouldShowWarning("run-1", "run-1")).toBe(false);
	});

	test("shows warning again for a different failed runId", () => {
		expect(shouldShowWarning("run-2", "run-1")).toBe(true);
	});

	test("does not show warning when no run has failed", () => {
		expect(shouldShowWarning(null, null)).toBe(false);
		expect(shouldShowWarning(null, "run-1")).toBe(false);
	});

	test("end-to-end: state machine drives warning decisions", () => {
		const state = { memoryUnavailableRunId: null as string | null };
		let shownForRun: string | null = null;

		// Run 1 fails
		handleRunStatus(state, "run-1", "memory_unavailable");
		if (shouldShowWarning(state.memoryUnavailableRunId, shownForRun)) {
			shownForRun = state.memoryUnavailableRunId;
		}
		expect(shownForRun).toBe("run-1");

		// Same run still failing - no duplicate warning
		expect(shouldShowWarning(state.memoryUnavailableRunId, shownForRun)).toBe(false);

		// Run 1 recovers
		handleRunStatus(state, "run-1", "completed");
		expect(state.memoryUnavailableRunId).toBeNull();
		expect(shouldShowWarning(state.memoryUnavailableRunId, shownForRun)).toBe(false);

		// Run 2 fails - new warning
		handleRunStatus(state, "run-2", "memory_unavailable");
		expect(shouldShowWarning(state.memoryUnavailableRunId, shownForRun)).toBe(true);
		shownForRun = state.memoryUnavailableRunId;
		expect(shownForRun).toBe("run-2");
	});
});
