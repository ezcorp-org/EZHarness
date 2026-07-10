/**
 * E2E for the deterministic-preprocess chat surface + GradeDeltaCard
 * (frontend-visual change ⇒ @evidence per the feature contract).
 *
 * RENDER-tier (mockApi): the backend runner's behavior (deterministic
 * trigger, row persistence, LLM grounding) is pinned by the bun suites
 * (src/__tests__/executor-preprocess-wiring.test.ts and friends). THIS
 * spec seeds a conversation exactly as the runner persists it — user →
 * `preprocess-result` row (chained) → assistant — and pins the
 * user-facing contract:
 *
 *   - the preprocess row renders INSIDE the transcript path as a
 *     GradeDeltaCard (grader badge, cert, identity title, grouped
 *     adjacent-grade bars, price table with honest N/A cells);
 *   - an ok:false row renders DefaultCard's error state (never a
 *     broken chart card);
 *   - the surrounding user + assistant turns render around the card.
 *
 * Evidence captures are a hard no-op unless EZCORP_E2E_EVIDENCE=1
 * (mirrors graded-card-scanner.spec).
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import {
	makeProject,
	makeConversation,
	makeMessage,
} from "./fixtures/data.js";

const PROJECT_ID = "proj-preprocess";
const CONV_ID = "conv-preprocess";
const CONV_ERR_ID = "conv-preprocess-err";

const project = makeProject({ id: PROJECT_ID, name: "Preprocess Project" });

const IDENTIFY_RECORD = {
	cert: "49392223",
	grader: "PSA",
	identity: {
		subject: "Charizard",
		year: "1999",
		set: "Pokemon Base Set",
		cardNo: "4",
		variety: "Holo",
		grade: "PSA 9",
	},
	grades: {
		PSA: { "9": 2587.5, "10": 30100 },
		BGS: { "9.5": 3875, "10": 46000 },
		SGC: { "10": 8494.97 },
	},
	deltas: [
		{
			company: "PSA",
			steps: [{ from: "9", to: "10", fromPrice: 2587.5, toPrice: 30100, pct: 1063.3 }],
		},
		{
			company: "BGS",
			steps: [{ from: "9.5", to: "10", fromPrice: 3875, toPrice: 46000, pct: 1087.1 }],
		},
	],
	sources: {
		decode: { source: "zxing", fetchedAt: "2026-07-09T00:00:00.000Z" },
		identity: { source: "psa-api", fetchedAt: "2026-07-09T00:00:00.000Z" },
		price: { source: "pricecharting", fetchedAt: "2026-07-09T00:00:00.000Z" },
	},
};

/** The exact chain shape the host runner persists (user → row → assistant). */
function seedMessages(convId: string, rowContent: string) {
	return [
		makeMessage({
			id: `${convId}-u1`,
			conversationId: convId,
			role: "user",
			content: "what is this slab worth? ![ext:graded-card-scanner]",
			parentMessageId: null,
			createdAt: "2026-07-09T00:00:00.000Z",
		}),
		makeMessage({
			id: `${convId}-pp1`,
			conversationId: convId,
			role: "preprocess-result",
			content: rowContent,
			parentMessageId: `${convId}-u1`,
			createdAt: "2026-07-09T00:00:01.000Z",
		}),
		makeMessage({
			id: `${convId}-a1`,
			conversationId: convId,
			role: "assistant",
			content: "That slab is a 1999 Base Set Charizard, PSA 9 — a 10 sells for ~12× more.",
			parentMessageId: `${convId}-pp1`,
			createdAt: "2026-07-09T00:00:02.000Z",
		}),
	];
}

