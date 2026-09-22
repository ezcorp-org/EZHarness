/**
 * DOM tests for the GitHub-style code review panel.
 *
 * Covers the behaviour that only exists once the model is wired into the real
 * component: the merged single file list, the header totals + viewed
 * progress, the filter box, expand/collapse (per file and all), the Viewed
 * checkbox (collapse + persistence + progress), the file tree, and the
 * split/unified preference round-trip.
 *
 * diff2html emits the two-column `.d2h-file-side-diff` only in side-by-side
 * mode; line-by-line renders a single column without it — that's the DOM
 * signal used to tell the modes apart.
 */

import { render, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import DiffSummaryPanel from "./DiffSummaryPanel.svelte";
import type { Message } from "$lib/api";
import { DIFF_VIEW_MODE_KEY } from "$lib/diff-view-mode";
import { viewedFilesKey } from "$lib/diff-review/viewed-files";
import { LARGE_DIFF_LINES } from "$lib/diff-review/review-model";

const CONV_ID = "conv-review";

const DIFF_MD = [
	"```diff",
	"--- a/src/auth.ts",
	"+++ b/src/auth.ts",
	"@@ -1,2 +1,2 @@",
	"-const ok = false;",
	"+const ok = true;",
	"```",
].join("\n");

const SECOND_DIFF_MD = [
	"```diff",
	"--- a/web/ui.svelte",
	"+++ b/web/ui.svelte",
	"@@ -1,1 +1,3 @@",
	"-<p>old</p>",
	"+<p>new</p>",
	"+<p>extra</p>",
	"```",
].join("\n");

function assistantMsg(content: string, id = "m1"): Message {
	return {
		id,
		conversationId: CONV_ID,
		role: "assistant",
		content,
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: null,
		parentMessageId: null,
		excluded: false,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

function editToolCall(filePath: string, id = "tc1") {
	return {
		id,
		conversationId: CONV_ID,
		extensionName: "builtin",
		toolName: "edit_file",
		input: { file_path: filePath, old_string: "before", new_string: "after" },
		status: "complete" as const,
		retryCount: 0,
	};
}

function renderPanel(overrides: Record<string, unknown> = {}) {
	return render(DiffSummaryPanel, {
		messages: [assistantMsg(DIFF_MD)],
		toolCalls: [],
		open: true,
		onclose: () => {},
		streaming: false,
		conversationId: CONV_ID,
		...overrides,
	});
}

afterEach(() => cleanup());
beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

test("confirms only the saved personal PR snapshot after a human reviews its files", async () => {
	const review = {
		state: "reviewing", proposalId: "proposal-1", digest: "a".repeat(64),
		repository: { id: 42, fullName: "owner/repo", baseRef: "main", baseSha: "b".repeat(40) },
		files: [{ path: "src/exact-file.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-before\n+after", binary: false }],
		checks: [{ name: "tests", result: "passed" }], title: "Original title", body: "Original body",
	} as const;
	const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...review, state: "created", prUrl: "https://github.com/owner/repo/pull/7" }), { headers: { "content-type": "application/json" } }));
	vi.stubGlobal("fetch", fetch);
	const onpersonalprupdate = vi.fn();
	const view = renderPanel({ personalPr: review, onpersonalprupdate });
	expect(view.getAllByText(/src\/exact-file\.ts/)).toHaveLength(2);
	expect(view.getByTestId("personal-pr-exact-diff")).toHaveTextContent("+after");
	expect(view.getByText(/The file list below is the saved run snapshot/)).toBeVisible();
	expect(view.queryByText("No file changes in this conversation")).not.toBeInTheDocument();
	await fireEvent.input(view.getByLabelText("PR title"), { target: { value: "Reviewed title" } });
	await fireEvent.click(view.getByRole("button", { name: "Create draft PR" }));
	await waitFor(() => expect(onpersonalprupdate).toHaveBeenCalledWith(expect.objectContaining({ state: "created", prUrl: "https://github.com/owner/repo/pull/7" })));
	const [url, init] = fetch.mock.calls[0]!;
	expect(url).toBe("/api/github/personal-prs/proposals/proposal-1/confirm");
	expect(JSON.parse(init.body)).toMatchObject({ expectedDigest: review.digest, title: "Reviewed title", body: "Original body", idempotencyKey: expect.any(String) });
});

