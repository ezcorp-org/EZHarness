/**
 * The live console's request kinds (C09, W14), answered through the shared
 * factory route boundary: `handleFactoryApi` authenticates, validates, and
 * encodes; this dispatcher runs the console service; the route kit's error
 * table gives each console refusal its status. Registered once, from the server hooks.
 */
import type { FactoryApplication } from "$server/factory/application";
import type { FactoryPrincipal } from "$server/factory/grants";
import { registerFactoryDispatcher } from "./route-kit";
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
    case "package.affected-runs":
      return { schemaVersion: VERSION, kind: "package.affected-runs", page: await (await application.console()).packages.affectedRuns(principal, request.path.projectId, request.path.referenceId, request.query) };
    case "purge.preview":
      return { schemaVersion: VERSION, kind: "purge.preview", resource: await (await application.console()).purge.preview(principal, request.path.tenantId) };
    case "purge.request":
      return { schemaVersion: VERSION, kind: "purge.request.resource", resource: await (await application.console()).purge.request(principal, request.path.tenantId, request.body, request.preconditions.idempotencyKey) };
    case "restore.list":
      return { schemaVersion: VERSION, kind: "restore.page", page: { items: [...await (await application.console()).restores.list(principal, request.path.tenantId)] } };
    case "restore.sign":
      return { schemaVersion: VERSION, kind: "restore.signature", resource: await (await application.console()).restores.sign(principal, request.path.tenantId, request.path.restoreId, request.body) };
    default:
      return null;
  }
}

let registered = false;

/** Registers the console dispatcher once per process. Its refusals map through the route kit's one error table. */
export function registerFactoryConsole(): void {
  if (registered) return;
  registered = true;
  registerFactoryDispatcher(dispatchFactoryConsoleRequest);
}
