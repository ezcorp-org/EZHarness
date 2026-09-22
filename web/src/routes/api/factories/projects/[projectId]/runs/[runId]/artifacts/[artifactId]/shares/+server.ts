import { handleFactoryConsoleSessionApi, readFactoryConsoleJson } from "../../../../../../../_console";
import type { RequestHandler } from "./$types";

/** Grants another project a read of this artifact's exact bytes. Human session only. */
export const POST: RequestHandler = event => handleFactoryConsoleSessionApi(event, {
  build: async () => ({ kind: "artifact.share", path: { projectId: event.params.projectId, runId: event.params.runId, artifactId: event.params.artifactId }, body: await readFactoryConsoleJson(event.request) }),
  run: async ({ principal, console, request }) => {
    if (request.kind !== "artifact.share") throw new TypeError("artifact.share expected");
    const resource = await console.tickets.share(principal, { projectId: event.params.projectId, runId: event.params.runId }, event.params.artifactId, request.body, request.preconditions.idempotencyKey);
    return { schemaVersion: "factory.api.response.v1", kind: "artifact.share.resource", resource } as const;
  },
});
