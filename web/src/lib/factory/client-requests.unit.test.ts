import { describe, expect, test, vi } from "vitest";
import type { FactoryApiResponse } from "@ezcorp/factory-sdk";
import { FactoryApiClient, FactoryApiClientError, blankFactory } from "./client";

/**
 * Every client method, pinned to the exact request it sends: method, encoded
 * path, the complete header set (the idempotency key names its operation),
 * and the exact body. A request the server would read differently is a test
 * failure here, not a surprise in the console.
 */

const digest = "a".repeat(64);
const source = blankFactory("factory one");
const envelope = (value: Record<string, unknown>) => ({ schemaVersion: "factory.api.response.v1", ...value }) as FactoryApiResponse;
const summary = { factoryId: source.id, revision: 1, archived: false, availability: "available", sourceDigest: digest, updatedAtMs: 1 };
const version = { factoryId: source.id, version: source.version, draftRevision: 1, definitionDigest: "sha256:" + digest, compiledBlobDigest: digest, compiledBytes: 1, publishedAtMs: 2 };
const credential = { serviceAccountId: "service one", credentialId: "credential/one", scopes: ["read"], revision: 1, issuedAtMs: 1_000, expiresAtMs: 61_000, revoked: false };
const packageLock = { package: "@ezcorp/release", manifestName: "release", version: "1.0.0", digest: "sha256:" + digest, export: "release" };
const trust = { revision: 1, state: "active", packageLock, packageTrustDigest: "sha256:" + digest, validatorTrustDigest: "sha256:" + digest, approvedBy: "admin-1", approvalGrantRevision: 1 };
const releaseBody = { runId: "run-1", nodeInstanceId: "node-1", candidateGeneration: 0, decisionId: "decision-1", candidateDigest: "sha256:" + digest, action: "publish", destination: { provider: "s3", account: "tenant-1", object: "release.json" }, request: { contentType: "application/json" }, estimatedSpendMicros: 1, deadlineMs: 2_000_000_000_000 };
const operation = { ...releaseBody, operationId: "operation/one", contractDigest: "sha256:" + digest, executionEpoch: 1, cancellationEpoch: 0, releaseEnableEpoch: 1, destinationDigest: "sha256:" + digest, requestDigest: "sha256:" + digest, state: "pending", dispatchGeneration: 0, dispatchStarted: false, archiveReady: true };
delete (operation as { request?: unknown }).request;
const contract = { contractId: "contract/one", revision: 1, contractDigest: "sha256:" + digest, validatorLockDigest: "sha256:" + digest, mandatoryClaims: [], claimGroups: [] };
const approval = { approvalId: "approval/one", operationId: "operation/one", contextDigest: digest, status: "pending", expiresAtMs: releaseBody.deadlineMs };
const commandApproval = { approvalId: "command/one", runId: "run/one", commandId: "command/one", nodeInstanceId: "review", revision: 1, contextDigest: digest, status: "answered", choices: ["ship", "hold"], context: {}, actorScope: "operator", expiresAtMs: releaseBody.deadlineMs, choice: "ship", decidedBy: "user-1", decidedAtMs: 1 };
const policy = { policyId: "policy/one", revision: 1, revoked: false, principalKind: "service", principalId: "service-1", action: "publish", destinationProvider: "s3", destinationAccount: "tenant-1", destinationPrefix: "releases/", contractDigest: "sha256:" + digest, maxOperations: 1, maxSpendMicros: 1, expiresAtMs: releaseBody.deadlineMs };
const run = { runId: "run/one", factoryId: source.id, factoryVersion: source.version, definitionDigest: "sha256:" + digest, grantRevision: 1, revision: 4, status: "waiting", createdAtMs: 1, updatedAtMs: 2 };
const reference = { package: "@ezcorp/runner", manifestName: "runner", version: "1.0.0", digest: "sha256:" + digest, export: "run" };
const packageResource = { referenceId: "b".repeat(64), reference, revision: 2, state: "active", installationId: "installation/one", releaseId: "release/one", boundAtMs: 1 };
const inspection = {
	run: { ...run, parameters: {} }, cursor: { token: "cursor/one", sequence: 3, expiresAtMs: 9 }, projectionLag: 1,
	children: { items: [] }, attempts: { items: [] }, artifacts: { items: [] }, blockers: [], acceptance: [], releases: [],
	costs: { limitMicros: "0", allocatedMicros: "0", spentMicros: "0", knownCostMicros: "0", unknownCostMicros: "0", admissionBlocked: false, uncertain: false },
};
const ticket = { url: "/download?ticket=t", expiresAtMs: 9, mediaType: "application/octet-stream", encodedBytes: 4 };
const share = { sourceProjectId: "project/one", sourceRunId: "run/one", artifactId: "artifact/one", targetProjectId: "project/two", digest: "sha256:" + digest, encodedBytes: 4, mediaType: "text/plain", revoked: false };
const affected = { runId: "run/one", attemptId: "attempt/one", attemptStatus: "admitted", launchState: null, trustRevision: 3, state: "revoked", reason: "factory_package_revoked", disposition: "run-terminal", recordedAtMs: 9 };
const grant = { principalKind: "user", principalId: "member/one", action: "factory.run", revision: 2, expiresAtMs: null, revoked: false, displayName: "Member One" };
const preview = { tenantId: "tenant/one", ready: true, preconditions: [], auditRowsLost: 0 };
const restore = { restoreId: "restore/1", mode: "tenant", state: "awaiting_signature", checkpointId: "c", previousEpoch: 1, executionEpoch: 2, startedAtMs: 1, reportDigest: `sha256:${"4".repeat(64)}` };
const signature = { restoreId: "restore/1", enabled: true, rebound: 2, blockedRuns: [] };
const material = { factoryId: "f.v1", factoryVersion: "1.0.0", definitionDigest: `sha256:${"1".repeat(64)}`, contractId: "contract", contractVersion: "1", contractDigest: `sha256:${"2".repeat(64)}`, validatorLockDigest: `sha256:${"3".repeat(64)}`, mandatoryClaims: [{ id: "tests", validatorId: "v", freshnessMs: 60000 }], claimGroups: [] };