test("refuses PR confirmation when the exact server diff is absent", () => {
	const view = renderPanel({ personalPr: {
		state: "reviewing", proposalId: "proposal-1", digest: "a".repeat(64),
		files: [{ path: "src/file.ts", status: "modified", additions: 1, deletions: 1 }],
		title: "Fix file", body: "Tested",
	} });
	expect(view.getByText("Exact diff unavailable.")).toBeVisible();
	expect(view.getByRole("button", { name: "Create draft PR" })).toBeDisabled();
});

test("reconciles an uncertain failed publication through confirm without offering a new create", async () => {
	const failed = {
		state: "failed", recoveryAction: "check_github", proposalId: "proposal-1", digest: "a".repeat(64),
		files: [{ path: "src/file.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-before\n+after", binary: false }],
		title: "Fix file", body: "Tested", checks: [],
	} as const;
	const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...failed, state: "created", prUrl: "https://github.com/owner/repo/pull/7" }), { headers: { "content-type": "application/json" } }));
	vi.stubGlobal("fetch", fetch);
	const onpersonalprupdate = vi.fn();
	const view = renderPanel({ personalPr: failed, onpersonalprupdate });
	expect(view.getByText("No verified checks recorded")).toBeVisible();
	expect(view.queryByRole("button", { name: "Create draft PR" })).not.toBeInTheDocument();
	await fireEvent.click(view.getByRole("button", { name: "Check GitHub result" }));
	await waitFor(() => expect(onpersonalprupdate).toHaveBeenCalledWith(expect.objectContaining({ state: "created" })));
	expect(fetch).toHaveBeenCalledWith("/api/github/personal-prs/proposals/proposal-1/confirm", expect.objectContaining({ method: "POST" }));
	expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ expectedDigest: failed.digest, title: failed.title, body: failed.body });
});

test("explicitly retries only a failed pre-ref attempt from the frozen review", async () => {
	const failed = {
		state: "failed", recoveryAction: "retry_pre_ref", proposalId: "proposal-1", digest: "a".repeat(64),
		files: [{ path: "src/file.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-before\n+after", binary: false }],
		title: "Fix file", body: "Tested", checks: [],
	} as const;
	const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...failed, state: "created", prUrl: "https://github.com/owner/repo/pull/7" }), { headers: { "content-type": "application/json" } }));
	vi.stubGlobal("fetch", fetch);
	const onpersonalprupdate = vi.fn();
	const view = renderPanel({ personalPr: failed, onpersonalprupdate });
	expect(view.getByText(/No GitHub commit was sent/)).toBeVisible();
	expect(view.queryByRole("button", { name: "Check GitHub result" })).not.toBeInTheDocument();
	await fireEvent.click(view.getByRole("button", { name: "Retry draft PR publication" }));
	await waitFor(() => expect(onpersonalprupdate).toHaveBeenCalledWith(expect.objectContaining({ state: "created" })));
	expect(fetch).toHaveBeenCalledWith("/api/github/personal-prs/proposals/proposal-1/confirm", expect.objectContaining({ method: "POST" }));
});

test("checks stored status after an uncertain confirmation and reports check errors", async () => {
	const review = {
		state: "reviewing", proposalId: "proposal-1", digest: "a".repeat(64),
		files: [{ path: "src/file.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-before\n+after", binary: false }],
		title: "Fix file", body: "Tested", checks: [],
	} as const;
	const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const fetch = vi.fn()
		.mockResolvedValueOnce(response({ error: "Confirmation outcome unknown" }, 503))
		.mockResolvedValueOnce(response({ error: "GitHub still unavailable" }, 503))
		.mockResolvedValueOnce(response({ ...review, state: "failed", recoveryAction: "check_github" }));
	vi.stubGlobal("fetch", fetch);
	const onpersonalprupdate = vi.fn();
	const view = renderPanel({ personalPr: review, onpersonalprupdate });
	await fireEvent.click(view.getByRole("button", { name: "Create draft PR" }));
	await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("Confirmation outcome unknown"));
	await fireEvent.click(view.getByRole("button", { name: "Check status" }));
	await waitFor(() => expect(view.getByRole("alert")).toHaveTextContent("GitHub still unavailable"));
	await fireEvent.click(view.getByRole("button", { name: "Check status" }));
	await waitFor(() => expect(onpersonalprupdate).toHaveBeenCalledWith(expect.objectContaining({ state: "failed", recoveryAction: "check_github" })));
	expect(fetch.mock.calls.slice(1).map(([url]) => url)).toEqual(["/api/github/personal-prs/proposals/proposal-1", "/api/github/personal-prs/proposals/proposal-1"]);
});

