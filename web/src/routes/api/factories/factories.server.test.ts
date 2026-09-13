import { beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalizeJson, compileFactory, referenceCodeV1, type FactoryApiResponse } from "@ezcorp/factory-sdk";
import type { FactoryApplication } from "$server/factory/application";
import { FactoryDefinitionError } from "$server/factory/definitions";
import { FactoryGrantError } from "$server/factory/grants";
import { FactoryMutationError } from "$server/factory/mutations";

const state = vi.hoisted(() => ({ enabled: true, application: null as unknown }));

vi.mock("$server/factory/boot", () => ({ factoryBootConfig: { get enabled() { return state.enabled; } } }));
vi.mock("$server/factory/application", async importOriginal => {
  const actual = await importOriginal<typeof import("$server/factory/application")>();
  return { ...actual, getFactoryApplication: () => state.application };
});

const definitions = {
  save: vi.fn(),
  archive: vi.fn(),
  read: vi.fn(),
  listDrafts: vi.fn(),
  importNew: vi.fn(),
  export: vi.fn(),
  validateSource: vi.fn(),
  publish: vi.fn(),
  readVersion: vi.fn(),
  listVersions: vi.fn(),
};
const grants = { list: vi.fn(), set: vi.fn(), revoke: vi.fn() };

const sourceDigest = createHash("sha256").update(canonicalizeJson(referenceCodeV1 as unknown as Parameters<typeof canonicalizeJson>[0])).digest("hex");
const compiledResult = compileFactory(referenceCodeV1);
if (!compiledResult.ok) throw new Error("Reference fixture must compile.");
const compiled = compiledResult.factory;
const compiledText = canonicalizeJson(compiled as unknown as Parameters<typeof canonicalizeJson>[0]);
const compiledBlobDigest = createHash("sha256").update(compiledText).digest("hex");
const metadata = { projectId: "project-1", factoryId: referenceCodeV1.id, revision: 1, sourceDigest, archived: false, updatedAtMs: 1, requiredResourceClasses: [], requirementsComplete: true, validationDiagnosticCount: 0 };
const draft = { ...metadata, source: referenceCodeV1 };
const version = { projectId: "project-1", factoryId: referenceCodeV1.id, version: referenceCodeV1.version, draftRevision: 1, definitionDigest: compiled.digest, compiledBlobDigest, compiledBytes: new TextEncoder().encode(compiledText).byteLength, publishedAtMs: 2 };
const grant = { projectId: "project-1", principalKind: "user" as const, principalId: "member-1", action: "factory.author" as const, revision: 1, expiresAtMs: null, revoked: false, issuerId: "admin-1", updatedAtMs: 3 };

const collection = await import("./projects/[projectId]/definitions/+server");
const importRoute = await import("./projects/[projectId]/definitions/import/+server");
const item = await import("./projects/[projectId]/definitions/[factoryId]/+server");
const exportRoute = await import("./projects/[projectId]/definitions/[factoryId]/export/+server");
const validateRoute = await import("./projects/[projectId]/definitions/[factoryId]/validate/+server");
const versions = await import("./projects/[projectId]/definitions/[factoryId]/versions/+server");
const versionRoute = await import("./projects/[projectId]/definitions/[factoryId]/versions/[version]/+server");
const grantList = await import("./projects/[projectId]/grants/+server");
const grantItem = await import("./projects/[projectId]/grants/[principalKind]/[principalId]/[action]/+server");
const shared = await import("./_shared");

beforeEach(() => {
  state.enabled = true;
  state.application = {
    tenantId: "tenant-1",
    definitions,
    grants,
    availableResourceClasses: new Set(["cpu"]),
  } as unknown as FactoryApplication;
  vi.clearAllMocks();
  definitions.save.mockResolvedValue(metadata);
  definitions.archive.mockResolvedValue({ ...metadata, revision: 2, archived: true });
  definitions.read.mockResolvedValue(draft);
  definitions.listDrafts.mockResolvedValue({ items: [draft], nextCursor: null });
  definitions.importNew.mockResolvedValue(metadata);
  definitions.export.mockResolvedValue({ revision: 1, content: compiledText });
  definitions.validateSource.mockResolvedValue({ ok: true, factory: compiled });
  definitions.publish.mockResolvedValue(version);
  definitions.readVersion.mockResolvedValue({ version, compiled });
  definitions.listVersions.mockResolvedValue({ items: [version], nextCursor: null });
  grants.list.mockResolvedValue({ items: [grant], nextCursor: null });
  grants.set.mockResolvedValue({ revision: 1, expiresAtMs: null });
  grants.revoke.mockResolvedValue({ revision: 2, expiresAtMs: null });
});

