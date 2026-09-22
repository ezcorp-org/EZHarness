import type { Page, TestInfo } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { makeConversation, makeMessage, makeProject } from "./fixtures/data.js";

const project = makeProject({ id: "private-project", name: "Private work" });
const conversation = makeConversation({ id: "private-conversation", projectId: project.id, title: "Fix a file" });
const messages = [
	makeMessage({ id: "user-1", conversationId: conversation.id, role: "user", content: "Fix the file" }),
	makeMessage({ id: "assistant-1", conversationId: conversation.id, role: "assistant", content: "The change is ready.", parentMessageId: "user-1", runId: "run-1" }),
];

async function exerciseDraftPr(page: Page, mockApi: (overrides?: MockOverrides) => Promise<void>, testInfo: TestInfo) {
	let state: "ready" | "reviewing" | "created" = "ready";
	const view = () => ({
		state,
		proposalId: "proposal-1",
		digest: "a".repeat(64),
		repository: { id: 42, fullName: "owner/private", baseRef: "main", baseSha: "b".repeat(40) },
		files: [{ path: "src/exact-file.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-before\n+after", binary: false }],
		checks: [{ name: "tests", result: "passed" }],
		title: "Fix a file",
		body: "Verified in sandbox",
		prUrl: state === "created" ? "https://github.com/owner/private/pull/7" : undefined,
	});
	await mockApi({
		projects: [project], conversations: [conversation], messages,
		routes: {
			"/api/github/personal-prs/runs/run-1/prepare": () => { state = "reviewing"; return view(); },
			"/api/github/personal-prs/runs/run-1": () => view(),
			"/api/github/personal-prs/proposals/proposal-1/confirm": () => { state = "created"; return view(); },
		},
	});
	await page.goto(`/project/${project.id}/chat/${conversation.id}`);
	const card = page.getByTestId("personal-pr-card");
	await expect(card.getByText("PR ready")).toBeVisible();
	await expect(card).toContainText("checks passed");
	await captureEvidence(page, testInfo, `personal-pr-card-${testInfo.project.name}`);
	await card.getByRole("button", { name: "Review & create draft PR" }).click();
	const review = page.getByTestId("personal-pr-review");
	await expect(review).toContainText("src/exact-file.ts");
	await expect(review.getByTestId("personal-pr-exact-diff")).toContainText("+after");
	await expect(review).toContainText("The file list below is the saved run snapshot");
	await expect(page.getByText("No file changes in this conversation")).toHaveCount(0);
	await captureEvidence(page, testInfo, `personal-pr-review-${testInfo.project.name}`);
	await review.getByLabel("PR title").fill("Reviewed fix");
	await review.getByRole("button", { name: "Create draft PR" }).click();
	await expect(review.getByRole("link", { name: "Open draft PR on GitHub" })).toHaveAttribute("href", "https://github.com/owner/private/pull/7");
	await page.reload();
	await expect(page.getByTestId("personal-pr-card")).toContainText("Draft PR created");
	await expect(page.getByRole("link", { name: "View PR on GitHub" })).toHaveAttribute("href", "https://github.com/owner/private/pull/7");
}

test("owner reviews an exact sandbox snapshot and creates one draft PR @evidence", async ({ page, mockApi }, testInfo) => {
	await exerciseDraftPr(page, mockApi, testInfo);
});

test.describe("mobile draft PR", () => {
	test.use({ viewport: { width: 390, height: 844 } });
	test("review stays usable on mobile @evidence", async ({ page, mockApi }, testInfo) => {
		await exerciseDraftPr(page, mockApi, testInfo);
	});
});
