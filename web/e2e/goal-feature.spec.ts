/**
 * Real-auth coverage for the retained host-side `/goal` command.
 *
 * The former spec targeted a retired goal pill and `/goal-state` route. This
 * suite exercises the supported journey: composer → messages route → PGlite
 * persistence → mock-LLM stream → visible status and clear cards. The mock
 * replaces only the LLM HTTP boundary; auth, database, and route logic are real.
 */
import type { APIResponse, Page } from "@playwright/test";
import { test, expect } from "./fixtures/hydration.js";
import { sendComposerMessage, threadMessages } from "./fixtures/composer.js";

interface SeededConversation {
	projectId: string;
	conversationId: string;
}

interface ConversationState {
	metadata?: { goal?: { condition?: string } };
}

interface MockCapture {
	scriptKey: string;
	requests: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }>;
}

interface PersistedMessage {
	role: string;
	content: string;
}

interface MockTurn {
	text?: string;
	holdKey?: string;
}

interface ActiveRunResponse {
	runId: string | null;
	status?: string;
}

interface MessageResponse {
	runId: string | null;
	ezActionResults?: Array<{ content: string }>;
}

async function seedConversation(page: Page): Promise<SeededConversation> {
	const response = await page.request.post("/api/__test/seed", {
		data: { title: `goal-e2e-${crypto.randomUUID()}` },
	});
	expect(response.status(), await response.text()).toBe(201);
	return (await response.json()) as SeededConversation;
}

async function scriptMockLlm(
	page: Page,
	scriptKey: string,
	turns: MockTurn[] = [
		{ text: "I started the requested work." },
		{ text: '{"achieved":false,"reason":"work remains"}' },
		{ text: "<<TASK_BLOCKED>> waiting for a human decision" },
	],
): Promise<void> {
	const response = await page.request.post("/api/__test/mock-llm/script", {
		data: { scriptKey, turns },
	});
	expect(response.status(), await response.text()).toBe(201);
}

async function pinMockModel(page: Page, conversationId: string, scriptKey: string): Promise<void> {
	const response = await page.request.put(`/api/conversations/${conversationId}`, {
		data: { provider: "ezcorp-mock", model: `mock:${scriptKey}` },
	});
	expect(response.status(), await response.text()).toBe(200);
}

async function setEvaluatorMock(page: Page, scriptKey: string): Promise<void> {
	const response = await page.request.put("/api/settings/provider:tierModels", {
		data: {
			value: {
				fast: [{ provider: "ezcorp-mock", model: `mock:${scriptKey}` }],
				balanced: [],
				powerful: [],
			},
		},
	});
	expect(response.status(), await response.text()).toBe(200);
	const persisted = await page.request.get("/api/settings/provider:tierModels");
	expect(persisted.status(), await persisted.text()).toBe(200);
	expect((await persisted.json()) as { value: unknown }).toEqual({
		value: {
			fast: [{ provider: "ezcorp-mock", model: `mock:${scriptKey}` }],
			balanced: [],
			powerful: [],
		},
	});
}

async function releaseMockLlm(page: Page, holdKey: string): Promise<void> {
	const response = await page.request.post("/api/__test/mock-llm/release", { data: { holdKey } });
	expect(response.status(), await response.text()).toBe(200);
	expect(await response.json()).toEqual({ released: true, holdKey });
}

async function clearEvaluatorMock(page: Page): Promise<void> {
	const response = await page.request.delete("/api/settings/provider:tierModels");
	expect([200, 404]).toContain(response.status());
}

function capturedMessageText(request: MockCapture["requests"][number]): string {
	return JSON.stringify(request.messages);
}

async function mockCapture(page: Page, scriptKey: string): Promise<MockCapture> {
	const response = await page.request.get(`/api/__test/mock-llm/script?scriptKey=${encodeURIComponent(scriptKey)}`);
	expect(response.status(), await response.text()).toBe(200);
	return (await response.json()) as MockCapture;
}

async function readActiveRun(page: Page, conversationId: string): Promise<ActiveRunResponse> {
	const response = await page.request.get(`/api/conversations/${conversationId}/active-run`);
	expect(response.status(), await response.text()).toBe(200);
	return (await response.json()) as ActiveRunResponse;
}

async function readMessages(page: Page, conversationId: string): Promise<PersistedMessage[]> {
	const response = await page.request.get(`/api/conversations/${conversationId}/messages`);
	expect(response.status(), await response.text()).toBe(200);
	return (await response.json()) as PersistedMessage[];
}

