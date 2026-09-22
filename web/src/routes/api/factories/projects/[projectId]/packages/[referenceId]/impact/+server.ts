import { handleFactoryConsoleApi } from "../../../../../_console";
import type { RequestHandler } from "./$types";

/** Which live runs a trust transition would reach, before it is committed. */
export const GET: RequestHandler = event => handleFactoryConsoleApi(event, {
  scope: "read",
  build: () => ({ kind: "package.impact", path: { projectId: event.params.projectId, referenceId: event.params.referenceId }, query: { transition: event.url.searchParams.get("transition") ?? "" } }),
  run: async ({ principal, console, request }) => {
    if (request.kind !== "package.impact") throw new TypeError("package.impact expected");
    return { schemaVersion: "factory.api.response.v1", kind: "package.impact", resource: await console.packages.impact(principal, event.params.projectId, event.params.referenceId, request.query.transition) } as const;
  },
});
