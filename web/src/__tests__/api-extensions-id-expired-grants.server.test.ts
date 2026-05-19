/**
 * Server-handler tests for /api/extensions/[id]/expired-grants (+server.ts).
 *
 * Phase 4 (capability-expiry) — feeds the settings-page banner. Auth
 * model: any authenticated user; 404 on unknown extension.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/extensions", () => ({
	getExtension: vi.fn(),
}));

vi.mock("$server/db/queries/expired-grants", () => ({
	listExpiredGrantsForExtension: vi.fn(),
}));

const { getExtension } = await import("$server/db/queries/extensions");
const { listExpiredGrantsForExtension } = await import(
	"$server/db/queries/expired-grants"
);
const { GET } = await import(
	"../routes/api/extensions/[id]/expired-grants/+server.ts"
);

function makeEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
}) {
	const id = opts.id ?? "scratchpad";
	return {
		url: new URL(`http://localhost/api/extensions/${id}/expired-grants`),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(
			`http://localhost/api/extensions/${id}/expired-grants`,
			{ method: "GET" },
		),
	} as any;
}

const adminUser = { id: "u-admin", email: "a@x", name: "a", role: "admin" };
const memberUser = { id: "u-member", email: "m@x", name: "m", role: "member" };

describe("GET /api/extensions/[id]/expired-grants", () => {
	beforeEach(() => {
		vi.mocked(getExtension).mockReset();
		vi.mocked(listExpiredGrantsForExtension).mockReset();
	});

	test("unauthenticated returns 401", async () => {
		let res: Response | undefined;
		try {
			res = await GET(makeEvent({ locals: {} }));
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
	});

	test("unknown extension returns 404", async () => {
		vi.mocked(getExtension).mockResolvedValue(null as any);
		const res = await GET(makeEvent({ locals: { user: memberUser } }));
		expect(res.status).toBe(404);
	});

	test("authenticated member gets the list (not admin-gated)", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "scratchpad",
			name: "Scratchpad",
		} as any);
		vi.mocked(listExpiredGrantsForExtension).mockResolvedValue([
			{
				auditId: "a-1",
				extensionId: "scratchpad",
				capability: "shell",
				ageMs: 1000,
				expiredAt: Date.now(),
			},
		]);
		const res = await GET(makeEvent({ locals: { user: memberUser } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { grants: any[] };
		expect(body.grants).toHaveLength(1);
		expect(body.grants[0].capability).toBe("shell");
	});

	test("admin user also gets the list", async () => {
		vi.mocked(getExtension).mockResolvedValue({ id: "scratchpad" } as any);
		vi.mocked(listExpiredGrantsForExtension).mockResolvedValue([]);
		const res = await GET(makeEvent({ locals: { user: adminUser } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { grants: any[] };
		expect(body.grants).toEqual([]);
	});

	test("query helper called with the URL's extension id", async () => {
		vi.mocked(getExtension).mockResolvedValue({ id: "ext-7" } as any);
		vi.mocked(listExpiredGrantsForExtension).mockResolvedValue([]);
		await GET(makeEvent({ id: "ext-7", locals: { user: memberUser } }));
		expect(vi.mocked(listExpiredGrantsForExtension)).toHaveBeenCalledWith(
			"ext-7",
		);
	});
});
