import { FACTORY_DISABLED_REASON, factoryBootConfig } from "$server/factory/boot";
import { draftAvailability, getFactoryApplication, type FactoryApplication } from "$server/factory/application";
import type { FactoryDraft, FactoryDraftMetadata, FactoryVersion } from "$server/factory/definitions";
import type { FactoryGrantRecord, FactoryPrincipal } from "$server/factory/grants";
import { FactoryRunLifecycleError } from "$server/factory/run-lifecycle";
import { FactoryServiceCredentialError } from "$server/factory/service-credentials";
import type { FactoryReleaseControl, FactoryReleaseTrustRecord } from "$server/factory/release-authority";
import { FactoryReleaseError, type FactoryReleaseOperation } from "$server/factory/releases";
import { FactoryAssuranceCommandError } from "$server/factory/assurance-commands";
import type { FactoryReleaseApplication } from "$server/factory/release-application";
import { signFactoryServiceToken } from "$server/auth/factory-service-token";
import { getJwtSecret } from "$server/auth/jwt";
import { readBoundedJson } from "$lib/server/security/bounded-json";
import { FactoryTrustedValidatorError } from "$server/factory/validator-materials";
import {
  answer,
  dispatchRegisteredFactoryRequest,
  factoryErrorResponse,
  factoryResponse,
  mappedFactoryError,
  registerFactoryErrorFamily,
  resolveFactoryPrincipal,
  type FactoryRouteScope,
} from "$lib/server/factory/route-kit";
import {
  FACTORY_API_REQUEST_SCHEMA_VERSION,
  FACTORY_API_RESPONSE_SCHEMA_VERSION,
  FACTORY_LIMITS,
  factoryApiPayloadDigest,
  validateFactoryApiRequest,
  type FactoryApiRequest,
  type FactoryApiResponse,
  type FactoryDefinitionListQuery,
  type FactoryDraftDetails,
  type FactoryDraftSummary,
  type FactoryGrantListQuery,
  type FactoryListQuery,
  type FactoryRunListQuery,
} from "@ezcorp/factory-sdk";

type FactoryMutationRequest = Extract<FactoryApiRequest, { preconditions: unknown }>;
type FactoryEvent = { readonly request: Request; readonly url: URL; readonly locals: App.Locals };
type FactoryRouteFields = Readonly<Record<string, unknown>>;

export interface FactoryRouteOptions {
  readonly scope: FactoryRouteScope;
  readonly build: () => FactoryRouteFields | Promise<FactoryRouteFields>;
}

export function handleFactorySessionApi(event: FactoryEvent, build: FactoryRouteOptions["build"]): Promise<Response> {
  return handleFactoryApi(event, { scope: "session", build });
}

const MUTATION_KINDS = new Set([
  "draft.create",
  "draft.update",
  "draft.delete",
  "draft.import",
  "version.publish",
  "grant.set",
  "grant.revoke",
  "run.start",
  "run.control",
  "approval.decide",
  "service-credential.issue",
  "service-credential.revoke",
  "release.trust.publish",
  "release.trust.revoke",
  "release.control.set",
  "release.contract.put",
  "release.prepare",
  "release.approval.request",
  "release.approval.decide",
  "release.policy.put",
  "release.policy.delete",
  "release.reconcile",
  // The live console's mutations (W14), answered by the registered console dispatcher.
  "package.install",
  "package.trust",
  "purge.request",
  "artifact.share",
  "artifact.unshare",
]);

// A release contract names a validator lock; a lock without registered,
// published, protected material is a typed refusal, not an opaque 500 (W09d O4).
registerFactoryErrorFamily({
  type: FactoryTrustedValidatorError,
  storage: "Trusted validator storage is unavailable.",
  answers: [
    answer(422, "The validator lock does not name registered, published, protected material.", "factory_validator_material_missing", "factory_validator_material_unpublished", "factory_validator_material_unprotected", "factory_validator_contract_untrusted"),
    answer(412, "The validator material is stale.", "factory_validator_material_stale"),
    answer(409, "Different validator material already uses this identity.", "factory_validator_material_conflict"),
    answer(403, "Trusted validator authority is required.", "factory_validator_scope"),
    answer(400, "The validator material request is invalid.", "factory_validator_invalid", "factory_validator_material_invalid"),
  ],
});

