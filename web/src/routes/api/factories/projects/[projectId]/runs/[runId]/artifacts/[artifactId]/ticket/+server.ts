import { handleFactoryConsoleApi } from "../../../../../../../_console";
import type { RequestHandler } from "./$types";

/** Mints a one-minute ticket for one artifact of one run, for the caller only. */
export const POST: RequestHandler = event => handleFactoryConsoleApi(event, {
  scope: "read",
  build: () => ({ kind: "artifact.ticket", path: { projectId: event.params.projectId, runId: event.params.runId, artifactId: event.params.artifactId } }),
  run: async ({ principal, console }) => {
    const base = `/api/factories/projects/${encodeURIComponent(event.params.projectId)}/runs/${encodeURIComponent(event.params.runId)}/artifacts/${encodeURIComponent(event.params.artifactId)}/download`;
    const ticket = await console.tickets.issue(principal, { projectId: event.params.projectId, runId: event.params.runId }, event.params.artifactId, base);
    return { schemaVersion: "factory.api.response.v1", kind: "artifact.ticket", ticket } as const;
  },
});
