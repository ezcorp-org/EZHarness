import { handleFactoryConsoleSessionApi } from "../../../_console";
import type { RequestHandler } from "./$types";

/** The closing preconditions and the audit a purge would destroy. Human tenant administrator only. */
export const GET: RequestHandler = event => handleFactoryConsoleSessionApi(event, {
  administrator: true,
  build: () => ({ kind: "purge.preview", path: { tenantId: event.params.tenantId } }),
  run: async ({ principal, console }) => ({ schemaVersion: "factory.api.response.v1", kind: "purge.preview", resource: await console.purge.preview(principal, event.params.tenantId) } as const),
});
