/**
 * The live console's request kinds (C09, W14), answered through the shared
 * factory route boundary: `handleFactoryApi` authenticates, validates, and
 * encodes; this dispatcher runs the console service; the error families below
 * give each console refusal its status. Registered once, from the server hooks.
 */
import type { FactoryApplication } from "$server/factory/application";
import { FactoryArtifactAccessError } from "$server/factory/artifact-access";
import { FactoryArtifactError } from "$server/factory/artifacts";
import { FactoryConsoleError } from "$server/factory/console-tokens";
import type { FactoryPrincipal } from "$server/factory/grants";
import { FactoryPackagePreparationError } from "$server/factory/package-preparation";
import { answer, registerFactoryDispatcher, registerFactoryErrorFamily, type ErrorFamily } from "./route-kit";
import { FACTORY_API_RESPONSE_SCHEMA_VERSION as VERSION, type FactoryApiRequest, type FactoryApiResponse } from "@ezcorp/factory-sdk";

/** The download path a ticket is valid for; the ticket itself binds the caller and the bytes. */
export function factoryArtifactDownloadPath(path: { readonly projectId: string; readonly runId: string; readonly artifactId: string }): string {
  return `/api/factories/projects/${encodeURIComponent(path.projectId)}/runs/${encodeURIComponent(path.runId)}/artifacts/${encodeURIComponent(path.artifactId)}/download`;
}

/** The run an artifact path names. */
export function factoryRunKey(path: { readonly projectId: string; readonly runId: string }): { readonly projectId: string; readonly runId: string } {
  return { projectId: path.projectId, runId: path.runId };
}

export async function dispatchFactoryConsoleRequest(application: FactoryApplication, principal: FactoryPrincipal, request: FactoryApiRequest): Promise<FactoryApiResponse | null> {
  switch (request.kind) {
    case "run.inspect": {
      const result = await (await application.console()).inspections.inspect(principal, request.path, request.query);
      return "section" in result ? { schemaVersion: VERSION, kind: "run.inspection.page", resource: result } : { schemaVersion: VERSION, kind: "run.inspection", resource: result };
    }
    case "artifact.ticket":
      return { schemaVersion: VERSION, kind: "artifact.ticket", ticket: await (await application.console()).tickets.issue(principal, factoryRunKey(request.path), request.path.artifactId, factoryArtifactDownloadPath(request.path)) };
    case "artifact.share":
      return { schemaVersion: VERSION, kind: "artifact.share.resource", resource: await (await application.console()).tickets.share(principal, factoryRunKey(request.path), request.path.artifactId, request.body, request.preconditions.idempotencyKey) };
    case "artifact.unshare":
      return { schemaVersion: VERSION, kind: "artifact.share.resource", resource: await (await application.console()).tickets.unshare(principal, factoryRunKey(request.path), request.path.artifactId, request.path.targetProjectId, request.preconditions.idempotencyKey) };
    case "validator.material":
      return { schemaVersion: VERSION, kind: "validator.material", resource: await (await application.console()).inspections.material(principal, request.path.projectId, request.query) };
    case "package.list":
      return { schemaVersion: VERSION, kind: "package.page", page: await (await application.console()).packages.list(principal, request.path.projectId, request.query) };
    case "package.install":
      return { schemaVersion: VERSION, kind: "package.resource", resource: await (await application.console()).packages.install(principal, request.path.projectId, request.body, request.preconditions.idempotencyKey) };
    case "package.trust":
      return { schemaVersion: VERSION, kind: "package.resource", resource: await (await application.console()).packages.transition(principal, request.path.projectId, request.path.referenceId, request.body.transition, request.preconditions.expectedRevision, request.preconditions.idempotencyKey) };
    case "package.impact":
      return { schemaVersion: VERSION, kind: "package.impact", resource: await (await application.console()).packages.impact(principal, request.path.projectId, request.path.referenceId, request.query.transition) };
    case "purge.preview":
      return { schemaVersion: VERSION, kind: "purge.preview", resource: await (await application.console()).purge.preview(principal, request.path.tenantId) };
    case "purge.request":
      return { schemaVersion: VERSION, kind: "purge.request.resource", resource: await (await application.console()).purge.request(principal, request.path.tenantId, request.body, request.preconditions.idempotencyKey) };
    default:
      return null;
  }
}

const ARTIFACT_ANSWERS = [
  // An unshared or mismatched read is "unavailable" in the service and a plain 404 here, so it never tells a share apart from nothing.
  answer(404, "Artifact not found.", "factory_artifact_not_found", "factory_artifact_grant_not_found", "factory_artifact_unavailable"),
  answer(403, "A human session is required to share an artifact.", "factory_human_required"),
  answer(409, "A different share already uses this identity.", "factory_artifact_conflict", "factory_artifact_grant_conflict"),
  answer(400, "The artifact request is invalid.", "factory_artifact_digest_invalid", "factory_artifact_identity_invalid", "factory_artifact_reference_invalid", "factory_artifact_size_invalid", "factory_artifact_json_invalid", "factory_artifact_grant_invalid"),
];

/** Every console refusal, by class. An unnamed code is a retryable storage failure, or rethrown. */
export const FACTORY_CONSOLE_ERROR_FAMILIES: readonly ErrorFamily[] = [
  {
    type: FactoryConsoleError,
    storage: null,
    answers: [
      answer(400, "The event cursor is not valid for this run.", "factory_cursor_invalid"),
      answer(410, "The event cursor expired. Take a new snapshot.", "factory_cursor_expired"),
      answer(400, "The page request is invalid.", "factory_page_invalid"),
      answer(404, "Runner package not found.", "factory_package_not_found"),
      answer(403, "A tenant administrator is required.", "factory_package_admin_required"),
      answer(400, "The confirmation must name this tenant exactly.", "factory_purge_confirmation"),
      answer(404, "Artifact not found.", "factory_artifact_not_found"),
      answer(403, "The artifact ticket is not valid for this request.", "factory_ticket_invalid"),
      answer(410, "The artifact ticket expired.", "factory_ticket_expired"),
      answer(400, "Name a published version or a validator lock digest, not both.", "factory_material_query_invalid"),
      answer(404, "No validator material is registered for this version or lock.", "factory_material_not_found"),
    ],
  },
  {
    type: FactoryPackagePreparationError,
    storage: "Package storage is unavailable.",
    answers: [
      answer(412, "The package trust revision is stale or the transition is not allowed.", "factory_package_trust_conflict"),
      answer(403, "A human tenant administrator session is required.", "factory_package_human_required"),
      answer(400, "The package request is invalid.", "factory_package_trust_invalid", "factory_package_reference_invalid", "factory_package_manifest_name_invalid"),
      answer(404, "The installed package release was not found.", "factory_package_release_unavailable", "factory_package_binding_missing"),
      answer(409, "A different package is already bound to this reference.", "factory_package_binding_conflict"),
    ],
  },
  { type: FactoryArtifactError, storage: "Artifact storage is unavailable.", answers: ARTIFACT_ANSWERS },
  { type: FactoryArtifactAccessError, storage: "Artifact storage is unavailable.", answers: ARTIFACT_ANSWERS },
];

let registered = false;

/** Registers the console dispatcher and its error families once per process. */
export function registerFactoryConsole(): void {
  if (registered) return;
  registered = true;
  registerFactoryDispatcher(dispatchFactoryConsoleRequest);
  for (const family of FACTORY_CONSOLE_ERROR_FAMILIES) registerFactoryErrorFamily(family);
}
