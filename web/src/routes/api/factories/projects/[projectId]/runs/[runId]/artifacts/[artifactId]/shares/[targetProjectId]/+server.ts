import { handleFactorySessionApi } from "../../../../../../../../_shared";
import type { RequestHandler } from "./$types";

export const DELETE: RequestHandler = event => handleFactorySessionApi(event, () => ({
  kind: "artifact.unshare", path: { projectId: event.params.projectId, runId: event.params.runId, artifactId: event.params.artifactId, targetProjectId: event.params.targetProjectId },
}));
