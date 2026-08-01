/**
 * INTEGRATION test — drives the REAL `stores.svelte.ts` switch handler by
 * capturing the WS subscriber and emitting a synthetic
 * `workflow:approval_request`.
 *
 * The event is the ONLY thing that puts a parked workflow decision in front
 * of the user. A run parks minutes after whatever started it, on no
 * conversation the client can map, and it outlives the tab — so if this
 * handler drops the event nothing renders and the run waits unseen until
 * somebody thinks to open the inbox.
 *
 * Proves:
 *   1. The notice lands on `store.pendingApprovals`, fields intact.
 *   2. A replayed notice (SSE resume replays every buffered event after the
 *      cursor) updates in place rather than stacking a second card for one
 *      decision.
 *   3. Dismiss clears it — the resolve path.
 *   4. An id-less notice is ignored: the answer route is keyed by it.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";

let capturedSubscriber: ((evt: { type: string; data: unknown }) => void) | null = null;

vi.mock("$lib/ws", () => ({
	createWSClient: () => ({
		subscribe: (fn: (evt: { type: string; data: unknown }) => void) => {
			capturedSubscriber = fn;
			return () => {};
		},
		close: () => {},
		manualRetry: () => {},
	}),
}));

vi.mock("$lib/api", () => ({
	fetchAgents: () => Promise.resolve([]),
	fetchRuns: () => Promise.resolve([]),
	fetchProjects: () => Promise.resolve([]),
	fetchSettings: () => Promise.resolve({}),
	fetchAgentConfigs: () => Promise.resolve([]),
	fetchPipelines: () => Promise.resolve([]),
	fetchWorkflows: () => Promise.resolve([]),
}));

import { initStores, dismissPendingApproval, store } from "$lib/stores.svelte";

function emit(type: string, data: unknown) {
	if (!capturedSubscriber) throw new Error("subscriber not captured — initStores not called?");
	capturedSubscriber({ type, data });
}

const NOTICE = {
	approvalId: "ap-1",
	workflowRunId: "run-1",
	workflowName: "ship-it",
	stepName: "confirm",
	prompt: "Publish the release notes?",
	choices: ["approve", "reject"],
	requireItemConsent: false,
	itemIds: [] as string[],
	expiresAt: null,
};

describe("stores.svelte.ts — pending workflow approvals", () => {
	beforeEach(() => {
		capturedSubscriber = null;
		initStores();
		store.pendingApprovals = [];
	});

	test("a parked approval lands on the tray with its fields intact", () => {
		emit("workflow:approval_request", { ...NOTICE, userId: "owner" });

		expect(store.pendingApprovals).toHaveLength(1);
		const entry = store.pendingApprovals[0]!;
		expect(entry.approvalId).toBe("ap-1");
		expect(entry.workflowName).toBe("ship-it");
		expect(entry.stepName).toBe("confirm");
		expect(entry.prompt).toBe("Publish the release notes?");
		expect(entry.choices).toEqual(["approve", "reject"]);
	});

	test("consent items arrive verbatim and in order", () => {
		// The card renders these and sends back what the user ticks. A
		// re-ordering here would silently change which item a click means.
		emit("workflow:approval_request", {
			...NOTICE,
			requireItemConsent: true,
			itemIds: ["b.ts", "a.ts", "A.ts"],
		});
		expect(store.pendingApprovals[0]!.itemIds).toEqual(["b.ts", "a.ts", "A.ts"]);
	});

	test("a replayed notice updates in place — one decision, one card", () => {
		emit("workflow:approval_request", NOTICE);
		emit("workflow:approval_request", { ...NOTICE, prompt: "Publish them now?" });

		expect(store.pendingApprovals).toHaveLength(1);
		expect(store.pendingApprovals[0]!.prompt).toBe("Publish them now?");
	});

	test("two different decisions both render", () => {
		emit("workflow:approval_request", NOTICE);
		emit("workflow:approval_request", { ...NOTICE, approvalId: "ap-2", stepName: "second" });
		expect(store.pendingApprovals.map((a) => a.approvalId)).toEqual(["ap-1", "ap-2"]);
	});

	test("dismiss clears exactly one — the resolve path", () => {
		emit("workflow:approval_request", NOTICE);
		emit("workflow:approval_request", { ...NOTICE, approvalId: "ap-2" });

		dismissPendingApproval("ap-1");
		expect(store.pendingApprovals.map((a) => a.approvalId)).toEqual(["ap-2"]);
	});

	test("a notice with no approvalId is ignored rather than rendered unanswerable", () => {
		emit("workflow:approval_request", { ...NOTICE, approvalId: "" });
		expect(store.pendingApprovals).toHaveLength(0);
	});
});
