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
	test("loads durable ready state and opens the exact proposal for review", async () => {
		const fetch = vi.fn().mockResolvedValueOnce(response(ready)).mockResolvedValueOnce(response({ ...ready, state: "reviewing" }));
		vi.stubGlobal("fetch", fetch);
		const onreview = vi.fn();
		const view = render(PersonalPrCard, { runId: "run-1", onreview });
		await waitFor(() => expect(view.getByText("Nothing pushed yet.")).toBeVisible());
		await fireEvent.click(view.getByRole("button", { name: "Review & create draft PR" }));
		await waitFor(() => expect(onreview).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "proposal-1", digest: ready.digest })));
		expect(fetch).toHaveBeenCalledWith("/api/github/personal-prs/runs/run-1/prepare", expect.objectContaining({ method: "POST", body: "{}" }));
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
