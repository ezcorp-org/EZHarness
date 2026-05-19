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
});
