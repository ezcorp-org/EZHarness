import { handleFactoryApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = event => handleFactoryApi(event, {
  scope: "chat",
  build: async () => ({ kind: "run.control", path: { projectId: event.params.projectId, runId: event.params.runId }, body: await readFactoryJson(event.request) }),
});
