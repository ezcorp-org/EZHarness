/**
 * E2E — the extension-author tool cards in the transcript
 * (frontend-visual change ⇒ `@evidence` per the feature contract).
 *
 * Two defects are pinned here, both of which were invisible to unit
 * tests because they are about what a user can SEE:
 *
 *  1. A FAILED authoring call rendered as a red ✗, the tool name, and
 *     nothing else. `extractInputSummary` did not know the
 *     extension-author input keys so the header summary was undefined,
 *     and the output preview was gated on `status === 'complete'`, so
 *     the host's machine-readable `code` was only reachable by
 *     expanding the card. Load / permission / execution / bad-response
 *     failures were one identical grey row.
 *
 *  2. `create_extension`'s only actionable output — the
 *     `/extensions/author?prefill=<draftId>` deep-link — declared no
 *     `cardType`, so it landed in DefaultCard where the collapsed
 *     50-char preview truncated the URL away entirely and expanding
 *     showed it as plain text in a `<pre>`, never a link.
 *
 * RENDER tier (`mockApi`): the conversation's `withToolCalls=true` GET
 * seeds persisted tool calls exactly as the server returns them, which
 * is also the path that proves the header reads the failure payload out
 * of `fullOutput` — on hydration `error` is the literal string "Error"
 * and the structured body lives in the output.
 *
 * `captureEvidence` is a hard no-op unless `EZCORP_E2E_EVIDENCE=1`.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const PROJECT_ID = "proj-ext-author-cards";
const project = makeProject({ id: PROJECT_ID, name: "Authoring Project" });

/** A persisted tool call in the shape `withToolCalls=true` returns. */
function persistedCall(over: {
	id: string;
	toolName: string;
	input: Record<string, unknown>;
	output: string;
	status: "success" | "error";
	messageId: string;
	cardType?: string;
}) {
	return {
		id: over.id,
		extensionId: "extension-author",
		toolName: over.toolName,
		input: over.input,
		outputSummary: over.output.slice(0, 120),
		fullOutput: over.output,
		success: over.status === "success",
		durationMs: 320,
		status: over.status,
		messageId: over.messageId,
		...(over.cardType ? { cardType: over.cardType } : {}),
	};
}

function seedTurn(convId: string) {
	return [
		makeMessage({
			id: `${convId}-u1`,
			conversationId: convId,
			role: "user",
			content: "build me a tool extension that returns the weather",
			parentMessageId: null,
			createdAt: "2026-07-20T00:00:00.000Z",
		}),
		makeMessage({
			id: `${convId}-a1`,
			conversationId: convId,
			role: "assistant",
			content: "Working on it.",
			parentMessageId: `${convId}-u1`,
			createdAt: "2026-07-20T00:00:01.000Z",
		}),
	];
}

test.describe("extension-author cards in the transcript", () => {
	test("a failed install shows its failure CLASS, the draft, and the reason without expanding @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		const convId = "conv-ext-author-fail";
		const messages = seedTurn(convId);
		await mockApi({
			projects: [project],
			conversations: [
				makeConversation({ id: convId, projectId: PROJECT_ID, title: "Authoring" }),
			],
			messages,
			messageToolCalls: {
				[`${convId}-a1`]: [
					persistedCall({
						id: "tc-install-fail",
						toolName: "install_draft",
						input: { draftId: "draft-abc123" },
						status: "error",
						messageId: `${convId}-a1`,
						cardType: "ez-install",
						output: JSON.stringify({
							ok: false,
							code: "VERIFY_FAILED",
							error:
								"ezcorp/drafts.install failed: VERIFY_FAILED: smoke-test-roundtrip: Smoke test failed: expected isError=false",
						}),
					}),
				],
			},
		});

		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const card = page.locator("#tool-call-tc-install-fail");
		await expect(card).toBeVisible({ timeout: 10_000 });

		// The collapsed header carries the class, the code, the draft, and
		// the reason — none of this required a click.
		const chip = card.getByTestId("tool-card-failure-class");
		await expect(chip).toBeVisible();
		await expect(chip).toHaveAttribute("data-failure-class", "execution");
		await expect(chip).toContainText("VERIFY_FAILED");
		await expect(card).toContainText("draft-abc123");
		await expect(card.getByTestId("tool-card-failure-message")).toContainText(
			"smoke-test-roundtrip",
		);
		// Still collapsed while all of that is readable.
		await expect(card.locator("[aria-expanded='false']")).toHaveCount(1);

		await captureEvidence(page, testInfo, "extension-author-failure-card");
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) =>
						a.name === "extension-author-failure-card" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(
				testInfo.attachments.some((a) => a.name === "extension-author-failure-card"),
			).toBe(false);
		}
	});

	test("a permission failure reads differently from an execution failure", async ({
		page,
		mockApi,
	}) => {
		const convId = "conv-ext-author-perm";
		const messages = seedTurn(convId);
		await mockApi({
			projects: [project],
			conversations: [
				makeConversation({ id: convId, projectId: PROJECT_ID, title: "Authoring" }),
			],
			messages,
			messageToolCalls: {
				[`${convId}-a1`]: [
					persistedCall({
						id: "tc-modify-denied",
						toolName: "modify_extension",
						input: { name: "weather" },
						status: "error",
						messageId: `${convId}-a1`,
						output: JSON.stringify({
							ok: false,
							code: "NOT_FOUND_OR_NOT_MODIFIABLE",
							error:
								"ezcorp/drafts.reopen failed: Extension not found, not yours, or modification is not enabled.",
						}),
					}),
				],
			},
		});

		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);
		const chip = page
			.locator("#tool-call-tc-modify-denied")
			.getByTestId("tool-card-failure-class");
		await expect(chip).toBeVisible({ timeout: 10_000 });
		// The whole point: this is NOT the same treatment as VERIFY_FAILED.
		await expect(chip).toHaveAttribute("data-failure-class", "permission");
		await expect(chip).toContainText("Not permitted");
		await expect(chip).toContainText("NOT_FOUND_OR_NOT_MODIFIABLE");
	});

	test("create_extension's draft link renders as a real clickable anchor", async ({
		page,
		mockApi,
	}) => {
		const convId = "conv-ext-author-draft";
		const messages = seedTurn(convId);
		await mockApi({
			projects: [project],
			conversations: [
				makeConversation({ id: convId, projectId: PROJECT_ID, title: "Authoring" }),
			],
			messages,
			messageToolCalls: {
				[`${convId}-a1`]: [
					persistedCall({
						id: "tc-create-ok",
						toolName: "create_extension",
						input: { name: "weather", type: "tool", description: "returns weather" },
						status: "success",
						messageId: `${convId}-a1`,
						cardType: "ez-draft",
						output: JSON.stringify({
							draftId: "draft-abc123",
							openUrl: "/extensions/author?prefill=draft-abc123",
							name: "weather",
							type: "tool",
						}),
					}),
				],
			},
		});

		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const card = page.locator("#tool-call-tc-create-ok");
		await expect(card).toBeVisible({ timeout: 10_000 });
		await expect(card.getByTestId("ez-tool-result-card")).toBeVisible();
		await expect(card).toContainText("Draft ready: weather");

		// A REAL anchor with the untruncated href — not 50 chars of JSON.
		const link = card.getByTestId("ez-card-open");
		await expect(link).toHaveText("Open draft editor");
		await expect(link).toHaveAttribute(
			"href",
			"/extensions/author?prefill=draft-abc123",
		);
	});
});
