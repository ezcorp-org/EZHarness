import { FACTORY_STREAM_HEADERS, factoryRunEventStream, handleFactoryConsoleApi } from "../../../../../_console";
import type { RequestHandler } from "./$types";

/**
 * The live run stream (C09): the client takes a snapshot from `inspection`,
 * then streams from its cursor. A native reconnect presents `Last-Event-ID`.
 */
export const GET: RequestHandler = event => handleFactoryConsoleApi(event, {
  scope: "read",
  build: () => ({
    kind: "run.events",
    path: { projectId: event.params.projectId, runId: event.params.runId },
    query: { cursor: event.request.headers.get("Last-Event-ID") ?? event.url.searchParams.get("cursor") ?? "" },
  }),
  run: async ({ principal, console, request }) => {
    const key = { projectId: event.params.projectId, runId: event.params.runId };
    const cursor = request.kind === "run.events" ? request.query.cursor : "";
    // The first batch is read here, so a refusal or an expired cursor is an HTTP status.
    const first = await console.events.read(principal, key, cursor);
    // A long-lived stream must not be cut by the adapter's per-request idle timeout.
    const platform = (event as { platform?: { server?: { timeout?: (request: Request, seconds: number) => void }; request?: Request } }).platform;
    if (platform?.server?.timeout && platform.request) platform.server.timeout(platform.request, 0);
    const body = factoryRunEventStream(first, { read: next => console.events.read(principal, key, next), signal: event.request.signal });
    return new Response(body, { status: 200, headers: FACTORY_STREAM_HEADERS });
  },
});
