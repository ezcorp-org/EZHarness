import { handleFactoryApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = event => handleFactoryApi(event, {
  scope: "write",
  build: async () => ({
    kind: "draft.validate",
    path: { projectId: event.params.projectId, factoryId: event.params.factoryId },
    body: await readFactoryJson(event.request),
  }),
});
