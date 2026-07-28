/**
 * E2E — the city-conditions card in the transcript
 * (frontend-visual change ⇒ `@evidence` per the feature contract).
 *
 * RENDER tier (`mockApi`): the conversation's `withToolCalls=true` GET
 * seeds a persisted tool call exactly as the server returns one, which is
 * also the path that proves the card reads its payload out of
 * `fullOutput` and its requested `unit` out of the call INPUT (the
 * envelope is always celsius — the card converts).
 *
 * What is pinned here is what a USER can see, which is where the failure
 * this card exists to kill lives:
 *
 *  1. MOLD. The provider publishes no mold spore data, so the payload
 *     ships `available: false` with a reason. The card must render an
 *     explicit "Not available" block SHOWING that reason — a blank, a 0,
 *     or a dash where a health figure belongs is the "execution
 *     succeeded, presentation lied" failure.
 *  2. A pollen grain the provider has NO value for (`null`) must be
 *     visually distinct from a MEASURED zero. Both are asserted in the
 *     same DOM so a regression that collapses them is caught.
 *  3. Honest degradation: an `ok:false` envelope renders a readable
 *     failure block, and an unparseable one falls through to DefaultCard
 *     rather than a blank-but-successful card.
 *  4. MOBILE. A prior bug collapsed a failure message to zero width in a
 *     non-wrapping flex row; the mold reason is measured at 390px.
 *
 * `captureEvidence` is a hard no-op unless `EZCORP_E2E_EVIDENCE=1`.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const PROJECT_ID = "proj-city-conditions";
const project = makeProject({ id: PROJECT_ID, name: "Conditions Project" });

const MOLD_REASON =
	"No keyless provider. Open-Meteo does not publish mold spore counts.";

/** The pinned contract envelope (tasks/city-conditions-contract.md).
 *  `birch: 0` is a MEASURED zero; alder/mugwort/olive are `null` — the
 *  provider has no value there. The card must not conflate them. */
const ENVELOPE = {
	v: 1,
	ok: true,
	place: {
		name: "Austin",
		admin1: "Texas",
		country: "United States",
		latitude: 30.267,
		longitude: -97.743,
		timezone: "America/Chicago",
	},
	observedAt: "2026-07-28T15:04:00-05:00",
	localTime: "3:04 PM",
	weather: {
		tempC: 34.2,
		feelsLikeC: 38.1,
		humidityPct: 55,
		windKph: 12.4,
		code: 2,
		label: "Partly cloudy",
		isDay: true,
	},
	pollen: {
		grains: { alder: null, birch: 0, grass: 8.1, mugwort: null, olive: null, ragweed: 1.4 },
		totalIndex: 9.5,
		band: "moderate",
	},
	mold: { available: false, reason: MOLD_REASON, count: null, band: null },
};

/** A persisted tool call in the shape `withToolCalls=true` returns. */
function persistedCall(over: {
	id: string;
	output: string;
	input: Record<string, unknown>;
	messageId: string;
	cardType?: string;
}) {
	return {
		id: over.id,
		extensionId: "city-conditions",
		toolName: "city-conditions__city_conditions",
		input: over.input,
		outputSummary: over.output.slice(0, 120),
		fullOutput: over.output,
		success: true,
		durationMs: 640,
		status: "success" as const,
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
			content: "what are the conditions in Austin? ![ext:city-conditions]",
			parentMessageId: null,
			createdAt: "2026-07-28T20:04:00.000Z",
		}),
		makeMessage({
			id: `${convId}-a1`,
			conversationId: convId,
			role: "assistant",
			content: "Here are the current conditions.",
			parentMessageId: `${convId}-u1`,
			createdAt: "2026-07-28T20:04:01.000Z",
		}),
	];
}

/** Seed one conversation whose assistant turn carries one city-conditions call. */
async function seedConditions(
	mockApi: (config: Record<string, unknown>) => Promise<void>,
	convId: string,
	call: ReturnType<typeof persistedCall>,
) {
	await mockApi({
		projects: [project],
		conversations: [
			makeConversation({ id: convId, projectId: PROJECT_ID, title: "Conditions" }),
		],
		messages: seedTurn(convId),
		messageToolCalls: { [`${convId}-a1`]: [call] },
	});
}

