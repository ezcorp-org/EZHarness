import { factoryConsoleError, factoryDownloadResponse, handleFactoryConsoleApi } from "../../../../../../../_console";
import type { RequestHandler } from "./$types";

/**
 * Artifact bytes, as a download only. The ticket names the artifact and the
 * caller; the caller must still be authenticated and still hold read.
 */
export const GET: RequestHandler = event => handleFactoryConsoleApi(event, {
  scope: "read",
  build: () => ({ kind: "artifact.ticket", path: { projectId: event.params.projectId, runId: event.params.runId, artifactId: event.params.artifactId } }),
  run: async ({ principal, console }) => {
    const ticket = event.url.searchParams.get("ticket");
    if (!ticket) return factoryConsoleError(403, "factory_ticket_invalid", "An artifact ticket is required.");
    const download = await console.tickets.download(principal, { projectId: event.params.projectId, runId: event.params.runId }, event.params.artifactId, ticket);
    return factoryDownloadResponse(download.bytes, download.artifactId);
  },
});
