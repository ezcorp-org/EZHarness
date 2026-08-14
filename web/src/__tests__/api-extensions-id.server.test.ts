/**
 * Server-handler unit tests for /api/extensions/[id]/+server.ts.
 *
 * Covers GET 401 + happy path + 404, PATCH scope/auth/404/disable-only/
 * happy-path with ExtensionRegistry.reload side-effect, and DELETE
 * scope/404/happy path. DB queries and registry are mocked at the
 * module boundary.
 */

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
		// `disabledByUser` is what keeps the OFF across a restart: the boot
		// reconcilers re-enable a disabled BUILT-IN unless this flag says the
		// user meant it (`ensureBundledExtensions`).
		expect(vi.mocked(updateExtension)).toHaveBeenCalledWith("ext-1", {
			enabled: false,
			disabledByUser: true,
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
		expect(body.error).toBe("Not found");
	});

	test("happy path: deletes row, reloads registry, returns 204 — and never killAll", async () => {
		vi.mocked(getExtension).mockResolvedValue(ext as any);
		vi.mocked(deleteExtension).mockResolvedValue(true as any);
		const res = await DELETE(
			makeEvent({ method: "DELETE", locals: { user: admin } }),
		);
		expect(res.status).toBe(204);
		expect(vi.mocked(deleteExtension)).toHaveBeenCalledWith("ext-1");
		expect(reload).toHaveBeenCalledTimes(1);
		// `killAll()` kills EVERY extension's subprocess, closes every MCP
		// client and drops every forward proxy — uninstalling one extension
		// took the rest down with it. `reload()` retires exactly the entries
		// that went away.
		expect(killAll).not.toHaveBeenCalled();
	});

	test("returns 409 for a built-in, and deletes nothing", async () => {
		// The row is recreated at the next boot with DEFAULT grants, so the
		// only lasting effect of allowing this was silently discarding the
		// admin's permission narrowing. Disabling is the supported off switch.
		vi.mocked(getExtension).mockResolvedValue({ ...ext, isBundled: true } as any);
		const res = await DELETE(
			makeEvent({ method: "DELETE", locals: { user: admin } }),
		);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toMatch(/disable it instead/);
		expect(vi.mocked(deleteExtension)).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	// ── Uninstall audit row ───────────────────────────────────────────
	//
	// This is the destructive end of the MCP lifecycle: an uninstall
	// cascade-deletes `extension_secrets`, i.e. the stored transport
	// credential. Install / edit / refresh all leave a row; without these
	// assertions the uninstall row could be deleted outright and the whole
	// suite would stay green, because `insertAuditEntry` never throws by
	// contract and the route swallows its failure.
	test("writes an ext:uninstalled audit row naming the actor, the target and the row's identity", async () => {
		vi.mocked(getExtension).mockResolvedValue(ext as any);
		vi.mocked(deleteExtension).mockResolvedValue(true as any);
		const res = await DELETE(makeEvent({ method: "DELETE", locals: { user: admin } }));
		expect(res.status).toBe(204);

		expect(insertAuditEntry).toHaveBeenCalledTimes(1);
		const [userId, action, target, metadata = {}] = insertAuditEntry.mock.calls[0]!;
		expect(userId).toBe(admin.id);
		expect(action).toBe("ext:uninstalled");
		// `audit_log.target` is a plain text column with no FK, so the trail
		// outlives the row it describes.
		expect(target).toBe(ext.id);
		expect(metadata.actor).toBe(admin.id);
		expect(metadata.extensionName).toBe(ext.name);
		expect(metadata.reason).toBe("uninstall");
		expect(metadata.newValue).toBeNull();
		expect(metadata.oldValue).toEqual({
			version: ext.version,
			source: ext.source,
			isBundled: ext.isBundled,
		});
	});

	test("purgeData in the audit row reflects the ?purgeData=1 query", async () => {
		// The irreversible half of the uninstall — whether the extension's own
		// data store was destroyed — is exactly what an investigator needs and
		// is not recoverable from anywhere else afterwards.
		vi.mocked(getExtension).mockResolvedValue(ext as any);
		vi.mocked(deleteExtension).mockResolvedValue(true as any);

		await DELETE(makeEvent({ method: "DELETE", locals: { user: admin }, search: "purgeData=1" }));
		expect(insertAuditEntry.mock.calls[0]![3]?.purgeData).toBe(true);

		insertAuditEntry.mockClear();
		await DELETE(makeEvent({ method: "DELETE", locals: { user: admin } }));
		expect(insertAuditEntry.mock.calls[0]![3]?.purgeData).toBe(false);
	});

	test("a refused uninstall writes NO audit row", async () => {
		// The trail must never claim a removal that did not happen.
		vi.mocked(getExtension).mockResolvedValue({ ...ext, isBundled: true } as any);
		await DELETE(makeEvent({ method: "DELETE", locals: { user: admin } }));
		expect(insertAuditEntry).not.toHaveBeenCalled();

		vi.mocked(getExtension).mockResolvedValue(null as any);
		await DELETE(makeEvent({ method: "DELETE", locals: { user: admin } }));
		expect(insertAuditEntry).not.toHaveBeenCalled();
	});
});