export function readFactoryJson(request: Request): Promise<unknown> {
  return readBoundedJson(request, FACTORY_LIMITS.maxDefinitionBytes + 65_536);
}

export function factoryListQuery(url: URL): FactoryListQuery {
  return compactQuery(url, ["limit", "cursor", "search"] as const) as FactoryListQuery;
}

export function factoryDefinitionListQuery(url: URL): FactoryDefinitionListQuery {
  return compactQuery(url, ["limit", "cursor", "search", "availability", "archived"] as const) as FactoryDefinitionListQuery;
}

export function factoryRunListQuery(url: URL): FactoryRunListQuery {
  return compactQuery(url, ["limit", "cursor", "search", "status", "factoryId"] as const) as FactoryRunListQuery;
}

export function factoryGrantListQuery(url: URL): FactoryGrantListQuery {
  return compactQuery(url, ["limit", "cursor", "principalKind", "action"] as const) as FactoryGrantListQuery;
}

function compactQuery(url: URL, keys: readonly string[]): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value === null) continue;
    if (key === "limit") query[key] = Number(value);
    else if (key === "archived") query[key] = value === "true" ? true : value === "false" ? false : value;
    else query[key] = value;
  }
  return query;
}

export async function handleFactoryApi(event: FactoryEvent, options: FactoryRouteOptions): Promise<Response> {
  // C09 names this reason exactly: a 404 with a `factory-disabled` reason. The
  // emitted string was `factory_disabled`, so a client matching the contract
  // never recognised the one answer the contract promises when the flag is off.
  if (!factoryBootConfig.enabled) return factoryErrorResponse(404, FACTORY_DISABLED_REASON, "Factories are disabled.");
  const application = getFactoryApplication();
  if (!application) return factoryErrorResponse(503, "factory_application_unavailable", "Factory services are not ready.", true);

  const service = event.locals.factoryServicePrincipal;
  const principal = resolveFactoryPrincipal(event, options);
  if (principal instanceof Response) return principal;

  let request: FactoryApiRequest;
  try {
    request = buildValidatedRequest(event.request, await options.build());
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof SyntaxError) return factoryErrorResponse(400, "invalid_json", error.message);
    throw error;
  }
  if (service && request.path.projectId !== service.projectId) return factoryErrorResponse(403, "factory_service_project_mismatch", "The service credential does not permit this project.");

  try {
    return factoryResponse(await dispatchFactoryRequest(application, principal, request));
  } catch (error) {
    return mappedFactoryError(error);
  }
}

function buildValidatedRequest(httpRequest: Request, fields: FactoryRouteFields): FactoryApiRequest {
  const base = { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, ...fields };
  let candidate: unknown = base;
  if (typeof fields.kind === "string" && MUTATION_KINDS.has(fields.kind)) {
    const ifMatch = httpRequest.headers.get("If-Match");
    if (ifMatch === null || !/^(0|[1-9][0-9]*)$/.test(ifMatch) || !Number.isSafeInteger(Number(ifMatch))) {
      throw factoryErrorResponse(412, "precondition_required", "A valid If-Match revision is required.");
    }
    const provisional = {
      ...base,
      preconditions: {
        idempotencyKey: httpRequest.headers.get("Idempotency-Key") ?? "",
        payloadDigest: "0".repeat(64),
        expectedRevision: Number(ifMatch),
      },
    } as FactoryMutationRequest;
    const preliminary = validateFactoryApiRequest(provisional);
    if (!preliminary.ok && preliminary.issues[0]?.code !== "API_PAYLOAD_DIGEST_MISMATCH") {
      throw validationResponse(preliminary.issues);
    }
    candidate = {
      ...provisional,
      preconditions: { ...provisional.preconditions, payloadDigest: factoryApiPayloadDigest(provisional) },
    };
  }
  const validation = validateFactoryApiRequest(candidate);
  if (!validation.ok) throw validationResponse(validation.issues);
  return candidate as FactoryApiRequest;
}

