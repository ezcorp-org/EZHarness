import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalizeJson } from "./canonical";
import { compileFactory } from "./compiler";
import { referenceCodeV1 } from "./references";
import { factoryApiRequestJsonSchema, factoryApiResponseJsonSchema, isFactoryApiRequest, isFactoryApiResponse } from "./schema";
import type { FactoryApiRequest, FactoryApiResponse, FactoryDraftSummary, JsonValue } from "./types";
import { FACTORY_API_REQUEST_SCHEMA_VERSION, FACTORY_API_RESPONSE_SCHEMA_VERSION, FACTORY_LIMITS } from "./types";
import { validateFactoryApiRequest, validateFactoryApiResponse } from "./validation";

const compiledResult = compileFactory(referenceCodeV1);
if (!compiledResult.ok) throw new Error(JSON.stringify(compiledResult.diagnostics));
const compiled = compiledResult.factory;
const sourceDigest = createHash("sha256").update(canonicalizeJson(referenceCodeV1 as unknown as JsonValue)).digest("hex");
const compiledJson = canonicalizeJson(compiled as unknown as JsonValue);
const compiledBlobDigest = createHash("sha256").update(compiledJson).digest("hex");
const preconditions = { idempotencyKey: "request-1", payloadDigest: sourceDigest, expectedRevision: 1 } as const;
const project = { projectId: "project-1" } as const;
const draft = { ...project, factoryId: referenceCodeV1.id } as const;
const definitionBody = { source: referenceCodeV1 } as const;

function code(result: ReturnType<typeof validateFactoryApiRequest> | ReturnType<typeof validateFactoryApiResponse>): string | undefined {
  return result.ok ? undefined : result.issues[0]?.code;
}

function requests(): FactoryApiRequest[] {
  return [
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "draft.create", path: project, preconditions: { ...preconditions, expectedRevision: 0 }, body: definitionBody },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "draft.update", path: draft, preconditions, body: definitionBody },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "draft.delete", path: draft, preconditions },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "draft.get", path: draft },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "draft.list", path: project, query: { limit: 50, availability: "available", archived: false } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "draft.import", path: project, preconditions: { ...preconditions, expectedRevision: 0 }, body: { format: "yaml", source: "schemaVersion: factory.v1" } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "draft.export", path: draft, query: { format: "json" } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "draft.validate", path: draft, body: definitionBody },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "version.publish", path: draft, preconditions, body: { version: referenceCodeV1.version } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "version.get", path: { ...draft, version: referenceCodeV1.version } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "version.list", path: draft, query: {} },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "run.start", path: draft, preconditions, body: { factoryVersion: referenceCodeV1.version, definitionDigest: compiled.digest, grantRevision: 3, parameters: { request: { kind: "inline", value: "build it" } } } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "run.get", path: { ...project, runId: "run-1" } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "run.list", path: project, query: { status: "running", factoryId: referenceCodeV1.id } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "run.control", path: { ...project, runId: "run-1" }, preconditions, body: { action: "cancel", reason: "User request" } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "run.control", path: { ...project, runId: "run-1" }, preconditions, body: { action: "repair", parameters: { instruction: { kind: "inline", value: "fix tests" } } } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "run.control", path: { ...project, runId: "run-1" }, preconditions, body: { action: "replan", parameters: {} } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "approval.get", path: { ...project, runId: "run-1", approvalId: "approval-1" } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "approval.list", path: project, query: { limit: 200 } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "approval.decide", path: { ...project, runId: "run-1", approvalId: "approval-1" }, preconditions, body: { decision: "approved", contextDigest: sourceDigest } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "grant.list", path: project, query: { principalKind: "service", action: "factory.run" } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "grant.set", path: { ...project, principalKind: "service", principalId: "agent-1", action: "factory.run" }, preconditions: { ...preconditions, expectedRevision: 0 }, body: { expiresAtMs: 2_000_000_000_000 } },
    { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, kind: "grant.revoke", path: { ...project, principalKind: "user", principalId: "user-1", action: "factory.author" }, preconditions },
  ];
}

function draftSummary(): FactoryDraftSummary {
  return { factoryId: referenceCodeV1.id, revision: 1, archived: false, availability: "available", sourceDigest, updatedAtMs: 1 };
}

