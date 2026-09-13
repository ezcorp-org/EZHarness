import { beforeEach, describe, expect, test, vi } from "vitest";
import type { FactoryApiResponse } from "@ezcorp/factory-sdk";
import { FactoryApiClient, FactoryApiClientError, blankFactory } from "./client";

const digest = "a".repeat(64);
const compiledDigest = "b".repeat(64);
const source = blankFactory("factory one");
const summary = {
	factoryId: source.id,
	revision: 1,
	archived: false,
	availability: "available" as const,
	sourceDigest: digest,
	updatedAtMs: 1,
};
const version = {
	factoryId: source.id,
	version: source.version,
	draftRevision: 1,
	definitionDigest: "sha256:" + digest,
	compiledBlobDigest: compiledDigest,
	compiledBytes: 1,
	publishedAtMs: 2,
};

function api(value: FactoryApiResponse, status = 200): Response {
	return Response.json(value, { status });
}

function response(kind: FactoryApiResponse["kind"]): FactoryApiResponse {
	switch (kind) {
		case "draft.summary":
			return { schemaVersion: "factory.api.response.v1", kind, resource: summary };
		case "draft.details":
			return { schemaVersion: "factory.api.response.v1", kind, resource: { ...summary, source } };
		case "draft.page":
			return { schemaVersion: "factory.api.response.v1", kind, page: { items: [summary] } };
		case "draft.export":
			return { schemaVersion: "factory.api.response.v1", kind, format: "yaml", source: "schemaVersion: factory.v1" };
		case "draft.validation":
			return { schemaVersion: "factory.api.response.v1", kind, valid: true, diagnostics: [] };
		case "version.page":
			return { schemaVersion: "factory.api.response.v1", kind, page: { items: [version] } };
		case "version.details":
			return { schemaVersion: "factory.api.response.v1", kind, resource: { ...version, source } };
		case "version.summary":
			return { schemaVersion: "factory.api.response.v1", kind, resource: version };
		default:
			throw new Error("unsupported fixture");
	}
}

