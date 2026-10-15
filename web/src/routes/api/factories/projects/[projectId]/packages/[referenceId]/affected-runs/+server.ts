import { factoryPackageAffectedRunsQuery, handleFactoryApi } from "../../../../../_shared";
import type { RequestHandler } from "./$types";

/** What the package fence recorded: every attempt a quarantine or revocation reached, and what it did (W02c). */
export const GET: RequestHandler = event => handleFactoryApi(event, {
  scope: "read",
  build: () => ({ kind: "package.affected-runs", path: { projectId: event.params.projectId, referenceId: event.params.referenceId }, query: factoryPackageAffectedRunsQuery(event.url) }),
});
