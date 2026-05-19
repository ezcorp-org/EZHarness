import { test, expect, describe } from "bun:test";

// ── Pure logic extracted from +page.svelte and ObservabilityPanel.svelte ───
//
// These tests pin the agent status derivation logic so that the "failed in
// list but completed in details" inconsistency (fixed April 2026) never
// regresses. Both the historical-agent-call heuristic and the observability
// panel override must agree on status.

// ── Types (mirrors stores.svelte.ts) ───────────────────────────────────────

type AssignmentStatus = "assigned" | "running" | "completed" | "failed";

interface AgentCallState {
	subConversationId: string;
	agentName: string;
	agentConfigId: string;
	task: string;
	status: "running" | "complete" | "error";
	resultPreview?: string;
	startedAt: number;
}

interface SubConvoSummary {
	id: string;
	agentName: string;
	agentConfigId: string;
	messageCount: number;
	lastMessagePreview: string | null;
	parentMessageId: string;
}

interface TaskAssignment {
	id: string;
	agentConfigId: string;
	agentName: string;
	status: AssignmentStatus;
	subConversationId?: string;
	resultPreview?: string;
}

interface TaskSnapshot {
	conversationId: string;
	tasks: Array<{
		id: string;
		assignments: TaskAssignment[];
	}>;
}

// ── Extracted logic: getHistoricalAgentCalls status derivation ──────────────
// Mirrors the per-sub-conversation mapping in +page.svelte getHistoricalAgentCalls()

function deriveAgentStatus(
	sc: SubConvoSummary,
	taskSnapshot?: TaskSnapshot,
): Pick<AgentCallState, "status" | "resultPreview"> {
	// Build assignment lookup (same as the real code)
	const assignmentBySubConvo = new Map<
		string,
		{ status: AssignmentStatus; resultPreview?: string }
	>();
	if (taskSnapshot) {
		for (const task of taskSnapshot.tasks) {
			for (const a of task.assignments ?? []) {
				if (a.subConversationId) {
					assignmentBySubConvo.set(a.subConversationId, {
						status: a.status,
						resultPreview: a.resultPreview,
					});
				}
			}
		}
	}

	const assignment = assignmentBySubConvo.get(sc.id);
	const hasResponse = (sc.messageCount ?? 0) >= 1;

	let status: AgentCallState["status"];
	let resultPreview: string | undefined;
	if (assignment) {
		status =
			assignment.status === "failed"
				? "error"
				: assignment.status === "running"
					? "running"
					: "complete";
		resultPreview =
			assignment.resultPreview ?? (sc.lastMessagePreview ?? undefined);
	} else {
		status = hasResponse ? "complete" : "error";
		resultPreview = hasResponse
			? (sc.lastMessagePreview ?? undefined)
			: "Agent did not respond";
	}

	return { status, resultPreview };
}

// ── Extracted logic: ObservabilityPanel isError derivation ──────────────────
// Mirrors the per-event isError check in ObservabilityPanel.svelte

