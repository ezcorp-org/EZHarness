import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

/**
 * @evidence — Phase B4 orchestration visibility.
 *
 * A structured-output assignment that finishes without producing schema-valid
 * JSON stays status "completed" (the run DID finish) but the terminal
 * `task:assignment_update` carries a top-level `structuredResultError`. The
 * store captures that into a `schemaFailed` flag and the AssignmentPill renders
 * an amber "schema" chip so the pill isn't misread as a clean green success.
 *
 * This RENDER-style spec seeds a running assignment via the tasks route, then
 * drives the terminal update + an `agent:complete` over the fake runtime-event
 * transport (same channel the sibling task-panel.spec.ts uses for
 * `task:snapshot`) — no real LLM.
 */

const TASKS_ROUTE_PATTERN = "/tasks";

const proj = makeProject({ id: "proj-schema", name: "Schema Project" });
const conv = makeConversation({ id: "conv-schema", projectId: "proj-schema", title: "Schema Convo" });

function runningAssignment(id: string, agentName: string, subConversationId: string) {
	return {
		id,
		agentConfigId: "cfg-1",
		agentName,
		isTeam: false,
		status: "running" as const,
		assignedAt: "2026-01-01T00:00:00.000Z",
		startedAt: "2026-01-01T00:00:00.000Z",
		subConversationId,
		agentRunId: "run-init",
	};
}

function seededSnapshot() {
	return {
		conversationId: "conv-schema",
		tasks: [
			{
				id: "t1",
				title: "Extract structured report",
				description: "",
				status: "active" as const,
				priority: 0,
				subtasks: [],
				assignments: [runningAssignment("a1", "schema-worker", "sub-42")],
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		],
		activeTaskId: "t1",
	};
}

test.describe("@evidence task-panel schema-failure badge", () => {
	test("terminal update with structuredResultError renders the amber schema chip", async ({
		page,
		mockApi,
		emitWs,
	}, testInfo) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => seededSnapshot() },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// The running assignment pill is present, with no schema chip yet.
		await expect(page.getByText("@schema-worker")).toBeVisible();
		await expect(page.getByTestId("assignment-schema-failed")).toHaveCount(0);

		// Drive the terminal update: the child COMPLETED but its output never
		// validated — `structuredResultError` rides the top-level event field.
		await emitWs({
			type: "task:assignment_update",
			data: {
				conversationId: "conv-schema",
				taskId: "t1",
				assignment: {
					...runningAssignment("a1", "schema-worker", "sub-42"),
					status: "completed",
					completedAt: "2026-01-01T00:05:00.000Z",
					resultPreview: "Here is the report you asked for…",
				},
				structuredResultError: "field `total` is required but was missing",
			},
		});

		// The amber "schema" chip now marks the completed-but-invalid assignment.
		const chip = page.getByTestId("assignment-schema-failed");
		await expect(chip).toBeVisible();
		await expect(chip).toHaveText("schema");

		await captureEvidence(page, testInfo, "task-panel-schema-badge");

		// A subsequent agent:complete for the same sub-conversation must not
		// crash or reset the panel — it drives the sub-agent done indicator.
		await emitWs({
			type: "agent:complete",
			data: {
				runId: "run-final-cycle",
				agentRunId: "run-final-cycle",
				subConversationId: "sub-42",
				agentName: "schema-worker",
				agentConfigId: "cfg-1",
				success: true,
				resultPreview: "Here is the report you asked for…",
				parentConversationId: "conv-schema",
			},
		});

		// Panel + chip remain intact after the terminal agent:complete.
		await expect(page.getByText("@schema-worker")).toBeVisible();
		await expect(page.getByTestId("assignment-schema-failed")).toBeVisible();

		await captureEvidence(page, testInfo, "task-panel-after-agent-complete");
	});

	test("a clean completion does NOT render the schema chip", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: { [TASKS_ROUTE_PATTERN]: () => seededSnapshot() },
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("@schema-worker")).toBeVisible();

		await emitWs({
			type: "task:assignment_update",
			data: {
				conversationId: "conv-schema",
				taskId: "t1",
				assignment: {
					...runningAssignment("a1", "schema-worker", "sub-42"),
					status: "completed",
					completedAt: "2026-01-01T00:05:00.000Z",
					resultPreview: "All good",
				},
				// No structuredResultError → clean success, no chip.
			},
		});

		// Wait for the completed check icon, then assert the chip is absent.
		await expect(page.locator('svg path[d="M5 13l4 4L19 7"]').first()).toBeVisible();
		await expect(page.getByTestId("assignment-schema-failed")).toHaveCount(0);
	});
});
