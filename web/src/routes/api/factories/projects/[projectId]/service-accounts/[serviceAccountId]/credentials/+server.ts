import { handleFactorySessionApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "service-credential.issue",
  path: { projectId: event.params.projectId, serviceAccountId: event.params.serviceAccountId },
  body: await readFactoryJson(event.request),
}));
