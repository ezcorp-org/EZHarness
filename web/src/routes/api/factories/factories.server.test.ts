import { beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalizeJson, compileFactory, referenceCodeV1, type FactoryApiResponse } from "@ezcorp/factory-sdk";
import type { FactoryApplication } from "$server/factory/application";
import { FactoryDefinitionError } from "$server/factory/definitions";
import { FactoryGrantError } from "$server/factory/grants";
import { FactoryRunLifecycleError } from "$server/factory/run-lifecycle";
import { FactoryMutationError } from "$server/factory/mutations";
import { FactoryServiceCredentialError } from "$server/factory/service-credentials";
import { FactoryReleaseAuthorityError } from "$server/factory/release-authority";
import { FactoryReleaseError } from "$server/factory/releases";
import { FactoryAssuranceError } from "$server/factory/assurance";
import { FactoryAssuranceCommandError } from "$server/factory/assurance-commands";

const state = vi.hoisted(() => ({ enabled: true, application: null as unknown }));

vi.mock("$server/factory/boot", () => ({ factoryBootConfig: { get enabled() { return state.enabled; }, installationId: "test-installation" } }));
vi.mock("$server/auth/jwt", async importOriginal => ({ ...(await importOriginal<typeof import("$server/auth/jwt")>()), getJwtSecret: async () => "test-factory-service-secret" }));
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
const runs = { start: vi.fn(), read: vi.fn(), list: vi.fn(), cancel: vi.fn(), readCommand: vi.fn() };
const grants = { list: vi.fn(), set: vi.fn(), revoke: vi.fn() };
const credentials = { issue: vi.fn(), revoke: vi.fn(), authenticate: vi.fn() };
const releaseAuthority = { publishTrust: vi.fn(), revokeTrust: vi.fn(), setReleaseEnabled: vi.fn() };
const releaseOperations = { putContract: vi.fn(), prepare: vi.fn(), inspect: vi.fn(), requestApproval: vi.fn(), decideApproval: vi.fn(), listNotifications: vi.fn(), putPolicy: vi.fn(), deletePolicy: vi.fn(), reconcile: vi.fn() };
const commandApprovals = { decide: vi.fn() };

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
const runStart = await import("./projects/[projectId]/definitions/[factoryId]/runs/+server");
const runList = await import("./projects/[projectId]/runs/+server");
const runItem = await import("./projects/[projectId]/runs/[runId]/+server");
const runControl = await import("./projects/[projectId]/runs/[runId]/control/+server");
const runCommand = await import("./projects/[projectId]/runs/[runId]/commands/[commandId]/+server");
const commandApproval = await import("./projects/[projectId]/runs/[runId]/approvals/[approvalId]/+server");
const credentialIssue = await import("./projects/[projectId]/service-accounts/[serviceAccountId]/credentials/+server");
const credentialRevoke = await import("./projects/[projectId]/service-accounts/[serviceAccountId]/credentials/[credentialId]/+server");
const releaseTrust = await import("./projects/[projectId]/release/trust/+server");
const releaseControl = await import("./projects/[projectId]/release/control/+server");
const releaseContractRoute = await import("./projects/[projectId]/release/contracts/[contractId]/+server");
const releaseCollection = await import("./projects/[projectId]/releases/+server");
const releaseItem = await import("./projects/[projectId]/releases/[operationId]/+server");
const releaseApprovalRequest = await import("./projects/[projectId]/releases/[operationId]/approvals/+server");
const releaseApprovalDecision = await import("./projects/[projectId]/release/approvals/[approvalId]/+server");
const releaseNotifications = await import("./projects/[projectId]/release/notifications/+server");
const releasePolicyRoute = await import("./projects/[projectId]/release/policies/[policyId]/+server");
const releaseReconciliation = await import("./projects/[projectId]/releases/[operationId]/reconciliations/+server");
const run = { runId: "run-1", factoryId: referenceCodeV1.id, factoryVersion: referenceCodeV1.version, definitionDigest: compiled.digest, grantRevision: 1, revision: 1, status: "queued", createdAtMs: 1, updatedAtMs: 1 };
const receipt = { resourceId: run.runId, commandId: "command-1", statusUrl: "/api/factories/projects/project-1/runs/run-1/commands/command-1" };
const shared = await import("./_shared");

