import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { configureFactoryApplication, createFactoryApplication, type FactoryApplication } from "../../factory/application";
import { FactoryRecords } from "../../factory/records";
import { digestBytes } from "../../extensions/v4/blobs";
import { up as repairAuditMetadata } from "../../db/migrations/repair-transactional-audit-metadata";

export function factoryProjectCreationConformance(create: () => Promise<{ db: TransactionalDb; close(): Promise<void> }>): void {
  let fixture: Awaited<ReturnType<typeof create>>;
  let application: FactoryApplication;
  let createProject: typeof import("../../db/queries/projects").createProject;
  const owner = { kind: "user", id: "factory-project-owner", authentication: "session" } as const;
  const tenantId = "project-creation-tenant";
  beforeAll(async () => {
    fixture = await create();
    createProject = (await import("../../db/queries/projects")).createProject;
    await new FactoryRecords(fixture.db, tenantId).bindInstallation();
    await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${owner.id}, 'project-creation@example.test', 'not-a-login', 'Project owner', 'user')`);
    application = createFactoryApplication({ database: fixture.db, tenantId, blobs: { put: async bytes => digestBytes(bytes), get: async () => { throw new Error("No artifact reads in project creation"); } }, availableResourceClasses: [], runOptions: { interpreterBuild: "test-build", interpreterCompatibility: "test", limits: { maxCostMicros: "1", maxTokens: 1, maxComputeMs: 1 }, resolveParameters: async () => ({}) } });
    configureFactoryApplication(application);
  });
  afterAll(async () => { configureFactoryApplication(null); await fixture?.close(); });

  test("the public project query commits owner rights and audit together without consent", async () => {
    const project = await createProject({ name: "Owned factory project", path: "/tmp/owned-factory-project", variables: { nested: { enabled: true } } }, owner.id);
    const grants = await application.grants.list(owner, project.id);
    expect(grants.items.map(grant => grant.action).sort()).toEqual(["factory.author", "factory.operate", "factory.publish", "factory.run"]);
    expect(grants.items.every(grant => grant.principalId === owner.id && grant.issuerId === owner.id && grant.revision === 1)).toBe(true);
    const facts = rows(await fixture.db.execute(sql`SELECT id FROM audit_log WHERE jsonb_typeof(metadata)='object' AND metadata->>'projectId'=${project.id} AND action='factory.grant.issued'`));
    expect(facts).toHaveLength(4);
    for (const action of ["factory.approve", "factory.trust", "factory.release"] as const) await expect(application.grants.authorize(owner, project.id, action)).rejects.toMatchObject({ code: "factory_forbidden" });
    const stored = (await import("../../db/queries/projects")).getProject;
    expect((await stored(project.id))!.variables).toEqual({ nested: { enabled: true } });
  });

  test("initialization cannot refresh revoked rights or grant them to a non-owner", async () => {
    const project = await createProject({ name: "Initialized once", path: "/tmp/initialized-once" }, owner.id);
    await application.grants.revoke(owner, { principal: owner, projectId: project.id, action: "factory.run", expectedRevision: 1 });
    await expect(fixture.db.transaction(tx => application.grants.initializeProjectInTransaction(tx, project.id, owner.id))).rejects.toMatchObject({ code: "factory_project_already_initialized" });
    expect((await application.grants.read(owner, { projectId: project.id, principal: owner, action: "factory.run" })).revoked).toBe(true);
    await fixture.db.execute(sql`UPDATE project_members SET role='member' WHERE project_id=${project.id}`);
    await expect(fixture.db.transaction(tx => application.grants.initializeProjectInTransaction(tx, project.id, owner.id))).rejects.toMatchObject({ code: "factory_forbidden" });
    await fixture.db.execute(sql`UPDATE users SET status='disabled' WHERE id=${owner.id}`);
    try { await expect(createProject({ name: "Inactive owner", path: "/tmp/inactive-project-owner" }, owner.id)).rejects.toMatchObject({ code: "factory_forbidden" }); }
    finally { await fixture.db.execute(sql`UPDATE users SET status='active' WHERE id=${owner.id}`); }
    expect(rows(await fixture.db.execute(sql`SELECT id FROM projects WHERE path='/tmp/inactive-project-owner'`))).toEqual([]);
  });

  test("a membership failure rolls back the project instead of leaving an orphan", async () => {
    await expect(createProject({ name: "Rejected membership", path: "/tmp/rejected-membership" }, "missing-owner")).rejects.toThrow();
    expect(rows(await fixture.db.execute(sql`SELECT id FROM projects WHERE path='/tmp/rejected-membership'`))).toEqual([]);
  });

  test("an upgrade repairs historical encoded audit objects without changing other facts", async () => {
    await fixture.db.execute(sql`DELETE FROM settings WHERE key='db:transactional-audit-json-repair:v1'`);
    await fixture.db.execute(sql`INSERT INTO audit_log (id,action,target,metadata) VALUES
      ('audit-repair-encoded','factory.grant.issued','original-target',to_jsonb('{"projectId":"old-project","nested":{"credential":"[REDACTED]"}}'::text)),
      ('audit-repair-object','factory.grant.issued','original-target','{"projectId":"plain-object"}'::jsonb),
      ('audit-repair-text','legacy.action','original-target',to_jsonb('plain text'::text)),
      ('audit-repair-invalid','legacy.action','original-target',to_jsonb('{invalid json'::text)),
      ('audit-repair-array','legacy.action','original-target',to_jsonb('[1,2]'::text))`);
    await repairAuditMetadata(fixture.db);
    const read = async () => rows<{ id: string; action: string; target: string; metadata: unknown }>(await fixture.db.execute(sql`SELECT id,action,target,metadata FROM audit_log WHERE id LIKE 'audit-repair-%' ORDER BY id`));
    const saved = await read();
    expect(saved.find(entry => entry.id === "audit-repair-encoded")).toEqual({ id: "audit-repair-encoded", action: "factory.grant.issued", target: "original-target", metadata: { projectId: "old-project", nested: { credential: "[REDACTED]" } } });
    expect(saved.find(entry => entry.id === "audit-repair-object")?.metadata).toEqual({ projectId: "plain-object" });
    expect(saved.find(entry => entry.id === "audit-repair-text")?.metadata).toBe("plain text");
    expect(saved.find(entry => entry.id === "audit-repair-invalid")?.metadata).toBe("{invalid json");
    expect(saved.find(entry => entry.id === "audit-repair-array")?.metadata).toBe("[1,2]");
    await repairAuditMetadata(fixture.db);
    expect(await read()).toEqual(saved);
    expect(rows(await fixture.db.execute(sql`SELECT value FROM settings WHERE key='db:transactional-audit-json-repair:v1'`))).toEqual([{ value: true }]);
  });

  test("factory-off creation keeps legacy owner membership without factory rights", async () => {
    configureFactoryApplication(null);
    try {
      const project = await createProject({ name: "Legacy project", path: "/tmp/legacy-project-creation" }, owner.id);
      expect(rows(await fixture.db.execute(sql`SELECT user_id,role FROM project_members WHERE project_id=${project.id}`))).toEqual([{ user_id: owner.id, role: "owner" }]);
      expect(rows(await fixture.db.execute(sql`SELECT project_id FROM factory_projects WHERE project_id=${project.id}`))).toEqual([]);
      expect(rows(await fixture.db.execute(sql`SELECT project_id FROM factory_grants WHERE project_id=${project.id}`))).toEqual([]);
    } finally { configureFactoryApplication(application); }
  });

  test("a grant audit failure rolls back project, membership, binding, and grants", async () => {
    const before = rows(await fixture.db.execute(sql`SELECT id FROM projects`)).length;
    const grantsBefore = rows(await fixture.db.execute(sql`SELECT project_id FROM factory_grants`)).length;
    await fixture.db.execute(sql`CREATE FUNCTION reject_project_grant_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='factory.grant.issued' THEN RAISE EXCEPTION 'grant audit failed'; END IF; RETURN NEW; END $$`);
    await fixture.db.execute(sql`CREATE TRIGGER reject_project_grant_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_project_grant_audit()`);
    try { await expect(createProject({ name: "Rejected audit", path: "/tmp/rejected-project-audit" }, owner.id)).rejects.toThrow(); }
    finally { await fixture.db.execute(sql`DROP TRIGGER reject_project_grant_audit ON audit_log`); await fixture.db.execute(sql`DROP FUNCTION reject_project_grant_audit()`); }
    expect(rows(await fixture.db.execute(sql`SELECT id FROM projects`))).toHaveLength(before);
    expect(rows(await fixture.db.execute(sql`SELECT project_id FROM factory_grants`))).toHaveLength(grantsBefore);
    expect(rows(await fixture.db.execute(sql`SELECT p.id FROM project_members p LEFT JOIN projects project ON project.id=p.project_id WHERE project.id IS NULL`))).toEqual([]);
  });
}