function validationResponse(issues: Extract<ReturnType<typeof validateFactoryApiRequest>, { ok: false }>["issues"]): Response {
  const precondition = issues.some(issue => issue.code === "API_EXPECTED_REVISION");
  return factoryErrorResponse(precondition ? 412 : 400, issues[0]?.code ?? "invalid_request", issues[0]?.message ?? "Invalid factory request.", false, issues);
}

/**
 * Routes one validated request to the sub-service that owns its verb.
 *
 * Each `dispatch*` below answers for exactly one application surface and
 * returns `null` for a kind it does not own, so the chain reproduces the
 * single switch this replaced: the first owner answers, an unclaimed kind
 * still reaches `unsupportedRequest`, and the ORDER of the groups is
 * irrelevant because the kinds partition cleanly across them. Dispatchers
 * registered through `registerFactoryDispatcher` (route-kit) run after the
 * built-in groups, so a new kind needs no edit here.
 */
async function dispatchFactoryRequest(application: FactoryApplication, principal: FactoryPrincipal, request: FactoryApiRequest): Promise<FactoryApiResponse> {
  return (
    (await dispatchDefinitions(application, principal, request)) ??
    (await dispatchRuns(application, principal, request)) ??
    (await dispatchGrants(application, principal, request)) ??
    (await dispatchCredentials(application, principal, request)) ??
    (await dispatchReleaseAuthority(application, principal, request)) ??
    (await dispatchReleases(application, principal, request)) ??
    (await dispatchRegisteredFactoryRequest(application, principal, request)) ??
    unsupportedRequest(request)
  );
}

/** Drafts and published versions — everything `application.definitions` owns. */
async function dispatchDefinitions(application: FactoryApplication, principal: FactoryPrincipal, request: FactoryApiRequest): Promise<FactoryApiResponse | null> {
  const definitions = application.definitions;
  switch (request.kind) {
    case "draft.create": {
      const item = await definitions.save(principal, { ...request.path, factoryId: request.body.source.id }, request.preconditions.expectedRevision, request.preconditions.idempotencyKey, request.body.source);
      return draftSummaryResponse(application, item);
    }
    case "draft.update": {
      const item = await definitions.save(principal, request.path, request.preconditions.expectedRevision, request.preconditions.idempotencyKey, request.body.source);
      return draftSummaryResponse(application, item);
    }
    case "draft.delete": {
      const item = await definitions.archive(principal, request.path, request.preconditions.expectedRevision, request.preconditions.idempotencyKey);
      return draftSummaryResponse(application, item);
    }
    case "draft.get": {
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "draft.details", resource: draftDetails(application, await definitions.read(principal, request.path)) };
    }
    case "draft.list":
      return listDrafts(application, principal, request.path.projectId, request.query);
    case "draft.import": {
      const item = await definitions.importNew(principal, request.path.projectId, request.preconditions.expectedRevision, request.preconditions.idempotencyKey, request.body.source, request.body.format);
      return draftSummaryResponse(application, item);
    }
    case "draft.export": {
      const exported = await definitions.export(principal, request.path);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "draft.export", format: request.query.format, source: exported.content };
    }
    case "draft.validate": {
      const result = await definitions.validateSource(principal, request.path, request.body.source);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "draft.validation", valid: result.ok, diagnostics: result.ok ? [] : result.diagnostics };
    }
    case "version.publish": {
      const version = await definitions.publish(principal, request.path, request.preconditions.expectedRevision, request.preconditions.idempotencyKey, request.body.version);
      return versionResponse(version);
    }
    case "version.get": {
      const result = await definitions.readVersion(principal, request.path, request.path.version);
      return {
        schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION,
        kind: "version.details",
        resource: { ...versionResource(result.version), source: result.compiled.definition },
      };
    }
    case "version.list": {
      const page = await definitions.listVersions(principal, request.path, request.query.cursor ?? "", request.query.limit ?? 50);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "version.page", page: apiPage(page.items.map(versionResource), page.nextCursor) };
    }
    default:
      return null;
  }
}

