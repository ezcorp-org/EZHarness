/**
 * Server-loader tests for the two savings dashboards' `+page.server.ts`
 * files (mirrors `conversation-audit-page-loader.server.test.ts`).
 *
 * Both loaders are THIN: guard + SSR fetch of the savings endpoint +
 * pass-through. Covered here:
 *   - no `locals.user` (DB-less e2e preview fail-open) → data-less
 *     shell, NO endpoint fetch (the page hydrates client-side).
 *   - authenticated + ok fetch → payload passed through with the
 *     default range.
 *   - authenticated + non-ok fetch → null savings (client retry path).
 *   - project loader passes the endpoint's ownership 404 through
 *     verbatim (fail-closed, no existence leak).
 */
import { describe, expect, test, vi } from "vitest";
import type { SavingsResponse } from "$lib/savings-format";

const { load: loadGlobal } = await import(
	"../routes/(app)/analytics/savings/+page.server.ts"
);
const { load: loadProject } = await import(
	"../routes/(app)/project/[id]/savings/+page.server.ts"
);

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

const payload: SavingsResponse = {
	rangeDays: 30,
	stats: {
		cacheSavedUsd: -0.042,
		cacheReadSavedUsd: 0.018,
		cacheWriteSurchargeUsd: 0.06,
		write1hPremiumUsd: 0.031,
		routingSavedUsd: 0.155,
		tokensCachedRead: 84_200,
		tokensCacheWritten: 121_000,
		cacheHitRate: 0.41,
		turnsTotal: 18,
		turnsRouted: 7,
		turnsFailover: 1,
	},
	perModel: [],
	subscriptionProviders: [],
	estimated: true,
};

function fetchStub(status: number, body: unknown = payload) {
	return vi.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	}));
}

function makeEvent(opts: {
	locals: Record<string, unknown>;
	fetch: ReturnType<typeof fetchStub>;
	params?: Record<string, string>;
}) {
	return {
		locals: opts.locals,
		fetch: opts.fetch,
		params: opts.params ?? {},
	} as any;
}

describe("/analytics/savings +page.server.ts", () => {
	test("no user (e2e preview fail-open) → shell, endpoint NOT fetched", async () => {
		const fetch = fetchStub(200);
		const data = await loadGlobal(makeEvent({ locals: {}, fetch }));
		expect(data).toEqual({ savings: null, rangeDays: 30 });
		expect(fetch).not.toHaveBeenCalled();
	});

	test("authenticated → SSR-fetches the per-user endpoint at the default range", async () => {
		const fetch = fetchStub(200);
		const data = await loadGlobal(makeEvent({ locals: { user }, fetch }));
		expect(data).toEqual({ savings: payload, rangeDays: 30 });
		expect(fetch).toHaveBeenCalledWith("/api/analytics/savings?days=30");
	});

	test("authenticated + non-ok fetch → null savings (client retry)", async () => {
		const fetch = fetchStub(500);
		const data = await loadGlobal(makeEvent({ locals: { user }, fetch }));
		expect(data).toEqual({ savings: null, rangeDays: 30 });
	});
});

describe("/project/[id]/savings +page.server.ts", () => {
	test("no user (e2e preview fail-open) → shell, endpoint NOT fetched", async () => {
		const fetch = fetchStub(200);
		const data = await loadProject(
			makeEvent({ locals: {}, fetch, params: { id: "p1" } }),
		);
		expect(data).toEqual({ savings: null, rangeDays: 30 });
		expect(fetch).not.toHaveBeenCalled();
	});

	test("authenticated → SSR-fetches the project endpoint at the default range", async () => {
		const fetch = fetchStub(200);
		const data = await loadProject(
			makeEvent({ locals: { user }, fetch, params: { id: "p1" } }),
		);
		expect(data).toEqual({ savings: payload, rangeDays: 30 });
		expect(fetch).toHaveBeenCalledWith("/api/analytics/savings/project/p1?days=30");
	});

	test("endpoint ownership 404 passes through as a page 404 (fail-closed)", async () => {
		const fetch = fetchStub(404, { error: "Project not found" });
		await expect(
			loadProject(makeEvent({ locals: { user }, fetch, params: { id: "foreign" } })),
		).rejects.toMatchObject({ status: 404 });
	});

	test("authenticated + non-404 failure → null savings (client retry)", async () => {
		const fetch = fetchStub(500);
		const data = await loadProject(
			makeEvent({ locals: { user }, fetch, params: { id: "p1" } }),
		);
		expect(data).toEqual({ savings: null, rangeDays: 30 });
	});
});