test.describe("city-conditions card in the transcript", () => {
	test("renders place-local time, the reading, both pollen states and an explicit mold reason @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		const convId = "conv-city-conditions";
		await seedConditions(
			mockApi,
			convId,
			persistedCall({
				id: "tc-city-ok",
				input: { city: "Austin" },
				messageId: `${convId}-a1`,
				cardType: "city-conditions",
				output: JSON.stringify(ENVELOPE),
			}),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const card = page.getByTestId("city-conditions-card");
		await expect(card).toBeVisible({ timeout: 10_000 });

		// Place + the PLACE's local time (not the runner's clock).
		await expect(page.getByTestId("city-conditions-place")).toHaveText(
			"Austin, Texas, United States",
		);
		await expect(page.getByTestId("city-conditions-timezone")).toHaveText("America/Chicago");
		const clock = page.getByTestId("city-conditions-local-time");
		await expect(clock).toHaveText("3:04 PM");
		await expect(clock).toHaveAttribute("data-reported", "true");

		// The reading — celsius, because the call requested no unit.
		await expect(page.getByTestId("city-conditions-temp")).toHaveText("34.2 °C");
		await expect(page.getByTestId("city-conditions-condition")).toHaveText("Partly cloudy");
		await expect(page.getByTestId("city-conditions-feels-like")).toHaveText("38.1 °C");
		await expect(page.getByTestId("city-conditions-humidity")).toHaveText("55%");
		await expect(page.getByTestId("city-conditions-wind")).toHaveText("12.4 km/h");

		// All six grains, the total, and the host-computed band.
		await expect(page.getByTestId("city-conditions-grain")).toHaveCount(6);
		await expect(page.getByTestId("city-conditions-pollen-total")).toHaveText("9.5");
		const band = page.getByTestId("city-conditions-pollen-band");
		await expect(band).toHaveText("Moderate");
		await expect(band).toHaveAttribute("data-band", "moderate");

		// A NULL grain and a MEASURED ZERO are not the same thing on screen.
		const alder = card.locator('[data-grain="alder"] [data-testid="city-conditions-grain-value"]');
		const birch = card.locator('[data-grain="birch"] [data-testid="city-conditions-grain-value"]');
		await expect(alder).toHaveText("Not reported");
		await expect(alder).toHaveAttribute("data-reported", "false");
		await expect(birch).toHaveText("0.0");
		await expect(birch).toHaveAttribute("data-reported", "true");
		// …and they differ in rendered style, not just in text.
		const alderStyle = await alder.evaluate((el) => getComputedStyle(el).fontStyle);
		const birchStyle = await birch.evaluate((el) => getComputedStyle(el).fontStyle);
		expect(alderStyle).toBe("italic");
		expect(birchStyle).toBe("normal");

		// MOLD — the figure that must never render blank.
		const mold = page.getByTestId("city-conditions-mold-unavailable");
		await expect(mold).toBeVisible();
		await expect(mold).toContainText("Not available");
		const reason = page.getByTestId("city-conditions-mold-reason");
		await expect(reason).toHaveText(MOLD_REASON);
		await expect(page.getByTestId("city-conditions-mold-count")).toHaveCount(0);

		// The surrounding turns render around the card.
		await expect(page.locator(`[data-message-id="${convId}-u1"]`)).toContainText(
			"what are the conditions in Austin?",
		);
		await expect(page.locator(`[data-message-id="${convId}-a1"]`)).toContainText(
			"Here are the current conditions.",
		);

		await captureEvidence(page, testInfo, "city-conditions-card");

		// Capture contract (mirrors preprocess-grade-delta.spec) — meaningful
		// in both modes rather than a bare screenshot call.
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "city-conditions-card" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "city-conditions-card")).toBe(false);
		}
	});

	test("unit:fahrenheit from the call input converts the celsius payload", async ({
		page,
		mockApi,
	}) => {
		const convId = "conv-city-conditions-f";
		await seedConditions(
			mockApi,
			convId,
			persistedCall({
				id: "tc-city-f",
				input: { city: "Austin", unit: "fahrenheit" },
				messageId: `${convId}-a1`,
				cardType: "city-conditions",
				output: JSON.stringify(ENVELOPE),
			}),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		await expect(page.getByTestId("city-conditions-card")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("city-conditions-temp")).toHaveText("93.6 °F");
		await expect(page.getByTestId("city-conditions-feels-like")).toHaveText("100.6 °F");
		await expect(page.getByTestId("city-conditions-wind")).toHaveText("7.7 mph");
		// Humidity is unitless and must not be touched by the conversion.
		await expect(page.getByTestId("city-conditions-humidity")).toHaveText("55%");
	});

	test("the mold reason stays readable at a 390px mobile width @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		// Regression guard: a failure message once collapsed to zero width in
		// a non-wrapping flex row on mobile. The reason IS the mold figure —
		// if it squeezes to nothing, the card is lying again.
		await page.setViewportSize({ width: 390, height: 900 });
		const convId = "conv-city-conditions-mobile";
		await seedConditions(
			mockApi,
			convId,
			persistedCall({
				id: "tc-city-mobile",
				input: { city: "Austin" },
				messageId: `${convId}-a1`,
				cardType: "city-conditions",
				output: JSON.stringify(ENVELOPE),
			}),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		await expect(page.getByTestId("city-conditions-card")).toBeVisible({ timeout: 10_000 });
		const reason = page.getByTestId("city-conditions-mold-reason");
		await expect(reason).toBeVisible();
		await expect(reason).toHaveText(MOLD_REASON);

		// The reason wraps into real width and real height — not a sliver.
		const box = await reason.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.width).toBeGreaterThan(120);
		expect(box!.height).toBeGreaterThan(20);

		// The grains still lay out without overflowing the card horizontally.
		const cardBox = await page.getByTestId("city-conditions-card").boundingBox();
		const grainBox = await page
			.locator('[data-grain="ragweed"]')
			.boundingBox();
		expect(grainBox!.x + grainBox!.width).toBeLessThanOrEqual(
			cardBox!.x + cardBox!.width + 1,
		);

		await captureEvidence(page, testInfo, "city-conditions-card-mobile");
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "city-conditions-card-mobile" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(
				testInfo.attachments.some((a) => a.name === "city-conditions-card-mobile"),
			).toBe(false);
		}
	});

	test("an ok:false envelope renders a readable failure block, never an empty card", async ({
		page,
		mockApi,
	}) => {
		const convId = "conv-city-conditions-err";
		await seedConditions(
			mockApi,
			convId,
			persistedCall({
				id: "tc-city-err",
				input: { city: "Attlantis" },
				messageId: `${convId}-a1`,
				cardType: "city-conditions",
				output: JSON.stringify({
					v: 1,
					ok: false,
					code: "CITY_NOT_FOUND",
					error: 'No geocoding match for "Attlantis".',
				}),
			}),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const failed = page.getByTestId("city-conditions-failed");
		await expect(failed).toBeVisible({ timeout: 10_000 });
		await expect(failed).toContainText("City conditions unavailable");
		await expect(page.getByTestId("city-conditions-failure-code")).toHaveText("CITY_NOT_FOUND");
		await expect(page.getByTestId("city-conditions-failure-message")).toHaveText(
			'No geocoding match for "Attlantis".',
		);
		// No half-drawn conditions panel alongside the failure.
		await expect(page.getByTestId("city-conditions-card")).toHaveCount(0);
	});

	test("an unparseable payload degrades to DefaultCard, not a blank conditions panel", async ({
		page,
		mockApi,
	}) => {
		const convId = "conv-city-conditions-junk";
		await seedConditions(
			mockApi,
			convId,
			persistedCall({
				id: "tc-city-junk",
				input: { city: "Austin" },
				messageId: `${convId}-a1`,
				cardType: "city-conditions",
				output: "upstream returned HTML, not JSON",
			}),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const defaultCard = page.getByTestId("tool-card-default");
		await expect(defaultCard).toBeVisible({ timeout: 10_000 });
		await expect(defaultCard).toContainText("city_conditions");
		await expect(page.getByTestId("city-conditions-card")).toHaveCount(0);
		await expect(page.getByTestId("city-conditions-failed")).toHaveCount(0);
	});
});
