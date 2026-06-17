/**
 * Server-handler unit tests for /api/search/backend (+server.ts) — the
 * Settings → Search BACKEND config (shared-search Phase 2).
 *
 * Covers GET (presence-only status; keys NEVER returned), POST (BYOK key
 * upsert + SearXNG URL, admin-gated, encrypted), DELETE (remove a key,
 * admin-gated). Mocks the settings query layer + audit writer + encryption
 * so no PGlite / on-disk secret is touched.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/settings", () => ({
	getSetting: vi.fn(),
	upsertSetting: vi.fn(async () => undefined),
	deleteSetting: vi.fn(async () => true),
}));
vi.mock("$server/db/queries/audit-log", () => ({
	insertAuditEntry: vi.fn(async () => undefined),
}));
vi.mock("$server/providers/encryption", () => ({
	encrypt: vi.fn((plain: string) => `enc:${plain}`),
}));

const { getSetting, upsertSetting, deleteSetting } = await import("$server/db/queries/settings");
const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { encrypt } = await import("$server/providers/encryption");
const { GET, POST, DELETE } = await import("../routes/api/search/backend/+server");

function makeEvent(opts: {
	locals?: Record<string, unknown>;
	body?: unknown;
	method?: "GET" | "POST" | "DELETE";
}) {
	const method = opts.method ?? "GET";
	return {
		url: new URL("http://localhost/api/search/backend"),
		locals: opts.locals ?? {},
		request: new Request("http://localhost/api/search/backend", {
			method,
			headers: { "content-type": "application/json" },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		}),
	} as any;
}

const adminUser = { user: { id: "admin-1", email: "a@x", name: "a", role: "admin" } };
const memberUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

describe("GET /api/search/backend", () => {
	beforeEach(() => {
		vi.mocked(getSetting).mockReset();
	});

	test("rejects 401 when locals.user is missing", async () => {
		let res: Response | undefined;
		try {
			await GET(makeEvent({ method: "GET" }));
			expect.fail("should have thrown");
		} catch (thrown) {
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
	});

	test("rejects 403 when caller is not admin", async () => {
		let res: Response | undefined;
		try {
			await GET(makeEvent({ method: "GET", locals: memberUser }));
			expect.fail("should have thrown");
		} catch (thrown) {
			res = thrown as Response;
		}
		expect(res!.status).toBe(403);
	});

	test("returns presence-only status; the key VALUE is never in the body", async () => {
		vi.mocked(getSetting).mockImplementation(async (key: string) => {
			if (key === "provider:apiKey:tavily") return "enc:super-secret-key";
			if (key === "global:search:searxngUrl") return "http://searxng:8080";
			return undefined;
		});
		const res = await GET(makeEvent({ method: "GET", locals: adminUser }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			providers: Array<{ provider: string; hasKey: boolean }>;
			searxngUrl: string;
		};
		expect(body.providers).toHaveLength(5);
		expect(body.providers.find((p) => p.provider === "tavily")?.hasKey).toBe(true);
		expect(body.providers.find((p) => p.provider === "brave")?.hasKey).toBe(false);
		expect(body.searxngUrl).toBe("http://searxng:8080");
		// The encrypted key must NOT appear anywhere in the serialized body.
		expect(JSON.stringify(body)).not.toContain("super-secret-key");
		expect(JSON.stringify(body)).not.toContain("enc:");
	});

	test("absent searxngUrl → empty string", async () => {
		vi.mocked(getSetting).mockResolvedValue(undefined);
		const res = await GET(makeEvent({ method: "GET", locals: adminUser }));
		const body = (await res.json()) as { searxngUrl: string };
		expect(body.searxngUrl).toBe("");
	});
});

describe("POST /api/search/backend", () => {
	beforeEach(() => {
		vi.mocked(upsertSetting).mockReset();
		vi.mocked(upsertSetting).mockResolvedValue(undefined);
		vi.mocked(insertAuditEntry).mockClear();
		vi.mocked(encrypt).mockClear();
	});

	test("rejects 403 when caller is not admin", async () => {
		let res: Response | undefined;
		try {
			await POST(makeEvent({ method: "POST", locals: memberUser, body: { provider: "tavily", apiKey: "k" } }));
			expect.fail("should have thrown");
		} catch (thrown) {
			res = thrown as Response;
		}
		expect(res!.status).toBe(403);
	});

	test("encrypts + stores a BYOK key under provider:apiKey:* and audits", async () => {
		const res = await POST(makeEvent({ method: "POST", locals: adminUser, body: { provider: "tavily", apiKey: " tav-key " } }));
		expect(res.status).toBe(200);
		expect((await res.json()).success).toBe(true);
		expect(encrypt).toHaveBeenCalledWith("tav-key");
		expect(upsertSetting).toHaveBeenCalledWith("provider:apiKey:tavily", "enc:tav-key");
		expect(insertAuditEntry).toHaveBeenCalledWith("admin-1", "search:backend_upsert", "tavily", {});
	});

	test("rejects 400 for an unknown BYOK provider", async () => {
		const res = await POST(makeEvent({ method: "POST", locals: adminUser, body: { provider: "bogus", apiKey: "k" } }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain("Invalid provider");
	});

	test("rejects 400 when apiKey is whitespace only", async () => {
		const res = await POST(makeEvent({ method: "POST", locals: adminUser, body: { provider: "brave", apiKey: "   " } }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("API key is required");
	});

	test("stores a valid SearXNG URL (no encryption — non-secret)", async () => {
		const res = await POST(makeEvent({ method: "POST", locals: adminUser, body: { searxngUrl: " http://searxng:8080 " } }));
		expect(res.status).toBe(200);
		expect(encrypt).not.toHaveBeenCalled();
		expect(upsertSetting).toHaveBeenCalledWith("global:search:searxngUrl", "http://searxng:8080");
		expect(insertAuditEntry).toHaveBeenCalledWith("admin-1", "search:backend_upsert", "searxngUrl", {});
	});

	test("allows clearing the SearXNG URL (empty string)", async () => {
		const res = await POST(makeEvent({ method: "POST", locals: adminUser, body: { searxngUrl: "" } }));
		expect(res.status).toBe(200);
		expect(upsertSetting).toHaveBeenCalledWith("global:search:searxngUrl", "");
	});

	test("rejects 400 for a non-http(s) SearXNG URL", async () => {
		const res = await POST(makeEvent({ method: "POST", locals: adminUser, body: { searxngUrl: "ftp://searxng" } }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain("http(s)");
	});

	test("rejects 400 for an unparseable SearXNG URL", async () => {
		const res = await POST(makeEvent({ method: "POST", locals: adminUser, body: { searxngUrl: "not a url" } }));
		expect(res.status).toBe(400);
	});

	test("rejects 400 on an empty body (no branch matched)", async () => {
		const res = await POST(makeEvent({ method: "POST", locals: adminUser, body: {} }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain("Invalid provider");
	});

	test("rejects 400 on an unknown field (strict schema)", async () => {
		const res = await POST(makeEvent({ method: "POST", locals: adminUser, body: { bogusField: 1 } }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid request body");
	});

	test("still 200 when the audit write throws (best-effort)", async () => {
		vi.mocked(insertAuditEntry).mockRejectedValueOnce(new Error("audit-fail"));
		const res = await POST(makeEvent({ method: "POST", locals: adminUser, body: { provider: "exa", apiKey: "k" } }));
		expect(res.status).toBe(200);
	});

	test("still 200 when the SearXNG-URL audit write throws (best-effort)", async () => {
		vi.mocked(insertAuditEntry).mockRejectedValueOnce(new Error("audit-fail"));
		const res = await POST(makeEvent({ method: "POST", locals: adminUser, body: { searxngUrl: "https://s" } }));
		expect(res.status).toBe(200);
	});
});

describe("DELETE /api/search/backend", () => {
	beforeEach(() => {
		vi.mocked(deleteSetting).mockReset();
		vi.mocked(deleteSetting).mockResolvedValue(true);
		vi.mocked(insertAuditEntry).mockClear();
	});

	test("rejects 403 when caller is not admin", async () => {
		let res: Response | undefined;
		try {
			await DELETE(makeEvent({ method: "DELETE", locals: memberUser, body: { provider: "tavily" } }));
			expect.fail("should have thrown");
		} catch (thrown) {
			res = thrown as Response;
		}
		expect(res!.status).toBe(403);
	});

	test("removes the BYOK key + audits", async () => {
		const res = await DELETE(makeEvent({ method: "DELETE", locals: adminUser, body: { provider: "jina" } }));
		expect(res.status).toBe(200);
		expect((await res.json()).success).toBe(true);
		expect(deleteSetting).toHaveBeenCalledWith("provider:apiKey:jina");
		expect(insertAuditEntry).toHaveBeenCalledWith("admin-1", "search:backend_delete", "jina", {});
	});

	test("rejects 400 for an unknown provider", async () => {
		const res = await DELETE(makeEvent({ method: "DELETE", locals: adminUser, body: { provider: "bogus" } }));
		expect(res.status).toBe(400);
	});

	test("rejects 400 when provider is missing", async () => {
		const res = await DELETE(makeEvent({ method: "DELETE", locals: adminUser, body: {} }));
		expect(res.status).toBe(400);
	});

	test("rejects 400 on an unknown field (strict schema)", async () => {
		const res = await DELETE(makeEvent({ method: "DELETE", locals: adminUser, body: { bogus: true } }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid request body");
	});

	test("still 200 when the audit write throws (best-effort)", async () => {
		vi.mocked(insertAuditEntry).mockRejectedValueOnce(new Error("audit-fail"));
		const res = await DELETE(makeEvent({ method: "DELETE", locals: adminUser, body: { provider: "serpapi" } }));
		expect(res.status).toBe(200);
	});
});
