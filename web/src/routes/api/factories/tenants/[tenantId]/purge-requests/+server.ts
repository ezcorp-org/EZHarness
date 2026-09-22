import { handleFactoryConsoleSessionApi, readFactoryConsoleJson } from "../../../_console";
import type { RequestHandler } from "./$types";

/**
 * Records a tenant purge request. It deletes nothing: open work refuses it,
 * and a queued request is carried out and certified under W19.
 */
export const POST: RequestHandler = event => handleFactoryConsoleSessionApi(event, {
  administrator: true,
  build: async () => ({ kind: "purge.request", path: { tenantId: event.params.tenantId }, body: await readFactoryConsoleJson(event.request) }),
  run: async ({ principal, console, request }) => {
    if (request.kind !== "purge.request") throw new TypeError("purge.request expected");
    const resource = await console.purge.request(principal, event.params.tenantId, request.body, request.preconditions.idempotencyKey);
    return { schemaVersion: "factory.api.response.v1", kind: "purge.request.resource", resource } as const;
  },
});
