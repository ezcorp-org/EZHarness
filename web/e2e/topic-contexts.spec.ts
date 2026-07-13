/**
 * E2E for Topic Contexts (WS7) — the click-a-topic-pill → extract → copy →
 * save-to-library feature. Every LLM-backed route (detect / extract) is mocked
 * at the network layer, so the browser never waits on a real model.
 *
 * Scenarios (spec §WS7):
 *   A  happy path: Topics button empty state → Analyze (mock POST returns a
 *      fixed topic set) → hover a message → topic pill → click → extract result
 *      panel + copied badge → clipboard actually holds the extracted markdown.
 *   B  staleness: cached GET returns `stale:true` → the popover shows the stale
 *      banner + "Refresh (N new)" label → Refresh re-POSTs the detect endpoint.
 *   C  library: deep-link `/memories?tab=contexts` → rows render → search +
 *      type-chip narrow the request (and the visible rows) → Copy → Delete
 *      (click-to-confirm, 2 clicks) removes the row.
 *   D  failure surfaces: extract → 503 `{error}` shows the actionable message;
 *      and an auto-copy that fails (gesture expiry) falls back to a manual Copy
 *      button that succeeds on the fresh gesture.
 *
 * @evidence captures (frontend-visual CI gate): topic-pills, topics-popover,
 * topic-extract-result, contexts-library.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

const PROJECT_ID = "proj-tc";
const CONV_ID = "conv-tc";

const project = makeProject({ id: PROJECT_ID, name: "Topic Contexts Project" });
const conversation = makeConversation({
	id: CONV_ID,
	projectId: PROJECT_ID,
	title: "Auth design chat",
});

const userMsg = makeMessage({
	id: "m-user",
	conversationId: CONV_ID,
	role: "user",
	content: "How should we implement JWT auth with refresh tokens?",
});
const asstMsg = makeMessage({
	id: "m-asst",
	conversationId: CONV_ID,
	role: "assistant",
	content:
		"Use short-lived access tokens with rotating httpOnly refresh tokens.",
	parentMessageId: "m-user",
	createdAt: "2026-01-01T00:01:00.000Z",
});

const CONTEXT_TYPES = [
	{ id: "feature", label: "Feature", description: "A capability or feature", sortOrder: 0 },
	{ id: "decision", label: "Decision", description: "A decision that was made", sortOrder: 1 },
	{ id: "how-to", label: "How-to", description: "A how-to guide", sortOrder: 2 },
];

// Detected topics — one anchored to the assistant row (drives the hover pill),
// one to the user row (so the popover shows a second row + a badge count of 2).
const TOPIC_JWT = {
	id: "t-jwt",
	label: "JWT auth with refresh tokens",
	typeId: "feature",
	messageIds: ["m-asst"],
};
const TOPIC_SESSION = {
	id: "t-session",
	label: "Session storage decision",
	typeId: "decision",
	messageIds: ["m-user"],
};

const EXTRACT_MARKDOWN =
	"## JWT auth with refresh tokens\n\n- Short-lived access token (15m)\n- Rotating refresh token, httpOnly cookie\n\n```ts\nconst access = sign(claims, { expiresIn: '15m' });\n```";

function extractContext(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx-jwt",
		topicLabel: TOPIC_JWT.label,
		typeId: "feature",
		title: TOPIC_JWT.label,
		content: EXTRACT_MARKDOWN,
		model: "qwen3:1.7b",
		updatedAt: "2026-01-01T00:05:00.000Z",
		...overrides,
	};
}

// Route matchers. Kept precise + disjoint so the extract route never shadows
// the topics list route (the extract URL doesn't end at `/topics`).
const RE_CONTEXT_TYPES = /\/api\/context-types(?:\?.*)?$/;
const RE_TOPICS = /\/api\/conversations\/[^/]+\/topics(?:\?.*)?$/;
const RE_EXTRACT = /\/api\/conversations\/[^/]+\/topics\/[^/]+\/extract(?:\?.*)?$/;
const RE_CONTEXTS_LIST = /\/api\/contexts(?:\?.*)?$/;
const RE_CONTEXTS_ID = /\/api\/contexts\/[^/]+(?:\?.*)?$/;

interface TopicsBody {
	topics: typeof TOPIC_JWT[];
	stale: boolean;
	analyzedAt: string | null;
}

interface TopicRouteOpts {
	getTopics: () => TopicsBody;
	postTopics?: () => TopicsBody;
	/** Extract response: a 200 `{context}` by default, or a >=400 `{error}`. */
	extract?: { status?: number; error?: string; context?: Record<string, unknown> };
	types?: typeof CONTEXT_TYPES;
}

/**
 * Install the topic/context routes AFTER `mockApi` so they win precedence
 * (Playwright runs later-registered handlers first). Returns recorders the
 * test can assert against.
 */