/** Runs, their commands, and command approvals — `application.runs` and its control surfaces. */
async function dispatchRuns(application: FactoryApplication, principal: FactoryPrincipal, request: FactoryApiRequest): Promise<FactoryApiResponse | null> {
  switch (request.kind) {
    case "run.start": {
      const result = await application.runs.start(principal, request.path, request.body, request.preconditions.expectedRevision, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "mutation.accepted", receipt: result.receipt };
    }
    case "run.get":
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "run.details", resource: await application.runs.read(principal, request.path) };
    case "run.list": {
      const page = await application.runs.list(principal, request.path.projectId, request.query);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "run.page", page: apiPage(page.items, page.nextCursor) };
    }
    case "run.control": {
      const result = request.body.action === "cancel"
        ? await application.runs.cancel(principal, request.path, request.preconditions.expectedRevision, request.preconditions.idempotencyKey, request.body.reason)
        : application.runControls
          ? await application.runControls.request(principal, request.path, request.body, request.preconditions.expectedRevision, request.preconditions.idempotencyKey)
          : (() => { throw new FactoryRunLifecycleError("factory_control_unavailable"); })();
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "mutation.accepted", receipt: result.receipt };
    }
    case "command.get":
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "command.resource", resource: await application.runs.readCommand(principal, { projectId: request.path.projectId, runId: request.path.runId }, request.path.commandId) };
    case "approval.decide": {
      if (!application.commandApprovals) throw new FactoryAssuranceCommandError("factory_command_approval_unavailable");
      const resource = await application.commandApprovals.decide(principal, request.path.projectId, request.path.runId, request.path.approvalId, request.body.contextDigest, request.body.choice, request.preconditions.expectedRevision, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "approval.resource", resource };
    }
    default:
      return null;
  }
}

/** Project grants — `application.grants`. */
async function dispatchGrants(application: FactoryApplication, principal: FactoryPrincipal, request: FactoryApiRequest): Promise<FactoryApiResponse | null> {
  switch (request.kind) {
    case "grant.list": {
      const page = await application.grants.list(principal, request.path.projectId, request.query);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "grant.page", page: apiPage(page.items.map(grantResource), page.nextCursor) };
    }
    case "grant.set": {
      const target = grantPrincipal(request.path.principalKind, request.path.principalId);
      const result = await application.grants.set(principal, { projectId: request.path.projectId, principal: target, action: request.path.action, expectedRevision: request.preconditions.expectedRevision, expiresAtMs: request.body.expiresAtMs }, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "grant.resource", resource: { principalKind: target.kind, principalId: target.id, action: request.path.action, revision: result.revision, expiresAtMs: result.expiresAtMs, revoked: false } };
    }
    case "grant.revoke": {
      const target = grantPrincipal(request.path.principalKind, request.path.principalId);
      const result = await application.grants.revoke(principal, { projectId: request.path.projectId, principal: target, action: request.path.action, expectedRevision: request.preconditions.expectedRevision }, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "grant.resource", resource: { principalKind: target.kind, principalId: target.id, action: request.path.action, revision: result.revision, expiresAtMs: result.expiresAtMs, revoked: true } };
    }
    default:
      return null;
  }
}

/** Service credentials — `application.credentials`, plus the token it signs on issue. */
async function dispatchCredentials(application: FactoryApplication, principal: FactoryPrincipal, request: FactoryApiRequest): Promise<FactoryApiResponse | null> {
  switch (request.kind) {
    case "service-credential.issue": {
      const result = await application.credentials.issue(principal, {
        ...request.path, scopes: request.body.scopes, expiresAtMs: request.body.expiresAtMs,
        expectedRevision: request.preconditions.expectedRevision as 0,
      }, request.preconditions.idempotencyKey);
      if (!factoryBootConfig.installationId) throw new FactoryServiceCredentialError("factory_service_credential_storage");
      const token = await signFactoryServiceToken(result, await getJwtSecret(), factoryBootConfig.installationId);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "service-credential.issued", resource: credentialResource(result), token };
    }
    case "service-credential.revoke": {
      const result = await application.credentials.revoke(principal, { ...request.path, expectedRevision: request.preconditions.expectedRevision }, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "service-credential.resource", resource: credentialResource(result) };
    }
    default:
      return null;
  }
}