test("shows exact binary review bytes and hashes", () => {
	const view = renderPanel({ personalPr: {
		state: "reviewing", proposalId: "proposal-1", digest: "a".repeat(64), title: "Binary change", body: "",
		files: [{ path: "assets/icon.png", status: "modified", additions: 0, deletions: 0, binary: true,
			beforeBytes: 2, afterBytes: 3, beforeSha256: "b".repeat(64), afterSha256: "c".repeat(64), beforeBase64: "AAE=", afterBase64: "AAEC" }],
		checks: [],
	} });
	expect(view.getByText(/Binary change. Review the exact bytes/)).toBeVisible();
	expect(view.getByText(/Before: 2 bytes/)).toHaveTextContent("b".repeat(64));
	expect(view.getByText(/After: 3 bytes/)).toHaveTextContent("c".repeat(64));
	expect(view.getByRole("link", { name: "Download before" })).toHaveAttribute("href", "data:application/octet-stream;base64,AAE=");
	expect(view.getByRole("link", { name: "Download after" })).toHaveAttribute("href", "data:application/octet-stream;base64,AAEC");
});

test("a changed base asks for reimport without offering publication", () => {
	const view = renderPanel({ personalPr: { state: "stale", recoveryAction: "reimport", proposalId: "proposal-1", digest: "a".repeat(64), files: [], checks: [] } });
	expect(view.getByText(/Start a new private sandbox import/)).toBeVisible();
	expect(view.queryByRole("button", { name: "Create draft PR" })).not.toBeInTheDocument();
});

test("a created proposal shows only a validated GitHub PR link", () => {
	const view = renderPanel({ personalPr: { state: "created", proposalId: "proposal-1", digest: "a".repeat(64), files: [], checks: [], prUrl: "https://github.com/owner/repo/pull/7" } });
	expect(view.getByRole("link", { name: "Open draft PR on GitHub" })).toHaveAttribute("href", "https://github.com/owner/repo/pull/7");
	view.unmount();
	const unsafe = renderPanel({ personalPr: { state: "created", proposalId: "proposal-2", files: [], checks: [], prUrl: "https://github.com.evil.test/owner/repo/pull/7" } });
	expect(unsafe.queryByRole("link", { name: "Open draft PR on GitHub" })).not.toBeInTheDocument();
	expect(unsafe.getByText("PR status: created")).toBeVisible();
});

describe("code review panel — header", () => {
	test("titles the panel 'Files changed' like GitHub's review tab", () => {
		const { getByRole } = renderPanel();
		expect(getByRole("heading", { level: 2 })).toHaveTextContent("Files changed");
	});

	test("shows the file count and the +N −M totals", () => {
		const { getByTestId } = renderPanel();
		expect(getByTestId("diff-review-count")).toHaveTextContent("1");
		expect(getByTestId("diff-review-totals")).toHaveTextContent("+1");
		expect(getByTestId("diff-review-totals")).toHaveTextContent("−1");
	});

	test("renders a five-square diffstat bar", () => {
		const { getAllByTestId } = renderPanel();
		const bar = getAllByTestId("diff-stat-bar")[0]!;
		expect(bar.querySelectorAll("[data-block]")).toHaveLength(5);
	});

	test("totals sum across every file in the review", () => {
		const { getByTestId } = renderPanel({
			messages: [assistantMsg(DIFF_MD), assistantMsg(SECOND_DIFF_MD, "m2")],
		});
		expect(getByTestId("diff-review-count")).toHaveTextContent("2");
		expect(getByTestId("diff-review-totals")).toHaveTextContent("+3");
		expect(getByTestId("diff-review-totals")).toHaveTextContent("−2");
	});
});

