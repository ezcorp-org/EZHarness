import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import type { FactoryReleaseNotificationResource } from "@ezcorp/factory-sdk/types";
import FactoryReleaseInbox from "./FactoryReleaseInbox.svelte";
import type { FactoryReleaseNotificationApi } from "./client";

const digest = "a".repeat(64);
const approval = { notificationId: "notification-approval", operationId: "release-approval", createdAtMs: 3, kind: "approval_requested" as const, approvalId: "approval-1", contextDigest: digest, expiresAtMs: 2_000_000_000_000 };
const uncertain = { notificationId: "notification-uncertain", operationId: "release-uncertain", createdAtMs: 2, kind: "release_uncertain" as const, dispatchGeneration: 2, outcomeCode: "provider_response_unknown" };
const settled = { notificationId: "notification-settled", operationId: "release-settled", createdAtMs: 1, kind: "release_settled" as const, dispatchGeneration: 1, outcomeCode: "confirmed" };
const commandApproval = { notificationId: "notification-command", createdAtMs: 4, kind: "command_approval_requested" as const, approvalId: "command-approval-1", runId: "run-1", commandId: "command-1", nodeInstanceId: "review", contextDigest: digest, context: { subject: "candidate-7" }, choices: ["ship", "hold"], actorScope: "operator" as const, expiresAtMs: 2_000_000_000_000 };

function api(items: readonly FactoryReleaseNotificationResource[] = [], nextCursor: string | null = null): FactoryReleaseNotificationApi {
	return {
		listReleaseNotifications: vi.fn(async () => ({ items, nextCursor })),
		decideReleaseApproval: vi.fn(async () => ({ approvalId: approval.approvalId, contextDigest: digest, status: "approved" as const })),
		decideCommandApproval: vi.fn(),
	};
}

describe("FactoryReleaseInbox", () => {
	test("shows each durable notification once and sends the exact approval decision", async () => {
		const service = api([approval, approval, uncertain, settled]);
		render(FactoryReleaseInbox, { projectId: "project-1", api: service });
		await screen.findByText("Release approval requested");
		expect(screen.getAllByText("release-approval")).toHaveLength(1);
		expect(screen.getByText("Release outcome uncertain")).toBeVisible();
		expect(screen.getByText("Reconciliation is required.", { exact: false })).toBeVisible();
		expect(screen.getByText("Release completed")).toBeVisible();
		const card = screen.getByText("Release approval requested").closest("article")!;
		await fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
		expect(service.decideReleaseApproval).toHaveBeenCalledWith("project-1", approval.approvalId, digest, "approved");
		await waitFor(() => expect(screen.queryByText("release-approval")).toBeNull());
	});

	test("loads another bounded page and keeps a failed denial recoverable", async () => {
		const list = vi.fn(async (_projectId: string, query?: { cursor?: string }) => query?.cursor
			? { items: [approval], nextCursor: null }
			: { items: [uncertain], nextCursor: "notification-next" });
		const decide = vi.fn()
			.mockRejectedValueOnce(new Error("Decision authority changed."))
			.mockResolvedValueOnce({ approvalId: approval.approvalId, contextDigest: digest, status: "denied" as const });
		const service = { listReleaseNotifications: list, decideReleaseApproval: decide, decideCommandApproval: vi.fn() } satisfies FactoryReleaseNotificationApi;
		render(FactoryReleaseInbox, { projectId: "project-1", api: service });
		await screen.findByText("Release outcome uncertain");
		await fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		const card = await screen.findByText("Release approval requested");
		await fireEvent.click(within(card.closest("article")!).getByRole("button", { name: "Deny" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Decision authority changed.");
		expect(screen.getByText("release-approval")).toBeVisible();
		await fireEvent.click(within(card.closest("article")!).getByRole("button", { name: "Deny" }));
		await waitFor(() => expect(screen.queryByText("release-approval")).toBeNull());
		expect(decide).toHaveBeenLastCalledWith("project-1", approval.approvalId, digest, "denied");
	});

	test("shows the sealed command context and sends one exact declared choice", async () => {
		const service = api([commandApproval]);
		vi.mocked(service.decideCommandApproval).mockRejectedValueOnce(new Error("Approval authority changed."));
		render(FactoryReleaseInbox, { projectId: "project-1", api: service });
		const title = await screen.findByText("Factory approval requested");
		const card = title.closest("article")!;
		expect(within(card).getByText(/Node review/)).toHaveTextContent('Node review · {"subject":"candidate-7"}');
		expect(within(card).queryByRole("button", { name: "approve" })).toBeNull();
		await fireEvent.click(within(card).getByRole("button", { name: "ship" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Approval authority changed.");
		expect(screen.getByText("command-1")).toBeVisible();
		await fireEvent.click(within(card).getByRole("button", { name: "ship" }));
		expect(service.decideCommandApproval).toHaveBeenCalledWith("project-1", "run-1", "command-approval-1", digest, "ship");
		expect(service.decideCommandApproval).toHaveBeenCalledTimes(2);
		await waitFor(() => expect(screen.queryByText("command-1")).toBeNull());
	});

	test("shows list failure, then refreshes to the current empty inbox", async () => {
		const list = vi.fn()
			.mockRejectedValueOnce(new Error("Inbox unavailable."))
			.mockResolvedValueOnce({ items: [], nextCursor: null });
		const service = { listReleaseNotifications: list, decideReleaseApproval: vi.fn(), decideCommandApproval: vi.fn() } satisfies FactoryReleaseNotificationApi;
		render(FactoryReleaseInbox, { projectId: "project-1", api: service });
		expect(await screen.findByRole("alert")).toHaveTextContent("Inbox unavailable.");
		await fireEvent.click(screen.getByRole("button", { name: "Refresh factory inbox" }));
		expect(await screen.findByText("No factory actions need your attention.")).toBeVisible();
	});

	test("does not load notifications without a selected project", () => {
		const service = api();
		render(FactoryReleaseInbox, { projectId: "", api: service });
		expect(service.listReleaseNotifications).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Refresh factory inbox" })).toBeDisabled();
	});
});
