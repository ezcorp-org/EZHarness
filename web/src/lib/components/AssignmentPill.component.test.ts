/**
 * DOM tests for AssignmentPill.svelte — Phase B4 schema-failure chip.
 *
 * A structured-output assignment that finishes without producing schema-valid
 * JSON stays status "completed" (the run DID finish) but carries
 * `schemaFailed`. Without a visible marker the pill reads as a plain green
 * success, so the amber "schema" chip must render for exactly that case and
 * NOT for a clean completion or a still-running assignment.
 */

import { fireEvent, render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import AssignmentPill from "./AssignmentPill.svelte";
import type { TaskAssignment } from "$lib/stores.svelte.js";

afterEach(() => cleanup());

function assignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
	return {
		id: overrides.id ?? "a1",
		agentConfigId: overrides.agentConfigId ?? "cfg-1",
		agentName: overrides.agentName ?? "researcher",
		isTeam: overrides.isTeam ?? false,
		status: overrides.status ?? "completed",
		assignedAt: overrides.assignedAt ?? "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("AssignmentPill schema-failure chip", () => {
	test("renders the amber 'schema' chip for a completed schema-failed assignment", () => {
		const { getByTestId } = render(AssignmentPill, {
			assignment: assignment({ status: "completed", schemaFailed: true }),
			now: Date.now(),
		});
		const chip = getByTestId("assignment-schema-failed");
		expect(chip).toHaveTextContent("schema");
		expect(chip).toHaveAttribute(
			"title",
			"Completed, but the final output did not match the requested schema",
		);
	});

	test("does NOT render the chip for a clean completion", () => {
		const { queryByTestId } = render(AssignmentPill, {
			assignment: assignment({ status: "completed", schemaFailed: false }),
			now: Date.now(),
		});
		expect(queryByTestId("assignment-schema-failed")).toBeNull();
	});

	test("does NOT render the chip while still running (flag not yet set)", () => {
		const { queryByTestId } = render(AssignmentPill, {
			assignment: assignment({ status: "running", startedAt: "2026-01-01T00:00:00Z" }),
			now: Date.now(),
		});
		expect(queryByTestId("assignment-schema-failed")).toBeNull();
	});
});

describe("AssignmentPill assignment controls", () => {
	test("starts an assigned team member and labels a resumable assignment", async () => {
		const onstart = vi.fn();
		const { getByTitle, getByText } = render(AssignmentPill, {
			assignment: assignment({ status: "assigned", isTeam: true, subConversationId: "sub-1" }),
			now: Date.now(),
			onstart,
		});
		expect(getByText("@researcher")).toBeInTheDocument();
		const start = getByTitle("Resume assignment");
		await fireEvent.click(start);
		expect(onstart).toHaveBeenCalledTimes(1);
	});

	test("shows prerequisites instead of invoking a blocked assignment", () => {
		const onstart = vi.fn();
		const { getByTestId } = render(AssignmentPill, {
			assignment: assignment({ status: "assigned" }),
			now: Date.now(),
			onstart,
			blocked: true,
			blockedBy: ["Fetch source", "Review change"],
		});
		expect(getByTestId("assignment-start-blocked")).toHaveAttribute(
			"title",
			"Waiting for prerequisites: Fetch source, Review change",
		);
		expect(onstart).not.toHaveBeenCalled();
	});

	test("shows a live autonomous cycle and stops a running assignment", async () => {
		const onstop = vi.fn();
		const { getByTestId, getByTitle } = render(AssignmentPill, {
			assignment: assignment({
				status: "running",
				startedAt: "2026-01-01T00:00:00.000Z",
				autonomousCycle: 2,
				autonomousMaxCycles: 4,
			}),
			now: Date.parse("2026-01-01T00:00:05.000Z"),
			onstop,
		});
		expect(getByTestId("autonomous-cycle")).toHaveTextContent("↻2/4");
		await fireEvent.click(getByTitle("Stop assignment (preserves context for resume)"));
		expect(onstop).toHaveBeenCalledTimes(1);
	});

	test("renders busy controls without firing duplicate start or stop actions", async () => {
		const { container, rerender } = render(AssignmentPill, {
			assignment: assignment({ status: "assigned" }), now: Date.now(), onstart: vi.fn(), starting: true,
		});
		expect(container.querySelector(".animate-spin")).toBeInTheDocument();
		await rerender({ assignment: assignment({ status: "running", startedAt: "2026-01-01T00:00:00.000Z" }), now: Date.now(), onstop: vi.fn(), stopping: true });
		expect(container.querySelector(".animate-spin")).toBeInTheDocument();
	});
});