describe("code review panel — file list", () => {
	test("merges tool-call edits and fenced message diffs into ONE file list", () => {
		const { getAllByTestId } = renderPanel({ toolCalls: [editToolCall("src/tool-edited.ts")] });
		const cards = getAllByTestId("diff-file-card");
		expect(cards.map((c) => c.getAttribute("data-path"))).toEqual([
			"src/tool-edited.ts",
			"src/auth.ts",
		]);
	});

	test("each card shows its own path and +N −M counts", () => {
		const { getAllByTestId } = renderPanel();
		expect(getAllByTestId("diff-file-card")[0]).toHaveTextContent("src/auth.ts");
		expect(getAllByTestId("diff-file-stat")[0]).toHaveTextContent("+1");
		expect(getAllByTestId("diff-file-stat")[0]).toHaveTextContent("−1");
	});

	test("files open expanded, as GitHub does", async () => {
		const { getAllByTestId } = renderPanel();
		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-expanded", "true");
		});
	});

	test("clicking the chevron collapses the file body", async () => {
		const { getAllByTestId, queryAllByTestId } = renderPanel();
		await fireEvent.click(getAllByTestId("diff-file-toggle")[0]!);
		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-expanded", "false");
		});
		expect(queryAllByTestId("diff-file-body")).toHaveLength(0);
	});

	test("Collapse all closes every file, then flips to Expand all", async () => {
		const { getByTestId, getAllByTestId } = renderPanel({
			messages: [assistantMsg(DIFF_MD), assistantMsg(SECOND_DIFF_MD, "m2")],
		});
		await fireEvent.click(getByTestId("diff-toggle-all"));
		await waitFor(() => {
			for (const card of getAllByTestId("diff-file-card")) {
				expect(card).toHaveAttribute("data-expanded", "false");
			}
		});
		expect(getByTestId("diff-toggle-all")).toHaveTextContent("Expand all");

		await fireEvent.click(getByTestId("diff-toggle-all"));
		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-expanded", "true");
		});
	});

	test("two diffs to the SAME file across messages both render", () => {
		// Regression: the tree keyed on path, so a conversation that touched one
		// file twice raised Svelte's each_key_duplicate and blanked the panel.
		const { getAllByTestId } = renderPanel({
			messages: [assistantMsg(DIFF_MD), assistantMsg(DIFF_MD, "m2")],
		});
		const cards = getAllByTestId("diff-file-card");
		expect(cards).toHaveLength(2);
		expect(cards.every((c) => c.getAttribute("data-path") === "src/auth.ts")).toBe(true);
		expect(getAllByTestId("review-tree-file")).toHaveLength(2);
	});

	test("a very large diff opens collapsed behind GitHub's note, and one click renders it", async () => {
		const huge = ["```diff", "--- a/big.ts", "+++ b/big.ts", "@@ -1 +1 @@"]
			.concat(Array.from({ length: LARGE_DIFF_LINES + 1 }, (_, i) => `+line ${i}`))
			.concat(["```"])
			.join("\n");
		const { getByTestId, getAllByTestId, queryAllByTestId } = renderPanel({
			messages: [assistantMsg(huge)],
		});

		expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-expanded", "false");
		expect(queryAllByTestId("diff-file-body")).toHaveLength(0);
		expect(getByTestId("diff-large-note")).toHaveTextContent(
			"Large diffs are not rendered by default.",
		);

		await fireEvent.click(getByTestId("diff-large-note"));
		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-expanded", "true");
		});
	});

	test("Expand all opens the large files too", async () => {
		const huge = ["```diff", "--- a/big.ts", "+++ b/big.ts", "@@ -1 +1 @@"]
			.concat(Array.from({ length: LARGE_DIFF_LINES + 1 }, (_, i) => `+line ${i}`))
			.concat(["```"])
			.join("\n");
		const { getByTestId, getAllByTestId } = renderPanel({ messages: [assistantMsg(huge)] });

		// Nothing is open, so the bulk control offers "Expand all".
		expect(getByTestId("diff-toggle-all")).toHaveTextContent("Expand all");
		await fireEvent.click(getByTestId("diff-toggle-all"));
		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-expanded", "true");
		});
	});

	test("a diff that only adds lines is badged as an added file", () => {
		const addOnly = ["```diff", "+++ b/src/new.ts", "@@ -0,0 +1,2 @@", "+one", "+two", "```"].join(
			"\n",
		);
		const { getByTestId, getAllByTestId } = renderPanel({ messages: [assistantMsg(addOnly)] });
		expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-status", "added");
		expect(getByTestId("diff-file-status")).toHaveTextContent("Added");
	});
});

