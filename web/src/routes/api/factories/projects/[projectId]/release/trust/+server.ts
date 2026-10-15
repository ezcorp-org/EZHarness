import { handleFactorySessionApi, readFactoryJson } from "../../../../_shared";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "release.trust.publish",
  path: { projectId: event.params.projectId },
  body: await readFactoryJson(event.request),
}));

export const DELETE: RequestHandler = event => handleFactorySessionApi(event, () => ({
  kind: "release.trust.revoke",
  path: { projectId: event.params.projectId },
}));
