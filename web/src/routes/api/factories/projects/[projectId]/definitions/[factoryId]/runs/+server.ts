import { handleFactoryApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = event => handleFactoryApi(event, {
  scope: "chat",
  build: async () => ({ kind: "run.start", path: { projectId: event.params.projectId, factoryId: event.params.factoryId }, body: await readFactoryJson(event.request) }),
});
