import { factoryDefinitionsConformance } from "../../src/__tests__/helpers/factory-definitions-suite";
import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { referenceCodeV1 } from "@ezcorp/factory-sdk";
import { EncryptedBlobStore, InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../src/factory/encryption";
import { FactoryGrants, type FactoryPrincipal } from "../../src/factory/grants";
import { FactoryRecords } from "../../src/factory/records";
import { createFactoryApplication } from "../../src/factory/application";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

factoryDefinitionsConformance(setupFactoryPostgres);

test("PostgreSQL and S3 retain encrypted compiled definition bytes through application composition", async () => {
  const fixture = await setupFactoryPostgres();
  const storage = await createFactoryOrdinaryStorage(`ordinary/factory-definitions/${randomUUID()}`);
  try {
    const tenantId = `definition-tenant-${randomUUID()}`, projectId = `definition-project-${randomUUID()}`;
    const administrator: FactoryPrincipal = { kind: "user", id: `definition-admin-${randomUUID()}`, authentication: "session" };
    const author: FactoryPrincipal = { kind: "user", id: `definition-author-${randomUUID()}`, authentication: "session" };
    const records = new FactoryRecords(fixture.db, tenantId); await records.bindInstallation();
    await fixture.db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, 'Definitions', '/tmp/definitions')`); await records.bindProject(projectId);
    for (const principal of [administrator, author]) {
      await fixture.db.execute(sql`INSERT INTO users(id, email, password_hash, name, role) VALUES (${principal.id}, ${`${principal.id}@example.test`}, 'not-a-login', ${principal.id}, ${principal === administrator ? "admin" : "member"})`);
      await fixture.db.execute(sql`INSERT INTO project_members(id, project_id, user_id, role) VALUES (${principal.id}, ${projectId}, ${principal.id}, 'member')`);
    }
    const grants = new FactoryGrants(fixture.db, tenantId);
    for (const action of ["factory.author", "factory.publish"] as const) await grants.set(administrator, { projectId, principal: author, action, expectedRevision: 0, expiresAtMs: null });
    const wraps: InstallationKeyWrap[] = [];
    const wrapStore: InstallationKeyWrapStore = { async load() { return wraps; }, async save(wrap) { wraps.push(wrap); } };
    const key = await InstallationDataKey.loadOrCreate(`installation-${tenantId}`, wrapStore, new StaticMasterKeyProvider({ id: "operator", bytes: new Uint8Array(32).fill(3) }));
    const application = createFactoryApplication({ database: fixture.db, tenantId, grants, blobs: new EncryptedBlobStore(storage.blobs, key, tenantId), availableResourceClasses: [], runOptions: { interpreterBuild: "test", interpreterCompatibility: "1", limits: { maxCostMicros: "1", maxTokens: 1, maxComputeMs: 1 }, resolveParameters: async () => ({}) } });
    const definitions = application.definitions;
    const source = { ...structuredClone(referenceCodeV1), id: "encrypted-definition", version: "1.0.0" };
    await definitions.save(author, { projectId, factoryId: source.id }, 0, "encrypted-definition-save", source);
    const version = await definitions.publish(author, { projectId, factoryId: source.id }, 1, "encrypted-definition-publish");
    expect(new TextDecoder().decode(await storage.blobs.get(version.compiledBlobDigest))).not.toContain(source.id);
    expect((await definitions.readVersion(author, { projectId, factoryId: source.id }, version.version)).compiled.digest).toBe(version.definitionDigest);
  } finally { await storage.close(); await fixture.close(); }
}, 30_000);
