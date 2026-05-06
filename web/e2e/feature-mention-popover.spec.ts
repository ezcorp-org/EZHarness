/**
 * E2E for the `$feature` chip's hover popover in chat history.
 *
 * Companion to `feature-mention-injection.spec.ts` (composer flow).
 * That suite covers the input side: typing `$cha` → picker → token
 * inserted. This suite covers the OUTPUT side: a persisted
 * `$[feature:NAME]` token in a chat message renders as a hover chip
 * that, on hover, shows the description + a code-editor-style file
 * tree. Mirrors `slash-commands.spec.ts`'s `/cmd` chip popover suite.
 *
 * Covered behaviors:
 *   1. Chat history renders the feature mention as a chip with the
 *      `$` sigil.
 *   2. Hovering the chip pops a tooltip showing
 *      "Feature $NAME" + description + "Files (N)".
 *   3. The file tree renders box-drawing connectors (├─ / └─) and
 *      every pinned file is visible after auto-expand.
 *   4. Clicking a directory row collapses its subtree without
 *      dismissing the popover.
 *   5. Mouseleave eventually unmounts the popover (deferred close
 *      working end-to-end).
 *   6. Popover position attribute reflects above/below decision.
 */
import { test, expect } from "./fixtures/test-base.js";
import {
	makeProject,
	makeConversation,
	makeMessage,
} from "./fixtures/data.js";

const PROJECT_ID = "proj-feat-popover";
const CONV_ID = "conv-feat-popover";
const FEATURE_ID = "f-chat";
const FEATURE_NAME = "chat";

const project = makeProject({ id: PROJECT_ID, name: "Feature Popover Project" });
const conv = makeConversation({
	id: CONV_ID,
	projectId: PROJECT_ID,
	title: "Feature popover chat",
});

// Persisted user message containing the raw `$[feature:chat]` token.
// MentionText.svelte renders this as a `feature` chip via getSegments.
const messageWithFeature = makeMessage({
	id: "msg-feat-1",
	conversationId: CONV_ID,
	role: "user",
	content: "Look at $[feature:chat] before changing the wire format.",
});

const featureFiles = {
	[FEATURE_ID]: [
		{ relpath: "src/chat/index.ts", source: "scan" as const },
		{ relpath: "src/chat/util.ts", source: "user" as const },
		{ relpath: "src/chat/stream/parser.ts", source: "scan" as const },
	],
};

const featureFixture = {
	id: FEATURE_ID,
	projectId: PROJECT_ID,
	name: FEATURE_NAME,
	description: "Streaming chat slice + persistence layer.",
	source: "agent" as const,
	fileCount: 3,
};

