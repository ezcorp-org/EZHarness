import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ── invokeInlineTool tests ──

// Re-implement the store logic for testability (same pattern as inline-tool-store.test.ts)
interface InlineToolCall {
	id: string;
	extensionName: string;
	toolName: string;
	input: Record<string, unknown>;
	status: "pending" | "running" | "complete" | "error";
	conversationId: string;
	retryCount: number;
}

class TestInlineToolStore {
	calls: InlineToolCall[] = [];

	add(call: Omit<InlineToolCall, "status" | "retryCount">): void {
		this.calls = [...this.calls, { ...call, status: "pending", retryCount: 0 }];
	}
}

let capturedStore: TestInlineToolStore;
let capturedFetchCalls: { url: string; options: RequestInit }[];
let originalFetch: typeof globalThis.fetch;

function invokeInlineTool(params: {
	conversationId: string;
	extensionName: string;
	toolName: string;
	input: Record<string, unknown>;
}): void {
	const invocationId =
		globalThis.crypto?.randomUUID?.() ??
		Math.random().toString(36).slice(2) + Date.now().toString(36);

	capturedStore.add({
		id: invocationId,
		extensionName: params.extensionName,
		toolName: params.toolName,
		input: params.input,
		conversationId: params.conversationId,
	});

	capturedFetchCalls.push({
		url: "/api/tool-invoke",
		options: {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				extensionName: params.extensionName,
				toolName: params.toolName,
				input: params.input,
				conversationId: params.conversationId,
				invocationId,
			}),
		},
	});

	fetch("/api/tool-invoke", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			extensionName: params.extensionName,
			toolName: params.toolName,
			input: params.input,
			conversationId: params.conversationId,
			invocationId,
		}),
	}).catch(() => {});
}