function deriveObsAgentIsError(
	eventType: "agent_call" | "agent_error",
	subConversationId: string | undefined,
	taskSnapshot?: TaskSnapshot,
): boolean {
	// Build assignment lookup (same as the real code)
	const assignmentStatusBySubConvo = new Map<string, AssignmentStatus>();
	if (taskSnapshot) {
		for (const task of taskSnapshot.tasks) {
			for (const a of task.assignments ?? []) {
				if (a.subConversationId)
					assignmentStatusBySubConvo.set(a.subConversationId, a.status);
			}
		}
	}

	const assignmentStatus = subConversationId
		? assignmentStatusBySubConvo.get(subConversationId)
		: undefined;
	return (
		assignmentStatus === "failed" ||
		(!assignmentStatus && eventType === "agent_error")
	);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSubConvo(
	overrides: Partial<SubConvoSummary> = {},
): SubConvoSummary {
	return {
		id: "sc-1",
		agentName: "Test Agent",
		agentConfigId: "cfg-1",
		messageCount: 1,
		lastMessagePreview: "Some agent response text...",
		parentMessageId: "msg-1",
		...overrides,
	};
}

function makeSnapshot(
	assignments: TaskAssignment[],
): TaskSnapshot {
	return {
		conversationId: "conv-1",
		tasks: [{ id: "task-1", assignments }],
	};
}

function makeAssignment(
	overrides: Partial<TaskAssignment> = {},
): TaskAssignment {
	return {
		id: "a-1",
		agentConfigId: "cfg-1",
		agentName: "Test Agent",
		status: "completed",
		subConversationId: "sc-1",
		...overrides,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════════

describe("historical agent status derivation (getHistoricalAgentCalls)", () => {
	describe("auto-spin-up flow (messageCount=1, no task assignments)", () => {
		test("agent with 1 message shows as complete (not error)", () => {
			// This was the original bug: auto-spin-up stores only the assistant
			// response (messageCount=1), old heuristic required >1 and showed error
			const sc = makeSubConvo({ messageCount: 1 });
			const { status } = deriveAgentStatus(sc);
			expect(status).toBe("complete");
		});

		test("agent with 1 message includes lastMessagePreview", () => {
			const sc = makeSubConvo({
				messageCount: 1,
				lastMessagePreview: "Agent thinking text...",
			});
			const { resultPreview } = deriveAgentStatus(sc);
			expect(resultPreview).toBe("Agent thinking text...");
		});

		test("agent with 0 messages shows as error", () => {
			const sc = makeSubConvo({ messageCount: 0, lastMessagePreview: null });
			const { status, resultPreview } = deriveAgentStatus(sc);
			expect(status).toBe("error");
			expect(resultPreview).toBe("Agent did not respond");
		});
	});

	describe("invoke_agent flow (messageCount>=2, no task assignments)", () => {
		test("agent with 2+ messages shows as complete", () => {
			const sc = makeSubConvo({ messageCount: 3 });
			const { status } = deriveAgentStatus(sc);
			expect(status).toBe("complete");
		});
	});

	describe("task assignment flow (overrides message-count heuristic)", () => {
		test("assignment status=failed → error, even with messages", () => {
			const sc = makeSubConvo({ messageCount: 5 });
			const snapshot = makeSnapshot([
				makeAssignment({ status: "failed", subConversationId: "sc-1" }),
			]);
			const { status } = deriveAgentStatus(sc, snapshot);
			expect(status).toBe("error");
		});

		test("assignment status=completed → complete", () => {
			const sc = makeSubConvo({ messageCount: 1 });
			const snapshot = makeSnapshot([
				makeAssignment({ status: "completed", subConversationId: "sc-1" }),
			]);
			const { status } = deriveAgentStatus(sc, snapshot);
			expect(status).toBe("complete");
		});

		test("assignment status=running → running", () => {
			const sc = makeSubConvo({ messageCount: 0 });
			const snapshot = makeSnapshot([
				makeAssignment({ status: "running", subConversationId: "sc-1" }),
			]);
			const { status } = deriveAgentStatus(sc, snapshot);
			expect(status).toBe("running");
		});

		test("assignment status=assigned → complete (assigned is not error)", () => {
			const sc = makeSubConvo({ messageCount: 0 });
			const snapshot = makeSnapshot([
				makeAssignment({ status: "assigned", subConversationId: "sc-1" }),
			]);
			const { status } = deriveAgentStatus(sc, snapshot);
			expect(status).toBe("complete");
		});

		test("assignment resultPreview overrides lastMessagePreview", () => {
			const sc = makeSubConvo({ lastMessagePreview: "DB preview" });
			const snapshot = makeSnapshot([
				makeAssignment({
					subConversationId: "sc-1",
					resultPreview: "Assignment result",
				}),
			]);
			const { resultPreview } = deriveAgentStatus(sc, snapshot);
			expect(resultPreview).toBe("Assignment result");
		});

		test("falls back to lastMessagePreview when assignment has no resultPreview", () => {
			const sc = makeSubConvo({ lastMessagePreview: "DB preview" });
			const snapshot = makeSnapshot([
				makeAssignment({
					subConversationId: "sc-1",
					resultPreview: undefined,
				}),
			]);
			const { resultPreview } = deriveAgentStatus(sc, snapshot);
			expect(resultPreview).toBe("DB preview");
		});

		test("unmatched sub-conversation falls back to heuristic", () => {
			const sc = makeSubConvo({ id: "sc-999", messageCount: 1 });
			const snapshot = makeSnapshot([
				makeAssignment({ subConversationId: "sc-1" }),
			]);
			const { status } = deriveAgentStatus(sc, snapshot);
			expect(status).toBe("complete"); // messageCount=1 → complete via heuristic
		});
	});
});

describe("observability panel agent status (isError derivation)", () => {
	describe("no task assignments (obs event type is source of truth)", () => {
		test("agent_call event → not error", () => {
			expect(deriveObsAgentIsError("agent_call", "sc-1")).toBe(false);
		});

		test("agent_error event → error", () => {
			expect(deriveObsAgentIsError("agent_error", "sc-1")).toBe(true);
		});

		test("agent_call with no subConversationId → not error", () => {
			expect(deriveObsAgentIsError("agent_call", undefined)).toBe(false);
		});

		test("agent_error with no subConversationId → error", () => {
			expect(deriveObsAgentIsError("agent_error", undefined)).toBe(true);
		});
	});

	describe("task assignment overrides obs event type", () => {
		test("agent_call event but assignment=failed → error", () => {
			// This was the obs panel bug: event said success but assignment said failed
			const snapshot = makeSnapshot([
				makeAssignment({ status: "failed", subConversationId: "sc-1" }),
			]);
			expect(deriveObsAgentIsError("agent_call", "sc-1", snapshot)).toBe(true);
		});

		test("agent_error event but assignment=completed → not error", () => {
			const snapshot = makeSnapshot([
				makeAssignment({ status: "completed", subConversationId: "sc-1" }),
			]);
			expect(deriveObsAgentIsError("agent_error", "sc-1", snapshot)).toBe(
				false,
			);
		});

		test("agent_call event with assignment=completed → not error", () => {
			const snapshot = makeSnapshot([
				makeAssignment({ status: "completed", subConversationId: "sc-1" }),
			]);
			expect(deriveObsAgentIsError("agent_call", "sc-1", snapshot)).toBe(
				false,
			);
		});

		test("unmatched subConversationId falls back to event type", () => {
			const snapshot = makeSnapshot([
				makeAssignment({ subConversationId: "sc-other" }),
			]);
			// sc-1 not in snapshot → fallback to event type
			expect(deriveObsAgentIsError("agent_call", "sc-1", snapshot)).toBe(
				false,
			);
			expect(deriveObsAgentIsError("agent_error", "sc-1", snapshot)).toBe(
				true,
			);
		});
	});
});

describe("cross-view consistency", () => {
	test("auto-spin-up agent: chat chips and obs panel agree on complete", () => {
		// Scenario: agent auto-spawned, produced 1 message, obs recorded agent_call
		const sc = makeSubConvo({ messageCount: 1 });
		const chatStatus = deriveAgentStatus(sc);
		const obsIsError = deriveObsAgentIsError("agent_call", "sc-1");

		expect(chatStatus.status).toBe("complete");
		expect(obsIsError).toBe(false);
		// Both agree: complete/not-error
	});

	test("failed assignment: chat chips and obs panel agree on failed", () => {
		// Scenario: task assignment marked failed, obs recorded agent_call (the original bug)
		const sc = makeSubConvo({ messageCount: 3 });
		const snapshot = makeSnapshot([
			makeAssignment({ status: "failed", subConversationId: "sc-1" }),
		]);

		const chatStatus = deriveAgentStatus(sc, snapshot);
		const obsIsError = deriveObsAgentIsError("agent_call", "sc-1", snapshot);

		expect(chatStatus.status).toBe("error");
		expect(obsIsError).toBe(true);
		// Both agree: error/failed
	});

	test("completed assignment: chat chips and obs panel agree on complete", () => {
		const sc = makeSubConvo({ messageCount: 2 });
		const snapshot = makeSnapshot([
			makeAssignment({ status: "completed", subConversationId: "sc-1" }),
		]);

		const chatStatus = deriveAgentStatus(sc, snapshot);
		const obsIsError = deriveObsAgentIsError("agent_call", "sc-1", snapshot);

		expect(chatStatus.status).toBe("complete");
		expect(obsIsError).toBe(false);
	});

	test("no messages, no assignment: both show error", () => {
		const sc = makeSubConvo({ messageCount: 0, lastMessagePreview: null });
		const chatStatus = deriveAgentStatus(sc);
		const obsIsError = deriveObsAgentIsError("agent_error", "sc-1");

		expect(chatStatus.status).toBe("error");
		expect(obsIsError).toBe(true);
	});
});
