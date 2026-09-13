import { handleFactorySessionApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "release.approval.request", path: { projectId: event.params.projectId, operationId: event.params.operationId }, body: await readFactoryJson(event.request),
}));
