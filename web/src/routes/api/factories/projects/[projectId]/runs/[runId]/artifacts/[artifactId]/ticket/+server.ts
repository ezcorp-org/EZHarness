import { handleFactoryApi } from "../../../../../../../_shared";
import type { RequestHandler } from "./$types";

/** Mints a one-minute ticket for one artifact of one run, for the caller only. */
export const POST: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({ kind: "artifact.ticket", path: { projectId: event.params.projectId, runId: event.params.runId, artifactId: event.params.artifactId } }),
});
