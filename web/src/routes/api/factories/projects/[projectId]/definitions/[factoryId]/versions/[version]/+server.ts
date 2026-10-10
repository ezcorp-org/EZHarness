import { handleFactoryApi } from "../../../../../../_shared";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({
    kind: "version.get",
    path: { projectId: event.params.projectId, factoryId: event.params.factoryId, version: event.params.version },
  }),
});
