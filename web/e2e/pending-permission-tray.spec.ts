/**
 * B3 — fallback pending-permission tray e2e.
 *
 * An EXTENSION-initiated privileged tool call (ez-code-factory's init_gate
 * hitting fs.write / shell) fires `tool:permission_request` on a conversation
 * the streaming layer never registered a run for. Before this fix the handler
 * only warned + toasted, so NO approval card rendered and the backend gate hung
 * forever. The fix routes such prompts onto a global fallback tray so the user
 * can still approve/deny.
 *
 * This spec drives the run-less prompt over the real SSE runtime-events stream
 * (the store subscribes via EventSource on `/api/runtime-events`) and asserts:
 *   - the tray renders a PermissionGate card (the extension four-scope chooser)
 *   - approving POSTs the decision to /api/tool-calls/:id/permission
 *   - the card is removed from the tray after resolution
 *
 * The `@evidence`-tagged case satisfies the Visual evidence CI gate (this adds
 * a new layout-scope surface). `captureEvidence` is a hard no-op unless
 * `EZCORP_E2E_EVIDENCE=1`.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject } from "./fixtures/data.js";

const PROMPT_ID = "prompt-init-gate-e2e";

const PERMISSION_EVENT = {
	type: "tool:permission_request",
	data: {
		conversationId: "conv-no-run-e2e",
		toolCallId: PROMPT_ID,
		toolName: "ez-code-factory__init_gate",
		input: { projectRoot: "/app/projects/ecf-demo" },
		extensionId: "ez-code-factory",
		capabilityKind: "shell",
	},
};

/** Capture the permission-decision POST so approve/deny resolves cleanly. */
async function installPermissionMock(page: Page) {
	const posts: unknown[] = [];
	await page.route("**/api/tool-calls/*/permission", (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		posts.push(route.request().postDataJSON());
		return route.fulfill({ json: { ok: true } });
	});
	return posts;
}

/** Wait until the store's SSE stream exists, then emit the run-less prompt. */
async function emitRunlessPrompt(page: Page, emitSse: (e: { type: string; data: unknown }) => Promise<void>) {
	await page.waitForFunction(() => {
		const es = (window as unknown as { __fakeEventSources?: unknown[] }).__fakeEventSources;
		return Array.isArray(es) && es.length > 0;
	});
	await emitSse(PERMISSION_EVENT, "runtime-events");
}

test.describe("Fallback pending-permission tray", () => {
	const proj = makeProject({ id: "proj-1" });

	test("run-less permission prompt renders on the tray and approving clears it", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [proj] });
		const posts = await installPermissionMock(page);

		await page.goto("/extensions");
		await emitRunlessPrompt(page, emitSse);

		// The prompt renders on the global fallback tray (four-scope chooser
		// because it's an extension-scoped capability).
		const tray = page.getByTestId("pending-permission-tray");
		await expect(tray).toBeVisible();
		await expect(page.getByTestId("permission-extension-badge")).toHaveText("ez-code-factory");
		await expect(page.getByTestId("permission-allow-session")).toBeVisible();

		// Approve → POST the decision, then the card is removed.
		await page.getByTestId("permission-allow-session").click();
		await expect(tray).toHaveCount(0);
		expect(posts).toEqual([{ approved: true, scope: "session" }]);
	});

	test("renders the fallback tray and captures evidence @evidence", async ({
		page,
		mockApi,
		emitSse,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		await installPermissionMock(page);

		await page.goto("/extensions");
		await emitRunlessPrompt(page, emitSse);

		const tray = page.getByTestId("pending-permission-tray");
		await expect(tray).toBeVisible();
		await captureEvidence(page, testInfo, "pending-permission-tray");

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "pending-permission-tray" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "pending-permission-tray")).toBe(false);
		}
	});
});
