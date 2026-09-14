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
const credential = { serviceAccountId: "service one", credentialId: "credential/one", scopes: ["read"] as const, revision: 1, issuedAtMs: 1_000, expiresAtMs: 61_000, revoked: false };
const packageLock = { package: "@ezcorp/release", manifestName: "release", version: "1.0.0", digest: "sha256:" + digest, export: "release" } as const;
const trust = { revision: 1, state: "active" as const, packageLock, packageTrustDigest: "sha256:" + compiledDigest, validatorTrustDigest: "sha256:" + digest, approvedBy: "admin-1", approvalGrantRevision: 1 };
const control = { enabled: true, enableEpoch: 1 };
const releaseBody = { runId: "run-1", nodeInstanceId: "node-1", candidateGeneration: 0, decisionId: "decision-1", candidateDigest: "sha256:" + digest, action: "publish", destination: { provider: "s3", account: "tenant-1", object: "release.json" }, request: { contentType: "application/json" }, estimatedSpendMicros: 1, deadlineMs: 2_000_000_000_000 } as const;
const releaseOperation = { operationId: "operation/one", runId: releaseBody.runId, nodeInstanceId: releaseBody.nodeInstanceId, candidateGeneration: releaseBody.candidateGeneration, decisionId: releaseBody.decisionId, candidateDigest: releaseBody.candidateDigest, action: releaseBody.action, destination: releaseBody.destination, estimatedSpendMicros: releaseBody.estimatedSpendMicros, deadlineMs: releaseBody.deadlineMs, contractDigest: "sha256:" + compiledDigest, executionEpoch: 1, cancellationEpoch: 0, releaseEnableEpoch: 1, destinationDigest: "sha256:" + digest, requestDigest: "sha256:" + compiledDigest, state: "pending" as const, dispatchGeneration: 0, dispatchStarted: false, archiveReady: true };
const releaseContract = { contractId: "contract/one", revision: 1, contractDigest: "sha256:" + digest, validatorLockDigest: "sha256:" + compiledDigest, mandatoryClaims: [], claimGroups: [] };
const releaseApproval = { approvalId: "approval/one", operationId: releaseOperation.operationId, contextDigest: digest, status: "pending" as const, expiresAtMs: releaseBody.deadlineMs };
const commandApproval = { approvalId: "command/one", runId: "run/one", commandId: "command/one", nodeInstanceId: "review", revision: 1 as const, contextDigest: digest, status: "answered" as const, choices: ["ship", "hold"], context: { subject: "candidate" }, actorScope: "operator" as const, expiresAtMs: releaseBody.deadlineMs, choice: "ship", decidedBy: "user-1", decidedAtMs: 1 };
const releaseNotification = { notificationId: "notification/one", operationId: releaseOperation.operationId, createdAtMs: 1, kind: "approval_requested" as const, approvalId: releaseApproval.approvalId, contextDigest: digest, expiresAtMs: releaseBody.deadlineMs };
const releasePolicy = { policyId: "policy/one", revision: 1 as const, revoked: false as const, principalKind: "service" as const, principalId: "service-1", action: "publish", destinationProvider: "s3", destinationAccount: "tenant-1", destinationPrefix: "releases/", contractDigest: "sha256:" + digest, maxOperations: 1, maxSpendMicros: 1, expiresAtMs: releaseBody.deadlineMs };
const controlReceipt = { resourceId: "run/one", commandId: "repair/one", statusUrl: "/api/factories/projects/project%2Fone/runs/run%2Fone/commands/repair%2Fone" };
const runSummary = { runId: "run/one", factoryId: source.id, factoryVersion: source.version, definitionDigest: "sha256:" + digest, grantRevision: 1, revision: 4, status: "waiting" as const, createdAtMs: 1, updatedAtMs: 2 };

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
		case "service-credential.issued":
			return { schemaVersion: "factory.api.response.v1", kind, resource: credential, token: "ezkfsvc_aaa.bbb.ccc" };
		case "service-credential.resource":
			return { schemaVersion: "factory.api.response.v1", kind, resource: { ...credential, revision: 2, revoked: true } };
		case "release.trust.resource":
			return { schemaVersion: "factory.api.response.v1", kind, resource: trust };
		case "release.control.resource":
			return { schemaVersion: "factory.api.response.v1", kind, resource: control };
		case "release.contract.resource":
			return { schemaVersion: "factory.api.response.v1", kind, resource: releaseContract };
		case "release.operation.resource":
			return { schemaVersion: "factory.api.response.v1", kind, resource: releaseOperation };
		case "release.approval.resource":
			return { schemaVersion: "factory.api.response.v1", kind, resource: releaseApproval };
		case "approval.resource":
			return { schemaVersion: "factory.api.response.v1", kind, resource: commandApproval };
		case "release.notification.page":
			return { schemaVersion: "factory.api.response.v1", kind, page: { items: [releaseNotification], nextCursor: "notification/next" } };
		case "release.policy.resource":
			return { schemaVersion: "factory.api.response.v1", kind, resource: releasePolicy };
		case "run.page":
			return { schemaVersion: "factory.api.response.v1", kind, page: { items: [runSummary], nextCursor: "run/next" } };
		case "run.details":
			return { schemaVersion: "factory.api.response.v1", kind, resource: { ...runSummary, parameters: {} } };
		case "mutation.accepted":
			return { schemaVersion: "factory.api.response.v1", kind, receipt: controlReceipt };
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
			if (path.includes("/release/contracts/")) return api(response("release.contract.resource"));
			if (path.includes("/release/notifications")) return api(response("release.notification.page"));
			if (path.includes("/release/approvals/")) return api(response("release.approval.resource"));
			if (path.includes("/runs/") && path.includes("/approvals/")) return api(response("approval.resource"));
			if (path.endsWith("/control") && path.includes("/runs/")) return api(response("mutation.accepted"));
			if (path.includes("/runs/")) return api(response("run.details"));
			if (path.includes("/runs")) return api(response("run.page"));
			if (path.includes("/release/policies/")) return api(response("release.policy.resource"));
			if (path.endsWith("/approvals")) return api(response("release.approval.resource"));
			if (path.endsWith("/reconciliations")) return api(response("release.operation.resource"));
			if (path.includes("/releases")) return api(response("release.operation.resource"));
			if (path.endsWith("/release/trust")) return api(response("release.trust.resource"));
			if (path.endsWith("/release/control")) return api(response("release.control.resource"));
			if (path.includes("/service-accounts/") && init?.method === "DELETE") return api(response("service-credential.resource"));
			if (path.includes("/service-accounts/")) return api(response("service-credential.issued"));
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

	test("reads the runs a control needs before it can name a revision", async () => {
		const client = new FactoryApiClient({ fetch: fetcher as unknown as typeof fetch, idempotencyKey: operation => "key:" + operation });
		expect(await client.listRuns("project/one")).toEqual({ items: [runSummary], nextCursor: "run/next" });
		expect(calls[0]!.path).toBe("/api/factories/projects/project%2Fone/runs");
		expect(await client.listRuns("project/one", { limit: 5, cursor: "run/next", status: "waiting", factoryId: "factory one" })).toEqual({ items: [runSummary], nextCursor: "run/next" });
		expect(calls[1]!.path).toBe("/api/factories/projects/project%2Fone/runs?limit=5&cursor=run%2Fnext&status=waiting&factoryId=factory+one");
		expect(await client.getRun("project/one", "run/one")).toEqual({ ...runSummary, parameters: {} });
		expect(calls[2]!.path).toBe("/api/factories/projects/project%2Fone/runs/run%2Fone");
		expect(calls[2]!.init).toBeUndefined();
	});

	test("routes an exact replan through the run control receipt", async () => {
		const client = new FactoryApiClient({ fetch: fetcher as unknown as typeof fetch, idempotencyKey: operation => "key:" + operation });
		const body = { action: "replan", nodeId: "child", reason: "Pin the corrected child", parameters: {}, replacement: { id: "reference.code.v1", version: "1.1.0", digest: "sha256:" + digest } } as const;
		expect(await client.controlRun("project/one", "run/one", 7, body)).toEqual(controlReceipt);
		expect(new Headers(calls[0]!.init?.headers).get("If-Match")).toBe("7");
		expect(new Headers(calls[0]!.init?.headers).get("Idempotency-Key")).toBe("key:control-run:run/one:replan:child");
		expect(calls[0]!.init?.body).toBe(JSON.stringify(body));
	});

	test("routes an exact repair through the run control receipt", async () => {
		const client = new FactoryApiClient({ fetch: fetcher as unknown as typeof fetch, idempotencyKey: operation => "key:" + operation });
		const body = { action: "repair", nodeId: "task/one", reason: "Correct input", parameters: { instruction: { kind: "inline", value: "second" } } } as const;
		expect(await client.controlRun("project/one", "run/one", 4, body)).toEqual(controlReceipt);
		expect(calls[0]!.path).toBe("/api/factories/projects/project%2Fone/runs/run%2Fone/control");
		expect(new Headers(calls[0]!.init?.headers).get("If-Match")).toBe("4");
		expect(new Headers(calls[0]!.init?.headers).get("Idempotency-Key")).toBe("key:control-run:run/one:repair:task/one");
		expect(calls[0]!.init?.body).toBe(JSON.stringify(body));
	});

	test("routes public release operations with exact preconditions and encoded identities", async () => {
		const client = new FactoryApiClient({ fetch: fetcher as unknown as typeof fetch, idempotencyKey: operation => "key:" + operation });
		expect(await client.putReleaseContract("project/one", "contract/one", { contractDigest: releaseContract.contractDigest, validatorLockDigest: releaseContract.validatorLockDigest, mandatoryClaims: [], claimGroups: [] }, 0)).toEqual(releaseContract);
		expect(await client.prepareRelease("project/one", releaseBody)).toEqual(releaseOperation);
		expect(await client.getRelease("project/one", "operation/one")).toEqual(releaseOperation);
		expect(await client.requestReleaseApproval("project/one", "operation/one", releaseBody.deadlineMs, 0)).toEqual(releaseApproval);
		expect(await client.decideReleaseApproval("project/one", "approval/one", digest, "approved")).toEqual(releaseApproval);
		expect(await client.decideCommandApproval("project/one", "run/one", "command/one", digest, "ship")).toEqual(commandApproval);
		expect(await client.listReleaseNotifications("project/one", { limit: 25, cursor: "notification/zero" })).toEqual({ items: [releaseNotification], nextCursor: "notification/next" });
		expect(await client.putReleasePolicy("project/one", "policy/one", releasePolicy)).toEqual(releasePolicy);
		expect(await client.deleteReleasePolicy("project/one", "policy/one", 1)).toEqual(releasePolicy);
		expect(await client.reconcileRelease("project/one", "operation/one", 1, { action: "keep_uncertain", reason: "Still unknown", providerEvidence: { lookup: true } })).toEqual(releaseOperation);
		expect(calls.map(call => call.path)).toEqual([
			"/api/factories/projects/project%2Fone/release/contracts/contract%2Fone",
			"/api/factories/projects/project%2Fone/releases",
			"/api/factories/projects/project%2Fone/releases/operation%2Fone",
			"/api/factories/projects/project%2Fone/releases/operation%2Fone/approvals",
			"/api/factories/projects/project%2Fone/release/approvals/approval%2Fone",
			"/api/factories/projects/project%2Fone/runs/run%2Fone/approvals/command%2Fone",
			"/api/factories/projects/project%2Fone/release/notifications?limit=25&cursor=notification%2Fzero",
			"/api/factories/projects/project%2Fone/release/policies/policy%2Fone",
			"/api/factories/projects/project%2Fone/release/policies/policy%2Fone",
			"/api/factories/projects/project%2Fone/releases/operation%2Fone/reconciliations",
		]);
		expect(new Headers(calls[3]!.init?.headers).get("If-Match")).toBe("0");
		expect(new Headers(calls[9]!.init?.headers).get("If-Match")).toBe("1");
		expect(new Headers(calls[5]!.init?.headers).get("If-Match")).toBe("0");
		expect(calls[5]!.init?.body).toBe(JSON.stringify({ contextDigest: digest, choice: "ship" }));
		expect(calls[8]!.init?.method).toBe("DELETE");
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
		expect(await client.issueServiceCredential("project/one", "service one", ["read"], 61_000)).toMatchObject({ resource: credential, token: expect.stringMatching(/^ezkfsvc_/) });
		expect(await client.revokeServiceCredential("project/one", "service one", "credential/one", 1)).toMatchObject({ revision: 2, revoked: true });
		expect(await client.publishReleaseTrust("project/one", 0, packageLock, "sha256:" + digest)).toEqual(trust);
		expect(await client.revokeReleaseTrust("project/one", 1)).toEqual(trust);
		expect(await client.setReleaseEnabled("project/one", true, 0)).toEqual(control);

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
		expect(calls[11]?.path).toContain("service%20one/credentials");
		expect(calls[11]?.init?.body).toBe(JSON.stringify({ scopes: ["read"], expiresAtMs: 61_000 }));
		expect(calls[12]?.path).toContain("credential%2Fone");
		expect(calls[12]?.init?.method).toBe("DELETE");
		expect(calls[13]?.path).toContain("project%2Fone/release/trust");
		expect(calls[13]?.init?.method).toBe("PUT");
		expect(calls[13]?.init?.body).toBe(JSON.stringify({ packageLock, validatorTrustDigest: "sha256:" + digest }));
		expect(calls[14]?.init?.method).toBe("DELETE");
		expect(calls[14]?.init?.body).toBeUndefined();
		expect(calls[15]?.path).toContain("project%2Fone/release/control");
		expect(calls[15]?.init?.body).toBe(JSON.stringify({ enabled: true }));
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
