import { factoryRunKey } from "$lib/server/factory/console-dispatch";
import { factoryErrorResponse } from "$lib/server/factory/route-kit";
import { factoryDownloadResponse, handleFactoryConsoleRaw } from "../../../../../../../_console";
import type { RequestHandler } from "./$types";

/**
 * Artifact bytes, as a download only. The ticket names the artifact and the
 * caller; the caller must still be authenticated and still hold read.
 */
export const GET: RequestHandler = event => handleFactoryConsoleRaw(event, {
  build: () => ({ kind: "artifact.ticket", path: { projectId: event.params.projectId, runId: event.params.runId, artifactId: event.params.artifactId } }),
  run: async ({ principal, console, request }) => {
    const ticket = event.url.searchParams.get("ticket");
    if (!ticket) return factoryErrorResponse(403, "factory_ticket_invalid", "An artifact ticket is required.");
    const download = await console.tickets.download(principal, factoryRunKey(request.path), request.path.artifactId, ticket);
    return factoryDownloadResponse(download.bytes, download.artifactId);
  },
});
