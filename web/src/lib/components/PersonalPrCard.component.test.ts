import "@testing-library/jest-dom/vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import PersonalPrCard from "./PersonalPrCard.svelte";

afterEach(() => { vi.unstubAllGlobals(); });

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ready = {
	state: "ready",
	proposalId: "proposal-1",
	digest: "a".repeat(64),
	repository: { id: 42, fullName: "owner/repo", baseRef: "main", baseSha: "b".repeat(40) },
	files: [{ path: "src/file.ts", status: "modified", additions: 2, deletions: 1 }],
	title: "Fix file",
	body: "Tested",
} as const;

describe("PersonalPrCard", () => {
	test("prepares an eligible completed run and opens the frozen proposal", async () => {
		const fetch = vi.fn().mockResolvedValueOnce(response({ state: "working", blockReason: "review_not_prepared", projectId: "p1" })).mockResolvedValueOnce(response(ready));
		vi.stubGlobal("fetch", fetch);
		const onreview = vi.fn();
		const view = render(PersonalPrCard, { runId: "run-1", onreview });
		await waitFor(() => expect(view.getByText("Changes ready for review")).toBeVisible());
		expect(view.queryByText("review_not_prepared")).not.toBeInTheDocument();
		await fireEvent.click(view.getByRole("button", { name: "Prepare PR review" }));
		await waitFor(() => expect(onreview).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "proposal-1", digest: ready.digest })));
		expect(fetch).toHaveBeenCalledWith("/api/github/personal-prs/runs/run-1/prepare", expect.objectContaining({ method: "POST", body: "{}" }));
	});

	test("ready review opens without preparing a second proposal", async () => {
		const fetch = vi.fn().mockResolvedValue(response(ready));
		vi.stubGlobal("fetch", fetch);
		const onreview = vi.fn();
		const view = render(PersonalPrCard, { runId: "run-1", onreview });
		await waitFor(() => expect(view.getByText("PR ready for review")).toBeVisible());
		await fireEvent.click(view.getByRole("button", { name: "Review & create draft PR" }));
		expect(onreview).toHaveBeenCalledWith(ready);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("blocked, stale, failed, and creating states use accurate labels", async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce(response({ state: "blocked", blockReason: "run_not_successful" }))
			.mockResolvedValueOnce(response({ state: "stale" }))
			.mockResolvedValueOnce(response({ state: "failed" }))
			.mockResolvedValueOnce(response({ state: "creating" }));
		vi.stubGlobal("fetch", fetch);
		const view = render(PersonalPrCard, { runId: "run-1", onreview: vi.fn() });
		await waitFor(() => expect(view.getByText("PR review blocked")).toBeVisible());
		expect(view.getByText(/did not finish successfully/)).toBeVisible();
		expect(view.queryByRole("link", { name: "Manage GitHub access" })).not.toBeInTheDocument();
		await view.rerender({ runId: "run-2", onreview: vi.fn() });
		await waitFor(() => expect(view.getByText("PR review expired")).toBeVisible());
		await view.rerender({ runId: "run-3", onreview: vi.fn() });
		await waitFor(() => expect(view.getByText("Draft PR creation failed")).toBeVisible());
		await view.rerender({ runId: "run-4", onreview: vi.fn() });
		await waitFor(() => expect(view.getByText("Creating draft PR")).toBeVisible());
	});

	test("a run with no PR proposal renders no card", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "Not found" }, 404)));
		const view = render(PersonalPrCard, { runId: "run-2", onreview: vi.fn() });
		await waitFor(() => expect(view.queryByTestId("personal-pr-card")).not.toBeInTheDocument());
	});

	test("blocks an unsafe provider link in created state", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...ready, state: "created", prUrl: "https://github.com.evil.test/owner/repo/pull/1" })));
		const view = render(PersonalPrCard, { runId: "run-3", onreview: vi.fn() });
		await waitFor(() => expect(view.getByText("Draft PR created")).toBeVisible());
		expect(view.queryByRole("link", { name: "View PR on GitHub" })).not.toBeInTheDocument();
	});
});
