import { checkAuth, requireSessionAuth } from "$server/auth/middleware";
import { factoryBootConfig } from "$server/factory/boot";
import { draftAvailability, getFactoryApplication, type FactoryApplication } from "$server/factory/application";
import { FactoryDefinitionError, type FactoryDraft, type FactoryDraftMetadata, type FactoryVersion } from "$server/factory/definitions";
import { FactoryGrantError, type FactoryGrantRecord, type FactoryPrincipal } from "$server/factory/grants";
import { FactoryMutationError } from "$server/factory/mutations";
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
  type ValidationIssue,
} from "@ezcorp/factory-sdk";

type FactoryRouteScope = "read" | "write" | "session";
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
  if (!factoryBootConfig.enabled) return errorResponse(404, "factory_disabled", "Factories are disabled.");
  const application = getFactoryApplication();
  if (!application) return errorResponse(503, "factory_application_unavailable", "Factory services are not ready.", true);

  const user = options.scope === "session" ? requireSessionAuth(event.locals) : checkAuth(event.locals);
  if (user instanceof Response) return user;
  if (options.scope !== "session") {
    const scope = requireScope(event.locals, options.scope);
    if (scope) return scope;
  }
  const principal = requestPrincipal(event.locals, user.id);
  if (!principal) return errorResponse(403, "factory_principal_unsupported", "This authentication method cannot use factories.");

  let request: FactoryApiRequest;
  try {
    request = buildValidatedRequest(event.request, await options.build());
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof SyntaxError) return errorResponse(400, "invalid_json", error.message);
    throw error;
  }

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

function grantPrincipal(kind: "user" | "service", id: string): FactoryPrincipal {
  return kind === "user" ? { kind, id, authentication: "session" } : { kind, id, authentication: "service" };
}

function apiPage<T>(items: readonly T[], cursor: string | null): { items: readonly T[]; nextCursor?: string } {
  return { items, ...(cursor === null ? {} : { nextCursor: cursor }) };
}

function response(value: FactoryApiResponse): Response {
  const validation = validateFactoryApiResponse(value);
  if (!validation.ok) throw new Error(`Invalid factory API response: ${validation.issues[0]?.code ?? "unknown"}`);
  return Response.json(value);
}

function mappedError(error: unknown): Response {
  if (error instanceof FactoryParseError) return errorResponse(400, error.code, error.message);
  if (error instanceof FactoryMutationError) {
    if (error.code === "idempotency_conflict") return errorResponse(409, error.code, "The idempotency key was already used for a different request.");
    if (error.code === "invalid_idempotency_key") return errorResponse(400, error.code, "A bounded Idempotency-Key is required.");
    return errorResponse(500, error.code, "The durable mutation receipt is unavailable.", true);
  }
  if (error instanceof FactoryGrantError) {
    if (error.code === "factory_grant_conflict" || error.code === "factory_grant_stale") return errorResponse(412, error.code, "The factory grant revision is stale.");
    if (error.code === "factory_grant_not_found") return errorResponse(404, error.code, "Factory grant not found.");
    if (error.code === "factory_forbidden" || error.code === "factory_human_required" || error.code === "factory_grant_widening") return errorResponse(403, error.code, "Factory authority is required.");
    if (error.code === "factory_grant_invalid" || error.code === "factory_page_invalid") return errorResponse(400, error.code, "The factory grant request is invalid.");
    return errorResponse(500, error.code, "Factory grant storage is unavailable.", true);
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
