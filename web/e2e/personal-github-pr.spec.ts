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
	let state: "working" | "ready" | "created" = "working";
	let prepareCalls = 0;
	const view = () => state === "working" ? { state, blockReason: "review_not_prepared", projectId: project.id } : ({
		state,
		proposalId: "proposal-1",
		digest: "a".repeat(64),
		reviewPath: `/project/${project.id}/chat/${conversation.id}?review=proposal-1`,
		repository: { id: 42, fullName: "owner/private", baseRef: "main", baseSha: "b".repeat(40) },
		files: [{ path: "src/exact-file.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-before\n+after", binary: false }],
		checks: [],
		title: "Fix a file",
		body: "Verified in sandbox",
		prUrl: state === "created" ? "https://github.com/owner/private/pull/7" : undefined,
	});
	await mockApi({
		projects: [project], conversations: [conversation], messages,
		routes: {
			"/api/github/personal-prs/runs/run-1/prepare": () => { prepareCalls += 1; state = "ready"; return view(); },
			"/api/github/personal-prs/runs/run-1": () => view(),
			"/api/github/personal-prs/proposals/proposal-1/confirm": () => { state = "created"; return view(); },
			"/api/github/personal-prs/proposals/proposal-1": () => view(),
		},
	});
	await page.goto(`/project/${project.id}/chat/${conversation.id}`);
	const card = page.getByTestId("personal-pr-card");
	await expect(card.getByText("Changes ready for review")).toBeVisible();
	await expect(card).not.toContainText("review_not_prepared");
	await captureEvidence(page, testInfo, `personal-pr-card-${testInfo.project.name}`);
	await card.getByRole("button", { name: "Prepare PR review" }).click();
	await expect(page).toHaveURL(/review=proposal-1$/);
	expect(prepareCalls).toBe(1);
	const review = page.getByTestId("personal-pr-review");
	await expect(review).toContainText("src/exact-file.ts");
	await expect(review.getByTestId("personal-pr-exact-diff")).toContainText("+after");
	await expect(review).toContainText("The file list below is the saved run snapshot");
		await expect(review).toContainText("No verified checks recorded");
	await expect(page.getByText("No file changes in this conversation")).toHaveCount(0);
		await captureEvidence(page, testInfo, `personal-pr-review-${testInfo.project.name}`);
		await review.getByRole("button", { name: "Close PR review" }).click();
		await page.getByTestId("diff-panel-btn").click();
		await expect(page.getByTestId("diff-review-toolbar")).toBeVisible();
		await expect(page.getByTestId("personal-pr-review")).toHaveCount(0);
		await page.getByRole("dialog", { name: "Files changed" }).getByRole("button", { name: "Close", exact: true }).click();
		await expect(page.getByTestId("diff-review-toolbar")).toHaveCount(0);
		await card.getByRole("button", { name: "Review & create draft PR" }).click();
		await expect(review).toBeVisible();
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

test("a no-change run explains why a PR cannot be prepared @evidence", async ({ page, mockApi }, testInfo) => {
	await mockApi({ projects: [project], conversations: [conversation], messages, routes: {
		"/api/github/personal-prs/runs/run-1/prepare": () => ({ state: "no_changes", projectId: project.id }),
		"/api/github/personal-prs/runs/run-1": () => ({ state: "working", blockReason: "review_not_prepared", projectId: project.id }),
	} });
	await page.goto(`/project/${project.id}/chat/${conversation.id}`);
	const card = page.getByTestId("personal-pr-card");
	await card.getByRole("button", { name: "Prepare PR review" }).click();
	await expect(card).toContainText("No file changes to review");
	await expect(card).toContainText("Make a change in this sandbox, then complete another run.");
	await expect(card.getByRole("button", { name: "Prepare PR review" })).toHaveCount(0);
	await captureEvidence(page, testInfo, "personal-pr-no-changes");
});

test("a review link from another conversation cannot replace this chat's diff @evidence", async ({ page, mockApi }, testInfo) => {
	await mockApi({ projects: [project], conversations: [conversation], messages, routes: {
		"/api/github/personal-prs/proposals/proposal-1": () => ({
			state: "ready", proposalId: "proposal-1", digest: "a".repeat(64),
			reviewPath: `/project/${project.id}/chat/another-conversation?review=proposal-1`,
		}),
	} });
	const proposalResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/github/personal-prs/proposals/proposal-1");
	await page.goto(`/project/${project.id}/chat/${conversation.id}?review=proposal-1`);
	const response = await proposalResponse;
	expect(response.ok()).toBe(true);
	await response.finished();
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	await page.getByTestId("diff-panel-btn").click();
	await expect(page.getByTestId("diff-review-toolbar")).toBeVisible();
	await expect(page.getByTestId("personal-pr-review")).toHaveCount(0);
	await captureEvidence(page, testInfo, "personal-pr-foreign-chat-review-link");
});

