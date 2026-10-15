import { handleFactoryApi } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

/** Which live runs a trust transition would reach, before it is committed. */
export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({ kind: "package.impact", path: { projectId: event.params.projectId, referenceId: event.params.referenceId }, query: { transition: event.url.searchParams.get("transition") ?? "" } }),
});
