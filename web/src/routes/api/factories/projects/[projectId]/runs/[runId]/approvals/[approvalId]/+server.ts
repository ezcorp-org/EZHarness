import { handleFactorySessionApi, readFactoryJson } from "../../../../../../_shared";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "approval.decide",
  path: { projectId: event.params.projectId, runId: event.params.runId, approvalId: event.params.approvalId },
  body: await readFactoryJson(event.request),
}));
