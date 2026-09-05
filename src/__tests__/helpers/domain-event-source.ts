import { validateManifest } from "@ezcorp/extension-contract";
import { getTestDb } from "./test-pglite";
import { releaseRuntimeFixture } from "./release-runtime";
import { DatabaseLifecycleRepository } from "../../db/queries/extension-releases";
import { createExtension } from "../../db/queries/extensions";
import { users, projects, conversations, conversationExtensions } from "../../db/schema";
import { buildFullGrantFromManifest } from "../../extensions/install-grant";
import { ExtensionDeliveryQueue } from "../../extensions/v4/deliveries";
import { sql } from "drizzle-orm";

export async function fillDomainEventQueue(source: { database: ReturnType<typeof getTestDb>; installationId: string }) {
  await source.database.execute(sql`INSERT INTO extension_release_deliveries(id, installation_id, deduplication_id, generation, state, available_at, lease_until, payload) SELECT 'full-' || generate_series, ${source.installationId}, 'full-' || generate_series, 1, 'queued', 0, 0, '{}' FROM generate_series(1,10000)`);
}

export async function domainEventSourceFixture(events: string[]) {
  const database = getTestDb();
  const [owner] = await database.insert(users).values({ email: `${crypto.randomUUID()}@example.test`, passwordHash: "fixture", name: "Owner", status: "active" }).returning();
  const [project] = await database.insert(projects).values({ name: "Domain events", path: `/tmp/${crypto.randomUUID()}` }).returning();
  const [conversation] = await database.insert(conversations).values({ userId: owner!.id, projectId: project!.id }).returning();
  const manifest = validateManifest({ schemaVersion: 4, name: `domain-source-${crypto.randomUUID()}`, version: "1.0.0", description: "Fixture", author: { name: "Test" }, permissions: { eventSubscriptions: events, appendMessages: { excludedDefault: true } } });
  const runtime = releaseRuntimeFixture(crypto.randomUUID(), manifest, { ownerId: owner!.id });
  const installationId = runtime.snapshot.installation.id;
  await new DatabaseLifecycleRepository(database).create({ installation: runtime.snapshot.installation, releases: { [runtime.snapshot.release.id]: runtime.snapshot.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
  const grantedPermissions = buildFullGrantFromManifest(manifest);
  await createExtension({ id: installationId, name: manifest.name, version: manifest.version, manifest, grantedPermissions, enabled: true, source: "release-v4", creatorUserId: owner!.id });
  await database.insert(conversationExtensions).values({ conversationId: conversation!.id, extensionId: installationId });
  return { database, owner: owner!, project: project!, conversation: conversation!, installationId, grantedPermissions, queue: new ExtensionDeliveryQueue(database) };
}