async function gotoChatWithMessage(page: any, mockApi: any) {
	await mockApi({
		projects: [project],
		conversations: [conv],
		messages: [messageWithFeature],
		features: [featureFixture],
		featureFiles,
	});
	await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`);
	// Connection establishment race (mirrors other feature specs).
	await page.waitForFunction(
		() => {
			const listeners = (window as any).__fakeWsListeners;
			if (listeners?.open) {
				for (const fn of listeners.open) {
					try {
						fn(new Event("open"));
					} catch {}
				}
			}
			const ta = document.querySelector("textarea");
			return ta && !(ta as HTMLTextAreaElement).disabled;
		},
		{ timeout: 5000 },
	);
}

test.describe("Feature mention chip — hover popover", () => {
	test("hovering a $feature chip reveals description + file tree", async ({
		page,
		mockApi,
	}) => {
		await gotoChatWithMessage(page, mockApi);

		const chip = page
			.locator(
				`[data-mention-kind='feature'][data-mention-name='${FEATURE_NAME}']`,
			)
			.first();
		await expect(chip).toBeVisible({ timeout: 5000 });
		await expect(chip).toHaveText(`$${FEATURE_NAME}`);

		await chip.hover();
		const popover = page.locator(`[data-feature-popover='${FEATURE_NAME}']`);
		await expect(popover).toBeVisible({ timeout: 3000 });
		await expect(popover).toContainText(`Feature $${FEATURE_NAME}`);
		await expect(popover).toContainText(featureFixture.description);
		await expect(popover).toContainText("Files (3)");

		// Auto-expand: every pinned file is visible without further clicks.
		for (const f of featureFiles[FEATURE_ID]) {
			await expect(popover).toContainText(f.relpath.split("/").pop()!);
		}

		// Box-drawing connectors render — at least one tee or corner.
		const popoverText = (await popover.textContent()) ?? "";
		expect(popoverText).toMatch(/├─|└─/);
	});

	test("clicking a directory row inside the popover collapses its subtree", async ({
		page,
		mockApi,
	}) => {
		await gotoChatWithMessage(page, mockApi);
		const chip = page
			.locator(
				`[data-mention-kind='feature'][data-mention-name='${FEATURE_NAME}']`,
			)
			.first();
		await chip.hover();
		const popover = page.locator(`[data-feature-popover='${FEATURE_NAME}']`);
		await expect(popover).toBeVisible({ timeout: 3000 });

		// All three files are visible after auto-expand.
		await expect(popover.locator("[data-feature-tree-file]")).toHaveCount(3);

		// Find a non-leaf dir that has children — `src/chat/stream` is
		// the deepest dir in the fixture (parent of parser.ts).
		const streamDir = popover.locator(
			"[data-feature-tree-dir='src/chat/stream']",
		);
		await expect(streamDir).toBeVisible();
		await streamDir.click();

		// One file (parser.ts) hidden; the other two remain.
		await expect(popover.locator("[data-feature-tree-file]")).toHaveCount(2);
		// Popover itself is still mounted — the click did NOT dismiss it.
		await expect(popover).toBeVisible();

		// Re-click expands again.
		await streamDir.click();
		await expect(popover.locator("[data-feature-tree-file]")).toHaveCount(3);
	});

	test("mouseleave eventually unmounts the popover (deferred close)", async ({
		page,
		mockApi,
	}) => {
		await gotoChatWithMessage(page, mockApi);
		const chip = page
			.locator(
				`[data-mention-kind='feature'][data-mention-name='${FEATURE_NAME}']`,
			)
			.first();
		await chip.hover();
		const popover = page.locator(`[data-feature-popover='${FEATURE_NAME}']`);
		await expect(popover).toBeVisible({ timeout: 3000 });

		// Move cursor far away from chip + popover.
		await page.mouse.move(0, 0);
		await expect(popover).toBeHidden({ timeout: 2000 });
	});

	test("popover position attribute exposes above/below for layout assertions", async ({
		page,
		mockApi,
	}) => {
		await gotoChatWithMessage(page, mockApi);
		const chip = page
			.locator(
				`[data-mention-kind='feature'][data-mention-name='${FEATURE_NAME}']`,
			)
			.first();
		await expect(chip).toBeVisible({ timeout: 5000 });

		// Inject ~600px of padding so the chip sits well below the
		// 360px flip threshold from the top of the viewport — popover
		// should render *above* the chip.
		await page.evaluate(() => {
			document.body.style.paddingTop = "600px";
		});
		await chip.scrollIntoViewIfNeeded();
		await chip.hover();

		const popover = page.locator(`[data-feature-popover='${FEATURE_NAME}']`);
		await expect(popover).toBeVisible({ timeout: 3000 });
		await expect(popover).toHaveAttribute("data-feature-popover-position", "above");
	});

	test("hovering a feature chip with no description shows the 'No description' fallback", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [project],
			conversations: [conv],
			messages: [messageWithFeature],
			features: [{ ...featureFixture, description: "" }],
			featureFiles,
		});
		await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`);
		await page.waitForFunction(
			() => {
				const ta = document.querySelector("textarea");
				return ta && !(ta as HTMLTextAreaElement).disabled;
			},
			{ timeout: 5000 },
		);

		const chip = page
			.locator(
				`[data-mention-kind='feature'][data-mention-name='${FEATURE_NAME}']`,
			)
			.first();
		await chip.hover();
		const popover = page.locator(`[data-feature-popover='${FEATURE_NAME}']`);
		await expect(popover).toBeVisible({ timeout: 3000 });
		await expect(popover).toContainText("No description");
	});

	test("hovering a feature chip with no pinned files shows 'No files pinned.'", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [project],
			conversations: [conv],
			messages: [messageWithFeature],
			features: [{ ...featureFixture, fileCount: 0 }],
			featureFiles: {},
		});
		await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`);
		await page.waitForFunction(
			() => {
				const ta = document.querySelector("textarea");
				return ta && !(ta as HTMLTextAreaElement).disabled;
			},
			{ timeout: 5000 },
		);

		const chip = page
			.locator(
				`[data-mention-kind='feature'][data-mention-name='${FEATURE_NAME}']`,
			)
			.first();
		await chip.hover();
		const popover = page.locator(`[data-feature-popover='${FEATURE_NAME}']`);
		await expect(popover).toBeVisible({ timeout: 3000 });
		await expect(popover).toContainText("Files (0)");
		await expect(popover).toContainText("No files pinned");
		// File tree is NOT mounted when there are zero files.
		await expect(popover.locator("[data-feature-tree-file]")).toHaveCount(0);
	});
});
