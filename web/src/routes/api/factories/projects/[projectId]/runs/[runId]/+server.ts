import { handleFactoryApi } from "../../../../_shared";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({ kind: "run.get", path: { projectId: event.params.projectId, runId: event.params.runId } }),
});
