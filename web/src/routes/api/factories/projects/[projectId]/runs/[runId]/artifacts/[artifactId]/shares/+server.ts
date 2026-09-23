import { handleFactorySessionApi, readFactoryJson } from "../../../../../../../_shared";
import type { RequestHandler } from "./$types";

/** Grants another project a read of this artifact's exact bytes. Human session only. */
export const POST: RequestHandler = event => handleFactorySessionApi(event, async () => ({
  kind: "artifact.share", path: { projectId: event.params.projectId, runId: event.params.runId, artifactId: event.params.artifactId }, body: await readFactoryJson(event.request),
}));