beforeEach(() => {
  state.enabled = true;
  state.application = {
    tenantId: "tenant-1",
    definitions,
    grants,
    credentials,
    releaseAuthority,
    releaseOperations,
    commandApprovals,
    runs,
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
  runs.start.mockResolvedValue({ run: { ...run, parameters: {} }, receipt });
  runs.read.mockResolvedValue({ ...run, parameters: {} });
  runs.list.mockResolvedValue({ items: [run], nextCursor: null });
  runs.cancel.mockResolvedValue({ run: { ...run, status: "cancelling", parameters: {} }, receipt });
  runs.readCommand.mockResolvedValue({ commandId: receipt.commandId, runId: run.runId, kind: "start_run", state: "outcome_unknown", attempts: 1, createdAtMs: 1, failureCode: "worker_lease_expired" });
  grants.list.mockResolvedValue({ items: [grant], nextCursor: null });
  grants.set.mockResolvedValue({ revision: 1, expiresAtMs: null });
  grants.revoke.mockResolvedValue({ revision: 2, expiresAtMs: null });
  const issuedAtMs = Math.floor(Date.now() / 1_000) * 1_000;
  credentials.issue.mockResolvedValue({ projectId: "project-1", serviceAccountId: "service-1", credentialId: "credential-1", scopes: ["read"], revision: 1, issuedByUserId: "member-1", issuedAtMs, expiresAtMs: issuedAtMs + 60_000, revoked: false });
  credentials.revoke.mockResolvedValue({ projectId: "project-1", serviceAccountId: "service-1", credentialId: "credential-1", scopes: ["read"], revision: 2, issuedByUserId: "member-1", issuedAtMs, expiresAtMs: issuedAtMs + 60_000, revoked: true });
  const packageLock = { package: "@ezcorp/release", version: "1.0.0", digest: `sha256:${sourceDigest}`, export: "release" };
  releaseAuthority.publishTrust.mockResolvedValue({ projectId: "project-1", revision: 1, state: "active", packageLock, packageTrustDigest: `sha256:${compiledBlobDigest}`, validatorTrustDigest: `sha256:${sourceDigest}`, approvedBy: "member-1", approvalGrantRevision: 1 });
  releaseAuthority.revokeTrust.mockResolvedValue({ projectId: "project-1", revision: 2, state: "revoked", packageLock, packageTrustDigest: `sha256:${compiledBlobDigest}`, validatorTrustDigest: `sha256:${sourceDigest}`, approvedBy: "member-1", approvalGrantRevision: 1 });
  releaseAuthority.setReleaseEnabled.mockResolvedValue({ projectId: "project-1", enabled: true, enableEpoch: 1 });
  const destination = { provider: "s3", account: "tenant-1", object: "release.json" };
  const operation = { tenantId: "tenant-1", projectId: "project-1", operationId: "operation-1", runId: "run-1", nodeInstanceId: "node-1", candidateGeneration: 0, decisionId: "decision-1", candidateDigest: `sha256:${sourceDigest}`, contractDigest: `sha256:${compiledBlobDigest}`, executionEpoch: 1, cancellationEpoch: 0, releaseEnableEpoch: 1, action: "publish", destination, destinationDigest: `sha256:${sourceDigest}`, request: { protected: true }, requestDigest: `sha256:${compiledBlobDigest}`, material: { secret: true }, materialDigest: `sha256:${sourceDigest}`, estimatedSpendMicros: 1, deadlineMs: 2_000_000_000_000, state: "pending", dispatchGeneration: 0, dispatchStarted: false, senderToken: "secret-token", archiveReady: true, intentArchive: { key: "secret", digest: `sha256:${sourceDigest}` } };
  releaseOperations.putContract.mockResolvedValue({ contractId: "contract-1", revision: 1, contractDigest: `sha256:${sourceDigest}`, validatorLockDigest: `sha256:${compiledBlobDigest}`, mandatoryClaims: [], claimGroups: [] });
  releaseOperations.prepare.mockResolvedValue(operation);
  releaseOperations.inspect.mockResolvedValue(operation);
  releaseOperations.requestApproval.mockResolvedValue({ approvalId: "approval-1", operationId: "operation-1", contextDigest: sourceDigest, status: "pending", expiresAtMs: 2_000_000_000_000 });
  releaseOperations.listNotifications.mockResolvedValue({ items: [{ notificationId: "notification-1", operationId: "operation-1", createdAtMs: 1, kind: "approval_requested", approvalId: "approval-1", contextDigest: sourceDigest, expiresAtMs: 2_000_000_000_000 }], nextCursor: "notification-1" });
  releaseOperations.decideApproval.mockResolvedValue({ approvalId: "approval-1", contextDigest: sourceDigest, status: "approved" });
  releaseOperations.putPolicy.mockResolvedValue({ policyId: "policy-1", revision: 1, revoked: false, principalKind: "service", principalId: "service-1", action: "publish", destinationProvider: "s3", destinationAccount: "tenant-1", destinationPrefix: "release/", contractDigest: `sha256:${sourceDigest}`, maxOperations: 1, maxSpendMicros: 1, expiresAtMs: 2_000_000_000_000 });
  releaseOperations.deletePolicy.mockResolvedValue({ policyId: "policy-1", revision: 2, revoked: true });
  releaseOperations.reconcile.mockResolvedValue({ ...operation, state: "uncertain", outcomeCode: "operator_kept_uncertain" });
  commandApprovals.decide.mockResolvedValue({ approvalId: "command-approval-1", runId: "run-1", commandId: "command-1", nodeInstanceId: "review", revision: 1, contextDigest: sourceDigest, status: "answered", choices: ["ship", "hold"], context: { subject: "deploy" }, actorScope: "operator", expiresAtMs: 2_000_000_000_000, choice: "ship", decidedBy: "member-1", decidedAtMs: 1 });
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

describe("factory run request routes", () => {
  const project = { projectId: "project-1" };
  const path = { ...project, runId: "run-1" };
  const definitionPath = { ...project, factoryId: referenceCodeV1.id };
  const body = { factoryVersion: referenceCodeV1.version, definitionDigest: compiled.digest, grantRevision: 1, parameters: {} };
  test("accepts a pinned run at revision zero and returns its durable status location", async () => {
    const response = await runStart.POST(event("POST", "/api/factories/projects/project-1/definitions/reference.code.v1/runs", { auth: "api-key", scopes: ["chat"], params: definitionPath, body, revision: 0, key: "run-key" }));
    expect(response.status).toBe(202); expect(await json(response)).toMatchObject({ kind: "mutation.accepted", receipt });
    expect(runs.start).toHaveBeenCalledWith({ kind: "user", id: "key-owner", authentication: "api-key" }, definitionPath, body, 0, "run-key");
    const denied = await runStart.POST(event("POST", "/api/factories/projects/project-1/definitions/reference.code.v1/runs", { auth: "api-key", scopes: ["write"], params: definitionPath, body, revision: 0, key: "run-key" }));
    expect(denied.status).toBe(403);
    const stale = await runStart.POST(event("POST", "/api/factories/projects/project-1/definitions/reference.code.v1/runs", { params: definitionPath, body, revision: 1, key: "run-key" }));
    expect(stale.status).toBe(412);
  });
  test("reads run summaries and failed dispatch separately, with scoped bounded filters", async () => {
    const page = await runList.GET(event("GET", "/api/factories/projects/project-1/runs?limit=2&cursor=before&status=queued&factoryId=reference.code.v1&search=code", { params: project }));
    expect(page.status).toBe(200); expect(await json(page)).toMatchObject({ kind: "run.page" });
    expect(runs.list).toHaveBeenCalledWith(expect.anything(), project.projectId, { limit: 2, cursor: "before", status: "queued", factoryId: "reference.code.v1", search: "code" });
    const detail = await runItem.GET(event("GET", "/api/factories/projects/project-1/runs/run-1", { params: path }));
    expect(await json(detail)).toMatchObject({ kind: "run.details", resource: { status: "queued" } });
    const command = await runCommand.GET(event("GET", receipt.statusUrl, { params: { ...path, commandId: receipt.commandId } }));
    expect(await json(command)).toMatchObject({ kind: "command.resource", resource: { state: "outcome_unknown" } });
    expect(runs.readCommand).toHaveBeenCalledWith(expect.anything(), path, receipt.commandId);
    expect((await runList.GET(event("GET", "/api/factories/projects/project-1/runs?limit=201", { params: project }))).status).toBe(400);
  });
  test("cancellation acknowledges the request without claiming a stopped run", async () => {
    const response = await runControl.POST(event("POST", "/api/factories/projects/project-1/runs/run-1/control", { params: path, body: { action: "cancel", reason: "Stop" }, revision: 1, key: "cancel-key" }));
    expect(response.status).toBe(202); expect(await json(response)).toMatchObject({ kind: "mutation.accepted", receipt });
    expect(runs.cancel).toHaveBeenCalledWith(expect.anything(), path, 1, "cancel-key", "Stop");
    const unavailable = await runControl.POST(event("POST", "/api/factories/projects/project-1/runs/run-1/control", { params: path, body: { action: "repair", nodeId: "candidate", parameters: {} }, revision: 1, key: "repair-key" }));
    expect(unavailable.status).toBe(503); expect(runs.cancel).toHaveBeenCalledTimes(1);
  });
  test("maps run preconditions, authority, availability, and storage failures", async () => {
    for (const [code, status] of [["factory_revision_conflict", 412], ["factory_revision_invalid", 412], ["factory_run_not_found", 404], ["factory_command_not_found", 404], ["factory_run_terminal", 409], ["factory_run_stopped", 409], ["factory_definition_conflict", 409], ["factory_input_invalid", 400], ["factory_page_invalid", 400], ["factory_interpreter_unavailable", 503], ["factory_run_corrupt", 500]] as const) {
      runs.read.mockRejectedValueOnce(new FactoryRunLifecycleError(code));
      const response = await runItem.GET(event("GET", "/api/factories/projects/project-1/runs/run-1", { params: path }));
      expect(response.status).toBe(status); expect(await json(response)).toMatchObject({ kind: "error", error: { code } });
    }
  });
});

describe("factory definition and grant routes", () => {
  test("issues and revokes short-lived credentials only through a human session", async () => {
    const path = { projectId: "project-1", serviceAccountId: "service-1" };
    const expiresAtMs = (Math.floor(Date.now() / 1_000) + 60) * 1_000;
    const issued = await credentialIssue.POST(event("POST", "/api/factories/projects/project-1/service-accounts/service-1/credentials", { params: path, body: { scopes: ["read"], expiresAtMs }, revision: 0, key: "credential-issue" }));
    expect(issued.status).toBe(200);
    expect(await json(issued)).toMatchObject({ kind: "service-credential.issued", resource: { serviceAccountId: "service-1", revision: 1 }, token: expect.stringMatching(/^ezkfsvc_/) });
    expect(credentials.issue).toHaveBeenCalledWith(expect.objectContaining({ authentication: "session" }), { ...path, scopes: ["read"], expiresAtMs, expectedRevision: 0 }, "credential-issue");
    const revoked = await credentialRevoke.DELETE(event("DELETE", "/api/factories/projects/project-1/service-accounts/service-1/credentials/credential-1", { params: { ...path, credentialId: "credential-1" }, revision: 1, key: "credential-revoke" }));
    expect(await json(revoked)).toMatchObject({ kind: "service-credential.resource", resource: { revision: 2, revoked: true } });
    const denied = await credentialIssue.POST(event("POST", "/api/factories/projects/project-1/service-accounts/service-1/credentials", { params: path, body: { scopes: ["read"], expiresAtMs }, revision: 0, key: "credential-key", auth: "api-key", scopes: ["write"] }));
    expect(denied.status).toBe(403);
  });

  test("uses service locals without creating a user and confines the project", async () => {
    const service = { tokenUse: "factory-service" as const, serviceAccountId: "service-1", projectId: "project-1", credentialId: "credential-1", revision: 1, scopes: ["read"] as const, issuedAtMs: 1_000, expiresAtMs: 2_000 };
    const allowed = event("GET", "/api/factories/projects/project-1/definitions", { params: { projectId: "project-1" }, anonymous: true }) as { locals: App.Locals };
    allowed.locals.factoryServicePrincipal = service;
    expect((await collection.GET(allowed as never)).status).toBe(200);
    expect(definitions.listDrafts).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "service", id: "service-1", credential: service }), "project-1", expect.anything());
    const foreign = event("GET", "/api/factories/projects/project-2/definitions", { params: { projectId: "project-2" }, anonymous: true }) as { locals: App.Locals };
    foreign.locals.factoryServicePrincipal = service;
    expect((await collection.GET(foreign as never)).status).toBe(403);
    const narrow = event("POST", "/api/factories/projects/project-1/definitions", { params: { projectId: "project-1" }, body: { source: referenceCodeV1 }, revision: 0, key: "service-write", anonymous: true }) as { locals: App.Locals };
    narrow.locals.factoryServicePrincipal = service;
    expect((await collection.POST(narrow as never)).status).toBe(403);
  });

  test("maps credential conflicts, absence, authority, input and storage errors", async () => {
    const params = { projectId: "project-1", serviceAccountId: "service-1", credentialId: "credential-1" };
    for (const [code, status] of [["factory_service_credential_conflict", 412], ["factory_service_credential_not_found", 404], ["factory_service_credential_forbidden", 403], ["factory_human_required", 403], ["factory_service_credential_invalid", 400], ["factory_service_credential_corrupt", 500]] as const) {
      credentials.revoke.mockRejectedValueOnce(new FactoryServiceCredentialError(code));
      const response = await credentialRevoke.DELETE(event("DELETE", "/api/factories/projects/project-1/service-accounts/service-1/credentials/credential-1", { params, revision: 1, key: `credential-${code}` }));
      expect(response.status).toBe(status);
      expect(await json(response)).toMatchObject({ kind: "error", error: { code } });
    }
  });
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

  test("answers a run-scoped generic approval only through a human session", async () => {
    const params = { projectId: "project-1", runId: "run-1", approvalId: "command-approval-1" };
    const response = await commandApproval.PUT(event("PUT", "/api/factories/projects/project-1/runs/run-1/approvals/command-approval-1", { params, body: { contextDigest: sourceDigest, choice: "ship" }, revision: 0, key: "answer-command" }));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ kind: "approval.resource", resource: { runId: "run-1", status: "answered", choice: "ship" } });
    expect(commandApprovals.decide).toHaveBeenCalledWith({ kind: "user", id: "member-1", authentication: "session" }, "project-1", "run-1", "command-approval-1", sourceDigest, "ship", 0, "answer-command");
    expect((await commandApproval.PUT(event("PUT", "/api/factories/projects/project-1/runs/run-1/approvals/command-approval-1", { params, body: { contextDigest: sourceDigest, choice: "ship" }, revision: 0, key: "answer-command-key", auth: "api-key", scopes: ["write"] }))).status).toBe(403);
    expect((await commandApproval.PUT(event("PUT", "/api/factories/projects/project-1/runs/run-1/approvals/command-approval-1", { params, body: { contextDigest: sourceDigest, choice: "ship" }, revision: 1, key: "answer-command-stale" }))).status).toBe(412);

    for (const [code, status] of [["factory_command_approval_not_found", 404], ["factory_command_approval_forbidden", 403], ["factory_command_approval_stale", 412], ["factory_command_approval_invalid", 400], ["factory_command_approval_corrupt", 500]] as const) {
      commandApprovals.decide.mockRejectedValueOnce(new FactoryAssuranceCommandError(code));
      const failure = await commandApproval.PUT(event("PUT", "/api/factories/projects/project-1/runs/run-1/approvals/command-approval-1", { params, body: { contextDigest: sourceDigest, choice: "ship" }, revision: 0, key: `answer-command-${code}` }));
      expect(failure.status).toBe(status);
      expect(await json(failure)).toMatchObject({ kind: "error", error: { code } });
    }
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
      build: () => ({ kind: "approval.get", path: { projectId: "project-1", runId: "run-1", approvalId: "approval-1" } }),
    })).rejects.toThrow("not handled");
  });
});

