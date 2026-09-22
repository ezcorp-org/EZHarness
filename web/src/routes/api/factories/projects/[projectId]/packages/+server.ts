import { factoryListQuery } from "../../../_shared";
import { handleFactoryConsoleApi, handleFactoryConsoleSessionApi, readFactoryConsoleJson } from "../../../_console";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = event => handleFactoryConsoleApi(event, {
  scope: "read",
  build: () => ({ kind: "package.list", path: { projectId: event.params.projectId }, query: factoryListQuery(event.url) }),
  run: async ({ principal, console, request }) => {
    const query = request.kind === "package.list" ? request.query : {};
    return { schemaVersion: "factory.api.response.v1", kind: "package.page", page: await console.packages.list(principal, event.params.projectId, query) } as const;
  },
});

/** Binds an installed v4 release to the project. C01's admin row: a human tenant administrator. */
export const POST: RequestHandler = event => handleFactoryConsoleSessionApi(event, {
  administrator: true,
  build: async () => ({ kind: "package.install", path: { projectId: event.params.projectId }, body: await readFactoryConsoleJson(event.request) }),
  run: async ({ principal, console, request }) => {
    if (request.kind !== "package.install") throw new TypeError("package.install expected");
    const resource = await console.packages.install(principal, event.params.projectId, request.body, request.preconditions.idempotencyKey);
    return { schemaVersion: "factory.api.response.v1", kind: "package.resource", resource } as const;
  },
});
