import { handleFactoryApi, readFactoryJson } from "../../../../_shared";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = event => handleFactoryApi(event, {
  scope: "write",
  build: async () => ({ kind: "draft.import", path: { projectId: event.params.projectId }, body: await readFactoryJson(event.request) }),
});
