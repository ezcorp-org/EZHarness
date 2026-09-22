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

/**
 * Routes one validated request to the sub-service that owns its verb.
 *
 * Each `dispatch*` below answers for exactly one application surface and
 * returns `null` for a kind it does not own, so the chain reproduces the
 * single switch this replaced: the first owner answers, an unclaimed kind
 * still reaches `unsupportedRequest`, and the ORDER of the groups is
 * irrelevant because the kinds partition cleanly across them.
 */
async function dispatchFactoryRequest(application: FactoryApplication, principal: FactoryPrincipal, request: FactoryApiRequest): Promise<FactoryApiResponse> {
  return (
    (await dispatchDefinitions(application, principal, request)) ??
    (await dispatchRuns(application, principal, request)) ??
    (await dispatchGrants(application, principal, request)) ??
    (await dispatchCredentials(application, principal, request)) ??
    (await dispatchReleaseAuthority(application, principal, request)) ??
    (await dispatchReleases(application, principal, request)) ??
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

function response(value: FactoryApiResponse): Response {
  const validation = validateFactoryApiResponse(value);
  if (!validation.ok) throw new Error(`Invalid factory API response: ${validation.issues[0]?.code ?? "unknown"}`);
  return Response.json(value, { status: value.kind === "mutation.accepted" ? 202 : 200 });
}

type FactoryCodedError = Error & { readonly code: string; readonly diagnostics?: unknown };

/** One HTTP answer shared by a set of error codes of one family. */
interface ErrorAnswer {
  readonly status: number;
  readonly message: string;
  readonly codes: ReadonlySet<string>;
  /** Attach the error's `diagnostics` as the response issues. */
  readonly diagnostics?: true;
}

/**
 * The answers one error class can produce. A code no answer names falls back
 * to a retryable 500 with the `storage` message, or is rethrown when the family
 * has no such fallback.
 */
interface ErrorFamily {
  readonly type: abstract new (...args: never[]) => FactoryCodedError;
  readonly storage: string | null;
  readonly answers: readonly ErrorAnswer[];
}

function answer(status: number, message: string, ...codes: string[]): ErrorAnswer {
  return { status, message, codes: new Set(codes) };
}

// Every error class below extends Error directly, so at most one family
// matches and the list order does not decide the answer.
const ERROR_FAMILIES: readonly ErrorFamily[] = [
  {
    type: FactoryMutationError,
    storage: "The durable mutation receipt is unavailable.",
    answers: [
      answer(409, "The idempotency key was already used for a different request.", "idempotency_conflict"),
      answer(400, "A bounded Idempotency-Key is required.", "invalid_idempotency_key"),
    ],
  },
  {
    type: FactoryServiceCredentialError,
    storage: "Factory service credential storage is unavailable.",
    answers: [
      answer(412, "The service credential revision is stale.", "factory_service_credential_conflict"),
      answer(404, "Factory service credential not found.", "factory_service_credential_not_found"),
      answer(403, "Factory service credential authority is required.", "factory_service_credential_forbidden", "factory_human_required"),
      answer(400, "The factory service credential request is invalid.", "factory_service_credential_invalid"),
    ],
  },
  {
    type: FactoryReleaseAuthorityError,
    storage: "Release authority storage is unavailable.",
    answers: [
      answer(412, "The release authority revision is stale.", "factory_release_trust_conflict", "factory_release_control_conflict"),
      answer(404, "Release trust not found.", "factory_release_trust_missing"),
      answer(403, "Human release authority is required.", "factory_release_authority_human_required", "factory_release_authority_scope"),
      answer(400, "The release authority request is invalid.", "factory_release_authority_invalid"),
    ],
  },
  {
    type: FactoryAssuranceError,
    storage: "Release assurance storage is unavailable.",
    answers: [
      answer(404, "Release assurance record not found.", "factory_assurance_not_found"),
      answer(412, "The release assurance precondition is stale.", "factory_assurance_stale", "factory_assurance_conflict"),
      answer(400, "The release assurance request is invalid.", "factory_assurance_invalid"),
      answer(422, "The candidate does not satisfy the current assurance contract.", "factory_assurance_claim_failed", "factory_assurance_evidence_stale"),
    ],
  },
  {
    type: FactoryAssuranceCommandError,
    storage: "Factory approval storage is unavailable.",
    answers: [
      answer(503, "Factory approval services are not ready.", "factory_command_approval_unavailable"),
      answer(404, "Factory approval not found.", "factory_command_approval_not_found"),
      answer(403, "Factory approval authority is required.", "factory_command_approval_forbidden", "factory_command_approval_scope"),
      answer(412, "The factory approval precondition is stale.", "factory_command_approval_stale", "factory_command_approval_conflict"),
      answer(400, "The factory approval request is invalid.", "factory_command_approval_invalid"),
    ],
  },
  {
    type: FactoryReleaseError,
    storage: "Release storage is unavailable.",
    answers: [
      answer(503, "Release services are not ready.", "factory_release_application_unavailable"),
      answer(503, "Release reconciliation proof timed out.", "factory_release_reconciliation_timeout"),
      answer(404, "Release operation not found.", "factory_release_not_found"),
      answer(409, "A different release record already uses this identity.", "factory_release_conflict", "factory_release_policy_conflict"),
      answer(412, "The release precondition is stale.", "factory_release_precondition", "factory_release_policy_stale", "factory_release_reconciliation_stale", "factory_release_not_claimable", "factory_release_stale", "factory_release_authority_stale", "factory_release_trust_changed", "factory_release_destination_changed"),
      answer(403, "The automatic release policy does not permit this operation.", "factory_release_policy_denied"),
      answer(403, "A human session is required to reconcile a release.", "factory_release_human_required"),
      answer(422, "The provider evidence does not prove the requested reconciliation.", "factory_release_absence_unproved", "factory_release_foreign_receipt"),
      answer(400, "The release request is invalid.", "factory_release_invalid", "factory_release_policy_invalid", "factory_release_reconciliation_invalid"),
    ],
  },
  {
    type: FactoryGrantError,
    storage: "Factory grant storage is unavailable.",
    answers: [
      answer(412, "The factory grant revision is stale.", "factory_grant_conflict", "factory_grant_stale"),
      answer(404, "Factory grant not found.", "factory_grant_not_found"),
      answer(403, "Factory authority is required.", "factory_forbidden", "factory_human_required", "factory_grant_widening"),
      answer(400, "The factory grant request is invalid.", "factory_grant_invalid", "factory_page_invalid"),
    ],
  },
  {
    type: FactoryRunLifecycleError,
    storage: "Factory run storage is unavailable.",
    answers: [
      answer(412, "The factory run revision is stale.", "factory_revision_conflict", "factory_revision_invalid"),
      answer(404, "Factory run or command not found.", "factory_run_not_found", "factory_command_not_found"),
      answer(409, "The factory run request conflicts with current state.", "factory_run_terminal", "factory_run_stopped", "factory_definition_conflict"),
      answer(400, "The factory run request is invalid.", "factory_input_invalid", "factory_page_invalid"),
      answer(503, "The required factory execution service is unavailable.", "factory_interpreter_unavailable", "factory_control_unavailable"),
    ],
  },
  {
    type: FactoryRunControlError,
    storage: null,
    answers: [
      answer(412, "The factory run control precondition is stale.", "factory_control_stale"),
      answer(403, "The replacement factory widens the current run authority.", "factory_control_widening"),
      answer(422, "The factory run control cannot apply to the current node.", "factory_control_invalid"),
      answer(500, "Factory run control authority is corrupt.", "factory_control_corrupt"),
    ],
  },
  {
    type: FactoryDefinitionError,
    storage: "Factory definition storage is unavailable.",
    answers: [
      answer(412, "The factory definition revision is stale.", "factory_revision_conflict", "factory_revision_invalid"),
      answer(404, "Factory definition not found.", "factory_definition_not_found", "factory_version_not_found"),
      answer(409, "The factory version conflicts with existing content.", "factory_version_conflict"),
      { ...answer(422, "The factory definition is not publishable.", "factory_definition_invalid"), diagnostics: true },
      answer(400, "The factory definition request is invalid.", "factory_definition_schema_invalid", "factory_definition_identity_mismatch", "factory_definition_too_large", "factory_format_invalid", "factory_page_invalid"),
    ],
  },
];

/**
 * Maps a thrown factory error to its HTTP answer. A 5xx answer is retryable and
 * a 4xx answer is not; an error outside every family is rethrown.
 */
function mappedError(error: unknown): Response {
  if (error instanceof FactoryParseError) return errorResponse(400, error.code, error.message);
  const family = ERROR_FAMILIES.find(candidate => error instanceof candidate.type);
  if (!family) throw error;
  const { code, diagnostics } = error as FactoryCodedError;
  const found = family.answers.find(candidate => candidate.codes.has(code));
  if (found) return errorResponse(found.status, code, found.message, found.status >= 500, found.diagnostics ? diagnostics as readonly ValidationIssue[] : undefined);
  if (family.storage === null) throw error;
  return errorResponse(500, code, family.storage, true);
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
