/**
 * Phase 52.3 — per-conversation audit drill-down e2e.
 *
 * The page is loaded via SSR (PageServerLoad) which queries the DB
 * directly. The mockApi fixture intercepts the page route too, so we
 * can fulfill the SSR data the page needs by mocking
 * `/api/conversations/[id]/audit` for the client-fetch path. SSR
 * itself reaches the real DB in the preview server — we deliberately
 * focus the e2e on user-visible structure (chips render, buckets
 * align, no leaked credentials in DOM) rather than data correctness
 * (the bucketing helper has its own unit suite).
 *
 * For the SSR data we need to seed entries — but this preview
 * server starts with an empty DB. We rely on the page's tolerance
 * for an empty timeline (renders the conversation header + an empty
 * timeline) to verify route accessibility + auth gate.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";
import { mockPageData, resumePage } from "./fixtures/page-data.js";

test.describe("Per-conversation audit drill-down", () => {
	const proj = makeProject({ id: "proj-1" });

	test("unauthenticated request is rejected (4xx)", async ({ page, mockApi }) => {
		// Under PI_SKIP_INIT=1 the preview server's hooks short-circuit
		// the auth check (see hooks.server.ts:367-372 — getUserCount()
		// throws and the request continues with locals.user undefined).
		// This spec verifies the SvelteKit error boundary surfaces a
		// 4xx for the unauthenticated route fetch — the proper RBAC
		// surface (admin / owner gating) is covered by the unit suite
		// `web/src/__tests__/api-conversations-id-audit.server.test.ts`.
		await mockApi({
			projects: [proj],
			extensions: [],
		});

		const res = await page.goto("/project/proj-1/chat/conv-not-mine/audit");
		expect(res?.status()).toBeGreaterThanOrEqual(400);
	});

	test("hydrates the audit timeline with capability, resource, and governance evidence", async ({
		page,
		mockApi,
	}) => {
		const path = "/project/proj-1/chat/conv-1/audit";
		await mockApi({ projects: [proj] });
		await mockPageData(page, path, {
			conversation: { id: "conv-1", title: "Release review", projectId: "proj-1" },
			messages: [
				{ id: "user-1", role: "user", createdAt: "2026-05-01T10:00:00.000Z", contentPreview: "Review the release" },
				{ id: "assistant-1", role: "assistant", createdAt: "2026-05-01T10:10:00.000Z", contentPreview: "The release is ready" },
				{ id: "user-2", role: "user", createdAt: "2026-05-01T10:20:00.000Z", contentPreview: "Ship it" },
			],
			entries: [
				{ id: "governance-1", kind: "governance", action: "extension.approved", createdAt: "2026-05-01T09:59:00.000Z" },
				{ id: "memory-1", kind: "capability", capability: "memory", action: "search", success: true, tokensUsed: 1500, costUsd: 0.003, model: "gpt-test", durationMs: 120, createdAt: "2026-05-01T10:02:00.000Z" },
				{ id: "events-1", kind: "capability", capability: "events", action: "publish", success: false, durationMs: 50, createdAt: "2026-05-01T10:05:00.000Z" },
				{ id: "resource-1", kind: "resource", resourceKind: "memory", resourceId: "memory-abcdef123456", action: "read", createdAt: "2026-05-01T10:11:00.000Z" },
			],
			nextCursor: null,
			extensionsById: {},
		});

		// Resume from the app shell to force a hydrated client transition. A
		// direct SSR visit validates the loader, but it can leave this route's
		// client chunk unloaded and therefore cannot exercise its timeline.
		await resumePage(page, path);

		await expect(page.getByRole("heading", { name: "Audit · Release review" })).toBeVisible();
		await expect(page.getByTestId("audit-conv-chips")).toContainText("memory · 1 call");
		await expect(page.getByTestId("audit-conv-bucket-before-first")).toContainText("extension.approved");

		const userTurn = page.locator('[data-testid="audit-conv-bucket"][data-message-id="user-1"]');
		await expect(userTurn).toHaveAttribute("data-bucket-size", "2");
		await expect(userTurn).toContainText("memory.search");
		await expect(userTurn).toContainText("1.5k tok · $0.003 · gpt-test · 120ms");
		await expect(userTurn).toContainText("events.publish");

		const assistantTurn = page.locator('[data-testid="audit-conv-bucket"][data-message-id="assistant-1"]');
		await expect(assistantTurn).toHaveAttribute("data-bucket-size", "1");
		await expect(assistantTurn).toContainText("memory.read");
		await expect(assistantTurn).toContainText("memory-abcde");

		const emptyTurn = page.locator('[data-testid="audit-conv-bucket"][data-message-id="user-2"]');
		await expect(emptyTurn).toContainText("No capability calls during this turn.");
		await expect(page.getByRole("link", { name: "Back to chat" })).toHaveAttribute(
			"href",
			"/project/proj-1/chat/conv-1",
		);
	});
});
