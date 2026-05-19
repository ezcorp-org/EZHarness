/**
 * Phase 5 — server-handler tests for the per-extension entity routes:
 *
 *   GET    /api/extensions/[id]/entities/[type]
 *   POST   /api/extensions/[id]/entities/[type]
 *   GET    /api/extensions/[id]/entities/[type]/[slug]
 *   PUT    /api/extensions/[id]/entities/[type]/[slug]
 *   DELETE /api/extensions/[id]/entities/[type]/[slug]
 *
 * Mocks the extension lookup and the extension_storage queries at the
 * module boundary; no real DB. The host-store adapter routes through
 * those query mocks, so we exercise the full server flow (auth, scope,
 * lookup, validation, write) without spinning up PGlite.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const fakeStorage: {
	rows: Map<string, { value: unknown; sizeBytes: number; encrypted: boolean }>;
} = { rows: new Map() };

function storageKey(
	extensionId: string,
	scope: string,
	scopeId: string | null,
	key: string,
): string {
	return `${extensionId}::${scope}::${scopeId ?? ""}::${key}`;
}

vi.mock("$server/db/queries/extension-storage", () => ({
	getStorageValue: vi.fn(
		async (extensionId: string, scope: string, scopeId: string | null, key: string) => {
			const row = fakeStorage.rows.get(storageKey(extensionId, scope, scopeId, key));
			return row ?? null;
		},
	),
	setStorageValue: vi.fn(
		async (
			extensionId: string,
			scope: string,
			scopeId: string | null,
			key: string,
			value: unknown,
			encrypted: boolean,
			sizeBytes: number,
		) => {
			fakeStorage.rows.set(storageKey(extensionId, scope, scopeId, key), {
				value,
				sizeBytes,
				encrypted,
			});
		},
	),
	deleteStorageValue: vi.fn(
		async (extensionId: string, scope: string, scopeId: string | null, key: string) => {
			return fakeStorage.rows.delete(storageKey(extensionId, scope, scopeId, key));
		},
	),
}));

vi.mock("$server/db/queries/extensions", () => ({
	getExtension: vi.fn(),
}));

const { getExtension } = await import("$server/db/queries/extensions");
const collection = await import(
	"../routes/api/extensions/[id]/entities/[type]/+server"
);
const record = await import(
	"../routes/api/extensions/[id]/entities/[type]/[slug]/+server"
);

const MANIFEST_WITH_POST_TYPE = {
	schemaVersion: 2,
	name: "substack-pilot",
	entities: [
		{
			type: "post-type",
			label: "Post Type",
			pluralLabel: "Post Types",
			scope: "user",
			schema: {
				type: "object",
				properties: {
					name: { type: "string", minLength: 1 },
					cadence: {
						type: "string",
						enum: ["weekly", "monthly", "ad-hoc"],
					},
				},
				required: ["name", "cadence"],
				additionalProperties: false,
			},
		},
	],
};

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

function makeEvent(opts: {
	href: string;
	params: { id: string; type: string; slug?: string };
	body?: unknown;
	method?: string;
	locals?: Record<string, unknown>;
}) {
	return {
		url: new URL(opts.href),
		params: opts.params,
		locals: opts.locals ?? { user },
		request: new Request(opts.href, {
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

beforeEach(() => {
	fakeStorage.rows.clear();
	vi.mocked(getExtension).mockReset();
});

describe("GET /api/extensions/[id]/entities/[type]", () => {
	test("returns 401 when unauthenticated", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-1",
			manifest: MANIFEST_WITH_POST_TYPE,
		} as any);
		await expectThrownResponse(
			() =>
				collection.GET(
					makeEvent({
						href: "http://x/api/extensions/ext-1/entities/post-type",
						params: { id: "ext-1", type: "post-type" },
						locals: {},
					}),
				),
			401,
		);
	});

	test("returns 404 when extension not found", async () => {
		vi.mocked(getExtension).mockResolvedValue(undefined as any);
		const res = await collection.GET(
			makeEvent({
				href: "http://x/api/extensions/missing/entities/post-type",
				params: { id: "missing", type: "post-type" },
			}),
		);
		expect(res.status).toBe(404);
	});

	test("returns 404 when entity type not declared", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-1",
			manifest: MANIFEST_WITH_POST_TYPE,
		} as any);
		const res = await collection.GET(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/character",
				params: { id: "ext-1", type: "character" },
			}),
		);
		expect(res.status).toBe(404);
	});

	test("returns empty list when no records exist", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-1",
			manifest: MANIFEST_WITH_POST_TYPE,
		} as any);
		const res = await collection.GET(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type",
				params: { id: "ext-1", type: "post-type" },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: unknown[] };
		expect(body.items).toEqual([]);
	});
});

describe("POST /api/extensions/[id]/entities/[type]", () => {
	beforeEach(() => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-1",
			manifest: MANIFEST_WITH_POST_TYPE,
		} as any);
	});

	test("creates a record (201) and lists it on subsequent GET", async () => {
		const res = await collection.POST(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type",
				params: { id: "ext-1", type: "post-type" },
				method: "POST",
				body: {
					slug: "weekly",
					data: { name: "Weekly", cadence: "weekly" },
				},
			}),
		);
		expect(res.status).toBe(201);

		const listRes = await collection.GET(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type",
				params: { id: "ext-1", type: "post-type" },
			}),
		);
		const list = (await listRes.json()) as {
			items: Array<{ slug: string; data: Record<string, unknown> }>;
		};
		expect(list.items.length).toBe(1);
		expect(list.items[0]!.slug).toBe("weekly");
	});

	test("rejects invalid slug (400)", async () => {
		const res = await collection.POST(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type",
				params: { id: "ext-1", type: "post-type" },
				method: "POST",
				body: {
					slug: "BAD SLUG",
					data: { name: "x", cadence: "weekly" },
				},
			}),
		);
		expect(res.status).toBe(400);
	});

	test("rejects data missing required field (400)", async () => {
		const res = await collection.POST(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type",
				params: { id: "ext-1", type: "post-type" },
				method: "POST",
				body: { slug: "weekly", data: { name: "Weekly" } },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error?: string;
			issues?: unknown[];
		};
		expect(body.error).toMatch(/cadence/);
		expect(Array.isArray(body.issues)).toBe(true);
	});

	test("rejects duplicate slug (409)", async () => {
		await collection.POST(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type",
				params: { id: "ext-1", type: "post-type" },
				method: "POST",
				body: {
					slug: "weekly",
					data: { name: "Weekly", cadence: "weekly" },
				},
			}),
		);
		const res = await collection.POST(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type",
				params: { id: "ext-1", type: "post-type" },
				method: "POST",
				body: {
					slug: "weekly",
					data: { name: "Weekly Again", cadence: "weekly" },
				},
			}),
		);
		expect(res.status).toBe(409);
	});
});

describe("GET/PUT/DELETE /api/extensions/[id]/entities/[type]/[slug]", () => {
	beforeEach(async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-1",
			manifest: MANIFEST_WITH_POST_TYPE,
		} as any);
		await collection.POST(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type",
				params: { id: "ext-1", type: "post-type" },
				method: "POST",
				body: {
					slug: "weekly",
					data: { name: "Weekly", cadence: "weekly" },
				},
			}),
		);
	});

	test("GET returns the record", async () => {
		const res = await record.GET(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
				params: { id: "ext-1", type: "post-type", slug: "weekly" },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			slug: string;
			data: { name: string };
		};
		expect(body.slug).toBe("weekly");
		expect(body.data.name).toBe("Weekly");
	});

	test("GET on missing slug returns 404", async () => {
		const res = await record.GET(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/missing",
				params: { id: "ext-1", type: "post-type", slug: "missing" },
			}),
		);
		expect(res.status).toBe(404);
	});

	test("PUT shallow-merges and re-validates", async () => {
		const res = await record.PUT(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
				params: { id: "ext-1", type: "post-type", slug: "weekly" },
				method: "PUT",
				body: { data: { name: "Weekly Roundup" } },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			slug: string;
			data: { name: string; cadence: string };
		};
		expect(body.data.name).toBe("Weekly Roundup");
		// cadence preserved from the original record (shallow merge).
		expect(body.data.cadence).toBe("weekly");
	});

	test("PUT with invalid patch returns 400", async () => {
		const res = await record.PUT(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
				params: { id: "ext-1", type: "post-type", slug: "weekly" },
				method: "PUT",
				body: { data: { cadence: "biweekly" } },
			}),
		);
		expect(res.status).toBe(400);
	});

	test("PUT with body.slug returns 400 (slug immutable)", async () => {
		const res = await record.PUT(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
				params: { id: "ext-1", type: "post-type", slug: "weekly" },
				method: "PUT",
				body: { patch: { slug: "new-slug", name: "x" } },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toMatch(/immutable/);
	});

	test("DELETE removes the record (deleted: true)", async () => {
		const res = await record.DELETE(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
				params: { id: "ext-1", type: "post-type", slug: "weekly" },
				method: "DELETE",
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { deleted: boolean };
		expect(body.deleted).toBe(true);

		// Confirm subsequent GET returns 404.
		const getRes = await record.GET(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
				params: { id: "ext-1", type: "post-type", slug: "weekly" },
			}),
		);
		expect(getRes.status).toBe(404);
	});

	test("DELETE on missing slug returns deleted: false", async () => {
		const res = await record.DELETE(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/missing",
				params: { id: "ext-1", type: "post-type", slug: "missing" },
				method: "DELETE",
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { deleted: boolean };
		expect(body.deleted).toBe(false);
	});
});

describe("soft-read drift handling (Phase 6)", () => {
	test("GET attaches _validationWarning when stored record fails current schema", async () => {
		// Plant a record with a cadence value that is no longer in the
		// enum (simulating a manifest update that tightened the schema).
		fakeStorage.rows.set(
			`ext-1::user::u1::__entity:post-type:weekly`,
			{
				value: { name: "Weekly", cadence: "biweekly" },
				sizeBytes: 32,
				encrypted: false,
			},
		);
		fakeStorage.rows.set(
			`ext-1::user::u1::__entity-index:post-type`,
			{ value: ["weekly"], sizeBytes: 16, encrypted: false },
		);
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-1",
			manifest: MANIFEST_WITH_POST_TYPE,
		} as any);

		const listRes = await collection.GET(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type",
				params: { id: "ext-1", type: "post-type" },
			}),
		);
		expect(listRes.status).toBe(200);
		const listBody = (await listRes.json()) as {
			items: Array<{
				slug: string;
				_validationWarning?: { code: string };
			}>;
		};
		expect(listBody.items[0]?._validationWarning?.code).toBe(
			"SCHEMA_DRIFT",
		);

		const getRes = await record.GET(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
				params: { id: "ext-1", type: "post-type", slug: "weekly" },
			}),
		);
		const getBody = (await getRes.json()) as {
			_validationWarning?: { code: string };
		};
		expect(getBody._validationWarning?.code).toBe("SCHEMA_DRIFT");
	});

	test("drifted records can still be DELETEd (soft-read doesn't block destructive ops)", async () => {
		fakeStorage.rows.set(
			`ext-1::user::u1::__entity:post-type:weekly`,
			{
				value: { name: "Weekly", cadence: "biweekly" },
				sizeBytes: 32,
				encrypted: false,
			},
		);
		fakeStorage.rows.set(
			`ext-1::user::u1::__entity-index:post-type`,
			{ value: ["weekly"], sizeBytes: 16, encrypted: false },
		);
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-1",
			manifest: MANIFEST_WITH_POST_TYPE,
		} as any);

		const res = await record.DELETE(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
				params: { id: "ext-1", type: "post-type", slug: "weekly" },
				method: "DELETE",
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { deleted: boolean };
		expect(body.deleted).toBe(true);
	});
});

describe("conversation-scoped declarations are not editable via UI", () => {
	test("rejects with 400", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-1",
			manifest: {
				...MANIFEST_WITH_POST_TYPE,
				entities: [
					{
						...MANIFEST_WITH_POST_TYPE.entities[0],
						scope: "conversation",
					},
				],
			},
		} as any);
		const res = await collection.GET(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type",
				params: { id: "ext-1", type: "post-type" },
			}),
		);
		expect(res.status).toBe(400);
	});
});

// ── Auth gate (401) + API-key scope (403) + storage 500 ───────────
//
// `requireAuth(locals)` throws a Response with status 401 when no
// `user` is present; `requireScope(locals, ...)` returns a 403
// Response when the API-key path is active and the required scope is
// missing. Both are first-class server-side gates that the existing
// tests didn't cover beyond the GET-collection happy path. The 500
// path covers an unexpected storage-layer failure on POST + PUT — the
// route surfaces the error rather than crashing.

describe("auth (401) — every method gated", () => {
	beforeEach(() => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-1",
			manifest: MANIFEST_WITH_POST_TYPE,
		} as any);
	});

	test("POST [type] returns 401 when unauthenticated", async () => {
		await expectThrownResponse(
			() =>
				collection.POST(
					makeEvent({
						href: "http://x/api/extensions/ext-1/entities/post-type",
						params: { id: "ext-1", type: "post-type" },
						method: "POST",
						body: { slug: "weekly", data: { name: "x", cadence: "weekly" } },
						locals: {},
					}),
				),
			401,
		);
	});

	test("GET [type]/[slug] returns 401 when unauthenticated", async () => {
		await expectThrownResponse(
			() =>
				record.GET(
					makeEvent({
						href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
						params: { id: "ext-1", type: "post-type", slug: "weekly" },
						locals: {},
					}),
				),
			401,
		);
	});

	test("PUT [type]/[slug] returns 401 when unauthenticated", async () => {
		await expectThrownResponse(
			() =>
				record.PUT(
					makeEvent({
						href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
						params: { id: "ext-1", type: "post-type", slug: "weekly" },
						method: "PUT",
						body: { data: { name: "Weekly Roundup" } },
						locals: {},
					}),
				),
			401,
		);
	});

	test("DELETE [type]/[slug] returns 401 when unauthenticated", async () => {
		await expectThrownResponse(
			() =>
				record.DELETE(
					makeEvent({
						href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
						params: { id: "ext-1", type: "post-type", slug: "weekly" },
						method: "DELETE",
						locals: {},
					}),
				),
			401,
		);
	});
});

describe("API-key scope (403) — read vs extensions gating", () => {
	// `requireScope` returns null when `locals.apiKeyScopes` is
	// undefined (cookie auth path). To exercise the 403 branch the
	// caller must come in via an API key WITHOUT the required scope.
	// GET routes require `read`; mutating routes require `extensions`.
	beforeEach(() => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-1",
			manifest: MANIFEST_WITH_POST_TYPE,
		} as any);
	});

	function localsWithScopes(scopes: string[]) {
		return { user, apiKeyScopes: scopes };
	}

	test("GET [type] returns 403 when API key lacks 'read' scope", async () => {
		const res = await collection.GET(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type",
				params: { id: "ext-1", type: "post-type" },
				locals: localsWithScopes(["chat"]),
			}),
		);
		expect(res.status).toBe(403);
	});

	test("POST [type] returns 403 when API key lacks 'extensions' scope", async () => {
		const res = await collection.POST(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type",
				params: { id: "ext-1", type: "post-type" },
				method: "POST",
				body: { slug: "weekly", data: { name: "Weekly", cadence: "weekly" } },
				locals: localsWithScopes(["read"]),
			}),
		);
		expect(res.status).toBe(403);
	});

	test("GET [type]/[slug] returns 403 when API key lacks 'read' scope", async () => {
		const res = await record.GET(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
				params: { id: "ext-1", type: "post-type", slug: "weekly" },
				locals: localsWithScopes(["chat"]),
			}),
		);
		expect(res.status).toBe(403);
	});

	test("PUT [type]/[slug] returns 403 when API key lacks 'extensions' scope", async () => {
		const res = await record.PUT(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
				params: { id: "ext-1", type: "post-type", slug: "weekly" },
				method: "PUT",
				body: { data: { name: "Weekly Roundup" } },
				locals: localsWithScopes(["read"]),
			}),
		);
		expect(res.status).toBe(403);
	});

	test("DELETE [type]/[slug] returns 403 when API key lacks 'extensions' scope", async () => {
		const res = await record.DELETE(
			makeEvent({
				href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
				params: { id: "ext-1", type: "post-type", slug: "weekly" },
				method: "DELETE",
				locals: localsWithScopes(["read"]),
			}),
		);
		expect(res.status).toBe(403);
	});
});

describe("storage layer errors propagate (SvelteKit returns 500)", () => {
	// Both POST and PUT call `setStorageValue` AFTER the validation gate;
	// an unexpected throw from the storage adapter (e.g. connection
	// drop, constraint violation) propagates from the handler — SvelteKit
	// translates that to a 500 at the framework level. The contract we
	// can verify in unit scope is: the handler does NOT swallow the
	// error silently (no 200 with bad data, no infinite hang).
	test("POST does not swallow setStorageValue failures", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-1",
			manifest: MANIFEST_WITH_POST_TYPE,
		} as any);
		const { setStorageValue } = await import(
			"$server/db/queries/extension-storage"
		);
		const original = vi.mocked(setStorageValue).getMockImplementation();
		vi.mocked(setStorageValue).mockRejectedValueOnce(
			new Error("connection refused"),
		);
		try {
			await expect(
				collection.POST(
					makeEvent({
						href: "http://x/api/extensions/ext-1/entities/post-type",
						params: { id: "ext-1", type: "post-type" },
						method: "POST",
						body: {
							slug: "weekly",
							data: { name: "Weekly", cadence: "weekly" },
						},
					}),
				),
			).rejects.toThrow(/connection refused/);
		} finally {
			if (original) vi.mocked(setStorageValue).mockImplementation(original);
		}
	});

	test("PUT does not swallow setStorageValue failures", async () => {
		vi.mocked(getExtension).mockResolvedValue({
			id: "ext-1",
			manifest: MANIFEST_WITH_POST_TYPE,
		} as any);
		// Plant a row so the PUT path reaches setStorageValue (a missing
		// record short-circuits to 404 before the throw fires).
		fakeStorage.rows.set(`ext-1::user::u1::__entity:post-type:weekly`, {
			value: { name: "Weekly", cadence: "weekly" },
			sizeBytes: 32,
			encrypted: false,
		});
		const { setStorageValue } = await import(
			"$server/db/queries/extension-storage"
		);
		const original = vi.mocked(setStorageValue).getMockImplementation();
		vi.mocked(setStorageValue).mockRejectedValueOnce(
			new Error("disk full"),
		);
		try {
			await expect(
				record.PUT(
					makeEvent({
						href: "http://x/api/extensions/ext-1/entities/post-type/weekly",
						params: { id: "ext-1", type: "post-type", slug: "weekly" },
						method: "PUT",
						body: { data: { name: "Weekly Roundup" } },
					}),
				),
			).rejects.toThrow(/disk full/);
		} finally {
			if (original) vi.mocked(setStorageValue).mockImplementation(original);
		}
	});
});
