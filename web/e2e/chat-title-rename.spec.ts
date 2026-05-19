import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

test.describe("Chat title rename", () => {
	const proj = makeProject({ id: "proj-1", name: "Title Rename Project" });

	test("double-click title, edit, click Save sends PUT and updates the header", async ({
		page,
		mockApi,
	}) => {
		const conv = makeConversation({
			id: "conv-1",
			projectId: "proj-1",
			title: "Original Title",
		});
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});

		// The mock layer answers PUT /api/conversations/:id by merging the
		// request body into the seeded conversation, so the round-trip is
		// real-enough for the UI to re-render the new title.
		const putPromise = page.waitForRequest(
			(req) =>
				req.method() === "PUT" &&
				req.url().endsWith(`/api/conversations/${conv.id}`),
		);

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const title = page.getByTestId("chat-title");
		await expect(title).toHaveText("Original Title");

		await title.dblclick();

		const input = page.getByTestId("chat-title-input");
		await expect(input).toBeVisible();
		await expect(input).toHaveValue("Original Title");

		await input.fill("Renamed Title");
		await page.getByTestId("chat-title-save").click();

		const req = await putPromise;
		expect(req.postDataJSON()).toEqual({ title: "Renamed Title" });

		// Edit form is replaced by the display span, now showing the new title.
		await expect(page.getByTestId("chat-title-input")).toHaveCount(0);
		await expect(page.getByTestId("chat-title")).toHaveText("Renamed Title");
	});

	test("Escape key cancels the edit without sending a request", async ({
		page,
		mockApi,
	}) => {
		const conv = makeConversation({
			id: "conv-1",
			projectId: "proj-1",
			title: "Keep This",
		});
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});

		const seenPuts: string[] = [];
		page.on("request", (req) => {
			if (
				req.method() === "PUT" &&
				req.url().endsWith(`/api/conversations/${conv.id}`)
			) {
				seenPuts.push(req.url());
			}
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const title = page.getByTestId("chat-title");
		await expect(title).toHaveText("Keep This");
		await title.dblclick();

		const input = page.getByTestId("chat-title-input");
		await input.fill("Discard me");
		await input.press("Escape");

		await expect(page.getByTestId("chat-title-input")).toHaveCount(0);
		await expect(page.getByTestId("chat-title")).toHaveText("Keep This");
		expect(seenPuts).toEqual([]);
	});
});
