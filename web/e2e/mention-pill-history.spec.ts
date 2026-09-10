import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";
import { measureContrast, useLightTheme, useDarkTheme } from "./fixtures/readable.js";

const proj = makeProject({ id: "proj-1", name: "Pill Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

const coloredMentions = [
	{ kind: "agent", token: "![agent:Coder]" },
	{ kind: "team", token: "![team:Reviewers]" },
	{ kind: "EZ", token: "![EZ:distill]" },
	{ kind: "file", token: "@[file:src/app.ts]" },
	{ kind: "dir", token: "@[dir:src]" },
	{ kind: "command", token: "/[cmd:review]" },
	{ kind: "lesson", token: "%[lesson:validation]" },
	{ kind: "workflow", token: "![workflow:deploy]" },
	{ kind: "feature", token: "$[feature:login]" },
	{ kind: "extension", token: "![ext:analyzer]" },
];

for (const [theme, useTheme] of [["light", useLightTheme], ["dark", useDarkTheme]] as const) {
	test(`mention labels remain readable in ${theme} theme @evidence`, async ({ page, mockApi }, testInfo) => {
		await useTheme(page);
		await mockApi({ projects: [proj], conversations: [conv], messages: [makeMessage({
			id: "mention-colors", conversationId: conv.id, role: "user",
			content: coloredMentions.map(({ token }) => token).join(" "),
		})] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.locator("#splash")).toHaveCount(0);
		const failures = [];
		for (const { kind } of coloredMentions) {
			const chip = page.getByTestId("chat-messages-container").locator(`[data-mention-kind="${kind}"]`);
			await expect(chip).toBeVisible();
			const measured = await measureContrast(chip);
			expect(measured.dark).toBe(theme === "dark");
			if (measured.ratio < 4.5) failures.push({ kind, ...measured });
		}
		expect(failures, "Every mention label must have at least 4.5:1 contrast").toEqual([]);
		await captureEvidence(page, testInfo, `mention-labels-${theme}`);
	});
}

test.describe("Mention pills in chat history", () => {
	test("assistant message renders extension mention as purple pill", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "analyze this" }),
				makeMessage({ id: "m2", conversationId: "conv-1", role: "assistant", content: "I used ![ext:analyzer] to check your code.", parentMessageId: "m1", createdAt: "2026-01-01T00:01:00.000Z" }),
			],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// The pill should render instead of raw text
		const pill = page.locator("span").filter({ hasText: "!analyzer" });
		await expect(pill).toBeVisible({ timeout: 5000 });

		// Raw token should NOT be visible
		await expect(page.getByText("![ext:analyzer]")).not.toBeVisible();

		// Pill should have purple styling
		const style = await pill.getAttribute("style");
		expect(style).toContain("rgba(168,85,247");
	});

	test("assistant message renders agent mention as blue pill", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "help me" }),
				makeMessage({ id: "m2", conversationId: "conv-1", role: "assistant", content: "Let me invoke ![agent:Code Assistant] for you.", parentMessageId: "m1", createdAt: "2026-01-01T00:01:00.000Z" }),
			],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const pill = page.locator("span").filter({ hasText: "!Code Assistant" });
		await expect(pill).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("![agent:Code Assistant]")).not.toBeVisible();

		const style = await pill.getAttribute("style");
		expect(style).toContain("rgba(59,130,246");
	});

	test("assistant message with multiple mentions renders all as pills", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "do both" }),
				makeMessage({ id: "m2", conversationId: "conv-1", role: "assistant", content: "I used ![ext:analyzer] and ![agent:Summarizer] together.", parentMessageId: "m1", createdAt: "2026-01-01T00:01:00.000Z" }),
			],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.locator("span").filter({ hasText: "!analyzer" })).toBeVisible({ timeout: 5000 });
		await expect(page.locator("span").filter({ hasText: "!Summarizer" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("![ext:analyzer]")).not.toBeVisible();
		await expect(page.getByText("![agent:Summarizer]")).not.toBeVisible();
	});

	test("user message renders mention as MentionChip component", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Check ![ext:analyzer] please" }),
			],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// User messages use MentionChip component (Svelte) with purple Tailwind classes
		const chip = page.locator("span.border-purple-500\\/30").filter({ hasText: "!analyzer" });
		await expect(chip).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("![ext:analyzer]")).not.toBeVisible();
	});
});