describe("code review panel — filter", () => {
	test("filters the list to matching paths", async () => {
		const { getByTestId, getAllByTestId } = renderPanel({
			messages: [assistantMsg(DIFF_MD), assistantMsg(SECOND_DIFF_MD, "m2")],
		});
		await fireEvent.input(getByTestId("diff-file-filter"), { target: { value: "auth" } });
		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")).toHaveLength(1);
		});
		expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-path", "src/auth.ts");
	});

	test("a filter that matches nothing shows the no-match state, and Clear filter restores", async () => {
		const { getByTestId, getAllByTestId, queryByTestId } = renderPanel();
		await fireEvent.input(getByTestId("diff-file-filter"), { target: { value: "zzz" } });
		await waitFor(() => {
			expect(getByTestId("diff-filter-empty")).toBeInTheDocument();
		});
		// The real empty state stays reserved for "no changes at all".
		expect(queryByTestId("diff-panel-empty")).toBeNull();

		await fireEvent.click(getByTestId("diff-filter-empty").querySelector("button")!);
		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")).toHaveLength(1);
		});
	});

	test("the header count follows the filter", async () => {
		const { getByTestId } = renderPanel({
			messages: [assistantMsg(DIFF_MD), assistantMsg(SECOND_DIFF_MD, "m2")],
		});
		await fireEvent.input(getByTestId("diff-file-filter"), { target: { value: "auth" } });
		await waitFor(() => {
			expect(getByTestId("diff-review-count")).toHaveTextContent("1");
		});
	});
});

describe("code review panel — Viewed checkbox", () => {
	test("ticking Viewed collapses the file and advances the progress", async () => {
		const { getByTestId, getAllByTestId } = renderPanel();
		expect(getByTestId("diff-viewed-progress")).toHaveTextContent("0 / 1 files viewed");

		await fireEvent.click(getAllByTestId("diff-viewed-checkbox")[0]!);
		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-viewed", "true");
		});
		expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-expanded", "false");
		expect(getByTestId("diff-viewed-progress")).toHaveTextContent("1 / 1 files viewed");
	});

	test("the progress bar fills proportionally", async () => {
		const { getByTestId, getAllByTestId } = renderPanel({
			messages: [assistantMsg(DIFF_MD), assistantMsg(SECOND_DIFF_MD, "m2")],
		});
		expect(getByTestId("diff-viewed-progress-fill").style.width).toBe("0%");
		await fireEvent.click(getAllByTestId("diff-viewed-checkbox")[0]!);
		await waitFor(() => {
			expect(getByTestId("diff-viewed-progress-fill").style.width).toBe("50%");
		});
	});

	test("the tick persists per conversation and is restored on mount", async () => {
		const { getAllByTestId, unmount } = renderPanel();
		await fireEvent.click(getAllByTestId("diff-viewed-checkbox")[0]!);
		await waitFor(() => {
			expect(localStorage.getItem(viewedFilesKey(CONV_ID))).toContain("code:m1#0");
		});
		unmount();

		const again = renderPanel();
		await waitFor(() => {
			expect(again.getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-viewed", "true");
		});
	});

	test("switching conversation resets the filter and collapse state", async () => {
		const { getByTestId, getAllByTestId, rerender } = renderPanel({
			messages: [assistantMsg(DIFF_MD), assistantMsg(SECOND_DIFF_MD, "m2")],
		});
		await fireEvent.input(getByTestId("diff-file-filter"), { target: { value: "auth" } });
		await fireEvent.click(getByTestId("diff-toggle-all"));
		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-expanded", "false");
		});

		await rerender({
			messages: [assistantMsg(DIFF_MD), assistantMsg(SECOND_DIFF_MD, "m2")],
			toolCalls: [],
			open: true,
			onclose: () => {},
			streaming: false,
			conversationId: "another-conv",
		});

		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")).toHaveLength(2);
		});
		expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-expanded", "true");
		expect(getByTestId("diff-file-filter")).toHaveValue("");
	});

	test("another conversation's ticks do not leak in", async () => {
		localStorage.setItem(viewedFilesKey("other-conv"), JSON.stringify(["code:m1#0"]));
		const { getAllByTestId } = renderPanel();
		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-viewed", "false");
		});
	});

	test("un-ticking re-opens the file", async () => {
		const { getAllByTestId } = renderPanel();
		await fireEvent.click(getAllByTestId("diff-viewed-checkbox")[0]!);
		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-viewed", "true");
		});
		await fireEvent.click(getAllByTestId("diff-viewed-checkbox")[0]!);
		await waitFor(() => {
			expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-expanded", "true");
		});
	});
});

