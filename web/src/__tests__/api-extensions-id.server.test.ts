
import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectThrownResponse, makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/db/queries/extensions", () => ({
	getExtension: vi.fn(),
	getExtensionByRef: vi.fn(),
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

// The uninstall audit row. This MUST be mocked for the DELETE assertions
// below to mean anything: unmocked, the real `insertAuditEntry` calls
// `getDb()`, throws "Database not initialized", and the route's own
// try/catch swallows it — so deleting the entire audit call from the
// handler changed nothing observable and the mutation survived. The
// swallow is correct behaviour (audit is observability, never a gate);
// the test just has to look at the seam rather than at the outcome.
// Typed with its real parameter list so `mock.calls[0]![3]` is indexable —
// a zero-arg `vi.fn()` gives calls the type `[][]` and every arg assertion
// becomes a TS2493 (the same fix as commit e4d7b359).
const insertAuditEntry = vi.fn(
	async (
		_userId: string | null,
		_action: string,
		_target?: string,
		_metadata?: Record<string, unknown>,
	) => "audit-1",
);
vi.mock("$server/db/queries/audit-log", () => ({ insertAuditEntry }));

const { getExtension, getExtensionByRef, updateExtension, deleteExtension } =
	await import("$server/db/queries/extensions");
const lifecycleDisable = vi.fn(async () => {});
const lifecycleUninstall = vi.fn(async () => {});
vi.mock("$server/extensions/extension-lifecycle-service", () => ({
  getExtensionLifecycle: async () => ({
    inspect: async (_actor: unknown, id: string) => {
      const extension = await getExtension(id);
      if (!extension) {
        const { LifecycleError } = await import("../../../src/extensions/v4/types");
        throw new LifecycleError("not_found", "Not found");
      }
      return {};
    },
    disable: lifecycleDisable, uninstall: lifecycleUninstall,
  }),
}));
beforeEach(() => {
  lifecycleDisable.mockClear(); lifecycleUninstall.mockClear();
  vi.mocked(getExtensionByRef).mockReset().mockImplementation(async (id) => getExtension(id));
});
const { GET, PATCH, DELETE } = await import(
	"../routes/api/extensions/[id]/+server"
);

function makeEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
	body?: unknown;
	method?: string;
	/** Query string WITHOUT the leading `?` — DELETE reads `purgeData=1`. */
	search?: string;
}) {
	const id = opts.id ?? "ext-1";
	const href = `http://localhost/api/extensions/${id}${opts.search ? `?${opts.search}` : ""}`;
	return makeRequestEvent(href, {
	  locals: opts.locals ?? {},
	  params: { id },
	  request: {
			method: opts.method ?? "GET",
			headers: { "content-type": "application/json" },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		},
	});
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
	// The three columns the uninstall audit row snapshots as `oldValue`.
	// Real values, so the DELETE assertions compare against something other
	// than `undefined === undefined`.
	version: "1.2.3",
	source: "mcp:stdio",
	isBundled: false,
};

describe("GET /api/extensions/[id]", () => {
	beforeEach(() => {
		vi.mocked(getExtensionByRef).mockReset();
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
		vi.mocked(getExtensionByRef).mockResolvedValue(ext as any);
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual(ext);
	});

	test("returns 404 when extension not found", async () => {
		vi.mocked(getExtensionByRef).mockResolvedValue(null as any);
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found");
	});

	// The post-install deep-link is `/extensions/<manifest-name>`, so this
	// read MUST go through the reference resolver, not the id-only lookup —
	// `getExtension(name)` is what rendered "Extension not found".
	test("resolves the route param as a REFERENCE (id or manifest name)", async () => {
		vi.mocked(getExtensionByRef).mockResolvedValue(ext as any);
		const res = await GET(makeEvent({ id: "weather", locals: { user } }));
		expect(res.status).toBe(200);
		expect(vi.mocked(getExtensionByRef)).toHaveBeenCalledWith("weather");
		expect(vi.mocked(getExtension)).not.toHaveBeenCalled();
		// The body carries the ROW id, which is what the page canonicalises
		// every downstream (id-only) call on.
		const body = (await res.json()) as { id: string };
		expect(body.id).toBe("ext-1");
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
		expect(body).toMatchObject({ message: "Not found" });
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
		expect(res.status).toBe(410);
		expect(await res.json()).toMatchObject({ controlUrl: "/api/extensions/control" });
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
		expect(body.error).toBe("Provide enabled:false");
	});

	test("disable delegates to the lifecycle with authenticated actor", async () => {
    vi.mocked(getExtension).mockResolvedValue(ext as any);
    lifecycleDisable.mockImplementationOnce(async () => {
      vi.mocked(getExtension).mockResolvedValue({ ...ext, enabled: false } as any);
    });
    const response = await PATCH(makeEvent({ method: "PATCH", body: { enabled: false }, locals: { user: admin, authMethod: "session" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false });
    expect(lifecycleDisable).toHaveBeenCalledWith({ principalId: admin.id, scope: "global", kind: "human" }, "ext-1");
    expect(updateExtension).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/extensions/[id]", () => {
	beforeEach(() => {
		vi.mocked(getExtension).mockReset();
		vi.mocked(deleteExtension).mockReset();
		reload.mockClear();
		killAll.mockClear();
		insertAuditEntry.mockClear();
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
		expect(body).toMatchObject({ message: "Not found" });
	});

  test.each([false, true])("uninstall retains data and delegates one installation (bundled=%s)", async (isBundled) => {
    vi.mocked(getExtension).mockResolvedValue({ ...ext, isBundled } as any);
    const response = await DELETE(makeEvent({ method: "DELETE", locals: { user: admin, authMethod: "session" } }));
    expect(response.status).toBe(204);
    expect(lifecycleUninstall).toHaveBeenCalledWith({ principalId: admin.id, scope: "global", kind: "human" }, ext.id);
    expect(deleteExtension).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(killAll).not.toHaveBeenCalled();
  });

  test("purge cannot bypass explicit data retention review", async () => {
    vi.mocked(getExtension).mockResolvedValue(ext as any);
    const response = await DELETE(makeEvent({ method: "DELETE", locals: { user: admin }, search: "purgeData=1" }));
    expect(response.status).toBe(400);
    expect(lifecycleUninstall).not.toHaveBeenCalled();
    expect(deleteExtension).not.toHaveBeenCalled();
  });

  test("a refused uninstall does not delegate or claim an audit event", async () => {
    vi.mocked(getExtension).mockResolvedValue(null as any);
    const response = await DELETE(makeEvent({ method: "DELETE", locals: { user: admin } }));
    expect(response.status).toBe(404);
    expect(lifecycleUninstall).not.toHaveBeenCalled();
    expect(insertAuditEntry).not.toHaveBeenCalled();
  });
});
