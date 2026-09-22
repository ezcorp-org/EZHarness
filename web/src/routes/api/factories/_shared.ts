import { checkAuth, checkRole, requireSessionAuth } from "$server/auth/middleware";
import { FACTORY_DISABLED_REASON, factoryBootConfig } from "$server/factory/boot";
import { draftAvailability, getFactoryApplication, type FactoryApplication } from "$server/factory/application";
import { FactoryDefinitionError, type FactoryDraft, type FactoryDraftMetadata, type FactoryVersion } from "$server/factory/definitions";
import { FactoryGrantError, type FactoryGrantRecord, type FactoryPrincipal } from "$server/factory/grants";
import { FactoryRunLifecycleError } from "$server/factory/run-lifecycle";
import { FactoryMutationError } from "$server/factory/mutations";
import { FactoryServiceCredentialError } from "$server/factory/service-credentials";
import { FactoryReleaseAuthorityError, type FactoryReleaseControl, type FactoryReleaseTrustRecord } from "$server/factory/release-authority";
import { FactoryAssuranceError } from "$server/factory/assurance";
import { FactoryReleaseError, type FactoryReleaseOperation } from "$server/factory/releases";
import { FactoryAssuranceCommandError } from "$server/factory/assurance-commands";
import { FactoryRunControlError } from "$server/factory/run-controls";
import type { FactoryReleaseApplication } from "$server/factory/release-application";
import { signFactoryServiceToken } from "$server/auth/factory-service-token";
import { getJwtSecret } from "$server/auth/jwt";
import { readBoundedJson } from "$lib/server/security/bounded-json";
import { requireScope } from "$lib/server/security/api-keys";
import {
  FACTORY_API_REQUEST_SCHEMA_VERSION,
  FACTORY_API_RESPONSE_SCHEMA_VERSION,
  FACTORY_LIMITS,
  FactoryParseError,
  factoryApiPayloadDigest,
  validateFactoryApiRequest,
  validateFactoryApiResponse,
  type FactoryApiRequest,
  type FactoryApiResponse,
  type FactoryDefinitionListQuery,
  type FactoryDraftDetails,
  type FactoryDraftSummary,
  type FactoryGrantListQuery,
  type FactoryListQuery,
  type FactoryRunListQuery,
  type ValidationIssue,
} from "@ezcorp/factory-sdk";

// C01's authority table names five API-key columns for factory actions.
// `admin` covers tenant-administrator rows; `session` still means no key of any
// scope can call the verb.
type FactoryRouteScope = "read" | "write" | "chat" | "admin" | "session";
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
]);

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
  if (!factoryBootConfig.enabled) return errorResponse(404, FACTORY_DISABLED_REASON, "Factories are disabled.");
  const application = getFactoryApplication();
  if (!application) return errorResponse(503, "factory_application_unavailable", "Factory services are not ready.", true);

  let principal: FactoryPrincipal;
  const service = event.locals.factoryServicePrincipal;
  if (options.scope !== "session" && service) {
    // A service credential carries only C01's delegable scopes. The admin rows
    // belong to a tenant administrator, and C01 is explicit that a service
    // principal cannot create consent or trust, so an admin row is refused here
    // rather than looked up in a vocabulary that cannot express it.
    if (options.scope === "admin") return errorResponse(403, "factory_service_scope_required", "A service credential cannot perform a tenant administrator action.");
    if (!service.scopes.includes(options.scope)) return errorResponse(403, "factory_service_scope_required", "The service credential does not permit this factory operation.");
    principal = { kind: "service", id: service.serviceAccountId, authentication: "service", credential: service };
  } else {
    const user = options.scope === "session" ? requireSessionAuth(event.locals) : checkAuth(event.locals);
    if (user instanceof Response) return user;
    if (options.scope !== "session") {
      const scope = requireScope(event.locals, options.scope);
      if (scope) return scope;
    }
    // `requireScope(locals, "admin")` is allow-all for a cookie session, because
    // a cookie carries no `apiKeyScopes`. C01 gives the admin rows to a tenant
    // administrator, so the admin scope is gated on both axes here — the role as
    // well as the key scope — rather than on the key alone.
    if (options.scope === "admin") {
      const role = checkRole(event.locals, "admin");
      if (role instanceof Response) return role;
    }
    const userPrincipal = requestPrincipal(event.locals, user.id);
    if (!userPrincipal) return errorResponse(403, "factory_principal_unsupported", "This authentication method cannot use factories.");
    principal = userPrincipal;
  }

  let request: FactoryApiRequest;
  try {
    request = buildValidatedRequest(event.request, await options.build());
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof SyntaxError) return errorResponse(400, "invalid_json", error.message);
    throw error;
  }
  if (service && request.path.projectId !== service.projectId) return errorResponse(403, "factory_service_project_mismatch", "The service credential does not permit this project.");

  try {
    return response(await dispatchFactoryRequest(application, principal, request));
  } catch (error) {
    return mappedError(error);
  }
}

