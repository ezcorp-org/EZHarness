import { test, expect } from "./fixtures/test-base.js";
import { makeAgent, makeAgentConfig, makeProject } from "./fixtures/data.js";

test.describe("Agents List Page", () => {
	test("shows heading and New Agent button", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents");

		await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
		await expect(page.getByRole("link", { name: "+ New Agent" })).toBeVisible();
	});

	test("shows empty state when no agents", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents");

		await expect(page.getByText("No agents configured")).toBeVisible();
	});

	test("no category chips when agents lack categories", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "basic-agent", source: "file", category: null }),
			],
		});
		await page.goto("/agents");

		await expect(page.getByText("basic-agent")).toBeVisible();
		// "All" chip only appears when categories exist
		await expect(page.getByRole("button", { name: "All categories" })).not.toBeVisible();
	});

	test("config agent shows Chat and Run buttons", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({
					name: "chat-agent",
					source: "config",
					id: "cfg-1",
					prompt: "You are helpful.",
					description: "A chatty agent",
				}),
			],
		});
		await page.goto("/agents");

		await expect(page.getByText("chat-agent")).toBeVisible();
		await expect(page.getByText("Config", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Run" })).toBeVisible();
	});

	test("file agent shows only Run button (no Chat)", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "file-agent", source: "file", id: null, prompt: null }),
			],
		});
		await page.goto("/agents");

		await expect(page.getByText("file-agent")).toBeVisible();
		await expect(page.getByText("File", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Chat" })).not.toBeVisible();
		await expect(page.getByRole("link", { name: "Run" })).toBeVisible();
	});

	test("category chips appear and filter agents", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "finance-bot", source: "config", id: "c1", prompt: "p", category: "Finance" }),
				makeAgent({ name: "eng-bot", source: "config", id: "c2", prompt: "p", category: "Engineering" }),
				makeAgent({ name: "general-bot", source: "file", category: null }),
			],
		});
		await page.goto("/agents");

		// All three agents visible initially
		await expect(page.getByText("finance-bot")).toBeVisible();
		await expect(page.getByText("eng-bot")).toBeVisible();
		await expect(page.getByText("general-bot")).toBeVisible();

		// Category chips visible
		const allBtn = page.getByRole("button", { name: "All categories" });
		const financeBtn = page.getByRole("button", { name: "Finance" });
		const engBtn = page.getByRole("button", { name: "Engineering" });
		await expect(allBtn).toBeVisible();
		await expect(financeBtn).toBeVisible();
		await expect(engBtn).toBeVisible();

		// Click Finance filter
		await financeBtn.click();
		await expect(page.getByText("finance-bot")).toBeVisible();
		await expect(page.getByText("eng-bot")).not.toBeVisible();
		// general-bot has no category, so it's also filtered out
		await expect(page.getByText("general-bot")).not.toBeVisible();

		// Click Finance again to deselect
		await financeBtn.click();
		await expect(page.getByText("finance-bot")).toBeVisible();
		await expect(page.getByText("eng-bot")).toBeVisible();
		await expect(page.getByText("general-bot")).toBeVisible();

		// Click All chip resets filter
		await engBtn.click();
		await expect(page.getByText("eng-bot")).toBeVisible();
		await expect(page.getByText("finance-bot")).not.toBeVisible();
		await allBtn.click();
		await expect(page.getByText("finance-bot")).toBeVisible();
		await expect(page.getByText("eng-bot")).toBeVisible();
	});

	test("ownership filters compose with search and can be cleared", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({
					name: "owned-planner",
					source: "config",
					id: "owned-1",
					prompt: "Plan work.",
					category: "Planning",
				}),
				makeAgent({
					name: "shared-reviewer",
					source: "config",
					id: "shared-1",
					prompt: "Review work.",
					category: "Review",
					shared: true,
					sharedByName: "Morgan",
				}),
			],
		});
		await page.goto("/agents");

		await page.getByRole("button", { name: /Shared with me/ }).click();
		await expect(page.getByText("shared-reviewer", { exact: true })).toBeVisible();
		await expect(page.getByText("owned-planner", { exact: true })).not.toBeVisible();

		const search = page.getByTestId("agent-search-input");
		await search.fill("no matching agent");
		await expect(page.getByTestId("agent-search-empty")).toContainText("no matching agent");
		await page.getByTestId("agent-search-clear").click();
		await expect(search).toHaveValue("");
		await expect(page.getByText("shared-reviewer", { exact: true })).toBeVisible();

		await page.getByRole("button", { name: "My agents", exact: true }).click();
		await expect(page.getByText("owned-planner", { exact: true })).toBeVisible();
		await expect(page.getByText("shared-reviewer", { exact: true })).not.toBeVisible();
	});

	test("Chat refuses the global workspace before it creates a conversation", async ({ page, mockApi }) => {
		const conversationWrites: string[] = [];
		page.on("request", (request) => {
			if (new URL(request.url()).pathname === "/api/conversations" && request.method() === "POST") {
				conversationWrites.push(request.url());
			}
		});
		await mockApi({
			agents: [
				makeAgent({
					name: "project-only-agent",
					source: "config",
					id: "agent-project-only",
					prompt: "Use a project.",
				}),
			],
		});
		await page.goto("/agents");

		await page.getByRole("button", { name: "Chat", exact: true }).click();
		await expect(page.getByText("Select a project first", { exact: true })).toBeVisible();
		expect(conversationWrites).toEqual([]);
	});

	for (const journey of [
		{
			name: "agent",
			project: makeProject({ id: "project-for-agent", name: "Agent project" }),
			path: "/agents",
			overrides: {
				agents: [makeAgent({ name: "project-chat-agent", source: "config", id: "agent-project-chat", prompt: "Use the selected project." })],
			},
			expectedBody: { projectId: "project-for-agent", agentConfigId: "agent-project-chat" },
		},
		{
			name: "team",
			project: makeProject({ id: "project-for-team", name: "Team project" }),
			path: "/agents?tab=teams",
			overrides: {
				agentConfigs: [makeAgentConfig({ id: "team-config-1", name: "Delivery Team", category: "team" })],
			},
			expectedBody: { projectId: "project-for-team", agentConfigId: "team-config-1" },
		},
	] as const) {
		test(`Chat creates and reloads the selected ${journey.name} conversation`, async ({ page, mockApi }) => {
			await page.addInitScript((projectId) => {
				localStorage.setItem("activeProjectId", projectId);
			}, journey.project.id);
			await mockApi({ projects: [journey.project], ...journey.overrides });
			await page.goto(journey.path);

			const created = page.waitForResponse((response) =>
				new URL(response.url()).pathname === "/api/conversations" && response.request().method() === "POST",
			);
			const request = page.waitForRequest((request) =>
				new URL(request.url()).pathname === "/api/conversations" && request.method() === "POST",
			);
			await page.getByRole("button", { name: "Chat", exact: true }).click();
			expect((await created).status()).toBe(200);
			expect((await request).postDataJSON()).toEqual(journey.expectedBody);

			const chatUrl = `/project/${journey.project.id}/chat/new-conv`;
			await expect(page).toHaveURL(chatUrl);
			await expect(page.getByRole("navigation", { name: "Conversations" }).getByText("New Conversation", { exact: true })).toBeVisible();
			await expect(page.getByRole("group", { name: "Chat input with file drop zone" })).toBeVisible();

			await page.reload();
			await expect(page).toHaveURL(chatUrl);
			await expect(page.getByRole("navigation", { name: "Conversations" }).getByText("New Conversation", { exact: true })).toBeVisible();
			await expect(page.getByRole("group", { name: "Chat input with file drop zone" })).toBeVisible();

			if (journey.name === "agent") {
				const secondCreated = page.waitForResponse((response) =>
					new URL(response.url()).pathname === "/api/conversations" && response.request().method() === "POST",
				);
				await page.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: "New Chat" }).click();
				expect(await (await secondCreated).json()).toMatchObject({
					id: "new-conv-2",
					projectId: journey.project.id,
				});
				const secondChatUrl = `/project/${journey.project.id}/chat/new-conv-2`;
				await expect(page).toHaveURL(secondChatUrl);

				const reloadedConversations = page.waitForResponse((response) => {
					const url = new URL(response.url());
					return url.pathname === "/api/conversations" && response.request().method() === "GET" && url.searchParams.get("projectId") === journey.project.id;
				});
				await page.reload();
				expect((await (await reloadedConversations).json()).map((conversation: { id: string }) => conversation.id)).toEqual(
					expect.arrayContaining(["new-conv", "new-conv-2"]),
				);
				await expect(page).toHaveURL(secondChatUrl);
				await expect(page.getByRole("navigation", { name: "Conversations" }).getByText("New Conversation", { exact: true })).toHaveCount(2);
				await expect(page.getByRole("group", { name: "Chat input with file drop zone" })).toBeVisible();
			}
		});
	}

	test("+ New Agent link navigates to /agents/new", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents");

		await page.getByRole("link", { name: "+ New Agent" }).click();
		await expect(page).toHaveURL("/agents/new");
	});

	test("config agent shows Edit button", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "editable-agent", source: "config", id: "cfg-1", prompt: "test prompt" }),
			],
		});
		await page.goto("/agents");

		await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
	});

	test("file-based agent does NOT show Edit button", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "file-agent", source: "file", id: null, prompt: null }),
			],
		});
		await page.goto("/agents");

		await expect(page.getByRole("button", { name: "Edit" })).not.toBeVisible();
	});

	test("shared read-only agent does NOT show Edit button", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "readonly-agent", source: "config", id: "cfg-ro", prompt: "p", shared: true, permission: "read" }),
			],
		});
		await page.goto("/agents");

		await expect(page.getByRole("button", { name: "Edit" })).not.toBeVisible();
	});

	test("Edit button navigates to agent detail page", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "nav-agent", source: "config", id: "cfg-nav", prompt: "test prompt" }),
			],
		});
		await page.goto("/agents");

		await page.getByRole("button", { name: "Edit" }).click();
		await expect(page).toHaveURL("/agents/nav-agent");
	});
});
