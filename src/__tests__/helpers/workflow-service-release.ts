import { getTestDb } from "./test-pglite";
import { workflowReleaseFixture } from "./workflow-release";
import { workflowDelegationReleaseBinding } from "../../runtime/workflow-release-assets";
import { users, extensions, serviceAccounts, workflowDelegations } from "../../db/schema";
import { up } from "../../db/migrations/add-workflow-delegation-release";

export async function workflowServiceReleaseFixture(options?: Parameters<typeof workflowReleaseFixture>[3]) {
  const db = getTestDb();
  await up(db);
  await up(db);
  await db.insert(users).values([{ id: "owner", email: "owner@test.invalid", name: "Owner", passwordHash: "hash" }, { id: "admin", email: "admin@test.invalid", name: "Admin", passwordHash: "hash", role: "admin" }]);
  const release = workflowReleaseFixture({ name: "sealed:task", description: "Sealed task", steps: [] }, "owner", "installation", options);
  await db.insert(extensions).values({ id: "installation", name: "sealed", version: "1.0.0", description: "Sealed", source: "test", enabled: true, manifest: release.snapshot.release.manifest });
  await db.insert(serviceAccounts).values({ id: "service", name: "Service", createdByUserId: "admin", scopes: [], maxTokensPerDay: 1000 });
  await db.insert(workflowDelegations).values({ id: "delegation", extensionId: "installation", jobRef: "job", ownerKind: "service", ownerServiceAccountId: "service", workflowName: "sealed:task", triggerKind: "cron", consentHash: "hash", definitionHash: "graph", consentedByUserId: "owner", maxTokensPerRun: 100, maxRunsPerDay: 10, extensionReleaseBinding: workflowDelegationReleaseBinding(release.entry) });
  const authority = { userId: null, runAsKind: "service", runAs: "service", delegationId: "delegation", projectId: null };
  return { db, release, authority };
}