test.describe("Deterministic preprocess — GradeDeltaCard in the transcript", () => {
	test("preprocess-result row renders the grade-delta chart card between user and assistant turns, and captures evidence @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			projects: [project],
			conversations: [
				makeConversation({ id: CONV_ID, projectId: PROJECT_ID, title: "Slab chat" }),
			],
			messages: seedMessages(
				CONV_ID,
				JSON.stringify({
					extensionName: "graded-card-scanner",
					toolName: "identify_slab",
					cardType: "grade-delta-chart",
					ok: true,
					output: JSON.stringify(IDENTIFY_RECORD),
				}),
			),
		});
		await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`);

		// The chained row is ON the transcript path (user → row → assistant).
		const row = page.getByTestId("preprocess-result-row");
		await expect(row).toBeVisible({ timeout: 5000 });
		await expect(row).toHaveAttribute("data-preprocess-status", "complete");

		// GradeDeltaCard rendered from the row's JSON payload.
		const card = page.getByTestId("grade-delta-card");
		await expect(card).toBeVisible();
		await expect(page.getByTestId("grade-delta-grader")).toHaveText("PSA");
		await expect(page.getByTestId("grade-delta-cert")).toHaveText("#49392223");
		await expect(page.getByTestId("grade-delta-title")).toContainText(
			"1999 Pokemon Base Set Charizard #4",
		);

		// Grouped bar chart: one bar per adjacent-grade step, one label per
		// company with steps (SGC has a single priced grade → chart-omitted).
		await expect(page.getByTestId("grade-delta-bar")).toHaveCount(2);
		const groups = page.getByTestId("grade-delta-group");
		await expect(groups).toHaveCount(2);
		await expect(groups.nth(0)).toHaveText("PSA");
		await expect(groups.nth(1)).toHaveText("BGS");
		await expect(card).toContainText("+1063.3%");

		// Price table: every company (SGC included) + honest N/A cells.
		const table = page.getByTestId("grade-delta-table");
		await expect(table).toContainText("$30,100.00");
		await expect(table).toContainText("$8,494.97");
		await expect(table).toContainText("N/A");

		// The surrounding turns render around the card.
		await expect(
			page.locator(`[data-message-id="${CONV_ID}-u1"]`),
		).toContainText("what is this slab worth?");
		await expect(
			page.locator(`[data-message-id="${CONV_ID}-a1"]`),
		).toContainText("PSA 9");

		await captureEvidence(page, testInfo, "preprocess-grade-delta-card");

		// Capture contract (mirrors graded-card-scanner.spec) — meaningful
		// in both modes rather than a bare screenshot call.
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "preprocess-grade-delta-card" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(
				testInfo.attachments.some((a) => a.name === "preprocess-grade-delta-card"),
			).toBe(false);
		}
	});

	test("ok:false preprocess row renders DefaultCard's error state, never a broken chart", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [project],
			conversations: [
				makeConversation({
					id: CONV_ERR_ID,
					projectId: PROJECT_ID,
					title: "Slab chat (failed decode)",
				}),
			],
			messages: seedMessages(
				CONV_ERR_ID,
				JSON.stringify({
					extensionName: "graded-card-scanner",
					toolName: "identify_slab",
					cardType: "grade-delta-chart",
					ok: false,
					output: "identify_slab failed for slab.png: unsupported image MIME",
				}),
			),
		});
		await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ERR_ID}`);

		const row = page.getByTestId("preprocess-result-row");
		await expect(row).toBeVisible({ timeout: 5000 });
		await expect(row).toHaveAttribute("data-preprocess-status", "error");

		// cardType is dropped on failure — DefaultCard owns the error state.
		await expect(page.getByTestId("grade-delta-card")).toHaveCount(0);
		await expect(page.getByTestId("grade-delta-missing")).toHaveCount(0);
		const defaultCard = page.getByTestId("tool-card-default");
		await expect(defaultCard).toBeVisible();
		await expect(defaultCard).toContainText("graded-card-scanner__identify_slab");

		// The assistant turn still rendered — a failed preprocess never
		// blocks the conversation.
		await expect(
			page.locator(`[data-message-id="${CONV_ERR_ID}-a1"]`),
		).toContainText("PSA 9");
	});
});
