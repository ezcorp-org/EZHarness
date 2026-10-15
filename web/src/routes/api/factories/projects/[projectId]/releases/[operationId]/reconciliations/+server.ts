import { handleFactoryApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = event => handleFactoryApi(event, {
  scope: "write", build: async () => ({ kind: "release.reconcile", path: { projectId: event.params.projectId, operationId: event.params.operationId }, body: await readFactoryJson(event.request) }),
});
