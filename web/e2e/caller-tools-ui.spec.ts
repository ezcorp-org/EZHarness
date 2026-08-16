/**
 * Caller-executed tools — the two surfaces a user actually sees.
 *
 *   1. The composer's 🔧 Tools popover grows a "Caller tools" section listing
 *      what the connected client device declared, with the same per-tool and
 *      master toggles every extension gets. Unchecking one is a REAL
 *      revocation: the map is persisted under the literal key `caller` and the
 *      runtime compiles it into `forceDeniedTools`.
 *   2. A caller tool's permission gate. Caller tools sit in NO auto-approve
 *      set — `needsApproval` returns true for `ask`, `auto-edit` AND `yolo` —
 *      so the user sees this card on every single call, whatever permission
 *      mode the client asked for. That is the feature's central safety
 *      property, and a screenshot of the card is the evidence for it.
 *
 * ── WHY THIS SPEC DRIVES NO RUN ──────────────────────────────────────────
 *
 * This is the MOCK lane, where `isTestSurfaceEnabled()` is fail-closed, so
 * `/api/__test/**` 404s and no scripted run is possible. Both surfaces are
 * therefore driven the way `pending-permission-tray.spec.ts` drives its
 * card — `page.route()` interception plus a synthetic SSE frame. The
 * functional flow (declare → LLM calls → gate → execute → result → resume)
 * is the real-tier `real-auth/caller-tool-flow.spec.ts`; splitting them is
 * deliberate, not an omission.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject, makeConversation } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Companion Chat" });

const DECLARED = [
	{
		name: "open_app",
		description: "Open an application on the connected device",
		parameters: { type: "object", properties: { app: { type: "string" } } },
	},
	{
		name: "capture_screen",
		description: "Take a screenshot of the connected device",
		parameters: { type: "object", properties: {} },
	},
];

/** Serve the conversation's declarations; capture any write back. */
async function mockCallerTools(page: Page, tools = DECLARED) {
	await page.route("**/api/conversations/*/caller-tools", (route) =>
		route.fulfill({ json: { tools } }),
	);
}

/** Capture the permission decision so approve/deny resolves cleanly. */
async function mockPermissionDecision(page: Page) {
	const posts: unknown[] = [];
	await page.route("**/api/tool-calls/*/permission", (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		posts.push(route.request().postDataJSON());
		return route.fulfill({ json: { ok: true } });
	});
	return posts;
}

/**
 * Wait for the store's SSE stream, then emit a caller-tool gate on a
 * conversation the streaming layer registered no run for — the same run-less
 * shape `pending-permission-tray.spec.ts` uses, which routes the prompt onto
 * the global fallback tray where it can be asserted without a live run.
 */
async function emitCallerGate(
	page: Page,
	emitSse: (e: { type: string; data: unknown }, urlMatch?: string) => Promise<void>,
) {
	await page.waitForFunction(() => {
		const es = (window as unknown as { __fakeEventSources?: unknown[] }).__fakeEventSources;
		return Array.isArray(es) && es.length > 0;
	});
	await emitSse(
		{
			type: "tool:permission_request",
			data: {
				conversationId: "conv-no-run-e2e",
				toolCallId: "tc-caller-open-app",
				toolName: "_caller__open_app",
				input: { app: "Notes" },
				category: "caller",
			},
		},
		"runtime-events",
	);
}