/** Release trust and the release switch — `application.releaseAuthority`. */
async function dispatchReleaseAuthority(application: FactoryApplication, principal: FactoryPrincipal, request: FactoryApiRequest): Promise<FactoryApiResponse | null> {
  switch (request.kind) {
    case "release.trust.publish": {
      const result = await application.releaseAuthority.publishTrust(principal, { ...request.path, ...request.body, expectedRevision: request.preconditions.expectedRevision }, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "release.trust.resource", resource: releaseTrustResource(result) };
    }
    case "release.trust.revoke": {
      const result = await application.releaseAuthority.revokeTrust(principal, request.path.projectId, request.preconditions.expectedRevision, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "release.trust.resource", resource: releaseTrustResource(result) };
    }
    case "release.control.set": {
      const result = await application.releaseAuthority.setReleaseEnabled(principal, request.path.projectId, request.body.enabled, request.preconditions.expectedRevision, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "release.control.resource", resource: releaseControlResource(result) };
    }
    default:
      return null;
  }
}

/** Release operations, contracts, policies, and notifications — `application.releaseOperations`. */
async function dispatchReleases(application: FactoryApplication, principal: FactoryPrincipal, request: FactoryApiRequest): Promise<FactoryApiResponse | null> {
  switch (request.kind) {
    case "release.contract.put": {
      const result = await releaseOperations(application).putContract(principal, request.path.projectId, request.path.contractId, request.body, request.preconditions.expectedRevision, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "release.contract.resource", resource: result };
    }
    case "release.prepare": {
      const result = await releaseOperations(application).prepare(principal, request.path.projectId, request.body, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "release.operation.resource", resource: releaseOperationResource(result) };
    }
    case "release.get": {
      const result = await releaseOperations(application).inspect(principal, request.path.projectId, request.path.operationId);
      if (!result) throw new FactoryReleaseError("factory_release_not_found");
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "release.operation.resource", resource: releaseOperationResource(result) };
    }
    case "release.approval.request": {
      const result = await releaseOperations(application).requestApproval(principal, request.path.projectId, request.path.operationId, request.body, request.preconditions.expectedRevision, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "release.approval.resource", resource: result };
    }
    case "release.approval.decide": {
      const result = await releaseOperations(application).decideApproval(principal, request.path.projectId, request.path.approvalId, request.body, request.preconditions.expectedRevision, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "release.approval.resource", resource: result };
    }
    case "release.notification.list": {
      const page = await releaseOperations(application).listNotifications(principal, request.path.projectId, request.query);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "release.notification.page", page: apiPage(page.items, page.nextCursor) };
    }
    case "release.policy.put": {
      const result = await releaseOperations(application).putPolicy(principal, request.path.projectId, request.path.policyId, request.body, request.preconditions.expectedRevision, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "release.policy.resource", resource: result };
    }
    case "release.policy.delete": {
      const result = await releaseOperations(application).deletePolicy(principal, request.path.projectId, request.path.policyId, request.preconditions.expectedRevision, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "release.policy.resource", resource: result };
    }
    case "release.reconcile": {
      const result = await releaseOperations(application).reconcile(principal, request.path.projectId, request.path.operationId, request.body, request.preconditions.expectedRevision, request.preconditions.idempotencyKey);
      return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "release.operation.resource", resource: releaseOperationResource(result) };
    }
    default:
      return null;
  }
}

function unsupportedRequest(request: FactoryApiRequest): never {
  throw new Error(`Factory request kind is not handled: ${request.kind}`);
}

