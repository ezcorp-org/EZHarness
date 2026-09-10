/** Legacy dashboard URLs must reach and operate the replacement chat workspace. */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test-base.js";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { makeProject } from "./fixtures/data.js";

type DashboardEntry = { path: string; projectId: string; name: string };
type MockApi = (overrides?: MockOverrides) => Promise<void>;

const global: DashboardEntry = { path: "/", projectId: "global", name: "Global" };
const project: DashboardEntry = { path: "/project/proj-1", projectId: "proj-1", name: "My Project" };

async function visitEmptyChat(page: Page, mockApi: MockApi, entry: DashboardEntry): Promise<void> {
	await mockApi({ projects: [makeProject({ id: entry.projectId, name: entry.name })], conversations: [] });
	await page.goto(entry.path);
	await expect(page).toHaveURL(`/project/${entry.projectId}/chat`);
	await expect(page.getByRole("heading", { name: "No conversations yet" })).toBeVisible();
	await expect(page.locator("aside").getByRole("link", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");
	await expect(page.getByRole("button", { name: "New Conversation", exact: true })).toBeVisible();
}

async function createConversation(page: Page, entry: DashboardEntry): Promise<void> {
	const request = page.waitForRequest((candidate) =>
		candidate.method() === "POST" && new URL(candidate.url()).pathname === "/api/conversations",
	);
	const response = page.waitForResponse((candidate) =>
		candidate.request().method() === "POST" && new URL(candidate.url()).pathname === "/api/conversations",
	);
	await page.getByRole("button", { name: "New Conversation", exact: true }).click();
	expect((await request).postDataJSON()).toMatchObject({ projectId: entry.projectId });
	const created = await response;
	expect(created.ok(), await created.text()).toBe(true);
	await page.waitForURL(`/project/${entry.projectId}/chat/new-conv`);
	await expect(page.locator("textarea.chat-textarea")).toBeFocused();
}

test("legacy root redirects to the Global empty-chat workspace", async ({ page, mockApi }) => {
	await visitEmptyChat(page, mockApi, global);
});

test("legacy root creates a Global conversation and opens its composer", async ({ page, mockApi }) => {
	await visitEmptyChat(page, mockApi, global);
	await createConversation(page, global);
});

test("legacy project URL redirects to that project's empty-chat workspace", async ({ page, mockApi }) => {
	await visitEmptyChat(page, mockApi, project);
});

test("legacy project URL creates a project-scoped conversation and opens its composer", async ({ page, mockApi }) => {
	await visitEmptyChat(page, mockApi, project);
	await createConversation(page, project);
});

test("a project redirect replaces Global before its new-conversation request", async ({ page, mockApi }) => {
	await visitEmptyChat(page, mockApi, global);
	await visitEmptyChat(page, mockApi, project);
	await createConversation(page, project);
});
