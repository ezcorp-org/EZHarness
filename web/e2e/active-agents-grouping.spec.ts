import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * E2E coverage for active-agent organization:
 *
 *  1. The `/active-agents` home page groups rows by project with project-name
 *     headers. Unassigned rows fall into an "Unassigned" bucket that comes
 *     last, even when its rows would sort alphabetically earlier.
 *  2. Project roots route into their chat workspace. Active-agent monitoring
 *     remains a dedicated global page so that one view can group every
 *     project and show unassigned runs.
 */

const projAlpha = makeProject({ id: "p-alpha", name: "Alpha" });
const projBravo = makeProject({ id: "p-bravo", name: "Bravo" });

const convAlpha = makeConversation({
	id: "conv-alpha",
	projectId: "p-alpha",
	title: "Alpha chat",
});
const convBravo = makeConversation({
	id: "conv-bravo",
	projectId: "p-bravo",
	title: "Bravo chat",
});

test.describe("/active-agents home page — grouped by project", () => {
	test("renders one group per project with headers and counts; unassigned last", async ({
		page,
		mockApi,
	}) => {
		const startedAt = Date.now();
		await mockApi({
			projects: [projBravo, projAlpha], // server order shouldn't matter
			conversations: [convAlpha, convBravo],
			routes: {
				"/active-agents": () => [
					{
						runId: "run-alpha-1",
						agentName: "Worker-A1",
						conversationId: "conv-alpha",
						parentConversationId: null,
						projectId: "p-alpha",
						conversationTitle: "Alpha chat",
						startedAt,
					},
					{
						runId: "run-bravo-1",
						agentName: "Worker-B1",
						conversationId: "conv-bravo",
						parentConversationId: null,
						projectId: "p-bravo",
						conversationTitle: "Bravo chat",
						startedAt,
					},
					{
						runId: "run-alpha-2",
						agentName: "Worker-A2",
						conversationId: "conv-alpha",
						parentConversationId: null,
						projectId: "p-alpha",
						conversationTitle: "Alpha chat",
						startedAt,
					},
					{
						runId: "run-orphan",
						agentName: "Worker-Orphan",
						conversationId: "conv-orphan",
						parentConversationId: null,
						projectId: null, // unassigned
						conversationTitle: null,
						startedAt,
					},
				],
			},
		});

		await page.goto("/active-agents");
		await page.waitForLoadState("networkidle");

		// Grouped container visible.
		await expect(page.getByTestId("active-agents-grouped")).toBeVisible();

		const headings = page.getByTestId("active-agents-group-heading");
		await expect(headings).toHaveCount(3);

		const headingTexts = await headings.allTextContents();
		const cleaned = headingTexts.map((t) =>
			t.replace(/\s*\(\d+\)\s*$/, "").trim(),
		);

		// Projects sorted alphabetically (Alpha, Bravo), Unassigned always last.
		expect(cleaned).toEqual(["Alpha", "Bravo", "Unassigned"]);

		// Per-group counts — Alpha has 2, Bravo has 1, Unassigned has 1.
		const countFor = (label: string) => {
			const raw = headingTexts.find((h) => h.trim().startsWith(label)) ?? "";
			const m = /\((\d+)\)/.exec(raw);
			return m ? Number(m[1]) : null;
		};
		expect(countFor("Alpha")).toBe(2);
		expect(countFor("Bravo")).toBe(1);
		expect(countFor("Unassigned")).toBe(1);

		// Each group only contains its own agents.
		const alphaSection = page
			.getByTestId("active-agents-group")
			.filter({ has: page.getByRole("heading", { name: /^Alpha/ }) });
		await expect(alphaSection.getByText("Worker-A1")).toBeVisible();
		await expect(alphaSection.getByText("Worker-A2")).toBeVisible();
		await expect(alphaSection.getByText("Worker-B1")).toHaveCount(0);

		const bravoSection = page
			.getByTestId("active-agents-group")
			.filter({ has: page.getByRole("heading", { name: /^Bravo/ }) });
		await expect(bravoSection.getByText("Worker-B1")).toBeVisible();

		const unassignedSection = page
			.getByTestId("active-agents-group")
			.filter({ has: page.getByRole("heading", { name: /^Unassigned/ }) });
		await expect(unassignedSection.getByText("Worker-Orphan")).toBeVisible();
	});

	test("shows the empty state when there are no active agents", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [projAlpha],
			routes: {
				"/active-agents": () => [],
			},
		});

		await page.goto("/active-agents");
		await page.waitForLoadState("networkidle");

		await expect(page.getByText("No active agents right now.")).toBeVisible();
		await expect(page.getByTestId("active-agents-grouped")).toHaveCount(0);
	});
});

test.describe("/project/[id] — routes to the project chat workspace", () => {
	test("redirects an existing project to its most recent chat", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [projAlpha, projBravo],
			conversations: [convAlpha, convBravo],
			messages: [
				makeMessage({
					id: "m-a-1",
					conversationId: "conv-alpha",
					role: "user",
					content: "hi",
				}),
			],
		});

		await page.goto("/project/p-alpha");
		await expect(page).toHaveURL(/\/project\/p-alpha\/chat\/conv-alpha$/);
		await expect(page.getByText("hi")).toBeVisible();
		await expect(page.getByTestId("active-agents-grouped")).toHaveCount(0);
	});

	test("keeps an empty project in its chat index instead of mounting a global monitor", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [projAlpha],
			conversations: [],
		});

		await page.goto("/project/p-alpha");
		await expect(page).toHaveURL(/\/project\/p-alpha\/chat$/);
		await expect(page.getByRole("heading", { name: "No conversations yet" })).toBeVisible();
		await expect(page.getByText("No active agents right now.")).toHaveCount(0);
	});
});