async function listDrafts(application: FactoryApplication, principal: FactoryPrincipal, projectId: string, query: FactoryDefinitionListQuery): Promise<FactoryApiResponse> {
  const limit = query.limit ?? 50;
  const scanLimit = query.availability === undefined ? limit : 200;
  const page = await application.definitions.listDrafts(principal, projectId, { after: query.cursor ?? "", limit: scanLimit, archived: query.archived, search: query.search });
  const matches = page.items.filter(item => query.availability === undefined || query.availability === draftAvailability(item, application.availableResourceClasses).availability);
  const items = matches.slice(0, limit).map(item => draftSummary(application, item));
  const nextCursor = matches.length > limit ? items[items.length - 1]!.factoryId : page.nextCursor;
  return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "draft.page", page: apiPage(items, nextCursor) };
}

function draftSummaryResponse(application: FactoryApplication, metadata: FactoryDraftMetadata): FactoryApiResponse {
  return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "draft.summary", resource: draftSummary(application, metadata) };
}

function draftSummary(application: FactoryApplication, metadata: FactoryDraftMetadata): FactoryDraftSummary {
  return { factoryId: metadata.factoryId, revision: metadata.revision, archived: metadata.archived, sourceDigest: metadata.sourceDigest, updatedAtMs: metadata.updatedAtMs, ...draftAvailability(metadata, application.availableResourceClasses) };
}

function draftDetails(application: FactoryApplication, item: FactoryDraft): FactoryDraftDetails {
  return { ...draftSummary(application, item), source: item.source };
}

function versionResponse(version: FactoryVersion): FactoryApiResponse {
  return { schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION, kind: "version.summary", resource: versionResource(version) };
}

function versionResource(version: FactoryVersion) {
  const { projectId: _projectId, ...resource } = version;
  return resource;
}

function grantResource(grant: FactoryGrantRecord) {
  return { principalKind: grant.principalKind, principalId: grant.principalId, action: grant.action, revision: grant.revision, expiresAtMs: grant.expiresAtMs, revoked: grant.revoked };
}

function credentialResource(record: import("$server/factory/service-credentials").FactoryServiceCredentialRecord) {
  return {
    serviceAccountId: record.serviceAccountId, credentialId: record.credentialId, scopes: record.scopes,
    revision: record.revision, issuedAtMs: record.issuedAtMs, expiresAtMs: record.expiresAtMs, revoked: record.revoked,
  };
}

function releaseTrustResource(record: FactoryReleaseTrustRecord) {
  const { projectId: _projectId, ...resource } = record;
  return resource;
}

function releaseControlResource(record: FactoryReleaseControl) {
  const { projectId: _projectId, ...resource } = record;
  return resource;
}

function releaseOperations(application: FactoryApplication): FactoryReleaseApplication {
  if (!application.releaseOperations) throw new FactoryReleaseError("factory_release_application_unavailable");
  return application.releaseOperations;
}

function releaseOperationResource(operation: FactoryReleaseOperation) {
  return {
    operationId: operation.operationId, runId: operation.runId, nodeInstanceId: operation.nodeInstanceId,
    candidateGeneration: operation.candidateGeneration, decisionId: operation.decisionId, candidateDigest: operation.candidateDigest,
    contractDigest: operation.contractDigest, executionEpoch: operation.executionEpoch, cancellationEpoch: operation.cancellationEpoch,
    releaseEnableEpoch: operation.releaseEnableEpoch, action: operation.action, destination: operation.destination,
    destinationDigest: operation.destinationDigest, requestDigest: operation.requestDigest, estimatedSpendMicros: operation.estimatedSpendMicros,
    deadlineMs: operation.deadlineMs, state: operation.state, dispatchGeneration: operation.dispatchGeneration,
    dispatchStarted: operation.dispatchStarted, archiveReady: operation.archiveReady,
    ...(operation.outcomeCode === undefined ? {} : { outcomeCode: operation.outcomeCode }),
    ...(operation.receipt === undefined ? {} : { receipt: operation.receipt }),
  };
}

function grantPrincipal(kind: "user" | "service", id: string): FactoryPrincipal {
  return kind === "user" ? { kind, id, authentication: "session" } : { kind, id, authentication: "service" };
}

function apiPage<T>(items: readonly T[], cursor: string | null): { items: readonly T[]; nextCursor?: string } {
  return { items, ...(cursor === null ? {} : { nextCursor: cursor }) };
}