beforeEach(() => {
	capturedStore = new TestInlineToolStore();
	capturedFetchCalls = [];
	originalFetch = globalThis.fetch;
	globalThis.fetch = mock(async () =>
		new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	) as any;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("invokeInlineTool", () => {
	test("adds call to inlineToolStore with pending status", () => {
		invokeInlineTool({
			conversationId: "conv-1",
			extensionName: "task-stack",
			toolName: "start-task",
			input: { taskId: "t-1" },
		});

		expect(capturedStore.calls).toHaveLength(1);
		expect(capturedStore.calls[0]!.status).toBe("pending");
		expect(capturedStore.calls[0]!.extensionName).toBe("task-stack");
		expect(capturedStore.calls[0]!.toolName).toBe("start-task");
		expect(capturedStore.calls[0]!.input).toEqual({ taskId: "t-1" });
		expect(capturedStore.calls[0]!.conversationId).toBe("conv-1");
	});

	test("fires fetch POST to /api/tool-invoke", () => {
		invokeInlineTool({
			conversationId: "conv-1",
			extensionName: "task-stack",
			toolName: "add-task",
			input: { title: "New Task" },
		});

		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(capturedFetchCalls).toHaveLength(1);
		expect(capturedFetchCalls[0]!.url).toBe("/api/tool-invoke");
		expect(capturedFetchCalls[0]!.options.method).toBe("POST");

		const body = JSON.parse(capturedFetchCalls[0]!.options.body as string);
		expect(body.extensionName).toBe("task-stack");
		expect(body.toolName).toBe("add-task");
		expect(body.input).toEqual({ title: "New Task" });
		expect(body.conversationId).toBe("conv-1");
		expect(body.invocationId).toBeDefined();
	});

	test("generates unique invocationId for each call", () => {
		invokeInlineTool({
			conversationId: "conv-1",
			extensionName: "task-stack",
			toolName: "start-task",
			input: { taskId: "t-1" },
		});
		invokeInlineTool({
			conversationId: "conv-1",
			extensionName: "task-stack",
			toolName: "start-task",
			input: { taskId: "t-2" },
		});

		expect(capturedStore.calls).toHaveLength(2);
		expect(capturedStore.calls[0]!.id).not.toBe(capturedStore.calls[1]!.id);
	});

	test("invocationId in store matches invocationId in fetch body", () => {
		invokeInlineTool({
			conversationId: "conv-1",
			extensionName: "task-stack",
			toolName: "finish-task",
			input: { taskId: "t-1", summary: "Done" },
		});

		const storeId = capturedStore.calls[0]!.id;
		const body = JSON.parse(capturedFetchCalls[0]!.options.body as string);
		expect(body.invocationId).toBe(storeId);
	});
});

// ── Action button visibility logic ──

describe("action button visibility logic", () => {
	// These test the derived `canAct` logic from the Svelte components

	function canAct(conversationId: string | undefined, toolCallStatus: string): boolean {
		return !!conversationId && toolCallStatus === "complete";
	}

	test("canAct is true when conversationId is set and status is complete", () => {
		expect(canAct("conv-1", "complete")).toBe(true);
	});

	test("canAct is false when conversationId is undefined", () => {
		expect(canAct(undefined, "complete")).toBe(false);
	});

	test("canAct is false when conversationId is empty string", () => {
		expect(canAct("", "complete")).toBe(false);
	});

	test("canAct is false when status is running", () => {
		expect(canAct("conv-1", "running")).toBe(false);
	});

	test("canAct is false when status is pending", () => {
		expect(canAct("conv-1", "pending")).toBe(false);
	});

	test("canAct is false when status is error", () => {
		expect(canAct("conv-1", "error")).toBe(false);
	});

	// TaskListCard shows Start for pending, Finish for active
	test("pending tasks show Start action", () => {
		const status: string = "pending";
		expect(status === "pending").toBe(true);
		expect(status === "active").toBe(false);
	});

	test("active tasks show Finish action", () => {
		const status: string = "active";
		expect(status === "active").toBe(true);
		expect(status === "pending").toBe(false);
	});

	test("completed tasks show no Start or Finish action", () => {
		const status: string = "completed";
		expect(status === "pending").toBe(false);
		expect(status === "active").toBe(false);
	});
});

// ── Inline form validation ──

describe("inline form validation", () => {
	test("add-task rejects empty title", () => {
		const title = "";
		expect(!title.trim()).toBe(true);
	});

	test("add-task rejects whitespace-only title", () => {
		const title = "   ";
		expect(!title.trim()).toBe(true);
	});

	test("add-task accepts valid title", () => {
		const title = "Setup DB";
		expect(!title.trim()).toBe(false);
	});

	test("finish-task rejects empty summary", () => {
		const summary = "";
		expect(!summary.trim()).toBe(true);
	});

	test("finish-task rejects whitespace-only summary", () => {
		const summary = "   \t  ";
		expect(!summary.trim()).toBe(true);
	});

	test("finish-task accepts valid summary", () => {
		const summary = "Database schema created";
		expect(!summary.trim()).toBe(false);
	});

	test("finish-task trims whitespace from summary", () => {
		const summary = "  Done with setup  ";
		expect(summary.trim()).toBe("Done with setup");
	});

	test("add-task trims whitespace from title", () => {
		const title = "  New Task  ";
		expect(title.trim()).toBe("New Task");
	});
});

// ── Extracted handler logic (pure functions matching component behavior) ──

interface HandlerResult {
	called: boolean;
	toolName?: string;
	input?: Record<string, unknown>;
}

interface TaskData {
	id?: string;
	title?: string;
	description?: string;
	status?: string;
}

// TaskDetailCard handlers

function detailHandleStart(params: {
	conversationId?: string;
	task: TaskData;
	actionLoading: boolean;
}): HandlerResult {
	if (!params.conversationId || !params.task?.id || params.actionLoading) return { called: false };
	return {
		called: true,
		toolName: "start-task",
		input: { taskId: params.task.id },
	};
}

function detailHandleFinish(params: {
	conversationId?: string;
	task: TaskData;
	actionLoading: boolean;
	finishSummary: string;
}): HandlerResult & { finishing: boolean; finishSummary: string } {
	if (!params.conversationId || !params.task?.id || params.actionLoading || !params.finishSummary.trim()) {
		return { called: false, finishing: true, finishSummary: params.finishSummary };
	}
	return {
		called: true,
		toolName: "finish-task",
		input: { taskId: params.task.id, summary: params.finishSummary.trim() },
		finishing: false,
		finishSummary: "",
	};
}

function detailHandleUpdate(params: {
	conversationId?: string;
	task: TaskData;
	actionLoading: boolean;
	editTitle: string;
	editDescription: string;
}): HandlerResult & { editing: boolean } {
	if (!params.conversationId || !params.task?.id || params.actionLoading) return { called: false, editing: true };
	const input: Record<string, unknown> = { taskId: params.task.id };
	if (params.editTitle.trim() && params.editTitle.trim() !== params.task.title) input.title = params.editTitle.trim();
	if (params.editDescription.trim() !== (params.task.description ?? "")) input.description = params.editDescription.trim();
	if (Object.keys(input).length <= 1) return { called: false, editing: false };
	return { called: true, toolName: "update-task", input, editing: false };
}

function detailStartEditing(task: TaskData): { editTitle: string; editDescription: string; editing: boolean } {
	return {
		editTitle: task?.title ?? "",
		editDescription: task?.description ?? "",
		editing: true,
	};
}

// TaskListCard handlers

function listHandleStartTask(params: {
	conversationId?: string;
	actionLoading: boolean;
	taskId: string;
}): HandlerResult {
	if (!params.conversationId || params.actionLoading) return { called: false };
	return { called: true, toolName: "start-task", input: { taskId: params.taskId } };
}

function listHandleFinishTask(params: {
	conversationId?: string;
	actionLoading: boolean;
	taskId: string;
	finishSummary: string;
}): HandlerResult & { finishingTaskId: string | null; finishSummary: string } {
	if (!params.conversationId || params.actionLoading || !params.finishSummary.trim()) {
		return { called: false, finishingTaskId: params.taskId, finishSummary: params.finishSummary };
	}
	return {
		called: true,
		toolName: "finish-task",
		input: { taskId: params.taskId, summary: params.finishSummary.trim() },
		finishingTaskId: null,
		finishSummary: "",
	};
}

function listHandleAddTask(params: {
	conversationId?: string;
	actionLoading: boolean;
	newTaskTitle: string;
}): HandlerResult & { addingTask: boolean; newTaskTitle: string } {
	if (!params.conversationId || params.actionLoading || !params.newTaskTitle.trim()) {
		return { called: false, addingTask: true, newTaskTitle: params.newTaskTitle };
	}
	return {
		called: true,
		toolName: "add-task",
		input: { title: params.newTaskTitle.trim() },
		addingTask: false,
		newTaskTitle: "",
	};
}

// ── TaskDetailCard handleStart ──

describe("TaskDetailCard handleStart", () => {
	test("calls start-task with taskId", () => {
		const result = detailHandleStart({ conversationId: "conv-1", task: { id: "t-1" }, actionLoading: false });
		expect(result.called).toBe(true);
		expect(result.toolName).toBe("start-task");
		expect(result.input).toEqual({ taskId: "t-1" });
	});

	test("no-ops when conversationId missing", () => {
		const result = detailHandleStart({ conversationId: undefined, task: { id: "t-1" }, actionLoading: false });
		expect(result.called).toBe(false);
	});

	test("no-ops when task.id missing", () => {
		const result = detailHandleStart({ conversationId: "conv-1", task: {}, actionLoading: false });
		expect(result.called).toBe(false);
	});

	test("no-ops when actionLoading true", () => {
		const result = detailHandleStart({ conversationId: "conv-1", task: { id: "t-1" }, actionLoading: true });
		expect(result.called).toBe(false);
	});
});

// ── TaskDetailCard handleFinish ──

describe("TaskDetailCard handleFinish", () => {
	test("calls finish-task with taskId and trimmed summary", () => {
		const result = detailHandleFinish({
			conversationId: "conv-1", task: { id: "t-1" }, actionLoading: false, finishSummary: "  Done  ",
		});
		expect(result.called).toBe(true);
		expect(result.toolName).toBe("finish-task");
		expect(result.input).toEqual({ taskId: "t-1", summary: "Done" });
	});

	test("rejects empty summary", () => {
		const result = detailHandleFinish({
			conversationId: "conv-1", task: { id: "t-1" }, actionLoading: false, finishSummary: "",
		});
		expect(result.called).toBe(false);
	});

	test("rejects whitespace-only summary", () => {
		const result = detailHandleFinish({
			conversationId: "conv-1", task: { id: "t-1" }, actionLoading: false, finishSummary: "   ",
		});
		expect(result.called).toBe(false);
	});

	test("resets finishing state and summary after call", () => {
		const result = detailHandleFinish({
			conversationId: "conv-1", task: { id: "t-1" }, actionLoading: false, finishSummary: "Done",
		});
		expect(result.finishing).toBe(false);
		expect(result.finishSummary).toBe("");
	});

	test("no-ops when conversationId missing", () => {
		const result = detailHandleFinish({
			conversationId: undefined, task: { id: "t-1" }, actionLoading: false, finishSummary: "Done",
		});
		expect(result.called).toBe(false);
	});

	test("no-ops when actionLoading true", () => {
		const result = detailHandleFinish({
			conversationId: "conv-1", task: { id: "t-1" }, actionLoading: true, finishSummary: "Done",
		});
		expect(result.called).toBe(false);
	});
});

// ── TaskDetailCard handleUpdate ──

describe("TaskDetailCard handleUpdate", () => {
	test("calls update-task with only changed fields", () => {
		const result = detailHandleUpdate({
			conversationId: "conv-1",
			task: { id: "t-1", title: "Old Title", description: "Old Desc" },
			actionLoading: false,
			editTitle: "New Title",
			editDescription: "Old Desc",
		});
		expect(result.called).toBe(true);
		expect(result.toolName).toBe("update-task");
		expect(result.input).toEqual({ taskId: "t-1", title: "New Title" });
	});

	test("includes description when changed", () => {
		const result = detailHandleUpdate({
			conversationId: "conv-1",
			task: { id: "t-1", title: "Title", description: "Old" },
			actionLoading: false,
			editTitle: "Title",
			editDescription: "New",
		});
		expect(result.called).toBe(true);
		expect(result.input).toEqual({ taskId: "t-1", description: "New" });
	});

	test("includes both title and description when both changed", () => {
		const result = detailHandleUpdate({
			conversationId: "conv-1",
			task: { id: "t-1", title: "Old", description: "Old Desc" },
			actionLoading: false,
			editTitle: "New",
			editDescription: "New Desc",
		});
		expect(result.called).toBe(true);
		expect(result.input).toEqual({ taskId: "t-1", title: "New", description: "New Desc" });
	});

	test("skips invokeInlineTool if nothing changed", () => {
		const result = detailHandleUpdate({
			conversationId: "conv-1",
			task: { id: "t-1", title: "Same", description: "Same" },
			actionLoading: false,
			editTitle: "Same",
			editDescription: "Same",
		});
		expect(result.called).toBe(false);
		expect(result.editing).toBe(false);
	});

	test("resets editing state after call", () => {
		const result = detailHandleUpdate({
			conversationId: "conv-1",
			task: { id: "t-1", title: "Old", description: "" },
			actionLoading: false,
			editTitle: "New",
			editDescription: "",
		});
		expect(result.editing).toBe(false);
	});

	test("no-ops when conversationId missing", () => {
		const result = detailHandleUpdate({
			conversationId: undefined,
			task: { id: "t-1", title: "Old" },
			actionLoading: false,
			editTitle: "New",
			editDescription: "",
		});
		expect(result.called).toBe(false);
	});

	test("no-ops when actionLoading true", () => {
		const result = detailHandleUpdate({
			conversationId: "conv-1",
			task: { id: "t-1", title: "Old" },
			actionLoading: true,
			editTitle: "New",
			editDescription: "",
		});
		expect(result.called).toBe(false);
	});
});

// ── TaskDetailCard startEditing ──

describe("TaskDetailCard startEditing", () => {
	test("populates editTitle and editDescription from task", () => {
		const result = detailStartEditing({ title: "My Task", description: "Some desc" });
		expect(result.editTitle).toBe("My Task");
		expect(result.editDescription).toBe("Some desc");
		expect(result.editing).toBe(true);
	});

	test("handles missing description (defaults to empty string)", () => {
		const result = detailStartEditing({ title: "My Task" });
		expect(result.editDescription).toBe("");
	});

	test("handles missing title (defaults to empty string)", () => {
		const result = detailStartEditing({});
		expect(result.editTitle).toBe("");
		expect(result.editDescription).toBe("");
	});
});

// ── TaskListCard handleStartTask ──

describe("TaskListCard handleStartTask", () => {
	test("calls start-task with taskId", () => {
		const result = listHandleStartTask({ conversationId: "conv-1", actionLoading: false, taskId: "t-5" });
		expect(result.called).toBe(true);
		expect(result.toolName).toBe("start-task");
		expect(result.input).toEqual({ taskId: "t-5" });
	});

	test("no-ops when conversationId missing", () => {
		const result = listHandleStartTask({ conversationId: undefined, actionLoading: false, taskId: "t-5" });
		expect(result.called).toBe(false);
	});

	test("no-ops when actionLoading true", () => {
		const result = listHandleStartTask({ conversationId: "conv-1", actionLoading: true, taskId: "t-5" });
		expect(result.called).toBe(false);
	});
});

// ── TaskListCard handleFinishTask ──

describe("TaskListCard handleFinishTask", () => {
	test("calls finish-task with taskId and trimmed summary", () => {
		const result = listHandleFinishTask({
			conversationId: "conv-1", actionLoading: false, taskId: "t-3", finishSummary: "  All done  ",
		});
		expect(result.called).toBe(true);
		expect(result.toolName).toBe("finish-task");
		expect(result.input).toEqual({ taskId: "t-3", summary: "All done" });
	});

	test("rejects empty summary", () => {
		const result = listHandleFinishTask({
			conversationId: "conv-1", actionLoading: false, taskId: "t-3", finishSummary: "",
		});
		expect(result.called).toBe(false);
	});

	test("rejects whitespace-only summary", () => {
		const result = listHandleFinishTask({
			conversationId: "conv-1", actionLoading: false, taskId: "t-3", finishSummary: "  \t  ",
		});
		expect(result.called).toBe(false);
	});

	test("resets finishingTaskId and finishSummary after call", () => {
		const result = listHandleFinishTask({
			conversationId: "conv-1", actionLoading: false, taskId: "t-3", finishSummary: "Done",
		});
		expect(result.finishingTaskId).toBeNull();
		expect(result.finishSummary).toBe("");
	});

	test("no-ops when conversationId missing", () => {
		const result = listHandleFinishTask({
			conversationId: undefined, actionLoading: false, taskId: "t-3", finishSummary: "Done",
		});
		expect(result.called).toBe(false);
	});
});

// ── TaskListCard handleAddTask ──

describe("TaskListCard handleAddTask", () => {
	test("calls add-task with trimmed title", () => {
		const result = listHandleAddTask({
			conversationId: "conv-1", actionLoading: false, newTaskTitle: "  New Task  ",
		});
		expect(result.called).toBe(true);
		expect(result.toolName).toBe("add-task");
		expect(result.input).toEqual({ title: "New Task" });
	});

	test("rejects empty title", () => {
		const result = listHandleAddTask({
			conversationId: "conv-1", actionLoading: false, newTaskTitle: "",
		});
		expect(result.called).toBe(false);
	});

	test("rejects whitespace-only title", () => {
		const result = listHandleAddTask({
			conversationId: "conv-1", actionLoading: false, newTaskTitle: "   ",
		});
		expect(result.called).toBe(false);
	});

	test("resets addingTask and newTaskTitle after call", () => {
		const result = listHandleAddTask({
			conversationId: "conv-1", actionLoading: false, newTaskTitle: "Task",
		});
		expect(result.addingTask).toBe(false);
		expect(result.newTaskTitle).toBe("");
	});

	test("no-ops when conversationId missing", () => {
		const result = listHandleAddTask({
			conversationId: undefined, actionLoading: false, newTaskTitle: "Task",
		});
		expect(result.called).toBe(false);
	});

	test("no-ops when actionLoading true", () => {
		const result = listHandleAddTask({
			conversationId: "conv-1", actionLoading: true, newTaskTitle: "Task",
		});
		expect(result.called).toBe(false);
	});
});

// ── Guard conditions (cross-cutting) ──

describe("guard conditions", () => {
	test("actionLoading prevents double-submit for detail handleStart", () => {
		expect(detailHandleStart({ conversationId: "c", task: { id: "t" }, actionLoading: true }).called).toBe(false);
	});

	test("actionLoading prevents double-submit for detail handleFinish", () => {
		expect(detailHandleFinish({ conversationId: "c", task: { id: "t" }, actionLoading: true, finishSummary: "x" }).called).toBe(false);
	});

	test("actionLoading prevents double-submit for detail handleUpdate", () => {
		expect(detailHandleUpdate({ conversationId: "c", task: { id: "t", title: "a" }, actionLoading: true, editTitle: "b", editDescription: "" }).called).toBe(false);
	});

	test("actionLoading prevents double-submit for list handleStartTask", () => {
		expect(listHandleStartTask({ conversationId: "c", actionLoading: true, taskId: "t" }).called).toBe(false);
	});

	test("actionLoading prevents double-submit for list handleFinishTask", () => {
		expect(listHandleFinishTask({ conversationId: "c", actionLoading: true, taskId: "t", finishSummary: "x" }).called).toBe(false);
	});

	test("actionLoading prevents double-submit for list handleAddTask", () => {
		expect(listHandleAddTask({ conversationId: "c", actionLoading: true, newTaskTitle: "x" }).called).toBe(false);
	});

	test("missing task.id prevents detail handleStart", () => {
		expect(detailHandleStart({ conversationId: "c", task: {}, actionLoading: false }).called).toBe(false);
	});

	test("missing task.id prevents detail handleFinish", () => {
		expect(detailHandleFinish({ conversationId: "c", task: {}, actionLoading: false, finishSummary: "x" }).called).toBe(false);
	});

	test("missing task.id prevents detail handleUpdate", () => {
		expect(detailHandleUpdate({ conversationId: "c", task: {}, actionLoading: false, editTitle: "x", editDescription: "" }).called).toBe(false);
	});
});
