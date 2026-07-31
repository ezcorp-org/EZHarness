/**
 * DOM tests for the pending-decisions tray — the one bottom-right stack.
 *
 * It exists because there are now TWO kinds of decision with nowhere inline
 * to live (a run-less permission prompt, and a workflow parked on an
 * approval) and each owning its own `fixed bottom-4 right-4` container put
 * them exactly on top of each other. So the thing worth testing is that
 * both render, together, in ONE container — not that either renders alone.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import PendingDecisionsTray from "$lib/components/tool-cards/PendingDecisionsTray.svelte";
import {
	store,
	registerPendingApproval,
	registerPendingPermission,
	type ToolCallState,
} from "$lib/stores.svelte.js";
import type { PendingApprovalNotice } from "$lib/workflow-approvals-logic";

beforeEach(() => {
	store.pendingPermissions = [];
	store.pendingApprovals = [];
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	store.pendingPermissions = [];
	store.pendingApprovals = [];
});

function permission(): ToolCallState {
	return {
		id: "prompt-1",
		toolName: "ez-code-factory__init_gate",
		status: "running",
		startedAt: Date.now(),
		permissionPending: true,
		extensionId: "ez-code-factory",
		capabilityKind: "shell",
	} as ToolCallState;
}

function approval(): PendingApprovalNotice {
	return {
		approvalId: "ap-1",
		workflowRunId: "run-1",
		workflowName: "ship-it",
		stepName: "confirm",
		prompt: "Publish the release notes?",
		choices: ["approve", "reject"],
		requireItemConsent: false,
		itemIds: [],
		expiresAt: null,
	};
}

describe("PendingDecisionsTray", () => {
	test("renders nothing at all when there is nothing to decide", () => {
		const { queryByTestId } = render(PendingDecisionsTray);
		expect(queryByTestId("pending-decisions-tray")).toBeNull();
		expect(queryByTestId("pending-approval-tray")).toBeNull();
		expect(queryByTestId("pending-permission-tray")).toBeNull();
	});

	test("a parked approval alone renders the container and the card", () => {
		registerPendingApproval(approval());
		const { getByTestId, queryByTestId } = render(PendingDecisionsTray);

		expect(getByTestId("pending-decisions-tray")).toBeInTheDocument();
		expect(getByTestId("pending-approval-card")).toBeInTheDocument();
		expect(queryByTestId("pending-permission-tray")).toBeNull();
	});

	test("a permission prompt alone still renders — no regression on the surface that already worked", () => {
		registerPendingPermission(permission());
		const { getByTestId, queryByTestId } = render(PendingDecisionsTray);

		expect(getByTestId("pending-permission-tray")).toBeInTheDocument();
		expect(queryByTestId("pending-approval-card")).toBeNull();
	});

	test("both kinds share ONE container instead of stacking on top of each other", () => {
		registerPendingApproval(approval());
		registerPendingPermission(permission());
		const { getAllByTestId, getByTestId } = render(PendingDecisionsTray);

		// One container is the property. Two would be two `fixed bottom-4
		// right-4` stacks at the same corner — which is exactly the bug this
		// component exists to prevent, and it is invisible to a test that
		// only ever renders one kind.
		expect(getAllByTestId("pending-decisions-tray")).toHaveLength(1);
		const container = getByTestId("pending-decisions-tray");
		expect(container).toContainElement(getByTestId("pending-approval-tray"));
		expect(container).toContainElement(getByTestId("pending-permission-tray"));
	});

	test("answering a card removes it from the tray — the resolve path", async () => {
		registerPendingApproval(approval());
		const { getAllByTestId, queryByTestId } = render(PendingDecisionsTray);

		await fireEvent.click(getAllByTestId("pending-approval-choice")[0]!);
		await waitFor(() => expect(queryByTestId("pending-approval-card")).toBeNull());
		// The whole container goes with it — no empty box left in the corner.
		expect(queryByTestId("pending-decisions-tray")).toBeNull();
		expect(store.pendingApprovals).toHaveLength(0);
	});

	test("every parked approval gets its own card", () => {
		registerPendingApproval(approval());
		registerPendingApproval({ ...approval(), approvalId: "ap-2", stepName: "second" });
		const { getAllByTestId } = render(PendingDecisionsTray);
		expect(getAllByTestId("pending-approval-card")).toHaveLength(2);
	});
});
