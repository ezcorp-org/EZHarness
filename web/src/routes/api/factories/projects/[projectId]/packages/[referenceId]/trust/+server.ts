import { handleFactoryConsoleSessionApi, readFactoryConsoleJson } from "../../../../../_console";
import type { RequestHandler } from "./$types";

/** Publish, quarantine, or revoke at the exact current trust revision (`If-Match`). */
export const POST: RequestHandler = event => handleFactoryConsoleSessionApi(event, {
  administrator: true,
  build: async () => ({ kind: "package.trust", path: { projectId: event.params.projectId, referenceId: event.params.referenceId }, body: await readFactoryConsoleJson(event.request) }),
  run: async ({ principal, console, request }) => {
    if (request.kind !== "package.trust") throw new TypeError("package.trust expected");
    const resource = await console.packages.transition(principal, event.params.projectId, event.params.referenceId, request.body.transition, request.preconditions.expectedRevision, request.preconditions.idempotencyKey);
    return { schemaVersion: "factory.api.response.v1", kind: "package.resource", resource } as const;
  },
});
