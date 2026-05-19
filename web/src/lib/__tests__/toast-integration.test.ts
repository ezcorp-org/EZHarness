import { test, expect, describe, beforeEach } from "bun:test";

/**
 * Integration tests: WS event handler -> toast creation.
 *
 * Replicates the WS event dispatch logic from stores.svelte.ts (lines 249-349)
 * and the toast store logic, verifying that specific WS events produce the
 * correct toast notifications.
 *
 * We cannot import stores.svelte.ts (Svelte runes) or toast.svelte.ts directly,
 * so we replicate the relevant decision logic as pure functions.
 */

// --- Toast types (replicated from toast.svelte.ts) ---

interface ToastData {
	id: string;
	type: "success" | "error" | "warning" | "info";
	message: string;
	action?: { label: string; onclick: () => void };
	dismissAt: number;
}

// --- Minimal store shape needed by the event handler ---

interface Run {
	id: string;
	error?: string;
}

interface StoreState {
	streamingRunToConversation: Record<string, string>;
	runs: Run[];
}

// --- Replicated toast collection ---

let toastLog: Array<Omit<ToastData, "id" | "dismissAt">>[];
let idCounter = 0;

function resetToasts() {
	toastLog = [];
	idCounter = 0;
}

/** Captures what addToast would be called with, for assertion. */
function addToast(toast: Omit<ToastData, "id" | "dismissAt">, _duration?: number) {
	toastLog.push([toast]);
	return `toast-${++idCounter}`;
}

function getToasts() {
	return toastLog.map((args) => args[0]);
}

// --- Replicated WS event handler logic (the toast-relevant portion) ---

interface WSEvent {
	type: string;
	data: Record<string, unknown>;
}

/**
 * Processes a WS event and calls addToast when appropriate.
 * This replicates the switch cases from stores.svelte.ts for:
 *   - run:complete
 *   - run:error
 *   - tool:error
 */
function handleWSEvent(
	event: WSEvent,
	store: StoreState,
	currentPathname: string,
) {
	switch (event.type) {
		case "run:complete":
		case "run:error":
		case "run:cancel": {
			const { run: updated } = event.data as { run: Run };
			const conversationId = store.streamingRunToConversation[updated.id];

			if (event.type === "run:complete") {
				const viewingConv =
					conversationId &&
					currentPathname.includes(conversationId);
				if (!viewingConv) {
					addToast({
						type: "success",
						message: "Run completed",
						action: {
							label: "View",
							onclick: () => {},
						},
					});
				}
			} else if (event.type === "run:error") {
				addToast({
					type: "error",
					message: `Run failed: ${(updated as any).error || "Unknown error"}`,
					action: {
						label: "View",
						onclick: () => {},
					},
				});
			}
			// run:cancel produces no toast
			break;
		}

		case "tool:error": {
			const { toolName } = event.data as {
				conversationId: string;
				toolName: string;
				error: string;
				duration: number;
			};
			addToast({ type: "warning", message: `Tool "${toolName}" failed` });
			break;
		}
	}
}

// --- Tests ---

