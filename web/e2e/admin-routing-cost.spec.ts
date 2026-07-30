import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

/**
 * @evidence — Admin Dashboard → Routing tab (routing + cost analytics).
 *
 * Two honesty properties are the point of this spec, not decoration:
 *
 *  1. An UNPRICED model (a subscription / OAuth plan is rate-limited, not
 *     billed per token) must be reported in TOKENS. A fabricated "$0.00"
 *     would read like a measured price. The API distinguishes the two by
 *     returning `cost: null` rather than a zeroed cost object.
 *  2. With no traffic yet, every rate is a truthful 0. The panel must say
 *     "nothing measured yet" rather than render zeros that look like failure.
 *
 * Both are asserted against REAL rendered numbers from a stubbed payload.
 */

const proj = makeProject({ id: "proj-1", name: "Test Project" });

const adminMe = {
	user: { id: "user-1", email: "admin@test.local", name: "Test Admin", role: "admin" },
};

const systemData = {
	health: { dbSizeBytes: 0, uptimeSeconds: 0, tableRowCounts: {} },
	activityFeed: [],
	errorSummary: { totalErrors: 0, errorRate: [], recentErrors: [] },
};

const emptyAnalytics = {
	chatActivity: [],
	modelUsage: [],
	agentStats: [],
	extensionStats: [],
	userStats: { totalUsers: 0, activeUsers30d: 0, signupsLast30d: [] },
	toolUsage: { byTool: [], byAgent: [], byUser: [], byModel: [] },
};

function cost(total: number) {
	return { input: total, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, total };
}

