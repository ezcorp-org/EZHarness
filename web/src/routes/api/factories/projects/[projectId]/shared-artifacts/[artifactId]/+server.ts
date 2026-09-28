import { factoryDownloadResponse, handleFactoryConsoleRaw } from "../../../../_console";
import type { RequestHandler } from "./$types";

/** The target project's read of a shared artifact. The caller names the exact bytes it was given. */
export const GET: RequestHandler = event => handleFactoryConsoleRaw(event, {
  build: () => ({
    kind: "artifact.shared.read",
    path: { projectId: event.params.projectId, artifactId: event.params.artifactId },
    query: { digest: event.url.searchParams.get("digest") ?? "", encodedBytes: Number(event.url.searchParams.get("encodedBytes")), mediaType: event.url.searchParams.get("mediaType") ?? "" },
  }),
  run: async ({ principal, console, request }) => {
    const read = await console.tickets.readShared(principal, request.path.projectId, request.path.artifactId, request.query);
    return factoryDownloadResponse(read.bytes, read.artifactId);
  },
});