function responses(): FactoryApiResponse[] {
  const version = { factoryId: referenceCodeV1.id, version: referenceCodeV1.version, draftRevision: 1, definitionDigest: compiled.digest, compiledBlobDigest, compiledBytes: new TextEncoder().encode(compiledJson).byteLength, publishedAtMs: 1 } as const;
  const run = { runId: "run-1", factoryId: referenceCodeV1.id, factoryVersion: referenceCodeV1.version, definitionDigest: compiled.digest, grantRevision: 1, revision: 1, status: "running", createdAtMs: 1, updatedAtMs: 1 } as const;
  const approval = { approvalId: "approval-1", runId: "run-1", revision: 1, contextDigest: sourceDigest, status: "pending", expiresAtMs: 2 } as const;
  const grant = { principalKind: "user", principalId: "user-1", action: "factory.author", revision: 1, expiresAtMs: null, revoked: false } as const;
  return [
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "draft.summary", resource: draftSummary() },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "draft.details", resource: { ...draftSummary(), source: referenceCodeV1 } },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "draft.page", page: { items: [draftSummary()], nextCursor: "next" } },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "draft.export", format: "json", source: "{}" },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "draft.validation", valid: true, diagnostics: [] },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "version.summary", resource: version },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "version.page", page: { items: [version] } },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "run.details", resource: { ...run, parameters: {} } },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "run.page", page: { items: [run] } },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "approval.resource", resource: approval },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "approval.page", page: { items: [approval] } },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "grant.resource", resource: grant },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "grant.page", page: { items: [grant] } },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "mutation.accepted", receipt: { resourceId: "run-1", commandId: "command-1", statusUrl: "/api/factories/runs/run-1" } },
    { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "error", error: { code: "revision_conflict", message: "Reload the draft.", retryable: false, currentRevision: 2 } },
  ];
}