describe("code review panel — file tree", () => {
	test("nests files under directory rows", () => {
		const { getByTestId, getAllByTestId } = renderPanel();
		expect(getByTestId("diff-file-tree")).toBeInTheDocument();
		expect(getAllByTestId("review-tree-dir").map((d) => d.getAttribute("data-path"))).toEqual([
			"src",
		]);
		expect(getAllByTestId("review-tree-file").map((f) => f.getAttribute("data-path"))).toEqual([
			"src/auth.ts",
		]);
	});

	test("collapsing a directory hides its files", async () => {
		const { getAllByTestId, queryAllByTestId } = renderPanel();
		await fireEvent.click(getAllByTestId("review-tree-dir")[0]!);
		await waitFor(() => {
			expect(queryAllByTestId("review-tree-file")).toHaveLength(0);
		});
	});

	test("the rail hides and comes back", async () => {
		const { getByTestId, queryByTestId } = renderPanel();
		await fireEvent.click(getByTestId("diff-tree-hide"));
		await waitFor(() => {
			expect(queryByTestId("diff-file-tree")).toBeNull();
		});
		await fireEvent.click(getByTestId("diff-tree-show"));
		await waitFor(() => {
			expect(getByTestId("diff-file-tree")).toBeInTheDocument();
		});
	});

	test("a viewed file is marked in the tree", async () => {
		const { getAllByTestId } = renderPanel();
		await fireEvent.click(getAllByTestId("diff-viewed-checkbox")[0]!);
		await waitFor(() => {
			expect(getAllByTestId("review-tree-file")[0]).toHaveAttribute("data-viewed", "true");
		});
	});

	test("clicking a tree row scrolls its card into view", async () => {
		const calls: string[] = [];
		const original = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
			calls.push(this.id);
		};
		try {
			const { getAllByTestId } = renderPanel();
			await fireEvent.click(getAllByTestId("review-tree-file")[0]!);
			expect(calls).toEqual(["review-file-code:m1#0"]);
		} finally {
			Element.prototype.scrollIntoView = original;
		}
	});
});

describe("code review panel — copy path", () => {
	function stubClipboard(writeText: (t: string) => Promise<void>) {
		const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		return () => {
			if (original) Object.defineProperty(navigator, "clipboard", original);
			else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "clipboard");
		};
	}

	test("copies the file path and flashes a confirmation", async () => {
		const written: string[] = [];
		const restore = stubClipboard(async (t) => void written.push(t));
		try {
			const { getAllByTestId } = renderPanel();
			await fireEvent.click(getAllByTestId("diff-copy-path")[0]!);
			await waitFor(() => {
				expect(written).toEqual(["src/auth.ts"]);
			});
			await waitFor(() => {
				expect(getAllByTestId("diff-copy-path")[0]!.querySelector("path")).toHaveAttribute(
					"d",
					expect.stringContaining("M13.78 4.22"),
				);
			});
		} finally {
			restore();
		}
	});

	test("a denied clipboard is swallowed — the header keeps working", async () => {
		const restore = stubClipboard(() => Promise.reject(new Error("denied")));
		try {
			const { getAllByTestId } = renderPanel();
			await fireEvent.click(getAllByTestId("diff-copy-path")[0]!);
			await waitFor(() => {
				expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-expanded", "true");
			});
			// Still the two-path "copy" glyph, not the single-path check.
			expect(getAllByTestId("diff-copy-path")[0]!.querySelectorAll("path")).toHaveLength(2);
		} finally {
			restore();
		}
	});
});