function requestPrincipal(locals: App.Locals, userId: string): FactoryPrincipal | null {
  if (locals.authMethod === "session") return { kind: "user", id: userId, authentication: "session" };
  if (locals.authMethod === "api-key") return { kind: "user", id: userId, authentication: "api-key" };
  return null;
}

function buildValidatedRequest(httpRequest: Request, fields: FactoryRouteFields): FactoryApiRequest {
  const base = { schemaVersion: FACTORY_API_REQUEST_SCHEMA_VERSION, ...fields };
  let candidate: unknown = base;
  if (typeof fields.kind === "string" && MUTATION_KINDS.has(fields.kind)) {
    const ifMatch = httpRequest.headers.get("If-Match");
    if (ifMatch === null || !/^(0|[1-9][0-9]*)$/.test(ifMatch) || !Number.isSafeInteger(Number(ifMatch))) {
      throw errorResponse(412, "precondition_required", "A valid If-Match revision is required.");
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
  return errorResponse(precondition ? 412 : 400, issues[0]?.code ?? "invalid_request", issues[0]?.message ?? "Invalid factory request.", false, issues);
}

async function dispatchFactoryRequest(application: FactoryApplication, principal: FactoryPrincipal, request: FactoryApiRequest): Promise<FactoryApiResponse> {
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
      return unsupportedRequest(request);
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

function response(value: FactoryApiResponse): Response {
  const validation = validateFactoryApiResponse(value);
  if (!validation.ok) throw new Error(`Invalid factory API response: ${validation.issues[0]?.code ?? "unknown"}`);
  return Response.json(value, { status: value.kind === "mutation.accepted" ? 202 : 200 });
}

function mappedError(error: unknown): Response {
  if (error instanceof FactoryParseError) return errorResponse(400, error.code, error.message);
  if (error instanceof FactoryMutationError) {
    if (error.code === "idempotency_conflict") return errorResponse(409, error.code, "The idempotency key was already used for a different request.");
    if (error.code === "invalid_idempotency_key") return errorResponse(400, error.code, "A bounded Idempotency-Key is required.");
    return errorResponse(500, error.code, "The durable mutation receipt is unavailable.", true);
  }
  if (error instanceof FactoryServiceCredentialError) {
    if (error.code === "factory_service_credential_conflict") return errorResponse(412, error.code, "The service credential revision is stale.");
    if (error.code === "factory_service_credential_not_found") return errorResponse(404, error.code, "Factory service credential not found.");
    if (error.code === "factory_service_credential_forbidden" || error.code === "factory_human_required") return errorResponse(403, error.code, "Factory service credential authority is required.");
    if (error.code === "factory_service_credential_invalid") return errorResponse(400, error.code, "The factory service credential request is invalid.");
    return errorResponse(500, error.code, "Factory service credential storage is unavailable.", true);
  }
  if (error instanceof FactoryReleaseAuthorityError) {
    if (error.code === "factory_release_trust_conflict" || error.code === "factory_release_control_conflict") return errorResponse(412, error.code, "The release authority revision is stale.");
    if (error.code === "factory_release_trust_missing") return errorResponse(404, error.code, "Release trust not found.");
    if (error.code === "factory_release_authority_human_required" || error.code === "factory_release_authority_scope") return errorResponse(403, error.code, "Human release authority is required.");
    if (error.code === "factory_release_authority_invalid") return errorResponse(400, error.code, "The release authority request is invalid.");
    return errorResponse(500, error.code, "Release authority storage is unavailable.", true);
  }
  if (error instanceof FactoryAssuranceError) {
    if (error.code === "factory_assurance_not_found") return errorResponse(404, error.code, "Release assurance record not found.");
    if (error.code === "factory_assurance_stale" || error.code === "factory_assurance_conflict") return errorResponse(412, error.code, "The release assurance precondition is stale.");
    if (error.code === "factory_assurance_invalid") return errorResponse(400, error.code, "The release assurance request is invalid.");
    if (error.code === "factory_assurance_claim_failed" || error.code === "factory_assurance_evidence_stale") return errorResponse(422, error.code, "The candidate does not satisfy the current assurance contract.");
    return errorResponse(500, error.code, "Release assurance storage is unavailable.", true);
  }
  if (error instanceof FactoryAssuranceCommandError) {
    if (error.code === "factory_command_approval_unavailable") return errorResponse(503, error.code, "Factory approval services are not ready.", true);
    if (error.code === "factory_command_approval_not_found") return errorResponse(404, error.code, "Factory approval not found.");
    if (error.code === "factory_command_approval_forbidden" || error.code === "factory_command_approval_scope") return errorResponse(403, error.code, "Factory approval authority is required.");
    if (error.code === "factory_command_approval_stale" || error.code === "factory_command_approval_conflict") return errorResponse(412, error.code, "The factory approval precondition is stale.");
    if (error.code === "factory_command_approval_invalid") return errorResponse(400, error.code, "The factory approval request is invalid.");
    return errorResponse(500, error.code, "Factory approval storage is unavailable.", true);
  }
  if (error instanceof FactoryReleaseError) {
    if (error.code === "factory_release_application_unavailable") return errorResponse(503, error.code, "Release services are not ready.", true);
    if (error.code === "factory_release_reconciliation_timeout") return errorResponse(503, error.code, "Release reconciliation proof timed out.", true);
    if (error.code === "factory_release_not_found") return errorResponse(404, error.code, "Release operation not found.");
    if (error.code === "factory_release_conflict" || error.code === "factory_release_policy_conflict") return errorResponse(409, error.code, "A different release record already uses this identity.");
    if (error.code === "factory_release_precondition" || error.code === "factory_release_policy_stale" || error.code === "factory_release_reconciliation_stale" || error.code === "factory_release_not_claimable" || error.code === "factory_release_stale" || error.code === "factory_release_authority_stale" || error.code === "factory_release_trust_changed" || error.code === "factory_release_destination_changed") return errorResponse(412, error.code, "The release precondition is stale.");
    if (error.code === "factory_release_policy_denied") return errorResponse(403, error.code, "The automatic release policy does not permit this operation.");
    if (error.code === "factory_release_human_required") return errorResponse(403, error.code, "A human session is required to reconcile a release.");
    if (error.code === "factory_release_absence_unproved" || error.code === "factory_release_foreign_receipt") return errorResponse(422, error.code, "The provider evidence does not prove the requested reconciliation.");
    if (error.code === "factory_release_invalid" || error.code === "factory_release_policy_invalid" || error.code === "factory_release_reconciliation_invalid") return errorResponse(400, error.code, "The release request is invalid.");
    return errorResponse(500, error.code, "Release storage is unavailable.", true);
  }
  if (error instanceof FactoryGrantError) {
    if (error.code === "factory_grant_conflict" || error.code === "factory_grant_stale") return errorResponse(412, error.code, "The factory grant revision is stale.");
    if (error.code === "factory_grant_not_found") return errorResponse(404, error.code, "Factory grant not found.");
    if (error.code === "factory_forbidden" || error.code === "factory_human_required" || error.code === "factory_grant_widening") return errorResponse(403, error.code, "Factory authority is required.");
    if (error.code === "factory_grant_invalid" || error.code === "factory_page_invalid") return errorResponse(400, error.code, "The factory grant request is invalid.");
    return errorResponse(500, error.code, "Factory grant storage is unavailable.", true);
  }
  if (error instanceof FactoryRunLifecycleError) {
    if (error.code === "factory_revision_conflict" || error.code === "factory_revision_invalid") return errorResponse(412, error.code, "The factory run revision is stale.");
    if (error.code === "factory_run_not_found" || error.code === "factory_command_not_found") return errorResponse(404, error.code, "Factory run or command not found.");
    if (error.code === "factory_run_terminal" || error.code === "factory_run_stopped" || error.code === "factory_definition_conflict") return errorResponse(409, error.code, "The factory run request conflicts with current state.");
    if (error.code === "factory_input_invalid" || error.code === "factory_page_invalid") return errorResponse(400, error.code, "The factory run request is invalid.");
    if (error.code === "factory_interpreter_unavailable" || error.code === "factory_control_unavailable") return errorResponse(503, error.code, "The required factory execution service is unavailable.", true);
    return errorResponse(500, error.code, "Factory run storage is unavailable.", true);
  }
  if (error instanceof FactoryRunControlError) {
    if (error.code === "factory_control_stale") return errorResponse(412, error.code, "The factory run control precondition is stale.");
    if (error.code === "factory_control_widening") return errorResponse(403, error.code, "The replacement factory widens the current run authority.");
    if (error.code === "factory_control_invalid") return errorResponse(422, error.code, "The factory run control cannot apply to the current node.");
    if (error.code === "factory_control_corrupt") return errorResponse(500, error.code, "Factory run control authority is corrupt.", true);
  }
  if (error instanceof FactoryDefinitionError) {
    if (error.code === "factory_revision_conflict" || error.code === "factory_revision_invalid") return errorResponse(412, error.code, "The factory definition revision is stale.");
    if (error.code === "factory_definition_not_found" || error.code === "factory_version_not_found") return errorResponse(404, error.code, "Factory definition not found.");
    if (error.code === "factory_version_conflict") return errorResponse(409, error.code, "The factory version conflicts with existing content.");
    if (error.code === "factory_definition_invalid") return errorResponse(422, error.code, "The factory definition is not publishable.", false, error.diagnostics as readonly ValidationIssue[]);
    if (error.code === "factory_definition_schema_invalid" || error.code === "factory_definition_identity_mismatch" || error.code === "factory_definition_too_large" || error.code === "factory_format_invalid" || error.code === "factory_page_invalid") return errorResponse(400, error.code, "The factory definition request is invalid.");
    return errorResponse(500, error.code, "Factory definition storage is unavailable.", true);
  }
  throw error;
}

function errorResponse(status: number, code: string, message: string, retryable = false, issues?: readonly ValidationIssue[]): Response {
  const value = {
    schemaVersion: FACTORY_API_RESPONSE_SCHEMA_VERSION,
    kind: "error",
    error: { code, message, retryable, ...(issues === undefined ? {} : { issues }) },
  } as FactoryApiResponse;
  const validation = validateFactoryApiResponse(value);
  if (!validation.ok) throw new Error(`Invalid factory API error response: ${validation.issues[0]?.code ?? "unknown"}`);
  return Response.json(value, { status });
}
