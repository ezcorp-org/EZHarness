/**
 * Server-handler unit tests for /api/marketplace/[id] (+server.ts).
 *
 * Covers GET 401-bypass-allowed (public read), 404, happy path body shape
 * (computes ratingPercent + includes latestVersion/versions/userRating/
 * installed flags), unauthenticated GET (userRating null), and DELETE
 * auth/scope/admin gates with audit-log + status-update side-effects.
 *
 * Mocks DB queries at the import boundary.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/marketplace", () => ({
	getListingById: vi.fn(),
	updateListingStatus: vi.fn(async () => undefined),
}));

vi.mock("$server/db/queries/marketplace-versions", () => ({
	getLatestVersion: vi.fn(),
	listVersions: vi.fn(),
}));

vi.mock("$server/db/queries/marketplace-ratings", () => ({
	getUserRating: vi.fn(),
}));

vi.mock("$server/db/queries/settings", () => ({
	isListingInstalled: vi.fn(),
}));

vi.mock("$server/db/queries/audit-log", () => ({
	insertAuditEntry: vi.fn(async () => undefined),
}));

const { getListingById, updateListingStatus } = await import(
	"$server/db/queries/marketplace"
);
const { getLatestVersion, listVersions } = await import(
	"$server/db/queries/marketplace-versions"
);
const { getUserRating } = await import("$server/db/queries/marketplace-ratings");
const { isListingInstalled } = await import("$server/db/queries/settings");
const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { GET, DELETE } = await import(
	"../routes/api/marketplace/[id]/+server.ts"
);

function makeEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
	method?: string;
}) {
	const id = opts.id ?? "abc";
	return {
		url: new URL(`http://localhost/api/marketplace/${id}`),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(`http://localhost/api/marketplace/${id}`, {
			method: opts.method ?? "GET",
		}),
	} as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };
const adminUser = { id: "admin-1", email: "a@x", name: "a", role: "admin" };

const listing = {
	id: "abc",
	slug: "weather",
	name: "Weather",
	description: "Weather info",
	authorId: "author-1",
	status: "active",
	ratingPositive: 7,
	ratingTotal: 10,
};

describe("GET /api/marketplace/[id]", () => {
	beforeEach(() => {
		vi.mocked(getListingById).mockReset();
		vi.mocked(getLatestVersion).mockReset();
		vi.mocked(listVersions).mockReset();
		vi.mocked(getUserRating).mockReset();
		vi.mocked(isListingInstalled).mockReset();
	});

	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(
			makeEvent({
				locals: { user, apiKeyScopes: ["chat"] },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("read");
	});

	test("returns 404 when listing not found", async () => {
		vi.mocked(getListingById).mockResolvedValue(undefined as any);
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found");
	});

	test("happy path (authenticated): includes ratingPercent + userRating + installed", async () => {
		vi.mocked(getListingById).mockResolvedValue(listing as any);
		vi.mocked(getLatestVersion).mockResolvedValue({
			id: "v1",
			version: "1.0.0",
		} as any);
		vi.mocked(listVersions).mockResolvedValue([
			{ id: "v1", version: "1.0.0" },
		] as any);
		vi.mocked(getUserRating).mockResolvedValue({ thumbsUp: true } as any);
		vi.mocked(isListingInstalled).mockResolvedValue(true);

		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			listing: { ratingPercent: number };
			latestVersion: unknown;
			versions: unknown[];
			userRating: unknown;
			installed: boolean;
		};
		// ratingPercent = round(7/10 * 100) = 70
		expect(body.listing.ratingPercent).toBe(70);
		expect(body.latestVersion).toEqual({ id: "v1", version: "1.0.0" });
		expect(body.versions).toEqual([{ id: "v1", version: "1.0.0" }]);
		expect(body.userRating).toEqual({ thumbsUp: true });
		expect(body.installed).toBe(true);
		expect(vi.mocked(getUserRating)).toHaveBeenCalledWith(listing.id, user.id);
	});

	test("ratingPercent = 0 when ratingTotal is 0", async () => {
		vi.mocked(getListingById).mockResolvedValue({
			...listing,
			ratingPositive: 0,
			ratingTotal: 0,
		} as any);
		vi.mocked(getLatestVersion).mockResolvedValue(undefined as any);
		vi.mocked(listVersions).mockResolvedValue([] as any);
		vi.mocked(getUserRating).mockResolvedValue(undefined as any);
		vi.mocked(isListingInstalled).mockResolvedValue(false);

		const res = await GET(makeEvent({ locals: { user } }));
		const body = (await res.json()) as {
			listing: { ratingPercent: number };
			userRating: unknown;
		};
		expect(body.listing.ratingPercent).toBe(0);
		// userRating from undefined → null in response
		expect(body.userRating).toBeNull();
	});

	test("unauthenticated request: userRating is null and getUserRating not called", async () => {
		vi.mocked(getListingById).mockResolvedValue(listing as any);
		vi.mocked(getLatestVersion).mockResolvedValue(null as any);
		vi.mocked(listVersions).mockResolvedValue([] as any);
		vi.mocked(isListingInstalled).mockResolvedValue(false);

		const res = await GET(makeEvent({ locals: {} }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { userRating: unknown };
		expect(body.userRating).toBeNull();
		expect(vi.mocked(getUserRating)).not.toHaveBeenCalled();
	});
});

describe("DELETE /api/marketplace/[id]", () => {
	beforeEach(() => {
		vi.mocked(updateListingStatus).mockReset();
		vi.mocked(insertAuditEntry).mockReset();
	});

	test("unauthenticated request throws 401 Response", async () => {
		let res: Response | undefined;
		try {
			await DELETE(makeEvent({ method: "DELETE", locals: {} }));
			expect.fail("should have thrown");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
		const body = (await res!.json()) as { error?: string };
		expect(body.error).toBe("Authentication required");
	});

	test("non-admin authenticated request throws 403 Response", async () => {
		let res: Response | undefined;
		try {
			await DELETE(
				makeEvent({
					method: "DELETE",
					locals: { user },
				}),
			);
			expect.fail("should have thrown");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(403);
		const body = (await res!.json()) as { error?: string };
		expect(body.error).toBe("Insufficient permissions");
	});

	test("API-key scope check returns 403 when scope missing", async () => {
		const res = await DELETE(
			makeEvent({
				method: "DELETE",
				locals: {
					user: adminUser,
					apiKeyScopes: ["read"],
				},
			}),
		);
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("admin");
	});

	test("happy path: marks listing 'removed' and writes audit entry", async () => {
		const res = await DELETE(
			makeEvent({
				method: "DELETE",
				locals: { user: adminUser },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok?: boolean };
		expect(body.ok).toBe(true);
		// Side-effects
		expect(vi.mocked(updateListingStatus)).toHaveBeenCalledWith(
			"abc",
			"removed",
		);
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledWith(
			adminUser.id,
			"marketplace:remove",
			"abc",
		);
	});
});