describe("FactoryApiClient", () => {
	const calls: Array<{ path: string; init?: RequestInit }> = [];
	let fetcher: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		calls.length = 0;
		fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const path = String(input);
			calls.push({ path, init });
			if (path.includes("/export")) return api(response("draft.export"));
			if (path.includes("/validate")) return api(response("draft.validation"));
			if (path.includes("/versions/")) return api(response("version.details"));
			if (path.endsWith("/versions") && init?.method === "POST") return api(response("version.summary"));
			if (path.endsWith("/versions")) return api(response("version.page"));
			if (path.endsWith("/import")) return api(response("draft.summary"));
			if (path.includes("/definitions/")) return api(init?.method === "PUT" || init?.method === "DELETE" ? response("draft.summary") : response("draft.details"));
			return api(init?.method === "POST" ? response("draft.summary") : response("draft.page"));
		});
	});

	test("routes every authoring operation with encoded identity and mutation preconditions", async () => {
		const client = new FactoryApiClient({ fetch: fetcher as unknown as typeof fetch, idempotencyKey: operation => "key:" + operation });
		expect(await client.listDrafts("project/one", { limit: 2, search: "long label", archived: false, availability: "available" })).toEqual([summary]);
		expect(await client.getDraft("project/one", source.id)).toMatchObject({ source });
		expect(await client.createDraft("project/one", source)).toEqual(summary);
		expect(await client.importDraft("project/one", "yaml", "source")).toEqual(summary);
		expect(await client.saveDraft("project/one", source.id, 1, source)).toEqual(summary);
		expect(await client.archiveDraft("project/one", source.id, 1)).toEqual(summary);
		expect(await client.exportDraft("project/one", source.id, "yaml")).toEqual({ format: "yaml", source: "schemaVersion: factory.v1" });
		expect((await client.validateDraft("project/one", source.id, source)).valid).toBe(true);
		expect(await client.listVersions("project/one", source.id)).toEqual([version]);
		expect(await client.getVersion("project/one", source.id, source.version)).toMatchObject({ source });
		expect(await client.publishVersion("project/one", source.id, 1, source.version)).toEqual(version);

		const listed = new URL(calls[0]!.path, "http://localhost");
		expect(listed.pathname).toContain("project%2Fone/definitions");
		expect(Object.fromEntries(listed.searchParams)).toEqual({ limit: "2", search: "long label", archived: "false", availability: "available" });
		expect(calls[1]?.path).toContain("factory%20one");
		expect(new Headers(calls[2]?.init?.headers).get("If-Match")).toBe("0");
		expect(new Headers(calls[2]?.init?.headers).get("Idempotency-Key")).toBe("key:create:factory one");
		expect(calls[4]?.init?.method).toBe("PUT");
		expect(calls[5]?.init?.method).toBe("DELETE");
		expect(calls[5]?.init?.body).toBeUndefined();
		expect(calls[6]?.path).toContain("format=yaml");
		expect(calls[7]?.init?.headers).toEqual({ "content-type": "application/json" });
		expect(calls[10]?.init?.body).toBe(JSON.stringify({ version: source.version }));
	});

	test("uses the platform fetch and bounded random key defaults", async () => {
		vi.stubGlobal("fetch", fetcher);
		vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
		const client = new FactoryApiClient();
		await client.listDrafts("project");
		await client.createDraft("project", source);
		expect(calls[0]?.path).toBe("/api/factories/projects/project/definitions");
		expect(new Headers(calls[1]?.init?.headers).get("Idempotency-Key")).toBe("factory-console:create:factory one:00000000-0000-4000-8000-000000000000");
		vi.unstubAllGlobals();
	});

	test("rejects API errors, malformed JSON, invalid schemas, HTTP failures, and wrong response kinds", async () => {
		const errorResponse: FactoryApiResponse = {
			schemaVersion: "factory.api.response.v1",
			kind: "error",
			error: { code: "factory_revision_conflict", message: "Reload.", retryable: false, currentRevision: 2 },
		};
		const cases: Array<{ response: Response; code: string }> = [
			{ response: api(errorResponse, 412), code: "factory_revision_conflict" },
			{ response: new Response("bad", { status: 502 }), code: "factory_invalid_response" },
			{ response: Response.json({ kind: "unknown" }), code: "factory_invalid_response" },
			{ response: api(response("draft.page"), 500), code: "factory_http_error" },
			{ response: api(response("draft.summary")), code: "factory_response_kind" },
		];
		for (const item of cases) {
			const client = new FactoryApiClient({ fetch: vi.fn(async () => item.response) as unknown as typeof fetch });
			const failure = await client.getDraft("project", source.id).catch(error => error);
			expect(failure).toBeInstanceOf(FactoryApiClientError);
			expect(failure.code).toBe(item.code);
		}
		const conflict: FactoryApiClientError = await new FactoryApiClient({ fetch: vi.fn(async () => api(errorResponse, 412)) as unknown as typeof fetch })
			.getDraft("project", source.id)
			.then(() => { throw new Error("expected conflict"); }, error => error as FactoryApiClientError);
		expect(conflict.status).toBe(412);
		expect(conflict.currentRevision).toBe(2);
	});

	test("creates a complete SDK-shaped empty draft", () => {
		expect(blankFactory("first.factory")).toEqual({
			schemaVersion: "factory.v1",
			id: "first.factory",
			version: "0.1.0",
			interpreterCompatibility: "factory-kernel.v1",
			inputPorts: {},
			outputPorts: {},
			graph: { nodes: [], outputs: {} },
			acceptance: { id: "first.factory.contract", version: "0.1.0", claims: [] },
			packages: [],
			factories: [],
			capabilities: [],
			effects: ["none"],
			bounds: { maxExpandedNodes: 10_000, maxScopeDepth: 16 },
			presentation: { title: "first.factory" },
		});
	});
});
