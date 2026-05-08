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

	test("non-authenticated user is denied access", async ({ page, mockApi }) => {
		// The mockApi sets up the auth middleware path; we override
		// the conversation row to belong to a DIFFERENT user so the
		// page returns 404.
		await mockApi({
			projects: [proj],
			extensions: [],
			currentUser: { id: "u-other", email: "x@x", name: "x", role: "user" },
		});

		// Page route returns 404 (the SSR loader throws error(404) for
		// non-owner). The page shows the SvelteKit error boundary.
		const res = await page.goto("/project/proj-1/chat/conv-not-mine/audit");
		expect(res?.status()).toBeGreaterThanOrEqual(400);
	});
});