async function readConversation(page: Page, conversationId: string): Promise<ConversationState> {
	const response = await page.request.get(`/api/conversations/${conversationId}`);
	expect(response.status(), await response.text()).toBe(200);
	return (await response.json()) as ConversationState;
}

async function sendAndCapture(page: Page, conversationId: string, content: string): Promise<APIResponse> {
	const sent = page.waitForResponse((response) =>
		response.request().method() === "POST" && response.url().endsWith(`/api/conversations/${conversationId}/messages`),
	);
	await sendComposerMessage(page, content);
	const response = await sent;
	expect(response.status(), await response.text()).toBe(200);
	return response;
}


test.describe("/goal — real auth, database, stream, and cards", () => {
	test("set starts a streamed turn, persists across reload, and status renders a durable card", async ({ page }) => {
		const { projectId, conversationId } = await seedConversation(page);
		const scriptKey = `goal-${crypto.randomUUID()}`;
		await scriptMockLlm(page, scriptKey);
		await pinMockModel(page, conversationId, scriptKey);
		await page.goto(`/project/${projectId}/chat/${conversationId}`);

		const set = await sendAndCapture(page, conversationId, "/goal finish the migration review");
		const setBody = (await set.json()) as MessageResponse;
		expect(setBody.runId).toEqual(expect.any(String));
		await expect(threadMessages(page).getByText("I started the requested work.", { exact: true })).toBeVisible({ timeout: 30_000 });
		await expect.poll(async () => (await readConversation(page, conversationId)).metadata?.goal?.condition, { timeout: 30_000 }).toBe("finish the migration review");

		await page.reload();
		await expect.poll(async () => (await readConversation(page, conversationId)).metadata?.goal?.condition).toBe("finish the migration review");

		const status = await sendAndCapture(page, conversationId, "/goal");
		const statusBody = (await status.json()) as MessageResponse;
		expect(statusBody.runId).toBeNull();
		expect(statusBody.ezActionResults).toHaveLength(1);
		expect(statusBody.ezActionResults?.[0]?.content).toMatch(/Goal (active|paused)/);
		const statusCards = threadMessages(page).locator('[data-goal-kind="status"], [data-goal-kind="paused"]');
		await expect(statusCards.last()).toBeVisible();
	});

	test("evaluator continues after false and clears the goal after true", async ({ page }) => {
		const { projectId, conversationId } = await seedConversation(page);
		const scriptKey = `goal-evaluator-${crypto.randomUUID()}`;
		await scriptMockLlm(page, scriptKey, [
			{ text: "First implementation step is complete." },
			{ text: '{"achieved":false,"reason":"one implementation step remains"}' },
			{ text: "Second implementation step is complete." },
			{ text: '{"achieved":true,"reason":"the requested work is complete"}' },
		]);
		await pinMockModel(page, conversationId, scriptKey);
		await setEvaluatorMock(page, scriptKey);
		try {
			await page.goto(`/project/${projectId}/chat/${conversationId}`);
			const set = await sendAndCapture(page, conversationId, "/goal complete the two implementation steps");
			expect((await set.json() as MessageResponse).runId).toEqual(expect.any(String));
			await expect.poll(async () => (await mockCapture(page, scriptKey)).requests.length, { timeout: 30_000 }).toBe(4);
			const capture = await mockCapture(page, scriptKey);
			expect(capture.requests.map((request) => request.model)).toEqual(Array(4).fill(`mock:${scriptKey}`));
			expect(capture.requests.filter((request) => capturedMessageText(request).includes("Goal condition:"))).toHaveLength(2);
			expect(capture.requests.filter((request) => capturedMessageText(request).includes("Continue working toward the active /goal condition"))).toHaveLength(1);
			expect(capture.requests.every((request) => request.messages.some((message) => message.role === "user"))).toBe(true);
			await expect.poll(async () => (await readConversation(page, conversationId)).metadata?.goal, { timeout: 30_000 }).toBeUndefined();
			await expect.poll(async () => (await readMessages(page, conversationId)).some((message) =>
				message.role === "ez-action-result" && message.content.includes("Goal achieved"),
			), { timeout: 30_000 }).toBe(true);
		} finally {
			await clearEvaluatorMock(page);
		}
	});

	test("Stop pauses a live goal and a manual composer turn resumes it", async ({ page }) => {
		const { projectId, conversationId } = await seedConversation(page);
		const scriptKey = `goal-stop-${crypto.randomUUID()}`;
		const holdKey = `goal-hold-${crypto.randomUUID()}`;
		await scriptMockLlm(page, scriptKey, [
			{ holdKey, text: "This must not finish before Stop." },
			{ text: "Manual recovery is underway." },
			{ text: '{"achieved":true,"reason":"manual recovery completed the goal"}' },
		]);
		await pinMockModel(page, conversationId, scriptKey);
		await setEvaluatorMock(page, scriptKey);
		try {
			await page.goto(`/project/${projectId}/chat/${conversationId}`);
			const set = await sendAndCapture(page, conversationId, "/goal verify manual recovery");
			expect((await set.json() as MessageResponse).runId).toEqual(expect.any(String));
			await expect.poll(async () => (await mockCapture(page, scriptKey)).requests.length, { timeout: 30_000 }).toBe(1);
			await expect.poll(async () => (await readActiveRun(page, conversationId)).runId, { timeout: 30_000 }).toEqual(expect.any(String));

			const stopped = page.waitForResponse((response) =>
				response.request().method() === "POST" && response.url().endsWith(`/api/conversations/${conversationId}/active-run`),
			);
			await page.getByRole("button", { name: "Stop generating" }).click();
			const stopResponse = await stopped;
			expect(stopResponse.status(), await stopResponse.text()).toBe(200);
			expect(await stopResponse.json()).toMatchObject({ cancelled: true, path: "memory" });
			await expect.poll(async () => (await readMessages(page, conversationId)).some((message) =>
				message.role === "ez-action-result" && message.content.includes("Goal paused"),
			), { timeout: 30_000 }).toBe(true);
			await releaseMockLlm(page, holdKey);

			const status = await sendAndCapture(page, conversationId, "/goal");
			expect((await status.json() as MessageResponse).ezActionResults?.[0]?.content).toContain("Goal paused");
			await expect(threadMessages(page).locator('[data-goal-kind="paused"]').last()).toBeVisible();

			const resumed = await sendAndCapture(page, conversationId, "Please continue with verified recovery.");
			expect((await resumed.json() as MessageResponse).runId).toEqual(expect.any(String));
			await expect.poll(async () => (await mockCapture(page, scriptKey)).requests.length, { timeout: 30_000 }).toBe(3);
			const capture = await mockCapture(page, scriptKey);
			expect(capturedMessageText(capture.requests[1]!)).toContain("Please continue with verified recovery.");
			await expect.poll(async () => (await readConversation(page, conversationId)).metadata?.goal, { timeout: 30_000 }).toBeUndefined();
		} finally {
			await clearEvaluatorMock(page);
		}
	});

	test("clear and stop return card-only responses and delete the persisted goal", async ({ page }) => {
		for (const command of ["clear", "stop"]) {
			const { projectId, conversationId } = await seedConversation(page);
			const scriptKey = `goal-${crypto.randomUUID()}`;
			await scriptMockLlm(page, scriptKey);
			await pinMockModel(page, conversationId, scriptKey);
			await page.goto(`/project/${projectId}/chat/${conversationId}`);
			await sendAndCapture(page, conversationId, "/goal retained until explicit clear");
			await expect.poll(async () => (await readConversation(page, conversationId)).metadata?.goal?.condition, { timeout: 30_000 }).toBe("retained until explicit clear");

			const cleared = await sendAndCapture(page, conversationId, `/goal ${command}`);
			const clearedBody = (await cleared.json()) as MessageResponse;
			expect(clearedBody.runId).toBeNull();
			expect(clearedBody.ezActionResults?.[0]?.content).toContain("Goal cleared");
			await expect(threadMessages(page).locator('[data-goal-kind="cleared"]')).toBeVisible();
			await expect.poll(async () => (await readConversation(page, conversationId)).metadata?.goal).toBeUndefined();
		}
	});

	test("status on a conversation with no goal is card-only and does not start an LLM run", async ({ page }) => {
		const { projectId, conversationId } = await seedConversation(page);
		const scriptKey = `goal-no-run-${crypto.randomUUID()}`;
		await scriptMockLlm(page, scriptKey);
		await pinMockModel(page, conversationId, scriptKey);
		await page.goto(`/project/${projectId}/chat/${conversationId}`);

		const status = await sendAndCapture(page, conversationId, "/goal");
		const body = (await status.json()) as MessageResponse;
		expect(body.runId).toBeNull();
		expect(body.ezActionResults?.[0]?.content).toContain("No active goal");
		await expect(threadMessages(page).locator('[data-goal-kind="status"]')).toBeVisible();
		await expect(threadMessages(page).getByTestId("streaming-skeleton")).toHaveCount(0);
		expect((await mockCapture(page, scriptKey)).requests).toEqual([]);
	});
});
