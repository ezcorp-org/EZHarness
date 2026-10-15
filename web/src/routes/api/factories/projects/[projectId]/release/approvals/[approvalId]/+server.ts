import { handleFactorySessionApi, readFactoryJson } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "release.approval.decide", path: { projectId: event.params.projectId, approvalId: event.params.approvalId }, body: await readFactoryJson(event.request),
}));
