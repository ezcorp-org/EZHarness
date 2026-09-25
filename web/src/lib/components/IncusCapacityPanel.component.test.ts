import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import IncusCapacityPanel from "./IncusCapacityPanel.svelte";

const digest = "a".repeat(64);
const plan = {
	setupId: "setup:1", planDigest: digest, expiresAt: "2999-01-01T00:00:00Z",
	observation: { hostId: "reviewed-host" },
	capacity: { allocatable: { memoryBytes: 8 * 1024 ** 3, cpuMillicores: 4000,
		diskBytes: 40 * 1024 ** 3, pids: 2048, executionSlots: 3 } },
};
const receipt = { plan, appliedAt: "2026-09-25T12:00:00Z", appliedBy: "admin" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
	status, headers: { "content-type": "application/json" },
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function review() {
	await fireEvent.click(screen.getByRole("button", { name: "Plan capacity" }));
	await waitFor(() => expect(screen.getByText(digest)).toBeVisible());
	await fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed these host limits/ }));
}

describe("IncusCapacityPanel", () => {
	test("loads saved capacity without inviting a second apply", async () => {
		const fetcher = vi.fn().mockResolvedValue(reply({ receipt }));
		vi.stubGlobal("fetch", fetcher);
		const view = render(IncusCapacityPanel, { setupId: "setup:1" });
		await waitFor(() => expect(view.getByText("Capacity is saved for this verified setup.")).toBeVisible());
		expect(view.getByText("8 GiB")).toBeVisible();
		expect(view.getByText("4 cores")).toBeVisible();
		expect(view.getByText("40 GiB")).toBeVisible();
		expect(view.getByText("2048")).toBeVisible();
		expect(view.getByText("3")).toBeVisible();
		expect(view.queryByRole("button", { name: "Plan capacity" })).toBeNull();
		expect(fetcher).toHaveBeenCalledWith("/api/infrastructure/incus/capacity?setupId=setup%3A1", { cache: "no-store" });
	});

	test("plans from the verified host and applies the exact reviewed object and digest", async () => {
		const fetcher = vi.fn().mockResolvedValueOnce(reply({ receipt: null }))
			.mockResolvedValueOnce(reply({ plan })).mockResolvedValueOnce(reply({ receipt }));
		vi.stubGlobal("fetch", fetcher);
		const onapplied = vi.fn();
		const view = render(IncusCapacityPanel, { setupId: "setup:1", onapplied });
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
		await fireEvent.click(view.getByRole("button", { name: "Plan capacity" }));
		await waitFor(() => expect(view.getByText(digest)).toBeVisible());
		expect(view.getByText("reviewed-host", { exact: false })).toBeVisible();
		expect(view.getByRole("button", { name: "Apply reviewed capacity" })).toBeDisabled();
		await fireEvent.click(view.getByRole("checkbox", { name: /I reviewed these host limits/ }));
		await fireEvent.click(view.getByRole("button", { name: "Apply reviewed capacity" }));
		await waitFor(() => expect(onapplied).toHaveBeenCalledWith(receipt));
		expect(JSON.parse(String(fetcher.mock.calls[1]![1].body))).toEqual({ action: "plan", setupId: "setup:1" });
		expect(JSON.parse(String(fetcher.mock.calls[2]![1].body))).toEqual({ action: "apply", plan, planDigest: digest });
		expect(view.getByText("Capacity is saved for this verified setup.")).toBeVisible();
	});

	test("checks saved status after an uncertain apply response and accepts the matching receipt", async () => {
		const fetcher = vi.fn().mockResolvedValueOnce(reply({ receipt: null }))
			.mockResolvedValueOnce(reply({ plan })).mockRejectedValueOnce(new TypeError("network lost"))
			.mockResolvedValueOnce(reply({ receipt }));
		vi.stubGlobal("fetch", fetcher);
		const onapplied = vi.fn();
		const view = render(IncusCapacityPanel, { setupId: "setup:1", onapplied });
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
		await review();
		await fireEvent.click(view.getByRole("button", { name: "Apply reviewed capacity" }));
		await waitFor(() => expect(view.getByText("Capacity is saved for this verified setup.")).toBeVisible());
		expect(fetcher.mock.calls[3]![0]).toBe("/api/infrastructure/incus/capacity?setupId=setup%3A1");
		expect(onapplied).toHaveBeenCalledWith(receipt);
	});

	test("shows an actionable rejection after status confirms no capacity was saved", async () => {
		const fetcher = vi.fn().mockResolvedValueOnce(reply({ receipt: null }))
			.mockResolvedValueOnce(reply({ plan })).mockResolvedValueOnce(reply({ message: "Cannot apply" }, 409))
			.mockResolvedValueOnce(reply({ receipt: null }))
			.mockResolvedValueOnce(reply({ plan }));
		vi.stubGlobal("fetch", fetcher);
		const view = render(IncusCapacityPanel, { setupId: "setup:1" });
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
		await review();
		await fireEvent.click(view.getByRole("button", { name: "Apply reviewed capacity" }));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Cannot apply"));
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
		await fireEvent.click(view.getByRole("button", { name: "Plan capacity" }));
		await waitFor(() => expect(view.getByText(digest)).toBeVisible());
		expect(fetcher).toHaveBeenCalledTimes(5);
	});

	test("requires an explicit recheck after transport loss with no saved receipt", async () => {
		const fetcher = vi.fn().mockResolvedValueOnce(reply({ receipt: null }))
			.mockResolvedValueOnce(reply({ plan })).mockRejectedValueOnce(new TypeError("network lost"))
			.mockResolvedValueOnce(reply({ receipt: null })).mockResolvedValueOnce(reply({ receipt: null }));
		vi.stubGlobal("fetch", fetcher);
		const view = render(IncusCapacityPanel, { setupId: "setup:1" });
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
		await review();
		await fireEvent.click(view.getByRole("button", { name: "Apply reviewed capacity" }));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Apply result is uncertain"));
		expect(view.getByRole("button", { name: "Plan capacity" })).toBeDisabled();
		await fireEvent.click(view.getByRole("button", { name: "Check saved status" }));
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
	});

	test("keeps retry blocked when the status check also fails", async () => {
		const fetcher = vi.fn().mockResolvedValueOnce(reply({ receipt: null }))
			.mockResolvedValueOnce(reply({ plan })).mockRejectedValueOnce(new TypeError("network lost"))
			.mockRejectedValueOnce(new TypeError("status lost"))
			.mockResolvedValueOnce(reply({ receipt: null }));
		vi.stubGlobal("fetch", fetcher);
		const view = render(IncusCapacityPanel, { setupId: "setup:1" });
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
		await review();
		await fireEvent.click(view.getByRole("button", { name: "Apply reviewed capacity" }));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("saved status could not be checked"));
		expect(view.getByRole("button", { name: "Plan capacity" })).toBeDisabled();
		await fireEvent.click(view.getByRole("button", { name: "Check saved status" }));
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
	});

	test("shows a different saved plan after a failed apply without claiming this plan succeeded", async () => {
		const other = { ...receipt, plan: { ...plan, planDigest: "b".repeat(64) } };
		const fetcher = vi.fn().mockResolvedValueOnce(reply({ receipt: null }))
			.mockResolvedValueOnce(reply({ plan })).mockResolvedValueOnce(reply({ message: "Changed" }, 409))
			.mockResolvedValueOnce(reply({ receipt: other }));
		vi.stubGlobal("fetch", fetcher);
		const onapplied = vi.fn();
		const view = render(IncusCapacityPanel, { setupId: "setup:1", onapplied });
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
		await review();
		await fireEvent.click(view.getByRole("button", { name: "Apply reviewed capacity" }));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("A different capacity plan was saved"));
		expect(view.getByText("b".repeat(64))).toBeVisible();
		expect(onapplied).not.toHaveBeenCalled();
	});

	test("rejects an expired plan locally and surfaces plan or status errors", async () => {
		const expired = { ...plan, expiresAt: "2000-01-01T00:00:00Z" };
		const fetcher = vi.fn().mockResolvedValueOnce(reply({ receipt: null }))
			.mockResolvedValueOnce(reply({ message: "Host unavailable" }, 409))
			.mockResolvedValueOnce(reply({ plan: expired }));
		vi.stubGlobal("fetch", fetcher);
		const view = render(IncusCapacityPanel, { setupId: "setup:1" });
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
		await fireEvent.click(view.getByRole("button", { name: "Plan capacity" }));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Host unavailable"));
		await review();
		await fireEvent.click(view.getByRole("button", { name: "Apply reviewed capacity" }));
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("This plan expired"));
		expect(fetcher).toHaveBeenCalledTimes(3);
	});

	test("reports status failure and recovers through a fresh status check", async () => {
		let resolveStatus!: (response: Response) => void;
		const pendingStatus = new Promise<Response>((resolve) => { resolveStatus = resolve; });
		const fetcher = vi.fn().mockResolvedValueOnce(reply({ message: "Setup unavailable" }, 409))
			.mockReturnValueOnce(pendingStatus);
		vi.stubGlobal("fetch", fetcher);
		const view = render(IncusCapacityPanel, { setupId: "setup:1" });
		await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Setup unavailable"));
		expect(view.getByRole("button", { name: "Plan capacity" })).toBeDisabled();
		await fireEvent.click(view.getByRole("button", { name: "Check saved status" }));
		await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
		expect(view.getByRole("button", { name: "Plan capacity" })).toBeDisabled();
		resolveStatus(reply({ receipt: null }));
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
	});

	test("ignores an old apply failure after the selected setup changes", async () => {
		let rejectOldApply!: (cause: Error) => void;
		const pending = new Promise<Response>((_resolve, reject) => { rejectOldApply = reject; });
		const fetcher = vi.fn().mockResolvedValueOnce(reply({ receipt: null }))
			.mockResolvedValueOnce(reply({ plan })).mockReturnValueOnce(pending)
			.mockResolvedValueOnce(reply({ receipt: null }));
		vi.stubGlobal("fetch", fetcher);
		const view = render(IncusCapacityPanel, { setupId: "setup:1" });
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
		await review();
		await fireEvent.click(view.getByRole("button", { name: "Apply reviewed capacity" }));
		await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
		await view.rerender({ setupId: "setup:2" });
		await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
		rejectOldApply(new Error("old setup failed"));
		await waitFor(() => expect(view.getByRole("button", { name: "Plan capacity" })).not.toBeDisabled());
		expect(view.queryByRole("alert")).toBeNull();
		expect(fetcher).toHaveBeenCalledTimes(4);
	});
});
