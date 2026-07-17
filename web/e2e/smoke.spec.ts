import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeWorkflow } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Smoke Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
const msg = makeMessage({ id: "msg-1", conversationId: "conv-1", role: "user", content: "Hi" });

const ROUTES = [
	{ path: "/", name: "Dashboard (no project)" },
	{ path: `/project/${proj.id}`, name: "Project dashboard" },
	{ path: `/project/${proj.id}/chat`, name: "Chat list" },
	{ path: `/project/${proj.id}/chat/${conv.id}`, name: "Chat conversation" },
	{ path: `/project/${proj.id}/settings`, name: "Project settings" },
	{ path: "/workflows", name: "Workflows" },
	{ path: "/agents/new", name: "New Agent" },
	{ path: "/new-project", name: "New Project" },
	{ path: "/memories", name: "Memories" },
];

for (const route of ROUTES) {
	test(`${route.name} (${route.path}) loads without console errors`, async ({ page, mockApi }) => {
		const errors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") errors.push(msg.text());
		});
		page.on("pageerror", (err) => errors.push(err.message));

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			workflows: [makeWorkflow()],
		});

		await page.goto(route.path);
		await expect(page.locator("body")).toBeVisible();

		// Filter out expected WS connection errors (no real server)
		const realErrors = errors.filter(
			(e) => !e.includes("WebSocket") && !e.includes("ERR_CONNECTION_REFUSED"),
		);
		expect(realErrors).toEqual([]);
	});
}

test("landing page shows EZCorp brand", async ({ page, mockApi }) => {
	await mockApi();
	await page.goto("/");
	await expect(page.getByText("EZCorp").first()).toBeVisible();
});