describe("code review panel — empty state", () => {
	test("shows the empty state when the conversation changed no files", () => {
		const { getByTestId, queryAllByTestId } = renderPanel({ messages: [], toolCalls: [] });
		expect(getByTestId("diff-panel-empty")).toHaveTextContent("No file changes");
		expect(queryAllByTestId("diff-file-card")).toHaveLength(0);
	});

	test("Collapse all is disabled with nothing to collapse", () => {
		const { getByTestId } = renderPanel({ messages: [], toolCalls: [] });
		expect(getByTestId("diff-toggle-all")).toBeDisabled();
	});

	test("the progress reads 0 / 0 rather than dividing by zero", () => {
		const { getByTestId } = renderPanel({ messages: [], toolCalls: [] });
		expect(getByTestId("diff-viewed-progress")).toHaveTextContent("0 / 0 files viewed");
		expect(getByTestId("diff-viewed-progress-fill").style.width).toBe("0%");
	});

	test("no file tree is drawn when there is nothing to list", () => {
		const { queryByTestId } = renderPanel({ messages: [], toolCalls: [] });
		expect(queryByTestId("diff-file-tree")).toBeNull();
		expect(queryByTestId("diff-tree-show")).toBeNull();
	});
});

describe("code review panel — streaming guard", () => {
	test("the in-flight message's half-written diff is left out", () => {
		const { getAllByTestId } = renderPanel({
			messages: [assistantMsg(DIFF_MD), assistantMsg(SECOND_DIFF_MD, "m2")],
			streaming: true,
		});
		expect(getAllByTestId("diff-file-card")).toHaveLength(1);
		expect(getAllByTestId("diff-file-card")[0]).toHaveAttribute("data-path", "src/auth.ts");
	});
});

describe("code review panel — split/unified preference persistence", () => {
	test("defaults to split when nothing is stored", async () => {
		const { container } = renderPanel();
		await waitFor(() => {
			expect(container.querySelector(".diff-panel-content .d2h-file-side-diff")).not.toBeNull();
		});
	});

	test("restores the persisted unified mode on mount (the refresh fix)", async () => {
		localStorage.setItem(DIFF_VIEW_MODE_KEY, "line-by-line");
		const { container } = renderPanel();
		await waitFor(() => {
			expect(container.querySelector(".diff-panel-content .d2h-wrapper")).not.toBeNull();
		});
		// Unified: the two-column side diff is absent.
		expect(container.querySelector(".diff-panel-content .d2h-file-side-diff")).toBeNull();
	});

	test("clicking Unified switches the view and persists the choice", async () => {
		const { container, getByRole } = renderPanel();
		await waitFor(() => {
			expect(container.querySelector(".diff-panel-content .d2h-file-side-diff")).not.toBeNull();
		});

		await fireEvent.click(getByRole("button", { name: "Unified" }));

		expect(localStorage.getItem(DIFF_VIEW_MODE_KEY)).toBe("line-by-line");
		await waitFor(() => {
			expect(container.querySelector(".diff-panel-content .d2h-file-side-diff")).toBeNull();
		});
	});

	test("clicking Split after Unified persists side-by-side again", async () => {
		localStorage.setItem(DIFF_VIEW_MODE_KEY, "line-by-line");
		const { container, getByRole } = renderPanel();
		await waitFor(() => {
			expect(container.querySelector(".diff-panel-content .d2h-wrapper")).not.toBeNull();
		});

		await fireEvent.click(getByRole("button", { name: "Split" }));

		expect(localStorage.getItem(DIFF_VIEW_MODE_KEY)).toBe("side-by-side");
		await waitFor(() => {
			expect(container.querySelector(".diff-panel-content .d2h-file-side-diff")).not.toBeNull();
		});
	});

	test("the active mode is marked pressed for assistive tech", () => {
		const { getByRole } = renderPanel();
		expect(getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true");
		expect(getByRole("button", { name: "Unified" })).toHaveAttribute("aria-pressed", "false");
	});
});
