/**
 * Server loader test for the per-extension audit `+page.server.ts`.
 *
 * Same deep-link class as the parent detail route: `[id]` is a REFERENCE
 * (row id OR manifest name), so the loader must resolve it once and then key
 * the audit reads on the RESOLVED `ext.id`. Passing the raw reference through
 * to `mergeAuditForExtension`/`statsForExtension` is the quiet failure mode —
 * the page renders, but the audit trail is empty because those tables store
 * the extension id.
 *
 * The admin gate and 404-on-unknown behaviour are asserted alongside so the
 * resolution change can't relax either.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/extensions", () => ({
	getExtensionByRef: vi.fn(),
}));

vi.mock("$server/db/queries/audit-merge", () => ({
	mergeAuditForExtension: vi.fn(),
	statsForExtension: vi.fn(),
}));

const { getExtensionByRef } = await import("$server/db/queries/extensions");
const { mergeAuditForExtension, statsForExtension } = await import(
	"$server/db/queries/audit-merge"
);
const { load } = await import(
	"../routes/(app)/extensions/[id]/audit/+page.server.ts"
);

const adminUser = { id: "u-admin", email: "a@x", name: "admin", role: "admin" };
const memberUser = { id: "u-mem", email: "m@x", name: "member", role: "user" };

const ROW = {
	id: "7f3a91c4-0d2e-4b88-9a51-6c0e2f4d1a77",
	name: "weather-lookup",
	version: "1.0.0",
	isBundled: false,
	grantedPermissions: { grantedAt: {} },
};

function makeEvent(id: string, user: Record<string, unknown> | undefined) {
	return { params: { id }, locals: user ? { user } : {} } as any;
}

// `load` is typed `MaybePromise<void | PageData>`; the async IIFE normalises
// both that and a synchronously-thrown Response into a rejected promise.
// `requireAuth`/`requireRole` throw a `Response` and `error()` an `HttpError`
// — both carry `.status`.
async function expectStatus(fn: () => unknown, status: number) {
	await expect((async () => fn())()).rejects.toMatchObject({ status });
}

describe("/extensions/[id]/audit +page.server.ts", () => {
	beforeEach(() => {
		vi.mocked(getExtensionByRef).mockReset();
		vi.mocked(mergeAuditForExtension).mockReset();
		vi.mocked(statsForExtension).mockReset();
		vi.mocked(mergeAuditForExtension).mockResolvedValue({
			entries: [],
			nextCursor: null,
		} as any);
		vi.mocked(statsForExtension).mockResolvedValue({} as any);
	});

	test("unauthenticated → 401", async () => {
		await expectStatus(() => load(makeEvent(ROW.id, undefined)), 401);
	});

	test("non-admin → 403", async () => {
		await expectStatus(() => load(makeEvent(ROW.id, memberUser)), 403);
		expect(vi.mocked(mergeAuditForExtension)).not.toHaveBeenCalled();
	});

	test("unknown reference → 404", async () => {
		vi.mocked(getExtensionByRef).mockResolvedValue(null as any);
		await expectStatus(() => load(makeEvent("no-such-ext", adminUser)), 404);
	});

	test("resolves the route param as a REFERENCE, not an id", async () => {
		vi.mocked(getExtensionByRef).mockResolvedValue(ROW as any);
		const data = (await load(makeEvent(ROW.name, adminUser))) as {
			extension: { id: string; name: string };
		};
		expect(vi.mocked(getExtensionByRef)).toHaveBeenCalledWith(ROW.name);
		expect(data.extension.id).toBe(ROW.id);
		expect(data.extension.name).toBe(ROW.name);
	});

	// The bug this guards: the loader resolved the row (so the page rendered)
	// but then queried the audit tables with the raw route param, which they
	// never key on — a silently empty trail for a name-addressed URL.
	test("audit reads are keyed on the RESOLVED row id, never the route param", async () => {
		vi.mocked(getExtensionByRef).mockResolvedValue(ROW as any);
		await load(makeEvent(ROW.name, adminUser));
		expect(vi.mocked(mergeAuditForExtension)).toHaveBeenCalledWith(ROW.id, {
			limit: 100,
		});
		expect(vi.mocked(statsForExtension)).toHaveBeenCalledWith(
			ROW.id,
			24 * 60 * 60 * 1000,
		);
	});
});