describe("factory release authority routes", () => {
  const path = { projectId: "project-1" };
  const packageLock = { package: "@ezcorp/release", version: "1.0.0", digest: `sha256:${sourceDigest}`, export: "release" };

  test("checks the feature and application before authentication or body parsing", async () => {
    state.enabled = false;
    const disabled = await releaseTrust.PUT(event("PUT", "/api/factories/projects/project-1/release/trust", { params: path, body: "{" }));
    expect(disabled.status).toBe(404);
    expect(await json(disabled)).toMatchObject({ kind: "error", error: { code: "factory_disabled" } });
    state.enabled = true;
    state.application = null;
    const unavailable = await releaseControl.PUT(event("PUT", "/api/factories/projects/project-1/release/control", { params: path, body: "{", anonymous: true }));
    expect(unavailable.status).toBe(503);
    expect(await json(unavailable)).toMatchObject({ kind: "error", error: { code: "factory_application_unavailable" } });
  });

  test("publishes and revokes trust and changes the release epoch through a human session", async () => {
    const published = await releaseTrust.PUT(event("PUT", "/api/factories/projects/project-1/release/trust", { params: path, body: { packageLock, validatorTrustDigest: `sha256:${sourceDigest}` }, revision: 0, key: "trust-publish" }));
    expect(published.status).toBe(200);
    expect(await json(published)).toMatchObject({ kind: "release.trust.resource", resource: { revision: 1, state: "active", packageLock } });
    expect(releaseAuthority.publishTrust).toHaveBeenCalledWith({ kind: "user", id: "member-1", authentication: "session" }, { ...path, packageLock, validatorTrustDigest: `sha256:${sourceDigest}`, expectedRevision: 0 }, "trust-publish");

    const revoked = await releaseTrust.DELETE(event("DELETE", "/api/factories/projects/project-1/release/trust", { params: path, revision: 1, key: "trust-revoke" }));
    expect(await json(revoked)).toMatchObject({ kind: "release.trust.resource", resource: { revision: 2, state: "revoked" } });
    expect(releaseAuthority.revokeTrust).toHaveBeenCalledWith(expect.objectContaining({ authentication: "session" }), path.projectId, 1, "trust-revoke");

    const controlled = await releaseControl.PUT(event("PUT", "/api/factories/projects/project-1/release/control", { params: path, body: { enabled: true }, revision: 0, key: "release-enable" }));
    expect(await json(controlled)).toEqual({ schemaVersion: "factory.api.response.v1", kind: "release.control.resource", resource: { enabled: true, enableEpoch: 1 } });
    expect(releaseAuthority.setReleaseEnabled).toHaveBeenCalledWith(expect.objectContaining({ authentication: "session" }), path.projectId, true, 0, "release-enable");
  });

  test("rejects API keys, internal callers, service credentials, and missing preconditions", async () => {
    const body = { packageLock, validatorTrustDigest: `sha256:${sourceDigest}` };
    expect((await releaseTrust.PUT(event("PUT", "/api/factories/projects/project-1/release/trust", { params: path, body, revision: 0, key: "api-key", auth: "api-key", scopes: ["write"] }))).status).toBe(403);
    expect((await releaseTrust.PUT(event("PUT", "/api/factories/projects/project-1/release/trust", { params: path, body, revision: 0, key: "internal", auth: "internal" }))).status).toBe(403);
    const service = event("PUT", "/api/factories/projects/project-1/release/trust", { params: path, body, revision: 0, key: "service", anonymous: true }) as { locals: App.Locals };
    service.locals.factoryServicePrincipal = { tokenUse: "factory-service", serviceAccountId: "service-1", projectId: path.projectId, credentialId: "credential-1", revision: 1, scopes: ["write"], issuedAtMs: 1_000, expiresAtMs: 2_000 };
    expect((await releaseTrust.PUT(service as never)).status).toBe(401);
    const missing = await releaseControl.PUT(event("PUT", "/api/factories/projects/project-1/release/control", { params: path, body: { enabled: true } }));
    expect(missing.status).toBe(412);
    expect(releaseAuthority.publishTrust).not.toHaveBeenCalled();
    expect(releaseAuthority.setReleaseEnabled).not.toHaveBeenCalled();
  });

  test("maps release authority conflicts, absence, scope, input, and storage failures", async () => {
    for (const [code, status] of [["factory_release_trust_conflict", 412], ["factory_release_control_conflict", 412], ["factory_release_trust_missing", 404], ["factory_release_authority_human_required", 403], ["factory_release_authority_scope", 403], ["factory_release_authority_invalid", 400], ["factory_release_trust_corrupt", 500]] as const) {
      releaseAuthority.revokeTrust.mockRejectedValueOnce(new FactoryReleaseAuthorityError(code));
      const response = await releaseTrust.DELETE(event("DELETE", "/api/factories/projects/project-1/release/trust", { params: path, revision: 1, key: `release-${code}` }));
      expect(response.status).toBe(status);
      expect(await json(response)).toMatchObject({ kind: "error", error: { code } });
    }
  });
});