describe("factory product API schema", () => {
  test("accepts every canonical request and response variant", () => {
    expect(factoryApiRequestJsonSchema.$id).toBe("urn:ezcorp:factory:api-request:v1");
    expect(factoryApiResponseJsonSchema.$id).toBe("urn:ezcorp:factory:api-response:v1");
    for (const request of requests()) {
      expect(isFactoryApiRequest(request)).toBe(true);
      expect(validateFactoryApiRequest(request)).toEqual({ ok: true });
    }
    for (const response of responses()) {
      expect(isFactoryApiResponse(response)).toBe(true);
      expect(validateFactoryApiResponse(response)).toEqual({ ok: true });
    }
  });

  test("rejects unknown fields, caller tenancy, missing headers, and unsafe revisions", () => {
    const create = requests()[0]!;
    expect(code(validateFactoryApiRequest({ ...create, tenantId: "attacker" }))).toBe("API_REQUEST_SCHEMA");
    expect(code(validateFactoryApiRequest({ ...create, body: { ...create.body, projectId: "attacker" } }))).toBe("API_REQUEST_SCHEMA");
    expect(code(validateFactoryApiRequest({ ...create, path: { ...create.path, unknown: true } }))).toBe("API_REQUEST_SCHEMA");
    expect(code(validateFactoryApiRequest({ ...create, preconditions: { ...create.preconditions, unknown: true } }))).toBe("API_REQUEST_SCHEMA");
    const { preconditions: _missing, ...withoutHeaders } = create;
    expect(code(validateFactoryApiRequest(withoutHeaders))).toBe("API_REQUEST_SCHEMA");
    expect(code(validateFactoryApiRequest({ ...create, preconditions: { ...create.preconditions, expectedRevision: 1 } }))).toBe("API_EXPECTED_REVISION");
    expect(code(validateFactoryApiRequest({ ...requests()[2]!, preconditions: { idempotencyKey: "key", payloadDigest: sourceDigest, expectedRevision: 0 } }))).toBe("API_EXPECTED_REVISION");
    expect(code(validateFactoryApiRequest({ ...create, preconditions: { idempotencyKey: "bad\nkey", payloadDigest: sourceDigest, expectedRevision: 0 } }))).toBe("API_IDEMPOTENCY_KEY");
    expect(code(validateFactoryApiRequest({ ...create, preconditions: { ...create.preconditions, payloadDigest: "A".repeat(64) } }))).toBe("API_PAYLOAD_DIGEST");
    expect(code(validateFactoryApiRequest({ ...requests()[2]!, preconditions: { ...preconditions, expectedRevision: 1.5 } }))).toBe("API_EXPECTED_REVISION");
    expect(code(validateFactoryApiRequest({ ...requests()[3]!, path: { ...draft, factoryId: "bad\0id" } }))).toBe("API_PATH_IDENTITY");
    expect(code(validateFactoryApiRequest({ ...requests()[4]!, query: { limit: 201 } }))).toBe("API_REQUEST_SCHEMA");
    expect(code(validateFactoryApiRequest({ ...requests()[4]!, query: { cursor: "bad\ncursor" } }))).toBe("API_QUERY");
    expect(code(validateFactoryApiRequest({ ...requests()[21]!, body: { expiresAtMs: null } }))).toBe("API_GRANT_EXPIRY");
  });

  test("rejects mismatched definitions, malformed digests, and oversized transport", () => {
    const update = requests()[1] as Extract<FactoryApiRequest, { kind: "draft.update" }>;
    expect(code(validateFactoryApiRequest({ ...update, path: { ...update.path, factoryId: "different" } }))).toBe("API_FACTORY_ID");
    const start = requests()[11] as Extract<FactoryApiRequest, { kind: "run.start" }>;
    expect(code(validateFactoryApiRequest({ ...start, body: { ...start.body, definitionDigest: `sha256:${"A".repeat(64)}` } }))).toBe("API_DEFINITION_DIGEST");
    expect(code(validateFactoryApiRequest({ ...start, body: { ...start.body, parameters: { "bad\nname": { kind: "inline", value: 1 } } } }))).toBe("API_PARAMETER_NAME");
    expect(code(validateFactoryApiRequest({ ...start, body: { ...start.body, parameters: { value: { kind: "inline", value: "x".repeat(FACTORY_LIMITS.maxInlineValueBytes + 1) } } } }))).toBe("API_PARAMETER_BYTES");
    expect(code(validateFactoryApiRequest({ ...start, body: { ...start.body, parameters: { value: { kind: "artifact", artifact: { artifactId: "../file", digest: `sha256:${sourceDigest}`, encodedBytes: 1 } } } } }))).toBe("RUNNER_ARTIFACT_ID");
    const nearLimit = "x".repeat(FACTORY_LIMITS.maxInlineValueBytes - 2);
    expect(code(validateFactoryApiRequest({ ...start, body: { ...start.body, parameters: { value: { kind: "inline", value: nearLimit } } } }))).toBe("API_RUN_START_BYTES");
    const approval = requests()[19] as Extract<FactoryApiRequest, { kind: "approval.decide" }>;
    expect(code(validateFactoryApiRequest({ ...approval, body: { ...approval.body, contextDigest: "bad" } }))).toBe("API_REQUEST_SCHEMA");
    const imported = requests()[5] as Extract<FactoryApiRequest, { kind: "draft.import" }>;
    expect(code(validateFactoryApiRequest({ ...imported, body: { ...imported.body, source: "界".repeat(5_600_000) } }))).toBe("API_IMPORT_BYTES");
    const largeDefinition = structuredClone(referenceCodeV1);
    (largeDefinition.inputPorts.request as { description?: string }).description = "界".repeat(5_600_000);
    const create = requests()[0] as Extract<FactoryApiRequest, { kind: "draft.create" }>;
    expect(code(validateFactoryApiRequest({ ...create, body: { source: largeDefinition } }))).toBe("API_DEFINITION_BYTES");
    expect(code(validateFactoryApiRequest({ ...start, body: { ...start.body, factoryVersion: "bad\nversion" } }))).toBe("API_VERSION");
    const repair = requests()[15] as Extract<FactoryApiRequest, { kind: "run.control" }>;
    expect(code(validateFactoryApiRequest({ ...repair, body: { action: "repair", parameters: { value: { kind: "inline", value: "x".repeat(FACTORY_LIMITS.maxInlineValueBytes + 1) } } } }))).toBe("API_PARAMETER_BYTES");
    expect(code(validateFactoryApiRequest({ ...repair, body: { action: "repair", parameters: { value: { kind: "inline", value: "x".repeat(FACTORY_LIMITS.maxInlineValueBytes - 2) } } } }))).toBe("API_CONTROL_BYTES");
  });

  test("rejects inconsistent and oversized response resources", () => {
    const summary = responses()[0] as Extract<FactoryApiResponse, { kind: "draft.summary" }>;
    expect(code(validateFactoryApiResponse({ ...summary, unknown: true }))).toBe("API_RESPONSE_SCHEMA");
    expect(code(validateFactoryApiResponse({ ...summary, resource: { ...summary.resource, unknown: true } }))).toBe("API_RESPONSE_SCHEMA");
    expect(code(validateFactoryApiResponse({ ...summary, resource: { ...summary.resource, sourceDigest: "bad" } }))).toBe("API_RESPONSE_SCHEMA");
    expect(code(validateFactoryApiResponse({ ...summary, resource: { ...summary.resource, availability: "unavailable" } }))).toBe("API_DRAFT_RESOURCE");
    expect(code(validateFactoryApiResponse({ ...summary, resource: { ...summary.resource, availabilityReason: "unexpected" } }))).toBe("API_DRAFT_RESOURCE");
    expect(validateFactoryApiResponse({ ...summary, resource: { ...summary.resource, availability: "unavailable", availabilityReason: "GPU unavailable" } })).toEqual({ ok: true });
    const details = responses()[1] as Extract<FactoryApiResponse, { kind: "draft.details" }>;
    expect(code(validateFactoryApiResponse({ ...details, resource: { ...details.resource, factoryId: "different" } }))).toBe("API_FACTORY_ID");
    const approval = responses()[9] as Extract<FactoryApiResponse, { kind: "approval.resource" }>;
    expect(code(validateFactoryApiResponse({ ...approval, resource: { ...approval.resource, status: "approved" } }))).toBe("API_APPROVAL_RESOURCE");
    const approvalPage = responses()[10] as Extract<FactoryApiResponse, { kind: "approval.page" }>;
    expect(code(validateFactoryApiResponse({ ...approvalPage, page: { items: [{ ...approvalPage.page.items[0]!, contextDigest: "b".repeat(64), status: "denied" }] } }))).toBe("API_APPROVAL_RESOURCE");
    const version = responses()[5] as Extract<FactoryApiResponse, { kind: "version.summary" }>;
    expect(code(validateFactoryApiResponse({ ...version, resource: { ...version.resource, compiledBlobDigest: "b".repeat(63) } }))).toBe("API_RESPONSE_SCHEMA");
    const versionPage = responses()[6] as Extract<FactoryApiResponse, { kind: "version.page" }>;
    expect(code(validateFactoryApiResponse({ ...versionPage, page: { items: [{ ...versionPage.page.items[0]!, compiledBlobDigest: "A".repeat(64) }] } }))).toBe("API_VERSION_DIGEST");
    const runDetails = responses()[7] as Extract<FactoryApiResponse, { kind: "run.details" }>;
    expect(code(validateFactoryApiResponse({ ...runDetails, resource: { ...runDetails.resource, definitionDigest: `sha256:${"A".repeat(64)}` } }))).toBe("API_RUN_DIGEST");
    expect(code(validateFactoryApiResponse({ ...runDetails, resource: { ...runDetails.resource, parameters: { value: { kind: "inline", value: "x".repeat(FACTORY_LIMITS.maxInlineValueBytes + 1) } } } }))).toBe("API_PARAMETER_BYTES");
    expect(code(validateFactoryApiResponse({ ...runDetails, resource: { ...runDetails.resource, output: { kind: "artifact", artifact: { artifactId: "../output", digest: `sha256:${sourceDigest}`, encodedBytes: 1 } } } }))).toBe("RUNNER_ARTIFACT_ID");
    const runPage = responses()[8] as Extract<FactoryApiResponse, { kind: "run.page" }>;
    expect(code(validateFactoryApiResponse({ ...runPage, page: { items: [{ ...runPage.page.items[0]!, definitionDigest: `sha256:${"A".repeat(64)}` }] } }))).toBe("API_RUN_DIGEST");
    const grant = responses()[11] as Extract<FactoryApiResponse, { kind: "grant.resource" }>;
    expect(code(validateFactoryApiResponse({ ...grant, resource: { ...grant.resource, principalKind: "service", expiresAtMs: null } }))).toBe("API_GRANT_EXPIRY");
    const grantPage = responses()[12] as Extract<FactoryApiResponse, { kind: "grant.page" }>;
    expect(code(validateFactoryApiResponse({ ...grantPage, page: { items: [{ ...grantPage.page.items[0]!, principalKind: "service", expiresAtMs: null }] } }))).toBe("API_GRANT_EXPIRY");
    const receipt = responses()[13] as Extract<FactoryApiResponse, { kind: "mutation.accepted" }>;
    expect(code(validateFactoryApiResponse({ ...receipt, receipt: { ...receipt.receipt, statusUrl: "/wrong/run-1" } }))).toBe("API_RECEIPT");
    const error = responses()[14] as Extract<FactoryApiResponse, { kind: "error" }>;
    expect(code(validateFactoryApiResponse({ ...error, error: { ...error.error, code: "bad\ncode" } }))).toBe("API_ERROR");
    const draftPage = responses()[2] as Extract<FactoryApiResponse, { kind: "draft.page" }>;
    expect(code(validateFactoryApiResponse({ ...draftPage, page: { items: Array(201).fill(draftSummary()) } }))).toBe("API_RESPONSE_SCHEMA");
    expect(code(validateFactoryApiResponse({ schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "draft.export", format: "yaml", source: "界".repeat(5_600_000) }))).toBe("API_RESPONSE_BYTES");
  });
});
