import { handleFactoryApi } from "../../../../_shared";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "chat", build: () => ({ kind: "release.get", path: { projectId: event.params.projectId, operationId: event.params.operationId } }),
});
