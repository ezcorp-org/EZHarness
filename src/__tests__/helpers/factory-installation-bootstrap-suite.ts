import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { configureFactoryApplication, createFactoryApplication, type FactoryApplication } from "../../factory/application";
import { FactoryRecords } from "../../factory/records";
import { digestBytes } from "../../extensions/v4/blobs";
import { FACTORY_BOOTSTRAP_ACKNOWLEDGEMENT, FactoryInstallationBootstrap, factoryBootstrapHost } from "../../factory/provisioning/bootstrap";
import type { FactoryBootstrapInvitation } from "../../factory/provisioning/invitation";
import { factoryRejection, makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "./factory-private-root";

/**
 * C01/C12 step 7 conformance: redeeming the invitation is identity, the
 * administrator's explicit consent is authority, and consent commits with its
 * grants and its audit entry or not at all.
 */
export function factoryInstallationBootstrapConformance(create: () => Promise<{ db: TransactionalDb; close(): Promise<void> }>): void {
  let fixture: Awaited<ReturnType<typeof create>>;
  let application: FactoryApplication;
  let createProject: typeof import("../../db/queries/projects").createProject;
  let root: string;
  const tenantId = "bootstrap-tenant";
  const installationId = "bootstrap-installation";
  const admin = { kind: "user", id: "bootstrap-admin", authentication: "session" } as const;
  const other = { kind: "user", id: "bootstrap-other-admin", authentication: "session" } as const;
  const invitation: FactoryBootstrapInvitation = { schemaVersion: "factory.bootstrap-invitation.v1", installationId, tenantId, invitationId: "invitation-1", administratorEmail: "first@example.test", tokenDigest: `sha256:${"a".repeat(64)}`, expiresAtMs: Number.MAX_SAFE_INTEGER };
  let projectId: string;

  beforeAll(async () => {
    fixture = await create();
    root = await makeFactoryPrivateRoot();
    createProject = (await import("../../db/queries/projects")).createProject;
    await new FactoryRecords(fixture.db, tenantId).bindInstallation();
    for (const [id, email] of [[admin.id, "first@example.test"], [other.id, "second@example.test"]]) {
      await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES (${id}, ${email}, 'not-a-login', ${id}, 'admin')`);
    }
    application = createFactoryApplication({ database: fixture.db, tenantId, blobs: { put: async bytes => digestBytes(bytes), get: async () => { throw new Error("no artifact reads in bootstrap"); } }, availableResourceClasses: [], runOptions: { interpreterBuild: "test-build", interpreterCompatibility: "test", limits: { maxCostMicros: "1", maxTokens: 1, maxComputeMs: 1 }, resolveParameters: async () => ({}) } });
    configureFactoryApplication(application);
    projectId = (await createProject({ name: "Bootstrap project", path: "/tmp/bootstrap-project" }, admin.id)).id;
  });
  afterAll(async () => { configureFactoryApplication(null); await removeFactoryPrivateRoot(root); await fixture?.close(); });

  const bootstrap = (id = installationId) => new FactoryInstallationBootstrap(fixture.db, id, tenantId);

  test("redemption binds exactly one administrator to the invitation and is audited", async () => {
    expect(await bootstrap().status()).toEqual({ state: "invited", invitationId: null });
    await bootstrap().recordRedeemed(invitation, admin.id);
    await bootstrap().recordRedeemed(invitation, admin.id);
    expect(await bootstrap().status()).toEqual({ state: "redeemed", invitationId: "invitation-1" });
    expect((await factoryRejection(bootstrap().recordRedeemed(invitation, other.id))).message).toBe("bootstrap_not_administrator");
    expect((await factoryRejection(bootstrap().recordRedeemed({ ...invitation, invitationId: "invitation-2" }, admin.id))).message).toBe("bootstrap_not_administrator");
    expect(rows(await fixture.db.execute(sql`SELECT action FROM audit_log WHERE action='factory.bootstrap.redeemed' AND target=${installationId}`))).toHaveLength(1);
  });

  test("redemption alone grants no consent authority", async () => {
    for (const action of ["factory.approve", "factory.trust", "factory.release"] as const) await expect(application.grants.authorize(admin, projectId, action)).rejects.toMatchObject({ code: "factory_forbidden" });
  });

  test("consent is refused to a non-session principal, a paraphrased acknowledgement, another administrator, and an unknown project", async () => {
    expect((await factoryRejection(bootstrap().consent({ ...admin, authentication: "api-key" }, { projectId, acknowledgement: FACTORY_BOOTSTRAP_ACKNOWLEDGEMENT }))).message).toBe("bootstrap_human_required");
    expect((await factoryRejection(bootstrap().consent({ kind: "service", id: "svc", authentication: "service" }, { projectId, acknowledgement: FACTORY_BOOTSTRAP_ACKNOWLEDGEMENT }))).message).toBe("bootstrap_human_required");
    expect((await factoryRejection(bootstrap().consent(admin, { projectId, acknowledgement: "yes" }))).message).toBe("bootstrap_acknowledgement_required");
    expect((await factoryRejection(bootstrap().consent(admin, { projectId: "", acknowledgement: FACTORY_BOOTSTRAP_ACKNOWLEDGEMENT }))).message).toBe("bootstrap_project_invalid");
    expect((await factoryRejection(bootstrap().consent(other, { projectId, acknowledgement: FACTORY_BOOTSTRAP_ACKNOWLEDGEMENT }))).message).toBe("bootstrap_not_administrator");
    expect((await factoryRejection(bootstrap().consent(admin, { projectId: "no-such-project", acknowledgement: FACTORY_BOOTSTRAP_ACKNOWLEDGEMENT }))).message).toBe("bootstrap_project_invalid");
    expect((await factoryRejection(bootstrap("never-redeemed").consent(admin, { projectId, acknowledgement: FACTORY_BOOTSTRAP_ACKNOWLEDGEMENT }))).message).toBe("bootstrap_not_redeemed");
  });

  test("a failed audit write rolls back the consent and every grant it would have issued", async () => {
    await fixture.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION w16_refuse_consent_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'factory.bootstrap.consent' THEN RAISE EXCEPTION 'audit store refused'; END IF; RETURN NEW; END $$`));
    await fixture.db.execute(sql.raw("CREATE TRIGGER w16_refuse_consent_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION w16_refuse_consent_audit()"));
    try {
      await expect(bootstrap().consent(admin, { projectId, acknowledgement: FACTORY_BOOTSTRAP_ACKNOWLEDGEMENT })).rejects.toThrow();
    } finally {
      await fixture.db.execute(sql.raw("DROP TRIGGER w16_refuse_consent_audit ON audit_log"));
      await fixture.db.execute(sql.raw("DROP FUNCTION w16_refuse_consent_audit()"));
    }
    expect((await bootstrap().status()).state).toBe("redeemed");
    expect(rows(await fixture.db.execute(sql`SELECT action FROM factory_grants WHERE tenant_id=${tenantId} AND project_id=${projectId} AND action IN ('factory.approve','factory.trust','factory.release')`))).toEqual([]);
  });

  test("two concurrent consents commit exactly once; the grants, the record, and the audit agree", async () => {
    const attempts = await Promise.allSettled([
      bootstrap().consent(admin, { projectId, acknowledgement: FACTORY_BOOTSTRAP_ACKNOWLEDGEMENT }),
      bootstrap().consent(admin, { projectId, acknowledgement: FACTORY_BOOTSTRAP_ACKNOWLEDGEMENT }),
    ]);
    const won = attempts.filter((attempt) => attempt.status === "fulfilled");
    expect(won).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected").map((attempt) => ((attempt as PromiseRejectedResult).reason as Error).message)).toEqual(["bootstrap_already_consented"]);
    const consent = (won[0] as PromiseFulfilledResult<{ consentDigest: string; grants: Readonly<Record<string, number>> }>).value;
    expect(consent.grants).toEqual({ "factory.approve": 1, "factory.trust": 1, "factory.release": 1 });
    expect(consent.consentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    for (const action of ["factory.approve", "factory.trust", "factory.release"] as const) expect((await application.grants.authorize(admin, projectId, action)).revision).toBe(1);
    expect(rows(await fixture.db.execute(sql`SELECT state, project_id, consent_digest FROM factory_installation_bootstrap WHERE installation_id=${installationId}`))).toEqual([{ state: "consented", project_id: projectId, consent_digest: consent.consentDigest }]);
    const audit = rows<{ metadata: { consentDigest?: string } }>(await fixture.db.execute(sql`SELECT metadata FROM audit_log WHERE action='factory.bootstrap.consent' AND target=${installationId}`));
    expect(audit.map((entry) => entry.metadata.consentDigest)).toEqual([consent.consentDigest]);
    expect(await bootstrap().status()).toEqual({ state: "consented", invitationId: "invitation-1" });
  });

  test("the schema refuses a consented row without its project, digest, and time", async () => {
    // `execute` hands back a thenable; `Promise.resolve` adopts it so the rejection is observed.
    expect(await factoryRejection(Promise.resolve(fixture.db.execute(sql`INSERT INTO factory_installation_bootstrap (installation_id, tenant_id, invitation_id, admin_user_id, state) VALUES ('bad-row', ${tenantId}, 'i', ${admin.id}, 'consented')`)))).toBeInstanceOf(Error);
    expect(await factoryRejection(Promise.resolve(fixture.db.execute(sql`INSERT INTO factory_installation_bootstrap (installation_id, tenant_id, invitation_id, admin_user_id, state) VALUES ('bad-user', ${tenantId}, 'i', 'no-such-user', 'redeemed')`)))).toBeInstanceOf(Error);
    expect(rows(await fixture.db.execute(sql`SELECT installation_id FROM factory_installation_bootstrap WHERE installation_id IN ('bad-row', 'bad-user')`))).toEqual([]);
  });

  test("the host reads a declared invitation privately, fails closed when it is unreadable, and is absent when none is declared", async () => {
    expect(await factoryBootstrapHost({}, () => { throw new Error("not a provisioned installation: the database is never touched"); })).toBeNull();
    const path = await writeModeFile(join(root, "bootstrap-invitation.json"), JSON.stringify(invitation));
    const host = await factoryBootstrapHost({ EZCORP_FACTORY_BOOTSTRAP_INVITATION: path, EZCORP_INSTALLATION_ID: installationId }, () => fixture.db);
    expect(host?.invitation).toEqual(invitation);
    expect(host?.bootstrap.tenantId).toBe(tenantId);
    expect((await factoryRejection(factoryBootstrapHost({ EZCORP_FACTORY_BOOTSTRAP_INVITATION: path, EZCORP_INSTALLATION_ID: "another-installation" }, () => fixture.db))).message).toBe("bootstrap_invitation_unavailable");
    expect((await factoryRejection(factoryBootstrapHost({ EZCORP_FACTORY_BOOTSTRAP_INVITATION: join(root, "missing.json") }, () => fixture.db))).message).toBe("bootstrap_invitation_unavailable");
  });
}