async function installTopicRoutes(page: Page, opts: TopicRouteOpts) {
	const rec = { postTopicsCalls: [] as unknown[], extractCalls: [] as string[] };
	const types = opts.types ?? CONTEXT_TYPES;

	await page.route(RE_CONTEXT_TYPES, (route) =>
		route.fulfill({ json: { types } }),
	);

	await page.route(RE_TOPICS, async (route) => {
		const method = route.request().method();
		if (method === "GET") return route.fulfill({ json: opts.getTopics() });
		if (method === "POST") {
			rec.postTopicsCalls.push(route.request().postDataJSON());
			return route.fulfill({ json: (opts.postTopics ?? opts.getTopics)() });
		}
		return route.fallback();
	});

	await page.route(RE_EXTRACT, async (route) => {
		rec.extractCalls.push(route.request().url());
		const e = opts.extract ?? {};
		if (e.status && e.status >= 400) {
			return route.fulfill({ status: e.status, json: { error: e.error ?? "" } });
		}
		return route.fulfill({ json: { context: e.context ?? extractContext() } });
	});

	return rec;
}

test.describe("Topic Contexts", () => {
	test("A: analyze → hover pill → extract → copied badge + clipboard @evidence", async ({
		page,
		mockApi,
		context,
	}, testInfo) => {
		// clipboard-write lets the auto-copy land; clipboard-read lets us assert it.
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await mockApi({
			projects: [project],
			conversations: [conversation],
			messages: [userMsg, asstMsg],
		});
		const rec = await installTopicRoutes(page, {
			// Cache-only load: nothing analyzed yet.
			getTopics: () => ({ topics: [], stale: false, analyzedAt: null }),
			// Analyze/Refresh detects the two topics.
			postTopics: () => ({
				topics: [TOPIC_JWT, TOPIC_SESSION],
				stale: false,
				analyzedAt: "2026-01-01T00:05:00.000Z",
			}),
			extract: { context: extractContext() },
		});

		await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`, {
			waitUntil: "networkidle",
		});
		await expect(
			page.getByText("Use short-lived access tokens"),
		).toBeVisible({ timeout: 5000 });

		// Open the header Topics popover → empty state.
		await page.getByTestId("topics-btn").click();
		const popover = page.getByTestId("topics-popover");
		await expect(popover).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("topics-empty")).toBeVisible();
		await expect(page.getByTestId("topics-analyze-btn")).toHaveText(/Analyze/);

		// Analyze → the mocked POST returns the fixed topic set.
		await page.getByTestId("topics-analyze-btn").click();
		await expect(
			popover.getByTestId(`topic-pill-${TOPIC_JWT.id}`),
		).toBeVisible({ timeout: 5000 });
		await expect(
			popover.getByTestId(`topic-pill-${TOPIC_SESSION.id}`),
		).toBeVisible();
		expect(rec.postTopicsCalls.length).toBe(1);
		await captureEvidence(page, testInfo, "topics-popover");

		// Close the popover (its full-screen backdrop would otherwise intercept
		// the message-row pill click) by clicking the backdrop away from the
		// top-right popover.
		await page.getByTestId("topics-backdrop").click({ position: { x: 8, y: 320 } });
		await expect(popover).toBeHidden();

		// Hover the assistant row → its hover-revealed topic pill appears. Both
		// anchored rows render a `topic-pills` overlay, so scope to the assistant
		// message to avoid matching the user row's pill too.
		const asstRow = page.locator('[data-message-id="m-asst"]');
		await asstRow.getByText("Use short-lived access tokens").hover();
		const rowPills = asstRow.getByTestId("topic-pills");
		await expect(rowPills).toBeVisible({ timeout: 5000 });
		const rowPill = rowPills.getByTestId(`topic-pill-${TOPIC_JWT.id}`);
		await expect(rowPill).toBeVisible();
		await captureEvidence(page, testInfo, "topic-pills");

		// Click the pill → stage-2 extract → result panel reopens in the popover.
		await rowPill.click();
		const result = page.getByTestId("topic-extract-result");
		await expect(result).toBeVisible({ timeout: 5000 });
		await expect(result).toContainText("Short-lived access token");
		await expect(page.getByTestId("topic-copied-badge")).toBeVisible();
		await expect(page.getByTestId("topic-library-link")).toHaveAttribute(
			"href",
			"/memories?tab=contexts",
		);
		expect(rec.extractCalls.length).toBe(1);
		await captureEvidence(page, testInfo, "topic-extract-result");

		// The extracted markdown really landed on the clipboard (chromium).
		const clip = await page.evaluate(() => navigator.clipboard.readText());
		expect(clip).toBe(EXTRACT_MARKDOWN);
	});

	test("B: cached stale topics → stale banner + Refresh re-POSTs", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [project],
			conversations: [conversation],
			messages: [userMsg, asstMsg],
		});
		const rec = await installTopicRoutes(page, {
			// Cached GET: already analyzed, now stale. Only the assistant row is
			// covered, so the client-side "N new" hint counts the user row → 1.
			getTopics: () => ({
				topics: [TOPIC_JWT],
				stale: true,
				analyzedAt: "2026-01-01T00:02:00.000Z",
			}),
			postTopics: () => ({
				topics: [TOPIC_JWT, TOPIC_SESSION],
				stale: false,
				analyzedAt: "2026-01-01T00:06:00.000Z",
			}),
		});

		await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`, {
			waitUntil: "networkidle",
		});
		// The cached GET populated the badge (count = 1).
		await expect(page.getByTestId("topics-badge")).toHaveText("1", {
			timeout: 5000,
		});

		await page.getByTestId("topics-btn").click();
		await expect(page.getByTestId("topics-stale-banner")).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByTestId("topics-stale-banner")).toContainText(
			"New messages since the last analysis",
		);
		// Derived client-side from the frozen contract's messageIds.
		await expect(page.getByTestId("topics-analyze-btn")).toHaveText(
			/Refresh \(1 new\)/,
		);

		// Refresh → re-POST the detect endpoint.
		await page.getByTestId("topics-analyze-btn").click();
		await expect
			.poll(() => rec.postTopicsCalls.length, { timeout: 5000 })
			.toBe(1);
		expect(rec.postTopicsCalls[0]).toEqual({ force: true });
		// After refresh the second topic shows up (no longer stale).
		await expect(
			page.getByTestId("topics-popover").getByTestId(`topic-pill-${TOPIC_SESSION.id}`),
		).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("topics-stale-banner")).toBeHidden();
	});

	test("C: library tab — search + type filter, copy, click-to-confirm delete @evidence", async ({
		page,
		mockApi,
		context,
	}, testInfo) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);

		const rowJwt = {
			id: "ctx-jwt",
			topicLabel: "JWT auth",
			typeId: "feature",
			title: "JWT auth implementation",
			content: "Short-lived access tokens with rotating refresh tokens.",
			conversationId: CONV_ID,
			model: "qwen3:1.7b",
			createdAt: "2026-01-01T00:05:00.000Z",
			updatedAt: "2026-01-01T00:05:00.000Z",
		};
		const rowDb = {
			id: "ctx-db",
			topicLabel: "Database choice",
			typeId: "decision",
			title: "Chose Postgres over Mongo",
			content: "We picked Postgres for relational integrity and JSONB.",
			conversationId: CONV_ID,
			model: "qwen3:1.7b",
			createdAt: "2026-01-01T00:06:00.000Z",
			updatedAt: "2026-01-01T00:06:00.000Z",
		};
		let rows = [rowJwt, rowDb];
		const listCalls: string[] = [];
		const deleteCalls: string[] = [];

		await mockApi({ projects: [project] });
		await page.route(RE_CONTEXT_TYPES, (route) =>
			route.fulfill({ json: { types: CONTEXT_TYPES } }),
		);
		await page.route(RE_CONTEXTS_LIST, async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			const url = new URL(route.request().url());
			listCalls.push(route.request().url());
			const search = (url.searchParams.get("search") ?? "").toLowerCase();
			const typeId = url.searchParams.get("typeId") ?? "";
			let out = rows;
			if (search) {
				out = out.filter((r) =>
					`${r.title} ${r.content}`.toLowerCase().includes(search),
				);
			}
			if (typeId) out = out.filter((r) => r.typeId === typeId);
			return route.fulfill({ json: { contexts: out, total: out.length } });
		});
		await page.route(RE_CONTEXTS_ID, async (route) => {
			if (route.request().method() !== "DELETE") return route.fallback();
			const id = new URL(route.request().url()).pathname.split("/").pop()!;
			deleteCalls.push(id);
			rows = rows.filter((r) => r.id !== id);
			return route.fulfill({ status: 204, body: "" });
		});

		await page.goto("/memories?tab=contexts", { waitUntil: "networkidle" });

		// Both rows render.
		await expect(
			page.locator('[data-testid="context-row"]'),
		).toHaveCount(2, { timeout: 5000 });
		await expect(page.getByText("JWT auth implementation")).toBeVisible();
		await expect(page.getByText("Chose Postgres over Mongo")).toBeVisible();
		await captureEvidence(page, testInfo, "contexts-library");

		// Search narrows the request AND the visible rows.
		await page.getByTestId("contexts-search").fill("postgres");
		await expect(
			page.locator('[data-testid="context-row"]'),
		).toHaveCount(1, { timeout: 5000 });
		await expect(page.getByText("Chose Postgres over Mongo")).toBeVisible();
		expect(listCalls.some((u) => u.includes("search=postgres"))).toBe(true);

		// Clear search, then filter by the "decision" type chip.
		await page.getByTestId("contexts-search").fill("");
		await expect(
			page.locator('[data-testid="context-row"]'),
		).toHaveCount(2, { timeout: 5000 });
		await page.getByTestId("context-type-chip-decision").click();
		await expect(
			page.locator('[data-testid="context-row"]'),
		).toHaveCount(1, { timeout: 5000 });
		await expect(page.getByText("Chose Postgres over Mongo")).toBeVisible();
		expect(listCalls.some((u) => u.includes("typeId=decision"))).toBe(true);

		// Expand the remaining row → Copy its content.
		const row = page.locator('[data-context-id="ctx-db"]');
		await row.getByText("Chose Postgres over Mongo").click();
		await expect(page.getByTestId("context-content")).toBeVisible();
		await row.getByTestId("context-copy").click();
		await expect(row.getByTestId("context-copy")).toHaveText(/Copied/);
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
			rowDb.content,
		);

		// Delete is click-to-confirm: first click arms, second click removes.
		await row.getByTestId("context-delete").click();
		await expect(row.getByTestId("context-delete")).toHaveText(/Confirm/);
		await row.getByTestId("context-delete").click();
		await expect(page.locator('[data-context-id="ctx-db"]')).toHaveCount(0, {
			timeout: 5000,
		});
		expect(deleteCalls).toContain("ctx-db");
	});

	test("D1: extract 503 surfaces the actionable error message", async ({
		page,
		mockApi,
	}) => {
		const errorMsg =
			"Couldn't extract this topic — the local model sidecar is unreachable. Start it or set a Topic Contexts model in settings.";
		await mockApi({
			projects: [project],
			conversations: [conversation],
			messages: [userMsg, asstMsg],
		});
		await installTopicRoutes(page, {
			getTopics: () => ({
				topics: [TOPIC_JWT],
				stale: false,
				analyzedAt: "2026-01-01T00:03:00.000Z",
			}),
			extract: { status: 503, error: errorMsg },
		});

		await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`, {
			waitUntil: "networkidle",
		});
		await expect(page.getByTestId("topics-badge")).toHaveText("1", {
			timeout: 5000,
		});
		await page.getByTestId("topics-btn").click();

		// Extract from the popover row → 503 → actionable error banner.
		await page
			.getByTestId("topics-popover")
			.getByTestId(`topic-pill-${TOPIC_JWT.id}`)
			.click();
		const err = page.getByTestId("topic-extract-error");
		await expect(err).toBeVisible({ timeout: 5000 });
		await expect(err).toHaveText(errorMsg);
	});

	test("D2: auto-copy failure falls back to a working manual Copy button", async ({
		page,
		mockApi,
		context,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		// Model a gesture-expiry: the auto-copy after the (awaited) extract fetch
		// throws, the execCommand fallback misses, but a fresh manual click works.
		await page.addInitScript(() => {
			let calls = 0;
			const clip = navigator.clipboard;
			const real = clip.writeText.bind(clip);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(clip as any).writeText = async (text: string) => {
				calls++;
				if (calls === 1) throw new Error("copy gesture expired");
				return real(text);
			};
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(document as any).execCommand = () => false;
		});

		await mockApi({
			projects: [project],
			conversations: [conversation],
			messages: [userMsg, asstMsg],
		});
		await installTopicRoutes(page, {
			getTopics: () => ({
				topics: [TOPIC_JWT],
				stale: false,
				analyzedAt: "2026-01-01T00:03:00.000Z",
			}),
			extract: { context: extractContext() },
		});

		await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`, {
			waitUntil: "networkidle",
		});
		await expect(page.getByTestId("topics-badge")).toHaveText("1", {
			timeout: 5000,
		});
		await page.getByTestId("topics-btn").click();
		await page
			.getByTestId("topics-popover")
			.getByTestId(`topic-pill-${TOPIC_JWT.id}`)
			.click();

		// Result panel shows, but the copied badge did NOT — a manual Copy button
		// is offered instead (auto-copy failed).
		await expect(page.getByTestId("topic-extract-result")).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByTestId("topic-copied-badge")).toBeHidden();
		const manualCopy = page.getByTestId("topic-copy-btn");
		await expect(manualCopy).toBeVisible();

		// The fresh gesture succeeds → copied badge appears + clipboard holds it.
		await manualCopy.click();
		await expect(page.getByTestId("topic-copied-badge")).toBeVisible({
			timeout: 5000,
		});
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
			EXTRACT_MARKDOWN,
		);
	});
});