test("owner checks an uncertain GitHub result after reload @evidence", async ({ page, mockApi }, testInfo) => {
	let state: "failed" | "created" = "failed";
	let checks = 0;
	const view = () => ({
		state, recoveryAction: state === "failed" ? "check_github" : undefined, proposalId: "proposal-1", digest: "a".repeat(64),
		repository: { id: 42, fullName: "owner/private", baseRef: "main", baseSha: "b".repeat(40) },
		files: [{ path: "src/exact-file.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-before\n+after", binary: false }],
		checks: [], title: "Fix a file", body: "Verified in sandbox",
		reviewPath: `/project/${project.id}/chat/${conversation.id}?review=proposal-1`,
		prUrl: state === "created" ? "https://github.com/owner/private/pull/7" : undefined,
	});
	await mockApi({ projects: [project], conversations: [conversation], messages, routes: {
		"/api/github/personal-prs/proposals/proposal-1/confirm": () => { checks += 1; state = "created"; return view(); },
		"/api/github/personal-prs/proposals/proposal-1": () => view(),
		"/api/github/personal-prs/runs/run-1": () => view(),
	} });
	await page.goto(`/project/${project.id}/chat/${conversation.id}`);
	await expect(page.getByTestId("personal-pr-card")).toContainText("Draft PR creation failed");
	await page.reload();
	await page.getByRole("button", { name: "Open PR review" }).click();
	const review = page.getByTestId("personal-pr-review");
	await expect(review.getByRole("button", { name: "Create draft PR" })).toHaveCount(0);
	await expect(review.getByRole("button", { name: "Check GitHub result" })).toBeVisible();
	await captureEvidence(page, testInfo, "personal-pr-uncertain-result");
	await review.getByRole("button", { name: "Check GitHub result" }).click();
	await expect(review.getByRole("link", { name: "Open draft PR on GitHub" })).toHaveAttribute("href", "https://github.com/owner/private/pull/7");
	expect(checks).toBe(1);
});

test("expired pre-commit creation requires an explicit owner retry @evidence", async ({ page, mockApi }, testInfo) => {
	const requests: Record<string, unknown>[] = [];
	let state: "creating" | "created" = "creating";
	const view = () => ({
		state, recoveryAction: state === "creating" ? "retry_pre_ref" : undefined, proposalId: "proposal-1", digest: "a".repeat(64),
		repository: { id: 42, fullName: "owner/private", baseRef: "main", baseSha: "b".repeat(40) },
		files: [{ path: "src/exact-file.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-before\n+after", binary: false }],
		checks: [], title: "Fix a file", body: "Tested",
		prUrl: state === "created" ? "https://github.com/owner/private/pull/7" : undefined,
		reviewPath: `/project/${project.id}/chat/${conversation.id}?review=proposal-1`,
	});
	await mockApi({ projects: [project], conversations: [conversation], messages, routes: {
		"/api/github/personal-prs/runs/run-1": () => view(),
		"/api/github/personal-prs/proposals/proposal-1": () => view(),
	} });
	await page.route("**/api/github/personal-prs/proposals/proposal-1/confirm", (route) => {
		requests.push(route.request().postDataJSON());
		state = "created";
		return route.fulfill({ json: view() });
	});
	await page.goto(`/project/${project.id}/chat/${conversation.id}`);
	await page.getByRole("button", { name: "Open PR review" }).click();
	const review = page.getByTestId("personal-pr-review");
	await expect(review.getByRole("button", { name: "Check GitHub result" })).toHaveCount(0);
	await captureEvidence(page, testInfo, "personal-pr-expired-pre-commit-retry");
	await review.getByRole("button", { name: "Retry draft PR publication" }).click();
	await expect(review.getByRole("link", { name: "Open draft PR on GitHub" })).toBeVisible();
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({ retryPreCommit: true });
});

test("failed confirmation shows the error and checks the saved GitHub result before recovery", async ({ page, mockApi }) => {
	let state: "reviewing" | "failed" | "created" = "reviewing";
	let confirmations = 0;
	const view = () => ({
		state, recoveryAction: state === "failed" ? "check_github" : undefined,
		proposalId: "proposal-1", digest: "a".repeat(64),
		repository: { id: 42, fullName: "owner/private", baseRef: "main", baseSha: "b".repeat(40) },
		files: [{ path: "src/exact-file.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-before\n+after", binary: false }],
		checks: [], title: "Fix a file", body: "Verified in sandbox",
		reviewPath: `/project/${project.id}/chat/${conversation.id}?review=proposal-1`,
		prUrl: state === "created" ? "https://github.com/owner/private/pull/7" : undefined,
	});
	await mockApi({ projects: [project], conversations: [conversation], messages, routes: {
		"/api/github/personal-prs/runs/run-1": () => view(),
		"/api/github/personal-prs/proposals/proposal-1": () => view(),
	} });
	await page.route("**/api/github/personal-prs/proposals/proposal-1/confirm", (route) => {
		confirmations++;
		if (confirmations === 1) {
			state = "failed";
			return route.fulfill({ status: 502, json: { error: "GitHub result is uncertain" } });
		}
		state = "created";
		return route.fulfill({ json: view() });
	});
	await page.goto(`/project/${project.id}/chat/${conversation.id}`);
	await page.getByRole("button", { name: "Review & create draft PR" }).click();
	const review = page.getByTestId("personal-pr-review");
	await expect(review.getByTestId("personal-pr-exact-diff")).toContainText("+after");
	await review.getByRole("button", { name: "Create draft PR" }).click();
	await expect(review.getByRole("alert")).toHaveText("GitHub result is uncertain");
	await expect(review.getByRole("button", { name: "Create draft PR" })).toBeDisabled();
	expect(confirmations).toBe(1);
	await review.getByRole("button", { name: "Check status" }).click();
	await expect(review.getByRole("button", { name: "Check GitHub result" })).toBeVisible();
	await expect(review.getByRole("button", { name: "Create draft PR" })).toHaveCount(0);
	await review.getByRole("button", { name: "Check GitHub result" }).click();
	await expect(review.getByRole("link", { name: "Open draft PR on GitHub" })).toHaveAttribute("href", "https://github.com/owner/private/pull/7");
	expect(confirmations).toBe(2);
});

test.describe("mobile draft PR", () => {
	test.use({ viewport: { width: 390, height: 844 } });
	test("review stays usable on mobile @evidence", async ({ page, mockApi }, testInfo) => {
		await exerciseDraftPr(page, mockApi, testInfo);
	});
});