function tokens(input: number) {
	return { input, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
}

/** 3 routed of 12 provenance-carrying turns = 25.0%; 2 legacy rows excluded. */
const routingWithTraffic = {
	days: 30,
	turns: { total: 14, routed: 3, pinned: 9, legacy: 2 },
	routedShare: 0.25,
	tierMix: [
		{ tier: "powerful", count: 2 },
		{ tier: "fast", count: 1 },
	],
	failover: { count: 1, rate: 1 / 12 },
	switches: {
		pairs: 6, total: 2, escalations: 1, downgrades: 1, lateral: 0, rate: 2 / 6,
		samples: [
			{
				conversationId: "conv-a", turnIndex: 2,
				fromProvider: "anthropic", fromModel: "claude-haiku-4-5", fromTier: "fast",
				toProvider: "anthropic", toModel: "claude-opus-4-5", toTier: "powerful",
				kind: "escalation" as const,
			},
			{
				conversationId: "conv-a", turnIndex: 5,
				fromProvider: "anthropic", fromModel: "claude-opus-4-5", fromTier: "powerful",
				toProvider: "google", toModel: "gemini-2.5-flash", toTier: "fast",
				kind: "downgrade" as const,
			},
		],
	},
	retries: {
		answeredTurns: 12, retriedTurns: 1, extraSiblings: 2, rate: 1 / 12,
		samples: [
			{
				conversationId: "conv-a", parentMessageId: "msg-u9",
				siblingCount: 3, continuedThroughMessageId: "msg-a9b",
			},
		],
	},
	spend: {
		segments: [
			{
				provider: "anthropic", model: "claude-opus-4-5", provenance: "routed" as const,
				turnCount: 2, tokens: tokens(2_000_000), cost: cost(38.25),
			},
			{
				provider: "anthropic", model: "claude-haiku-4-5", provenance: "pinned" as const,
				turnCount: 9, tokens: tokens(9_000_000), cost: cost(22.3),
			},
			// UNPRICED: a subscription plan. Tokens only — never a dollar figure.
			{
				provider: "qwen-token-plan", model: "deepseek-v3.2", provenance: "routed" as const,
				turnCount: 1, tokens: tokens(500_000), cost: null,
			},
		],
		routedUsd: 38.25,
		pinnedUsd: 22.3,
		legacyUsd: 2.95,
		// Deliberately off a half-cent boundary: 63.50 / 2 = 31.75 exactly, so
		// the assertion tests the panel and not `toFixed`'s rounding of a float
		// like 31.775 (which lands on "31.77", not "31.78").
		totalUsd: 63.5,
		unpricedTurns: 1,
		unpricedTokens: 500_000,
		conversations: 2,
		usdPerConversation: 31.75,
	},
};

/** Turns happened, but nothing measurable came of them AND nothing was priced. */
const routingAllUnpriced = {
	days: 30,
	turns: { total: 4, routed: 4, pinned: 0, legacy: 0 },
	routedShare: 1,
	tierMix: [{ tier: "balanced", count: 4 }],
	failover: { count: 0, rate: 0 },
	switches: { pairs: 0, total: 0, escalations: 0, downgrades: 0, lateral: 0, rate: 0, samples: [] },
	retries: { answeredTurns: 4, retriedTurns: 0, extraSiblings: 0, rate: 0, samples: [] },
	spend: {
		segments: [
			{
				provider: "qwen-token-plan", model: "deepseek-v3.2", provenance: "routed" as const,
				turnCount: 4, tokens: tokens(1_200_000), cost: null,
			},
		],
		routedUsd: 0, pinnedUsd: 0, legacyUsd: 0, totalUsd: 0,
		unpricedTurns: 4, unpricedTokens: 1_200_000,
		conversations: 2,
		usdPerConversation: null,
	},
};

const routingNoTraffic = {
	days: 30,
	turns: { total: 0, routed: 0, pinned: 0, legacy: 0 },
	routedShare: 0,
	tierMix: [],
	failover: { count: 0, rate: 0 },
	switches: { pairs: 0, total: 0, escalations: 0, downgrades: 0, lateral: 0, rate: 0, samples: [] },
	retries: { answeredTurns: 0, retriedTurns: 0, extraSiblings: 0, rate: 0, samples: [] },
	spend: {
		segments: [], routedUsd: 0, pinnedUsd: 0, legacyUsd: 0, totalUsd: 0,
		unpricedTurns: 0, unpricedTokens: 0, conversations: 0, usdPerConversation: null,
	},
};

/**
 * Route-override keys are matched by `path.includes(pattern)`, so the longer
 * `/api/admin/analytics/routing` key MUST be inserted before the shorter
 * `/api/admin/analytics` one or the shorter would swallow it.
 */
function mocks(routing: unknown) {
	return {
		projects: [proj],
		routes: {
			"/api/admin/analytics/routing": () => routing,
			"/api/admin/analytics": () => emptyAnalytics,
			"/api/admin/system": () => systemData,
			"/api/auth/me": () => adminMe,
		},
	};
}

async function openRoutingTab(page: import("@playwright/test").Page) {
	await page.goto("/admin/dashboard");
	await expect(page.getByRole("button", { name: "Routing" })).toBeVisible({ timeout: 5000 });
	await page.getByRole("button", { name: "Routing" }).click();
}

test.describe("@evidence Admin Dashboard — Routing & Cost panel", () => {
	test("reports the routed share, escalations, retries and priced spend", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi(mocks(routingWithTraffic));
		await openRoutingTab(page);

		const panel = page.getByTestId("routing-panel");
		await expect(panel).toBeVisible({ timeout: 5000 });

		// ── Headline: the number that decides whether routing pays ──
		const share = page.getByTestId("routing-routed-share");
		await expect(share).toContainText("25.0%");
		await expect(share).toContainText("3 routed");
		await expect(share).toContainText("9 pinned");
		// Legacy rows are surfaced on their own, NOT folded into "routed".
		await expect(page.getByTestId("routing-legacy")).toContainText("2 without provenance");

		// Cost per resolved CONVERSATION, not per call.
		const perConv = page.getByTestId("routing-usd-per-conversation");
		await expect(perConv).toContainText("$31.75");
		await expect(perConv).toContainText("$63.50 over 2 conversations");

		// ── Tier mix (routed turns only) ──
		const tierMix = page.getByTestId("routing-tier-mix");
		await expect(tierMix).toContainText("powerful");
		await expect(tierMix).toContainText("fast");

		// ── Escalations, split by ladder direction, with the turn index ──
		const switches = page.getByTestId("routing-switches");
		await expect(switches).toContainText("2");
		await expect(switches).toContainText("1 up");
		await expect(switches).toContainText("1 down");
		await expect(switches).toContainText("escalation");
		await expect(switches).toContainText("claude-haiku-4-5");
		await expect(switches).toContainText("claude-opus-4-5");
		await expect(switches).toContainText("turn 2");
		await expect(switches).toContainText("downgrade");
		await expect(switches).toContainText("gemini-2.5-flash");
		await expect(switches).toContainText("turn 5");

		// ── A/B retries, including which sibling the branch continued through ──
		const retries = page.getByTestId("routing-retries");
		await expect(retries).toContainText("1");
		await expect(retries).toContainText("12 answered turns");
		await expect(retries).toContainText("3 answers");
		await expect(retries).toContainText("continued through msg-a9b");

		// ── Priced spend, routed vs pinned, per provider+model ──
		const spend = page.getByTestId("routing-spend");
		await expect(spend).toContainText("Routed $38.25");
		await expect(spend).toContainText("Pinned $22.30");
		await expect(spend).toContainText("claude-opus-4-5");
		await expect(spend).toContainText("$38.25");
		await expect(spend).toContainText("$22.30");
		// The unpriced model is NOT in the dollar table.
		await expect(spend).not.toContainText("deepseek-v3.2");

		// ── Unpriced (subscription) model: TOKENS, never a fabricated $0.00 ──
		const unpriced = page.getByTestId("routing-unpriced");
		await expect(unpriced).toContainText("deepseek-v3.2");
		await expect(unpriced).toContainText("qwen-token-plan");
		await expect(unpriced).toContainText("500,000 tok");
		await expect(unpriced).toContainText("no dollar cost");
		await expect(unpriced).not.toContainText("$0.00");

		await captureEvidence(page, testInfo, "admin-routing-cost-panel", { fullPage: true });
	});

	test("an all-subscription install shows tokens and a blank cost, never $0.00", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi(mocks(routingAllUnpriced));
		await openRoutingTab(page);

		await expect(page.getByTestId("routing-panel")).toBeVisible({ timeout: 5000 });

		// Nothing was priced, so "cost per conversation" is UNKNOWN — an em-dash
		// plus a reason, not the $0.00 a naive sum would print.
		const perConv = page.getByTestId("routing-usd-per-conversation");
		await expect(perConv).toContainText("No priced turns in this period");
		await expect(perConv).not.toContainText("$0.00");

		// The turns themselves are real and reported in tokens.
		await expect(page.getByTestId("routing-routed-share")).toContainText("100.0%");
		const unpriced = page.getByTestId("routing-unpriced");
		await expect(unpriced).toContainText("1,200,000 tok");
		await expect(unpriced).toContainText("4 turns");

		// Zero escalations / zero retries on real traffic read as an explicit
		// "none happened", not as a broken panel.
		await expect(page.getByTestId("routing-switches")).toContainText(
			"No mid-conversation model switches in this period",
		);
		await expect(page.getByTestId("routing-retries")).toContainText("No A/B retries in this period");

		await captureEvidence(page, testInfo, "admin-routing-cost-all-unpriced", { fullPage: true });
	});

	test("with no traffic at all the panel says so instead of showing zeros", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi(mocks(routingNoTraffic));
		await openRoutingTab(page);

		const empty = page.getByTestId("routing-empty");
		await expect(empty).toBeVisible({ timeout: 5000 });
		await expect(empty).toContainText("No assistant turns in this period yet");
		// The zeros-and-percentages panel is not rendered at all.
		await expect(page.getByTestId("routing-panel")).toHaveCount(0);
		await expect(page.getByTestId("routing-routed-share")).toHaveCount(0);

		await captureEvidence(page, testInfo, "admin-routing-cost-empty-state");
	});
});