test.describe("Caller-executed tools — composer surface", () => {
	test("the Tools popover lists the connected device's tools @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], extensions: [] });
		await mockCallerTools(page);

		await page.goto("/project/proj-1/chat/conv-1");
		await page.getByTestId("conversation-tools-trigger").click();
		await expect(page.getByTestId("conversation-tools-popover")).toBeVisible();

		// Its own section, keyed by the literal pseudo-extension id "caller" —
		// a real extension NAMED caller cannot collide, because every real
		// extension's toggle key is a UUID.
		await expect(page.getByTestId("conv-ext-toggle-caller")).toBeChecked();
		await expect(page.getByTestId("conv-tool-caller-open_app")).toBeChecked();
		await expect(page.getByTestId("conv-tool-caller-capture_screen")).toBeChecked();

		await captureEvidence(page, testInfo, "caller-tools-dropdown");
	});

	test("unchecking a caller tool persists the narrowed map under the `caller` key", async ({
		page,
		mockApi,
	}) => {
		let lastPutBody: Record<string, unknown> | null = null;
		page.on("request", (req) => {
			if (req.method() === "PUT" && /\/api\/conversations\/conv-1$/.test(req.url())) {
				lastPutBody = req.postDataJSON() as Record<string, unknown>;
			}
		});

		await mockApi({ projects: [proj], conversations: [conv], extensions: [] });
		await mockCallerTools(page);

		await page.goto("/project/proj-1/chat/conv-1");
		await page.getByTestId("conversation-tools-trigger").click();
		await page.getByTestId("conv-tool-caller-capture_screen").uncheck();

		// The SAME `Record<extId, string[]>` shape every extension toggle
		// writes — no special case anywhere on the write path.
		await expect.poll(() => lastPutBody).not.toBeNull();
		expect((lastPutBody as unknown as { extensionTools: unknown }).extensionTools).toEqual({
			caller: ["open_app"],
		});
	});

	test("the master toggle switches the whole caller surface off", async ({ page, mockApi }) => {
		let lastPutBody: Record<string, unknown> | null = null;
		page.on("request", (req) => {
			if (req.method() === "PUT" && /\/api\/conversations\/conv-1$/.test(req.url())) {
				lastPutBody = req.postDataJSON() as Record<string, unknown>;
			}
		});

		await mockApi({ projects: [proj], conversations: [conv], extensions: [] });
		await mockCallerTools(page);

		await page.goto("/project/proj-1/chat/conv-1");
		await page.getByTestId("conversation-tools-trigger").click();
		await page.getByTestId("conv-ext-toggle-caller").uncheck();

		// `[]` is the explicit OFF marker the runtime reads as "deny all of
		// this extension's tools" — distinct from an ABSENT key, which means
		// "all of them".
		await expect.poll(() => lastPutBody?.extensionTools).toEqual({ caller: [] });
		await expect(page.getByTestId("conv-tool-caller-open_app")).not.toBeChecked();
	});

	test("a conversation with no declarations shows no caller section", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], extensions: [] });
		await mockCallerTools(page, []);

		await page.goto("/project/proj-1/chat/conv-1");
		await page.getByTestId("conversation-tools-trigger").click();
		await expect(page.getByTestId("conversation-tools-popover")).toBeVisible();
		await expect(page.getByTestId("conv-ext-toggle-caller")).toHaveCount(0);
	});
});

test.describe("Caller-executed tools — the permission gate", () => {
	test("a caller tool call opens a gate the user can see and answer @evidence", async ({
		page,
		mockApi,
		emitSse,
	}, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], extensions: [] });
		await mockCallerTools(page);
		const posts = await mockPermissionDecision(page);

		await page.goto("/extensions");
		await emitCallerGate(page, emitSse);

		const tray = page.getByTestId("pending-permission-tray");
		await expect(tray).toBeVisible();
		const card = page.getByTestId("tool-card-permission");
		await expect(card).toBeVisible();
		// The user is told WHICH tool, with WHAT arguments, and that it is the
		// `caller` category — the whole point of refusing to auto-approve it.
		await expect(card).toContainText("_caller__open_app");
		await expect(card).toContainText("caller");
		await expect(card).toContainText("Notes");

		await captureEvidence(page, testInfo, "caller-tool-permission-gate");

		// No `extensionId` on the payload, so this is the built-in two-button
		// gate: one decision, this call only, no stored always-allow row.
		await expect(page.getByTestId("permission-scope-chooser")).toHaveCount(0);
		await page.getByTestId("permission-allow").click();
		await expect(tray).toHaveCount(0);
		expect(posts).toEqual([{ approved: true }]);
	});
});