interface Recorded { readonly method: string; readonly path: string; readonly headers: Record<string, string> | undefined; readonly body: string | undefined }

function client(reply: FactoryApiResponse) {
	const calls: Recorded[] = [];
	const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ method: init?.method ?? "GET", path: String(input), headers: init?.headers as Record<string, string> | undefined, body: init?.body as string | undefined });
		return Response.json(reply);
	});
	return { calls, api: new FactoryApiClient({ fetch: fetcher as unknown as typeof fetch, idempotencyKey: name => "key:" + name }) };
}

const mutation = (revision: number, key: string, body?: unknown) => ({
	headers: { "If-Match": String(revision), "Idempotency-Key": "key:" + key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
	body: body === undefined ? undefined : JSON.stringify(body),
});

const P = "/api/factories/projects/project%2Fone";

describe("every client request is exact", () => {
	const cases: Array<{ name: string; reply: FactoryApiResponse; call: (api: FactoryApiClient) => Promise<unknown>; expect: Recorded; result?: unknown }> = [
		{ name: "createDraft", reply: envelope({ kind: "draft.summary", resource: summary }), call: api => api.createDraft("project/one", source), expect: { method: "POST", path: `${P}/definitions`, ...mutation(0, "create:factory one", { source }) } },
		{ name: "importDraft", reply: envelope({ kind: "draft.summary", resource: summary }), call: api => api.importDraft("project/one", "yaml", "id: x"), expect: { method: "POST", path: `${P}/definitions/import`, ...mutation(0, "import", { format: "yaml", source: "id: x" }) } },
		{ name: "saveDraft", reply: envelope({ kind: "draft.summary", resource: summary }), call: api => api.saveDraft("project/one", "factory one", 3, source), expect: { method: "PUT", path: `${P}/definitions/factory%20one`, ...mutation(3, "save:factory one", { source }) } },
		{ name: "archiveDraft", reply: envelope({ kind: "draft.summary", resource: summary }), call: api => api.archiveDraft("project/one", "factory one", 4), expect: { method: "DELETE", path: `${P}/definitions/factory%20one`, ...mutation(4, "archive:factory one") } },
		{ name: "validateDraft", reply: envelope({ kind: "draft.validation", valid: true, diagnostics: [] }), call: api => api.validateDraft("project/one", "factory one", source), expect: { method: "POST", path: `${P}/definitions/factory%20one/validate`, headers: { "content-type": "application/json" }, body: JSON.stringify({ source }) } },
		{ name: "publishVersion", reply: envelope({ kind: "version.summary", resource: version }), call: api => api.publishVersion("project/one", "factory one", 5, "1.2.3"), expect: { method: "POST", path: `${P}/definitions/factory%20one/versions`, ...mutation(5, "publish:factory one:1.2.3", { version: "1.2.3" }) } },
		{ name: "issueServiceCredential", reply: envelope({ kind: "service-credential.issued", resource: credential, token: "ezkfsvc_aaa.bbb.ccc" }), call: api => api.issueServiceCredential("project/one", "service one", ["read"], 61_000), expect: { method: "POST", path: `${P}/service-accounts/service%20one/credentials`, ...mutation(0, "issue-credential:service one", { scopes: ["read"], expiresAtMs: 61_000 }) } },
		{ name: "revokeServiceCredential", reply: envelope({ kind: "service-credential.resource", resource: credential }), call: api => api.revokeServiceCredential("project/one", "service one", "credential/one", 2), expect: { method: "DELETE", path: `${P}/service-accounts/service%20one/credentials/credential%2Fone`, ...mutation(2, "revoke-credential:credential/one") } },
		{ name: "publishReleaseTrust", reply: envelope({ kind: "release.trust.resource", resource: trust }), call: api => api.publishReleaseTrust("project/one", 0, packageLock as never, "sha256:" + digest), expect: { method: "PUT", path: `${P}/release/trust`, ...mutation(0, "publish-release-trust:project/one", { packageLock, validatorTrustDigest: "sha256:" + digest }) } },
		{ name: "revokeReleaseTrust", reply: envelope({ kind: "release.trust.resource", resource: trust }), call: api => api.revokeReleaseTrust("project/one", 1), expect: { method: "DELETE", path: `${P}/release/trust`, ...mutation(1, "revoke-release-trust:project/one") } },
		{ name: "setReleaseEnabled", reply: envelope({ kind: "release.control.resource", resource: { enabled: true, enableEpoch: 1 } }), call: api => api.setReleaseEnabled("project/one", true, 6), expect: { method: "PUT", path: `${P}/release/control`, ...mutation(6, "set-release-enabled:project/one", { enabled: true }) } },
		{ name: "putReleaseContract", reply: envelope({ kind: "release.contract.resource", resource: contract }), call: api => api.putReleaseContract("project/one", "contract/one", { contractDigest: contract.contractDigest, validatorLockDigest: contract.validatorLockDigest, mandatoryClaims: [], claimGroups: [] } as never, 7), expect: { method: "PUT", path: `${P}/release/contracts/contract%2Fone`, ...mutation(7, "put-release-contract:contract/one", { contractDigest: contract.contractDigest, validatorLockDigest: contract.validatorLockDigest, mandatoryClaims: [], claimGroups: [] }) } },
		{ name: "prepareRelease", reply: envelope({ kind: "release.operation.resource", resource: operation }), call: api => api.prepareRelease("project/one", releaseBody as never), expect: { method: "POST", path: `${P}/releases`, ...mutation(0, "prepare-release:run-1:node-1", releaseBody) } },
		{ name: "requestReleaseApproval", reply: envelope({ kind: "release.approval.resource", resource: approval }), call: api => api.requestReleaseApproval("project/one", "operation/one", 99, 2), expect: { method: "POST", path: `${P}/releases/operation%2Fone/approvals`, ...mutation(2, "request-release-approval:operation/one", { expiresAtMs: 99 }) } },
		{ name: "decideReleaseApproval", reply: envelope({ kind: "release.approval.resource", resource: approval }), call: api => api.decideReleaseApproval("project/one", "approval/one", digest, "denied"), expect: { method: "PUT", path: `${P}/release/approvals/approval%2Fone`, ...mutation(0, "decide-release-approval:approval/one", { contextDigest: digest, decision: "denied" }) } },
		{ name: "decideCommandApproval", reply: envelope({ kind: "approval.resource", resource: commandApproval }), call: api => api.decideCommandApproval("project/one", "run/one", "command/one", digest, "hold"), expect: { method: "PUT", path: `${P}/runs/run%2Fone/approvals/command%2Fone`, ...mutation(0, "decide-command-approval:command/one", { contextDigest: digest, choice: "hold" }) } },
		{ name: "putReleasePolicy", reply: envelope({ kind: "release.policy.resource", resource: policy }), call: api => api.putReleasePolicy("project/one", "policy/one", policy as never), expect: { method: "PUT", path: `${P}/release/policies/policy%2Fone`, ...mutation(0, "put-release-policy:policy/one", policy) } },
		{ name: "deleteReleasePolicy", reply: envelope({ kind: "release.policy.resource", resource: policy }), call: api => api.deleteReleasePolicy("project/one", "policy/one", 3), expect: { method: "DELETE", path: `${P}/release/policies/policy%2Fone`, ...mutation(3, "delete-release-policy:policy/one") } },
		{ name: "reconcileRelease", reply: envelope({ kind: "release.operation.resource", resource: operation }), call: api => api.reconcileRelease("project/one", "operation/one", 4, { action: "keep_uncertain", reason: "r", providerEvidence: {} } as never), expect: { method: "POST", path: `${P}/releases/operation%2Fone/reconciliations`, ...mutation(4, "reconcile-release:operation/one:4", { action: "keep_uncertain", reason: "r", providerEvidence: {} }) } },
		{ name: "startRun", reply: envelope({ kind: "mutation.accepted", receipt: { resourceId: "run/one", commandId: "start/one", statusUrl: "/api/factories/projects/project%2Fone/runs/run%2Fone/commands/start%2Fone" } }), call: api => api.startRun("project/one", "factory one", { factoryVersion: "1.0.0", definitionDigest: "sha256:" + digest, grantRevision: 3, parameters: {} }), expect: { method: "POST", path: `${P}/definitions/factory%20one/runs`, ...mutation(0, "start-run:factory one:1.0.0", { factoryVersion: "1.0.0", definitionDigest: "sha256:" + digest, grantRevision: 3, parameters: {} }) }, result: { resourceId: "run/one", commandId: "start/one", statusUrl: "/api/factories/projects/project%2Fone/runs/run%2Fone/commands/start%2Fone" } },
		{ name: "inspectRun", reply: envelope({ kind: "run.inspection", resource: inspection }), call: api => api.inspectRun("project/one", "run/one", "node a"), expect: { method: "GET", path: `${P}/runs/run%2Fone/inspection?search=node+a`, headers: undefined, body: undefined }, result: inspection },
		{ name: "inspectRun without a filter", reply: envelope({ kind: "run.inspection", resource: inspection }), call: api => api.inspectRun("project/one", "run/one"), expect: { method: "GET", path: `${P}/runs/run%2Fone/inspection`, headers: undefined, body: undefined } },
		{ name: "inspectRunSection", reply: envelope({ kind: "run.inspection.page", resource: { section: "attempts", page: { items: [] } } }), call: api => api.inspectRunSection("project/one", "run/one", { section: "attempts", cursor: "c/1", limit: 5, search: "n" }), expect: { method: "GET", path: `${P}/runs/run%2Fone/inspection?section=attempts&cursor=c%2F1&limit=5&search=n`, headers: undefined, body: undefined }, result: { section: "attempts", page: { items: [] } } },
		{ name: "artifactTicket", reply: envelope({ kind: "artifact.ticket", ticket }), call: api => api.artifactTicket("project/one", "run/one", "artifact/one"), expect: { method: "POST", path: `${P}/runs/run%2Fone/artifacts/artifact%2Fone/ticket`, headers: undefined, body: undefined }, result: ticket },
		{ name: "shareArtifact", reply: envelope({ kind: "artifact.share.resource", resource: share }), call: api => api.shareArtifact("project/one", "run/one", "artifact/one", "project/two", "text/plain"), expect: { method: "POST", path: `${P}/runs/run%2Fone/artifacts/artifact%2Fone/shares`, ...mutation(0, "share-artifact:artifact/one:project/two", { targetProjectId: "project/two", mediaType: "text/plain" }) }, result: share },
		{ name: "listPackages", reply: envelope({ kind: "package.page", page: { items: [packageResource], nextCursor: "next/1" } }), call: api => api.listPackages("project/one", { limit: 7, cursor: "c", search: "run" }), expect: { method: "GET", path: `${P}/packages?limit=7&cursor=c&search=run`, headers: undefined, body: undefined }, result: { items: [packageResource], nextCursor: "next/1" } },
		{ name: "listPackages without a next page", reply: envelope({ kind: "package.page", page: { items: [] } }), call: api => api.listPackages("project/one"), expect: { method: "GET", path: `${P}/packages`, headers: undefined, body: undefined }, result: { items: [], nextCursor: null } },
		{ name: "installPackage", reply: envelope({ kind: "package.resource", resource: packageResource }), call: api => api.installPackage("project/one", { reference, installationId: "i", releaseId: "r" }), expect: { method: "POST", path: `${P}/packages`, ...mutation(0, `install-package:sha256:${digest}:run`, { reference, installationId: "i", releaseId: "r" }) }, result: packageResource },
		{ name: "packageImpact", reply: envelope({ kind: "package.impact", resource: { transition: "revoke", currentRevision: 2, allowed: true, runs: [], truncated: false } }), call: api => api.packageImpact("project/one", "ref/one", "revoke"), expect: { method: "GET", path: `${P}/packages/ref%2Fone/impact?transition=revoke`, headers: undefined, body: undefined } },
		{ name: "packageAffectedRuns", reply: envelope({ kind: "package.affected-runs", page: { items: [affected], nextCursor: "a/2" } }), call: api => api.packageAffectedRuns("project/one", "ref/one", { trustRevision: 3, limit: 9, cursor: "a/1" }), expect: { method: "GET", path: `${P}/packages/ref%2Fone/affected-runs?trustRevision=3&limit=9&cursor=a%2F1`, headers: undefined, body: undefined }, result: { items: [affected], nextCursor: "a/2" } },
		{ name: "packageAffectedRuns without a next page", reply: envelope({ kind: "package.affected-runs", page: { items: [] } }), call: api => api.packageAffectedRuns("project/one", "ref/one"), expect: { method: "GET", path: `${P}/packages/ref%2Fone/affected-runs`, headers: undefined, body: undefined }, result: { items: [], nextCursor: null } },
		{ name: "transitionPackage", reply: envelope({ kind: "package.resource", resource: packageResource }), call: api => api.transitionPackage("project/one", "ref/one", "quarantine", 2), expect: { method: "POST", path: `${P}/packages/ref%2Fone/trust`, ...mutation(2, "package-quarantine:ref/one:2", { transition: "quarantine" }) } },
		{ name: "listGrants", reply: envelope({ kind: "grant.page", page: { items: [grant], nextCursor: "g/2" } }), call: api => api.listGrants("project/one", { limit: 9, cursor: "g/1", principalKind: "user", action: "factory.run" }), expect: { method: "GET", path: `${P}/grants?limit=9&cursor=g%2F1&principalKind=user&action=factory.run`, headers: undefined, body: undefined }, result: { items: [grant], nextCursor: "g/2" } },
		{ name: "listGrants without a next page", reply: envelope({ kind: "grant.page", page: { items: [] } }), call: api => api.listGrants("project/one"), expect: { method: "GET", path: `${P}/grants`, headers: undefined, body: undefined }, result: { items: [], nextCursor: null } },
		{ name: "setGrant", reply: envelope({ kind: "grant.resource", resource: grant }), call: api => api.setGrant("project/one", "user", "member/one", "factory.run", 1, 55), expect: { method: "PUT", path: `${P}/grants/user/member%2Fone/factory.run`, ...mutation(1, "set-grant:user:member/one:factory.run:1", { expiresAtMs: 55 }) }, result: grant },
		{ name: "revokeGrant", reply: envelope({ kind: "grant.resource", resource: { ...grant, revoked: true } }), call: api => api.revokeGrant("project/one", "service", "svc/one", "factory.operate", 3), expect: { method: "DELETE", path: `${P}/grants/service/svc%2Fone/factory.operate`, ...mutation(3, "revoke-grant:service:svc/one:factory.operate:3") } },
		{ name: "validatorMaterial by version", reply: envelope({ kind: "validator.material", resource: material }), call: api => api.validatorMaterial("project/one", { factoryId: "f.v1", factoryVersion: "1.0.0" }), expect: { method: "GET", path: "/api/factories/projects/project%2Fone/validator-materials?factoryId=f.v1&factoryVersion=1.0.0", headers: undefined, body: undefined }, result: material },
		{ name: "validatorMaterial by lock", reply: envelope({ kind: "validator.material", resource: material }), call: api => api.validatorMaterial("p", { validatorLockDigest: material.validatorLockDigest }), expect: { method: "GET", path: `/api/factories/projects/p/validator-materials?validatorLockDigest=${encodeURIComponent(material.validatorLockDigest)}`, headers: undefined, body: undefined }, result: material },
		{ name: "listRestores", reply: envelope({ kind: "restore.page", page: { items: [restore] } }), call: api => api.listRestores("tenant/one"), expect: { method: "GET", path: "/api/factories/tenants/tenant%2Fone/restores", headers: undefined, body: undefined }, result: [restore] },
		{ name: "signRestore", reply: envelope({ kind: "restore.signature", resource: signature }), call: api => api.signRestore("tenant/one", "restore/1", restore.reportDigest), expect: { method: "POST", path: "/api/factories/tenants/tenant%2Fone/restores/restore%2F1/signatures", ...mutation(0, "sign-restore:restore/1", { reportDigest: restore.reportDigest }) }, result: signature },
		{ name: "purgePreview", reply: envelope({ kind: "purge.preview", resource: preview }), call: api => api.purgePreview("tenant/one"), expect: { method: "GET", path: "/api/factories/tenants/tenant%2Fone/purge-preview", headers: undefined, body: undefined }, result: preview },
		{ name: "requestPurge", reply: envelope({ kind: "purge.request.resource", resource: { ...preview, requestId: "purge-1", state: "queued", requestedBy: "u", requestedAtMs: 1 } }), call: api => api.requestPurge("tenant/one", "closing", "tenant/one"), expect: { method: "POST", path: "/api/factories/tenants/tenant%2Fone/purge-requests", ...mutation(0, "purge:tenant/one", { reason: "closing", confirmTenantId: "tenant/one" }) } },
	];

	for (const item of cases) {
		test(item.name, async () => {
			const { calls, api } = client(item.reply);
			const result = await item.call(api);
			expect(calls).toEqual([item.expect]);
			if (item.result !== undefined) expect(result).toEqual(item.result);
		});
	}
});

describe("responses the client refuses, by exact message", () => {
	const read = (response: Response) => new FactoryApiClient({ fetch: vi.fn(async () => response) as unknown as typeof fetch }).getDraft("p", "f").then(() => { throw new Error("expected a refusal"); }, error => error as FactoryApiClientError);

	test("each refusal names what went wrong", async () => {
		expect(await read(new Response("not json", { status: 200 }))).toMatchObject({ status: 200, code: "factory_invalid_response", message: "The factory service returned invalid JSON." });
		expect(await read(Response.json({ kind: "draft.page" }, { status: 201 }))).toMatchObject({ status: 201, code: "factory_invalid_response", message: "Value does not match the generated FactoryApiResponse schema." });
		expect(await read(Response.json(envelope({ kind: "draft.page", page: { items: [] } }), { status: 503 }))).toMatchObject({ status: 503, code: "factory_http_error", message: "The factory request failed." });
		expect(await read(Response.json(envelope({ kind: "draft.page", page: { items: [] } })))).toMatchObject({ status: 502, code: "factory_response_kind", message: "The factory service returned draft.page instead of draft.details." });
	});
});

describe("streams and bytes", () => {
	test("the event stream opens with an SSE accept header and returns the body", async () => {
		const body = new ReadableStream<Uint8Array>();
		const signal = new AbortController().signal;
		const fetcher = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
		const api = new FactoryApiClient({ fetch: fetcher as unknown as typeof fetch });
		expect(await api.openRunEvents("project/one", "run/one", "cursor/one", signal)).toBe(body);
		expect(fetcher).toHaveBeenCalledWith(`${P}/runs/run%2Fone/events?cursor=cursor%2Fone`, { headers: { accept: "text/event-stream" }, signal });
	});

	test("a refused stream surfaces its status and code; an empty body is its own error", async () => {
		const refusal = Response.json(envelope({ kind: "error", error: { code: "factory_cursor_expired", message: "Take a new snapshot.", retryable: false } }), { status: 410 });
		const expired = await new FactoryApiClient({ fetch: vi.fn(async () => refusal) as unknown as typeof fetch }).openRunEvents("p", "r", "c", new AbortController().signal).catch(error => error as FactoryApiClientError);
		expect(expired).toMatchObject({ status: 410, code: "factory_cursor_expired" });
		const empty = await new FactoryApiClient({ fetch: vi.fn(async () => Response.json(envelope({ kind: "draft.page", page: { items: [] } }))) as unknown as typeof fetch })
			.openRunEvents("p", "r", "c", new AbortController().signal).catch(error => error as FactoryApiClientError);
		expect(empty).toMatchObject({ status: 200, code: "factory_stream_unavailable", message: "The run event stream did not open." });
		const noBody = new Response(null, { status: 200 });
		const bodiless = await new FactoryApiClient({ fetch: vi.fn(async () => noBody) as unknown as typeof fetch }).openRunEvents("p", "r", "c", new AbortController().signal).catch(error => error as FactoryApiClientError);
		expect(bodiless).toMatchObject({ code: "factory_invalid_response" });
	});

	test("only a successful, bodied response that is an event stream opens the stream", async () => {
		const open = (reply: Response) =>
			new FactoryApiClient({ fetch: vi.fn(async () => reply) as unknown as typeof fetch }).openRunEvents("p", "r", "c", new AbortController().signal);
		const body = new ReadableStream<Uint8Array>();
		// A parameterised media type is still an event stream.
		expect(await open(new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }))).toBe(body);
		// A failure is a failure even when it claims to be a stream.
		await expect(open(new Response("gateway down", { status: 502, headers: { "content-type": "text/event-stream" } })))
			.rejects.toMatchObject({ status: 502, code: "factory_invalid_response" });
		// A success with no body cannot be read as a stream.
		await expect(open(new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } })))
			.rejects.toMatchObject({ status: 200, code: "factory_invalid_response" });
		// No content type at all is a client error, not a crash.
		await expect(open(new Response(new Uint8Array([1]), { status: 200 }))).rejects.toBeInstanceOf(FactoryApiClientError);
	});

	test("artifact bytes are bounded before and after the download", async () => {
		const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])));
		const api = new FactoryApiClient({ fetch: fetcher as unknown as typeof fetch });
		expect(await api.artifactBytes(ticket, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(fetcher).toHaveBeenCalledWith("/download?ticket=t");
		await expect(api.artifactBytes({ ...ticket, encodedBytes: 5 }, 4)).rejects.toMatchObject({ status: 413, code: "factory_artifact_too_large", message: "The artifact is larger than the preview limit." });
		expect(fetcher).toHaveBeenCalledTimes(1);
		// The ticket understated the size: the bytes that arrived are checked too, with the same answer.
		await expect(api.artifactBytes({ ...ticket, encodedBytes: 3 }, 3)).rejects.toMatchObject({ status: 413, code: "factory_artifact_too_large", message: "The artifact is larger than the preview limit." });
		const refused = new FactoryApiClient({ fetch: vi.fn(async () => Response.json(envelope({ kind: "error", error: { code: "factory_ticket_expired", message: "expired", retryable: false } }), { status: 410 })) as unknown as typeof fetch });
		await expect(refused.artifactBytes(ticket, 10)).rejects.toMatchObject({ status: 410, code: "factory_ticket_expired" });
	});
});