describe("WS event -> toast integration", () => {
	beforeEach(() => {
		resetToasts();
	});

	describe("run:complete", () => {
		test("creates success toast when NOT viewing the conversation", () => {
			const store: StoreState = {
				streamingRunToConversation: { "run-1": "conv-abc" },
				runs: [{ id: "run-1" }],
			};

			handleWSEvent(
				{ type: "run:complete", data: { run: { id: "run-1" } } },
				store,
				"/dashboard", // not viewing the conversation
			);

			const toasts = getToasts();
			expect(toasts).toHaveLength(1);
			expect(toasts[0].type).toBe("success");
			expect(toasts[0].message).toBe("Run completed");
			expect(toasts[0].action).toBeDefined();
			expect(toasts[0].action!.label).toBe("View");
		});

		test("does NOT create toast when viewing the same conversation", () => {
			const store: StoreState = {
				streamingRunToConversation: { "run-1": "conv-abc" },
				runs: [{ id: "run-1" }],
			};

			handleWSEvent(
				{ type: "run:complete", data: { run: { id: "run-1" } } },
				store,
				"/project/proj-1/chat/conv-abc", // viewing the conversation
			);

			const toasts = getToasts();
			expect(toasts).toHaveLength(0);
		});

		test("creates toast when conversationId is not in pathname even if partially similar", () => {
			const store: StoreState = {
				streamingRunToConversation: { "run-1": "conv-abc" },
				runs: [{ id: "run-1" }],
			};

			handleWSEvent(
				{ type: "run:complete", data: { run: { id: "run-1" } } },
				store,
				"/project/proj-1/chat/conv-xyz", // different conversation
			);

			const toasts = getToasts();
			expect(toasts).toHaveLength(1);
			expect(toasts[0].type).toBe("success");
		});

		test("creates toast when run has no mapped conversation (unknown runId)", () => {
			const store: StoreState = {
				streamingRunToConversation: {},
				runs: [],
			};

			handleWSEvent(
				{ type: "run:complete", data: { run: { id: "run-unknown" } } },
				store,
				"/dashboard",
			);

			// conversationId is undefined, so viewingConv is falsy => toast created
			const toasts = getToasts();
			expect(toasts).toHaveLength(1);
			expect(toasts[0].type).toBe("success");
		});
	});

	describe("run:error", () => {
		test("creates error toast with the run's error message", () => {
			const store: StoreState = {
				streamingRunToConversation: { "run-1": "conv-abc" },
				runs: [{ id: "run-1" }],
			};

			handleWSEvent(
				{
					type: "run:error",
					data: { run: { id: "run-1", error: "Rate limit exceeded" } },
				},
				store,
				"/project/proj-1/chat/conv-abc",
			);

			const toasts = getToasts();
			expect(toasts).toHaveLength(1);
			expect(toasts[0].type).toBe("error");
			expect(toasts[0].message).toBe("Run failed: Rate limit exceeded");
			expect(toasts[0].action!.label).toBe("View");
		});

		test("creates error toast with 'Unknown error' when no error field", () => {
			const store: StoreState = {
				streamingRunToConversation: {},
				runs: [],
			};

			handleWSEvent(
				{
					type: "run:error",
					data: { run: { id: "run-2" } },
				},
				store,
				"/dashboard",
			);

			const toasts = getToasts();
			expect(toasts).toHaveLength(1);
			expect(toasts[0].message).toBe("Run failed: Unknown error");
		});

		test("error toast is created regardless of current pathname", () => {
			const store: StoreState = {
				streamingRunToConversation: { "run-1": "conv-abc" },
				runs: [{ id: "run-1" }],
			};

			// Even if viewing the conversation, error toast still fires
			handleWSEvent(
				{
					type: "run:error",
					data: { run: { id: "run-1", error: "OOM" } },
				},
				store,
				"/project/proj-1/chat/conv-abc",
			);

			const toasts = getToasts();
			expect(toasts).toHaveLength(1);
			expect(toasts[0].type).toBe("error");
		});
	});

	describe("run:cancel", () => {
		test("does NOT create any toast", () => {
			const store: StoreState = {
				streamingRunToConversation: { "run-1": "conv-abc" },
				runs: [{ id: "run-1" }],
			};

			handleWSEvent(
				{ type: "run:cancel", data: { run: { id: "run-1" } } },
				store,
				"/dashboard",
			);

			const toasts = getToasts();
			expect(toasts).toHaveLength(0);
		});
	});

	describe("tool:error", () => {
		test("creates warning toast with tool name", () => {
			const store: StoreState = {
				streamingRunToConversation: { "run-1": "conv-abc" },
				runs: [{ id: "run-1" }],
			};

			handleWSEvent(
				{
					type: "tool:error",
					data: {
						conversationId: "conv-abc",
						toolName: "web_search",
						error: "DNS resolution failed",
						duration: 3000,
					},
				},
				store,
				"/dashboard",
			);

			const toasts = getToasts();
			expect(toasts).toHaveLength(1);
			expect(toasts[0].type).toBe("warning");
			expect(toasts[0].message).toBe('Tool "web_search" failed');
		});

		test("tool:error toast has no action button", () => {
			const store: StoreState = {
				streamingRunToConversation: {},
				runs: [],
			};

			handleWSEvent(
				{
					type: "tool:error",
					data: {
						conversationId: "conv-1",
						toolName: "read_file",
						error: "Permission denied",
						duration: 100,
					},
				},
				store,
				"/dashboard",
			);

			const toasts = getToasts();
			expect(toasts).toHaveLength(1);
			expect(toasts[0].action).toBeUndefined();
		});
	});

	describe("multiple events in sequence", () => {
		test("tool:error then run:error produces 2 toasts", () => {
			const store: StoreState = {
				streamingRunToConversation: { "run-1": "conv-abc" },
				runs: [{ id: "run-1" }],
			};

			handleWSEvent(
				{
					type: "tool:error",
					data: {
						conversationId: "conv-abc",
						toolName: "fetch_data",
						error: "timeout",
						duration: 5000,
					},
				},
				store,
				"/dashboard",
			);

			handleWSEvent(
				{
					type: "run:error",
					data: { run: { id: "run-1", error: "Tool failure" } },
				},
				store,
				"/dashboard",
			);

			const toasts = getToasts();
			expect(toasts).toHaveLength(2);
			expect(toasts[0].type).toBe("warning");
			expect(toasts[1].type).toBe("error");
		});

		test("multiple run:complete events each produce a toast when not viewing", () => {
			const store: StoreState = {
				streamingRunToConversation: {
					"run-1": "conv-1",
					"run-2": "conv-2",
				},
				runs: [{ id: "run-1" }, { id: "run-2" }],
			};

			handleWSEvent(
				{ type: "run:complete", data: { run: { id: "run-1" } } },
				store,
				"/dashboard",
			);
			handleWSEvent(
				{ type: "run:complete", data: { run: { id: "run-2" } } },
				store,
				"/dashboard",
			);

			const toasts = getToasts();
			expect(toasts).toHaveLength(2);
			expect(toasts.every((t) => t.type === "success")).toBe(true);
		});

		test("unhandled event types produce no toasts", () => {
			const store: StoreState = {
				streamingRunToConversation: {},
				runs: [],
			};

			handleWSEvent(
				{ type: "run:start", data: { run: { id: "run-1" } } },
				store,
				"/dashboard",
			);
			handleWSEvent(
				{ type: "tool:complete", data: { toolName: "x" } },
				store,
				"/dashboard",
			);

			expect(getToasts()).toHaveLength(0);
		});
	});
});