describe("factory release and assurance routes", () => {
  const projectId = "project-1";
  const operationId = "operation-1";
  const prepareBody = { runId: "run-1", nodeInstanceId: "node-1", candidateGeneration: 0, decisionId: "decision-1", candidateDigest: `sha256:${sourceDigest}`, action: "publish", destination: { provider: "s3", account: "tenant-1", object: "release.json" }, request: { contentType: "application/json" }, estimatedSpendMicros: 1, deadlineMs: 2_000_000_000_000 };

  test("prepares and reads a sanitized operation through chat-scoped service authority", async () => {
    const preparedEvent = event("POST", `/api/factories/projects/${projectId}/releases`, { anonymous: true, params: { projectId }, body: prepareBody, revision: 0, key: "prepare-1" }) as { locals: App.Locals };
    preparedEvent.locals.factoryServicePrincipal = { tokenUse: "factory-service", serviceAccountId: "service-1", projectId, credentialId: "credential-1", revision: 1, scopes: ["chat"], issuedAtMs: 1_000, expiresAtMs: 2_000_000_000_000 };
    const prepared = await releaseCollection.POST(preparedEvent as never);
    expect(prepared.status).toBe(200);
    const resource = (await json(prepared) as Extract<FactoryApiResponse, { kind: "release.operation.resource" }>).resource;
    expect(resource).toMatchObject({ operationId, destination: prepareBody.destination, archiveReady: true });
    expect(resource).not.toHaveProperty("senderToken"); expect(resource).not.toHaveProperty("material"); expect(resource).not.toHaveProperty("request"); expect(resource).not.toHaveProperty("intentArchive");
    expect(releaseOperations.prepare).toHaveBeenCalledWith(expect.objectContaining({ kind: "service", id: "service-1" }), projectId, prepareBody, "prepare-1");

    const readEvent = event("GET", `/api/factories/projects/${projectId}/releases/${operationId}`, { anonymous: true, params: { projectId, operationId } }) as { locals: App.Locals };
    readEvent.locals.factoryServicePrincipal = preparedEvent.locals.factoryServicePrincipal;
    expect((await releaseItem.GET(readEvent as never)).status).toBe(200);
    readEvent.locals.factoryServicePrincipal = { ...preparedEvent.locals.factoryServicePrincipal, scopes: ["read"] };
    expect((await releaseItem.GET(readEvent as never)).status).toBe(403);
  });

  test("keeps contract, approvals, and policies on human sessions with exact If-Match values", async () => {
    const contractBody = { contractDigest: `sha256:${sourceDigest}`, validatorLockDigest: `sha256:${compiledBlobDigest}`, mandatoryClaims: [], claimGroups: [] };
    expect((await releaseContractRoute.PUT(event("PUT", `/api/factories/projects/${projectId}/release/contracts/contract-1`, { params: { projectId, contractId: "contract-1" }, body: contractBody, revision: 0, key: "contract-1" }))).status).toBe(200);
    expect(releaseOperations.putContract).toHaveBeenCalledWith(expect.objectContaining({ authentication: "session" }), projectId, "contract-1", contractBody, 0, "contract-1");

    expect((await releaseApprovalRequest.POST(event("POST", `/api/factories/projects/${projectId}/releases/${operationId}/approvals`, { params: { projectId, operationId }, body: { expiresAtMs: 2_000_000_000_000 }, revision: 0, key: "request-approval" }))).status).toBe(200);
    expect((await releaseApprovalDecision.PUT(event("PUT", `/api/factories/projects/${projectId}/release/approvals/approval-1`, { params: { projectId, approvalId: "approval-1" }, body: { contextDigest: sourceDigest, decision: "approved" }, revision: 0, key: "decide-approval" }))).status).toBe(200);

    const policyBody = { principalKind: "service", principalId: "service-1", action: "publish", destinationProvider: "s3", destinationAccount: "tenant-1", destinationPrefix: "release/", contractDigest: `sha256:${sourceDigest}`, maxOperations: 1, maxSpendMicros: 1, expiresAtMs: 2_000_000_000_000 };
    expect((await releasePolicyRoute.PUT(event("PUT", `/api/factories/projects/${projectId}/release/policies/policy-1`, { params: { projectId, policyId: "policy-1" }, body: policyBody, revision: 0, key: "policy-put" }))).status).toBe(200);
    expect((await releasePolicyRoute.DELETE(event("DELETE", `/api/factories/projects/${projectId}/release/policies/policy-1`, { params: { projectId, policyId: "policy-1" }, revision: 1, key: "policy-delete" }))).status).toBe(200);
    expect((await releaseContractRoute.PUT(event("PUT", `/api/factories/projects/${projectId}/release/contracts/contract-1`, { auth: "api-key", scopes: ["write"], params: { projectId, contractId: "contract-1" }, body: contractBody, revision: 0, key: "api-key" }))).status).toBe(403);
  });

  test("lists bounded release inbox items only for an interactive session", async () => {
    const response = await releaseNotifications.GET(event("GET", `/api/factories/projects/${projectId}/release/notifications?limit=25&cursor=notification-0`, { params: { projectId } }));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ kind: "release.notification.page", page: { items: [{ kind: "approval_requested", approvalId: "approval-1" }], nextCursor: "notification-1" } });
    expect(releaseOperations.listNotifications).toHaveBeenCalledWith(expect.objectContaining({ authentication: "session" }), projectId, { limit: 25, cursor: "notification-0" });
    expect((await releaseNotifications.GET(event("GET", `/api/factories/projects/${projectId}/release/notifications`, { auth: "api-key", scopes: ["read"], params: { projectId } }))).status).toBe(403);
  });

  test("routes reconciliation through write scope while the real adapter retains its human store gate", async () => {
    const body = { action: "keep_uncertain", reason: "Provider outcome is still unknown", providerEvidence: { lookup: true } };
    const response = await releaseReconciliation.POST(event("POST", `/api/factories/projects/${projectId}/releases/${operationId}/reconciliations`, { params: { projectId, operationId }, body, revision: 1, key: "reconcile-1" }));
    expect(response.status).toBe(200);
    expect(releaseOperations.reconcile).toHaveBeenCalledWith(expect.objectContaining({ authentication: "session" }), projectId, operationId, body, 1, "reconcile-1");
    expect((await releaseReconciliation.POST(event("POST", `/api/factories/projects/${projectId}/releases/${operationId}/reconciliations`, { auth: "api-key", scopes: ["read"], params: { projectId, operationId }, body, revision: 1, key: "reconcile-read" }))).status).toBe(403);
    releaseOperations.reconcile.mockRejectedValueOnce(new FactoryReleaseError("factory_release_human_required"));
    expect((await releaseReconciliation.POST(event("POST", `/api/factories/projects/${projectId}/releases/${operationId}/reconciliations`, { auth: "api-key", scopes: ["write"], params: { projectId, operationId }, body, revision: 1, key: "reconcile-key" }))).status).toBe(403);
    expect(releaseOperations.reconcile).toHaveBeenLastCalledWith(expect.objectContaining({ authentication: "api-key" }), projectId, operationId, body, 1, "reconcile-key");
  });

  test("rejects malformed bodies and missing composition before any store mutation", async () => {
    expect((await releaseCollection.POST(event("POST", `/api/factories/projects/${projectId}/releases`, { params: { projectId }, body: { ...prepareBody, candidateDigest: "bad" }, revision: 0, key: "bad" }))).status).toBe(400);
    expect((await releaseApprovalRequest.POST(event("POST", `/api/factories/projects/${projectId}/releases/${operationId}/approvals`, { params: { projectId, operationId }, body: { expiresAtMs: 2 }, key: "missing-match" }))).status).toBe(412);
    state.application = { ...(state.application as object), releaseOperations: undefined };
    expect((await releaseItem.GET(event("GET", `/api/factories/projects/${projectId}/releases/${operationId}`, { params: { projectId, operationId } }))).status).toBe(503);
    expect(releaseOperations.prepare).not.toHaveBeenCalled();
  });

  test("maps release and assurance failures without exposing protected state", async () => {
    releaseOperations.inspect.mockRejectedValueOnce(new FactoryReleaseError("factory_release_not_found"));
    expect((await releaseItem.GET(event("GET", `/api/factories/projects/${projectId}/releases/${operationId}`, { params: { projectId, operationId } }))).status).toBe(404);
    releaseOperations.reconcile.mockRejectedValueOnce(new FactoryReleaseError("factory_release_reconciliation_stale"));
    expect((await releaseReconciliation.POST(event("POST", `/api/factories/projects/${projectId}/releases/${operationId}/reconciliations`, { params: { projectId, operationId }, body: { action: "keep_uncertain", reason: "Unknown", providerEvidence: { lookup: true } }, revision: 1, key: "stale" }))).status).toBe(412);
    releaseOperations.reconcile.mockRejectedValueOnce(new FactoryReleaseError("factory_release_reconciliation_timeout"));
    expect((await releaseReconciliation.POST(event("POST", `/api/factories/projects/${projectId}/releases/${operationId}/reconciliations`, { params: { projectId, operationId }, body: { action: "keep_uncertain", reason: "Unknown", providerEvidence: { lookup: true } }, revision: 1, key: "timeout" }))).status).toBe(503);
    const contractBody = { contractDigest: `sha256:${sourceDigest}`, validatorLockDigest: `sha256:${compiledBlobDigest}`, mandatoryClaims: [], claimGroups: [] };
    for (const [code, status] of [["factory_assurance_not_found", 404], ["factory_assurance_stale", 412], ["factory_assurance_invalid", 400], ["factory_assurance_claim_failed", 422], ["factory_assurance_corrupt", 500]] as const) {
      releaseOperations.putContract.mockRejectedValueOnce(new FactoryAssuranceError(code));
      expect((await releaseContractRoute.PUT(event("PUT", `/api/factories/projects/${projectId}/release/contracts/contract-1`, { params: { projectId, contractId: "contract-1" }, body: contractBody, revision: 0, key: `assurance-${code}` }))).status).toBe(status);
    }
    for (const [code, status] of [["factory_release_absence_unproved", 422], ["factory_release_reconciliation_invalid", 400], ["factory_release_corrupt", 500]] as const) {
      releaseOperations.reconcile.mockRejectedValueOnce(new FactoryReleaseError(code));
      expect((await releaseReconciliation.POST(event("POST", `/api/factories/projects/${projectId}/releases/${operationId}/reconciliations`, { params: { projectId, operationId }, body: { action: "keep_uncertain", reason: "Unknown", providerEvidence: { lookup: true } }, revision: 1, key: `release-${code}` }))).status).toBe(status);
    }
  });
});