function event(method: string, pathname: string, options: { body?: unknown; revision?: number; key?: string; auth?: "session" | "api-key" | "internal"; anonymous?: boolean; scopes?: string[]; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.revision !== undefined) headers["If-Match"] = String(options.revision);
  if (options.key !== undefined) headers["Idempotency-Key"] = options.key;
  const request = new Request(`http://localhost${pathname}`, { method, headers, body: options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body) });
  const authMethod = options.auth ?? "session";
  return {
    request,
    url: new URL(request.url),
    params: options.params ?? {},
    locals: options.anonymous ? {} : { user: { id: authMethod === "session" ? "member-1" : "key-owner", email: "member@example.test", name: "Member", role: "member", status: "active" }, authMethod, ...(authMethod === "api-key" ? { apiKeyScopes: options.scopes ?? ["read", "write"] } : {}), ...(authMethod === "internal" ? { apiKeyId: "internal-1" } : {}) },
  } as never;
}

async function json(response: Response): Promise<FactoryApiResponse> {
  return await response.json() as FactoryApiResponse;
}

describe("factory definition and grant routes", () => {
  test("routes every successful draft, version, and grant operation through the shared contract", async () => {
    const project = { projectId: "project-1" };
    const resource = { ...project, factoryId: referenceCodeV1.id };
    const grantPath = { ...project, principalKind: "user", principalId: "member-1", action: "factory.author" };
    const calls = [
      collection.GET(event("GET", "/api/factories/projects/project-1/definitions?limit=1&search=reference&availability=available&archived=false", { params: project })),
      collection.POST(event("POST", "/api/factories/projects/project-1/definitions", { params: project, body: { source: referenceCodeV1 }, revision: 0, key: "create" })),
      importRoute.POST(event("POST", "/api/factories/projects/project-1/definitions/import", { params: project, body: { format: "json", source: JSON.stringify(referenceCodeV1) }, revision: 0, key: "import" })),
      item.GET(event("GET", "/api/factories/projects/project-1/definitions/reference.code.v1", { params: resource })),
      item.PUT(event("PUT", "/api/factories/projects/project-1/definitions/reference.code.v1", { params: resource, body: { source: referenceCodeV1 }, revision: 1, key: "update" })),
      item.DELETE(event("DELETE", "/api/factories/projects/project-1/definitions/reference.code.v1", { params: resource, revision: 1, key: "archive" })),
      exportRoute.GET(event("GET", "/api/factories/projects/project-1/definitions/reference.code.v1/export?format=yaml", { params: resource })),
      validateRoute.POST(event("POST", "/api/factories/projects/project-1/definitions/reference.code.v1/validate", { params: resource, body: { source: referenceCodeV1 } })),
      versions.GET(event("GET", "/api/factories/projects/project-1/definitions/reference.code.v1/versions?limit=2", { params: resource })),
      versions.POST(event("POST", "/api/factories/projects/project-1/definitions/reference.code.v1/versions", { params: resource, body: { version: "1.0.0" }, revision: 1, key: "publish" })),
      versionRoute.GET(event("GET", "/api/factories/projects/project-1/definitions/reference.code.v1/versions/1.0.0", { params: { ...resource, version: "1.0.0" } })),
      grantList.GET(event("GET", "/api/factories/projects/project-1/grants?principalKind=user&action=factory.author", { params: project })),
      grantItem.PUT(event("PUT", "/api/factories/projects/project-1/grants/user/member-1/factory.author", { params: grantPath, body: { expiresAtMs: null }, revision: 0, key: "grant" })),
      grantItem.DELETE(event("DELETE", "/api/factories/projects/project-1/grants/user/member-1/factory.author", { params: grantPath, revision: 1, key: "revoke" })),
    ];
    const responses = await Promise.all(calls);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect((await json(responses[0]!)).kind).toBe("draft.page");
    expect((await json(responses[3]!)).kind).toBe("draft.details");
    expect((await json(responses[6]!)).kind).toBe("draft.export");
    expect((await json(responses[7]!)).kind).toBe("draft.validation");
    expect((await json(responses[8]!)).kind).toBe("version.page");
    expect((await json(responses[9]!)).kind).toBe("version.summary");
    expect((await json(responses[10]!)).kind).toBe("version.details");
    expect((await json(responses[11]!)).kind).toBe("grant.page");
    expect((await json(responses[13]!)).kind).toBe("grant.resource");
    expect(definitions.publish).toHaveBeenCalledWith(expect.objectContaining({ authentication: "session" }), resource, 1, "publish", "1.0.0");
    expect(grants.set).toHaveBeenCalledWith(expect.objectContaining({ authentication: "session" }), expect.objectContaining({ expectedRevision: 0 }), "grant");
  });

  test("checks feature and application readiness before authentication or body parsing", async () => {
    state.enabled = false;
    const disabled = await collection.POST(event("POST", "/api/factories/projects/project-1/definitions", { params: { projectId: "project-1" }, body: "not json" }));
    expect(disabled.status).toBe(404);
    expect((await json(disabled))).toMatchObject({ kind: "error", error: { code: "factory_disabled" } });
    state.enabled = true;
    state.application = null;
    const unavailable = await collection.GET(event("GET", "/api/factories/projects/project-1/definitions", { params: { projectId: "project-1" }, anonymous: true }));
    expect(unavailable.status).toBe(503);
    expect((await json(unavailable))).toMatchObject({ error: { code: "factory_application_unavailable", retryable: true } });
  });

  test("enforces authentication, exact key scopes, and human-only publication", async () => {
    const params = { projectId: "project-1", factoryId: referenceCodeV1.id };
    const anonymous = await collection.GET(event("GET", "/api/factories/projects/project-1/definitions", { params, anonymous: true }));
    expect(anonymous.status).toBe(401);
    const narrow = await collection.POST(event("POST", "/api/factories/projects/project-1/definitions", { params, body: { source: referenceCodeV1 }, revision: 0, key: "key", auth: "api-key", scopes: ["read"] }));
    expect(narrow.status).toBe(403);
    const keyPublish = await versions.POST(event("POST", "/api/factories/projects/project-1/definitions/reference.code.v1/versions", { params, body: { version: "1.0.0" }, revision: 1, key: "publish", auth: "api-key" }));
    expect(keyPublish.status).toBe(403);
    const internal = await collection.GET(event("GET", "/api/factories/projects/project-1/definitions", { params, auth: "internal" }));
    expect(internal.status).toBe(403);
    const keyAuthor = await collection.POST(event("POST", "/api/factories/projects/project-1/definitions", { params, body: { source: referenceCodeV1 }, revision: 0, key: "key", auth: "api-key", scopes: ["write"] }));
    expect(keyAuthor.status).toBe(200);
    expect(definitions.save).toHaveBeenLastCalledWith(expect.objectContaining({ authentication: "api-key" }), expect.anything(), 0, "key", referenceCodeV1);
  });

  test("rejects malformed SDK inputs and missing or stale header preconditions", async () => {
    const params = { projectId: "project-1" };
    const malformed = await collection.POST(event("POST", "/api/factories/projects/project-1/definitions", { params, body: "{" , revision: 0, key: "create" }));
    expect(malformed.status).toBe(400);
    const missingMatch = await collection.POST(event("POST", "/api/factories/projects/project-1/definitions", { params, body: { source: referenceCodeV1 }, key: "create" }));
    expect(missingMatch.status).toBe(412);
    const invalidMatch = await collection.POST(event("POST", "/api/factories/projects/project-1/definitions", { params, body: { source: referenceCodeV1 }, key: "create", revision: -1 }));
    expect(invalidMatch.status).toBe(412);
    const wrongCreationRevision = await collection.POST(event("POST", "/api/factories/projects/project-1/definitions", { params, body: { source: referenceCodeV1 }, key: "create", revision: 1 }));
    expect(wrongCreationRevision.status).toBe(412);
    const missingKey = await collection.POST(event("POST", "/api/factories/projects/project-1/definitions", { params, body: { source: referenceCodeV1 }, revision: 0 }));
    expect(missingKey.status).toBe(400);
    const badQuery = await collection.GET(event("GET", "/api/factories/projects/project-1/definitions?limit=201", { params }));
    expect(badQuery.status).toBe(400);
    await expect(shared.handleFactoryApi(event("GET", "/api/factories/projects/project-1/definitions"), {
      scope: "read",
      build: () => { throw new Error("route build failure"); },
    })).rejects.toThrow("route build failure");
  });

  test("maps store conflicts, denials, parse errors, invalid definitions, and storage failures", async () => {
    const params = { projectId: "project-1", factoryId: referenceCodeV1.id };
    definitions.save.mockRejectedValueOnce(new FactoryMutationError("idempotency_conflict"));
    expect((await collection.POST(event("POST", "/api/factories/projects/project-1/definitions", { params, body: { source: referenceCodeV1 }, revision: 0, key: "same" }))).status).toBe(409);
    definitions.save.mockRejectedValueOnce(new FactoryMutationError("invalid_idempotency_key"));
    expect((await collection.POST(event("POST", "/api/factories/projects/project-1/definitions", { params, body: { source: referenceCodeV1 }, revision: 0, key: "valid" }))).status).toBe(400);
    definitions.save.mockRejectedValueOnce(new FactoryMutationError("factory_receipt_corrupt"));
    expect((await collection.POST(event("POST", "/api/factories/projects/project-1/definitions", { params, body: { source: referenceCodeV1 }, revision: 0, key: "valid" }))).status).toBe(500);
    for (const [code, status] of [["factory_revision_conflict", 412], ["factory_definition_not_found", 404], ["factory_version_conflict", 409], ["factory_definition_schema_invalid", 400], ["factory_definition_corrupt", 500]] as const) {
      definitions.read.mockRejectedValueOnce(new FactoryDefinitionError(code));
      expect((await item.GET(event("GET", "/api/factories/projects/project-1/definitions/reference.code.v1", { params }))).status).toBe(status);
    }
    definitions.read.mockRejectedValueOnce(new FactoryDefinitionError("factory_definition_invalid", [{ code: "BROKEN", message: "Broken", path: [] }]));
    expect((await item.GET(event("GET", "/api/factories/projects/project-1/definitions/reference.code.v1", { params }))).status).toBe(422);
    for (const [code, status] of [["factory_grant_conflict", 412], ["factory_grant_not_found", 404], ["factory_forbidden", 403], ["factory_grant_invalid", 400], ["factory_grant_corrupt", 500]] as const) {
      grants.list.mockRejectedValueOnce(new FactoryGrantError(code));
      expect((await grantList.GET(event("GET", "/api/factories/projects/project-1/grants", { params }))).status).toBe(status);
    }
  });

  test("filters availability across pages, emits cursors, and refuses unsupported request kinds", async () => {
    const unavailable = { ...draft, factoryId: "gpu", requiredResourceClasses: ["gpu"], source: { ...referenceCodeV1, id: "gpu", graph: { ...referenceCodeV1.graph, nodes: referenceCodeV1.graph.nodes.map((node, index) => index === 0 ? { ...node, resources: { resourceClass: "gpu" } } : node) } } };
    definitions.listDrafts
      .mockResolvedValueOnce({ items: [unavailable], nextCursor: "gpu" })
      .mockResolvedValueOnce({ items: [draft], nextCursor: null });
    const response = await collection.GET(event("GET", "/api/factories/projects/project-1/definitions?availability=available&limit=1", { params: { projectId: "project-1" } }));
    expect(await json(response)).toMatchObject({ kind: "draft.page", page: { items: [], nextCursor: "gpu" } });
    const continued = await collection.GET(event("GET", "/api/factories/projects/project-1/definitions?availability=available&limit=1&cursor=gpu", { params: { projectId: "project-1" } }));
    expect(await json(continued)).toMatchObject({ kind: "draft.page", page: { items: [{ factoryId: referenceCodeV1.id }] } });
    definitions.listDrafts.mockResolvedValueOnce({ items: [draft, { ...draft, factoryId: "second", source: { ...referenceCodeV1, id: "second" } }], nextCursor: null });
    const cursor = await collection.GET(event("GET", "/api/factories/projects/project-1/definitions?limit=1", { params: { projectId: "project-1" } }));
    expect(await json(cursor)).toMatchObject({ page: { nextCursor: referenceCodeV1.id } });
    await expect(shared.handleFactoryApi(event("POST", "/api/factories/projects/project-1/runs", { body: {}, revision: 1, key: "run" }), {
      scope: "write",
      build: () => ({ kind: "run.start", path: { projectId: "project-1", factoryId: referenceCodeV1.id }, body: { factoryVersion: "1.0.0", definitionDigest: compiled.digest, grantRevision: 1, parameters: {} } }),
    })).rejects.toThrow("not handled");
  });
});
