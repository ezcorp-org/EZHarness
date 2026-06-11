/**
 * Server-handler unit tests for /api/extensions/[id]/+server.ts.
 *
 * Covers GET 401 + happy path + 404, PATCH scope/auth/404/disable-only/
 * happy-path with ExtensionRegistry.reload side-effect, and DELETE
 * scope/404/happy path. DB queries and registry are mocked at the
 * module boundary.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/extensions", () => ({
	getExtension: vi.fn(),
	updateExtension: vi.fn(),
	deleteExtension: vi.fn(),
}));

const reload = vi.fn(async () => undefined);
const killAll = vi.fn(() => undefined);
vi.mock("$server/extensions/registry", () => ({
	ExtensionRegistry: {
		getInstance: () => ({ reload, killAll }),
	},
}));

const { getExtension, updateExtension, deleteExtension } = await import(
	"$server/db/queries/extensions"
);
const { GET, PATCH, DELETE } = await import(
	"../routes/api/extensions/[id]/+server"
);

function makeEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
	body?: unknown;
	method?: string;
}) {
	const id = opts.id ?? "ext-1";
	const href = `http://localhost/api/extensions/${id}`;
	return {
		url: new URL(href),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(href, {
			method: opts.method ?? "GET",
			headers: { "content-type": "application/json" },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		}),
	} as any;
}

async function expectThrownResponse(
	fn: () => Promise<Response> | Response,
	status: number,
): Promise<Response> {
	let res: Response | undefined;
	try {
		res = await fn();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		res = thrown as Response;
	}
	expect(res!.status).toBe(status);
	return res!;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };
// PATCH (disable) and DELETE are instance-wide, admin-only since
// fix(ext-api) c93ea27e — mirror the /activate sibling route.
const admin = { id: "a1", email: "a@x", name: "a", role: "admin" };
const ext = {
	id: "ext-1",
	name: "weather",
	description: "weather tools",
	enabled: true,
};

describe("GET /api/extensions/[id]", () => {
	beforeEach(() => {
		vi.mocked(getExtension).mockReset();
	});

	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(() => GET(makeEvent({})), 401);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(
			makeEvent({
				locals: { user, apiKeyScopes: ["chat"] },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("read");
	});

	test("happy path: returns extension row", async () => {
		vi.mocked(getExtension).mockResolvedValue(ext as any);
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual(ext);
	});

	test("returns 404 when extension not found", async () => {
		vi.mocked(getExtension).mockResolvedValue(null as any);
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found");
	});
});

describe("PATCH /api/extensions/[id]", () => {
	beforeEach(() => {
		vi.mocked(getExtension).mockReset();
		vi.mocked(updateExtension).mockReset();
		reload.mockClear();
	});

	test("rejects 401 when locals.user is missing", async () => {
		await expectThrownResponse(
			() => PATCH(makeEvent({ method: "PATCH", body: { enabled: false } })),
			401,
		);
	});

	test("returns 403 when API-key scope missing 'extensions'", async () => {
		const res = await PATCH(
			makeEvent({
				method: "PATCH",
				body: { enabled: false },
				locals: { user, apiKeyScopes: ["read"] },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.required).toBe("extensions");
	});

	test("returns 403 for non-admin users", async () => {
		vi.mocked(getExtension).mockResolvedValue(ext as any);
		const res = await PATCH(
			makeEvent({
				method: "PATCH",
				body: { enabled: false },
				locals: { user },
			}),
		);
		expect(res.status).toBe(403);
		expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
	});

	test("returns 404 when extension not found", async () => {
		vi.mocked(getExtension).mockResolvedValue(null as any);
		const res = await PATCH(
			makeEvent({
				method: "PATCH",
				body: { enabled: false },
				locals: { user: admin },
			}),
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found");
	});

	test("rejects enabled=true (must use POST /:id/activate)", async () => {
		vi.mocked(getExtension).mockResolvedValue(ext as any);
		const res = await PATCH(
			makeEvent({
				method: "PATCH",
				body: { enabled: true },
				locals: { user: admin },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Use POST /:id/activate to enable an extension");
		expect(vi.mocked(updateExtension)).not.toHaveBeenCalled();
	});

	test("returns 400 when enabled is missing / non-boolean", async () => {
		vi.mocked(getExtension).mockResolvedValue(ext as any);
		const res = await PATCH(
			makeEvent({
				method: "PATCH",
				body: {}, // no recognised update field
				locals: { user: admin },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("No valid update fields provided");
	});

	test("happy path: enabled=false updates extension and reloads registry", async () => {
		vi.mocked(getExtension).mockResolvedValue(ext as any);
		vi.mocked(updateExtension).mockResolvedValue({
			...ext,
			enabled: false,
		} as any);
		const res = await PATCH(
			makeEvent({
				method: "PATCH",
				body: { enabled: false },
				locals: { user: admin },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { enabled: boolean };
		expect(body.enabled).toBe(false);
		expect(vi.mocked(updateExtension)).toHaveBeenCalledWith("ext-1", {
			enabled: false,
		});
		// Side-effect: registry reloaded after disable.
		expect(reload).toHaveBeenCalledTimes(1);
	});
});

describe("DELETE /api/extensions/[id]", () => {
	beforeEach(() => {
		vi.mocked(getExtension).mockReset();
		vi.mocked(deleteExtension).mockReset();
		reload.mockClear();
		killAll.mockClear();
	});

	test("rejects 401 when locals.user is missing", async () => {
		await expectThrownResponse(
			() => DELETE(makeEvent({ method: "DELETE" })),
			401,
		);
	});

	test("returns 403 when API-key scope missing 'extensions'", async () => {
		const res = await DELETE(
			makeEvent({
				method: "DELETE",
				locals: { user, apiKeyScopes: ["read"] },
			}),
		);
		expect(res.status).toBe(403);
	});

	test("returns 403 for non-admin users", async () => {
		vi.mocked(getExtension).mockResolvedValue(ext as any);
		const res = await DELETE(
			makeEvent({ method: "DELETE", locals: { user } }),
		);
		expect(res.status).toBe(403);
		expect(vi.mocked(deleteExtension)).not.toHaveBeenCalled();
		expect(killAll).not.toHaveBeenCalled();
	});

	test("returns 404 when extension not found", async () => {
		vi.mocked(getExtension).mockResolvedValue(null as any);
		const res = await DELETE(
			makeEvent({ method: "DELETE", locals: { user: admin } }),
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found");
	});

	test("happy path: kills subprocesses, deletes row, reloads registry, returns 204", async () => {
		vi.mocked(getExtension).mockResolvedValue(ext as any);
		vi.mocked(deleteExtension).mockResolvedValue(true as any);
		const res = await DELETE(
			makeEvent({ method: "DELETE", locals: { user: admin } }),
		);
		expect(res.status).toBe(204);
		// Side-effects in order
		expect(killAll).toHaveBeenCalledTimes(1);
		expect(vi.mocked(deleteExtension)).toHaveBeenCalledWith("ext-1");
		expect(reload).toHaveBeenCalledTimes(1);
	});
});
