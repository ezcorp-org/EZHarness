import { makeRequestEvent } from "./helpers/server-route-test-utils";

import {
	describe,
	test,
	expect,
	vi,
	beforeEach,
} from "vitest";

// ── Mocks: shared backend modules ─────────────────────────────────

vi.mock("$server/db/queries/extensions", () => ({
	getExtension: vi.fn(),
	updateExtension: vi.fn(async (_id: string, data: unknown) => ({ id: _id, ...(data as object) })),
}));

vi.mock("$server/db/queries/expired-grants", () => ({
	listExpiredGrantsForExtension: vi.fn(),
}));

vi.mock("$server/db/queries/audit-log", () => ({
	insertAuditEntry: vi.fn(async () => "audit-id-mock"),
}));

vi.mock("$server/extensions/registry", () => ({
	ExtensionRegistry: {
		getInstance: () => ({ reload: vi.fn(async () => undefined) }),
	},
}));

const { getExtension, updateExtension } = await import("$server/db/queries/extensions");
const { listExpiredGrantsForExtension } = await import("$server/db/queries/expired-grants");
const { insertAuditEntry } = await import("$server/db/queries/audit-log");

const expiredGrantsRoute = await import(
	"../routes/api/extensions/[id]/expired-grants/+server.ts"
);
const reapproveRoute = await import(
	"../routes/api/extensions/[id]/reapprove/+server.ts"
);

const DAY_MS = 24 * 60 * 60 * 1000;

const adminUser = { id: "u-admin", email: "a@x", name: "a", role: "admin" } as const;
const memberUser = { id: "u-member", email: "m@x", name: "m", role: "member" } as const;

function makeEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
	body?: unknown;
	method?: string;
	path?: string;
}) {
	const id = opts.id ?? "scratchpad";
	const path = opts.path ?? `/api/extensions/${id}/expired-grants`;
	return makeRequestEvent(`http://localhost${path}`, {
	  locals: opts.locals ?? {},
	  params: { id },
	  request: {
			method: opts.method ?? "GET",
			headers: { "content-type": "application/json" },
			body: opts.body ? JSON.stringify(opts.body) : undefined,
		},
	});
}

beforeEach(() => {
	vi.mocked(getExtension).mockReset();
	vi.mocked(updateExtension).mockReset();
	vi.mocked(listExpiredGrantsForExtension).mockReset();
	vi.mocked(insertAuditEntry).mockReset();

	// Default: updateExtension echoes back its input shape.
	vi.mocked(updateExtension).mockImplementation(async (_id: string, data: any) => ({
		id: _id,
		...data,
	}));
	vi.mocked(insertAuditEntry).mockResolvedValue("audit-id-mock");
});

describe("cap-expiry flow — banner load → reapprove → grantedAt resets", () => {
	test("banner load fn returns the audit-row shape the banner consumes", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "scratchpad",
			name: "Scratchpad",
			manifest: {},
		} as any);
		vi.mocked(listExpiredGrantsForExtension).mockResolvedValue([
			{
				auditId: "a-1",
				extensionId: "scratchpad",
				capability: "shell",
				ageMs: 1 * DAY_MS,
				expiredAt: Date.now() - 1 * DAY_MS,
			},
		]);

		const res = await expiredGrantsRoute.GET(
			makeEvent({ locals: { user: memberUser } }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { grants: any[] };
		expect(body.grants).toHaveLength(1);
		expect(body.grants[0]).toMatchObject({
			auditId: "a-1",
			capability: "shell",
			extensionId: "scratchpad",
		});
	});

	test("banner load returns 404 for unknown extension", async () => {
		vi.mocked(getExtension).mockResolvedValue(null as any);
		const res = await expiredGrantsRoute.GET(
			makeEvent({ locals: { user: memberUser } }),
		);
		expect(res.status).toBe(404);
	});

	test("banner load requires authentication", async () => {
		// No `user` in locals — requireAuth throws a 401 Response.
		let res: Response | undefined;
		try {
			res = await expiredGrantsRoute.GET(makeEvent({ locals: {} }));
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
	});


  test("expired grants stay revoked until a new exact release approval", async () => {
    const current = { id: "scratchpad", name: "scratchpad", manifest: { permissions: { shell: true } }, grantedPermissions: { grantedAt: {} } };
    vi.mocked(getExtension).mockResolvedValue(current as never);
    for (const user of [memberUser, adminUser]) {
      const response = await reapproveRoute.POST(makeEvent({ method: "POST", locals: { user }, body: { capability: "shell", scope: "forever", ttlOverrideMs: null } }));
      expect(response.status).toBe(410);
    }
    expect(updateExtension).not.toHaveBeenCalled();
    expect(insertAuditEntry).not.toHaveBeenCalled();
    expect(current.grantedPermissions).toEqual({ grantedAt: {} });
  });
});
