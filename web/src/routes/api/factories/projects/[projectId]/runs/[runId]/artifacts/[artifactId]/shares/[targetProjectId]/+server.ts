import { handleFactoryConsoleSessionApi } from "../../../../../../../../_console";
import type { RequestHandler } from "./$types";

export const DELETE: RequestHandler = event => handleFactoryConsoleSessionApi(event, {
  build: () => ({ kind: "artifact.unshare", path: { projectId: event.params.projectId, runId: event.params.runId, artifactId: event.params.artifactId, targetProjectId: event.params.targetProjectId } }),
  run: async ({ principal, console, request }) => {
    if (request.kind !== "artifact.unshare") throw new TypeError("artifact.unshare expected");
    const resource = await console.tickets.unshare(principal, { projectId: event.params.projectId, runId: event.params.runId }, event.params.artifactId, event.params.targetProjectId, request.preconditions.idempotencyKey);
    return { schemaVersion: "factory.api.response.v1", kind: "artifact.share.resource", resource } as const;
  },
});
