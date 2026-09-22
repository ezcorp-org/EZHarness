/**
 * The C12 provisioner against real PostgreSQL.
 *
 * The database step, the ledger, the secrets step, and the fleet upgrade ledger
 * are REAL here; the steps that need a running Temporal, object store, Compose
 * engine, or ingress are recording drivers, because those are proven end to end
 * by the live ten-installation proof, not by this suite. What this suite owns is
 * the provisioner's own contract: order, phases, failure records, recovery,
 * ownership, teardown, purge, and upgrade waves.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { factoryRejection, makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "../../src/__tests__/helpers/factory-private-root";
import { FactoryDatabaseStep, factoryDatabaseMarker, factoryDatabasePairs, type FactoryDatabaseKind } from "../../src/factory/provisioning/database";
import type { FactoryInstallationContext, FactoryProvisioningDriver, FactoryStepResources } from "../../src/factory/provisioning/installation";
import { factoryFleetResourceName, factoryInstallationNames } from "../../src/factory/provisioning/installation";
import { assertFactoryStepResources } from "../../src/factory/provisioning/ledger";
import { LocalFactoryProvisioner, type FactoryProvisioningDrivers, type FactoryWorkCensus } from "../../src/factory/provisioning/local";
import { FactorySecretsStep } from "../../src/factory/provisioning/secrets";
import { FactoryProvisioningError, FACTORY_PROVISIONING_STEPS, type FactoryProvisioningStepName } from "../../src/factory/provisioning/steps";
import { FactoryStorageRevocationUnsupported } from "../../src/factory/provisioning/storage";
import { FactoryFleetUpgrades, type FactoryBuild, type FactoryUpgradeComponent } from "../../src/factory/provisioning/fleet-upgrade";
import { factoryDatabaseCensus } from "../../src/factory/provisioning/census";

const url = process.env.FACTORY_TEST_POSTGRES_URL;
if (!url) throw new Error("FACTORY_TEST_POSTGRES_URL is required for real PostgreSQL provisioning conformance.");

const fleetId = `pg${randomBytes(4).toString("hex")}`;
const controlName = `factory_control_${randomUUID().replaceAll("-", "")}`;
let admin: SQL;
let controlUrl: string;
let root: string;
const provisioners: LocalFactoryProvisioner[] = [];
const databaseSteps: FactoryDatabaseStep[] = [];

type Call = { readonly step: string; readonly action: string; readonly tenantId: string };
const calls: Call[] = [];
const failures = new Map<string, number>();

/** A driver that records every call and fails `ensure` on demand. It owns a marker file so teardown has something real to remove. */
class RecordingDriver implements FactoryProvisioningDriver {
  constructor(readonly step: FactoryProvisioningStepName) {}
  private fail(action: string, tenantId: string): void {
    const key = `${this.step}:${action}:${tenantId}`;
    const remaining = failures.get(key) ?? 0;
    if (remaining > 0) { failures.set(key, remaining - 1); throw new FactoryProvisioningError(`${this.step}_injected`, `injected ${action} failure in ${this.step}`, this.step); }
  }
  async ensure(installation: FactoryInstallationContext, recorded: FactoryStepResources | undefined): Promise<FactoryStepResources> {
    calls.push({ step: this.step, action: "ensure", tenantId: installation.tenantId });
    this.fail("ensure", installation.tenantId);
    return { owner: this.step, generation: String(Number(recorded?.generation ?? "0") + 1) };
  }
  async verify(installation: FactoryInstallationContext): Promise<void> { calls.push({ step: this.step, action: "verify", tenantId: installation.tenantId }); this.fail("verify", installation.tenantId); }
  async teardown(installation: FactoryInstallationContext): Promise<void> { calls.push({ step: this.step, action: "teardown", tenantId: installation.tenantId }); this.fail("teardown", installation.tenantId); }
  async rotate(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<FactoryStepResources> { calls.push({ step: this.step, action: "rotate", tenantId: installation.tenantId }); return { ...resources, rotated: "yes" }; }
  async purge(installation: FactoryInstallationContext): Promise<void> { calls.push({ step: this.step, action: "purge", tenantId: installation.tenantId }); }
  async serve(installation: FactoryInstallationContext): Promise<void> { calls.push({ step: this.step, action: "serve", tenantId: installation.tenantId }); }
  async hold(installation: FactoryInstallationContext): Promise<void> { calls.push({ step: this.step, action: "hold", tenantId: installation.tenantId }); }
}

/** Storage whose teardown finishes but cannot revoke a seeded identity. */
class SeededStorageDriver extends RecordingDriver {
  constructor() { super("storage"); }
  override async teardown(installation: FactoryInstallationContext): Promise<void> { await super.teardown(installation); throw new FactoryStorageRevocationUnsupported(["ordinary", "archive"]); }
}

function drivers(database: FactoryDatabaseStep, secrets: FactoryProvisioningDriver): FactoryProvisioningDrivers {
  return {
    database: database as FactoryProvisioningDrivers["database"],
    storage: new SeededStorageDriver() as FactoryProvisioningDrivers["storage"],
    temporal: new RecordingDriver("temporal") as FactoryProvisioningDrivers["temporal"],
    secrets: secrets as FactoryProvisioningDrivers["secrets"],
    deployment: new RecordingDriver("deployment") as FactoryProvisioningDrivers["deployment"],
    ingress: new RecordingDriver("ingress") as unknown as FactoryProvisioningDrivers["ingress"],
    invitation: new RecordingDriver("invitation") as FactoryProvisioningDrivers["invitation"],
  };
}

function provisioner(options: { readonly fault?: (step: FactoryProvisioningStepName, point: "before" | "after") => Promise<void>; readonly afterExternalResourceCreated?: (resource: "role" | "database", kind: FactoryDatabaseKind) => Promise<void> } = {}): LocalFactoryProvisioner {
  let created: LocalFactoryProvisioner | undefined;
  const database = new FactoryDatabaseStep({ adminUrl: url!, progress: (installation, resources) => created!.ledger.stepProgress(installation.tenantId, "database", resources), ...(options.afterExternalResourceCreated ? { afterExternalResourceCreated: options.afterExternalResourceCreated } : {}) });
  databaseSteps.push(database);
  const secrets = new FactorySecretsStep({ registry: { conflicts: (tenantId, digests) => created!.ledger.digestConflicts(tenantId, digests) }, grantableRoots: () => [join(root, "projects")] });
  created = new LocalFactoryProvisioner({ fleetId, controlDatabaseUrl: controlUrl, secretsRoot: join(root, "installations"), operatorRoot: join(root, "operator"), drivers: drivers(database, secrets), ...(options.fault ? { fault: options.fault } : {}) });
  provisioners.push(created);
  return created;
}

const request = (tenantId: string) => ({ tenantId, hostname: `${tenantId}.${fleetId}.factory.test`, administratorEmail: `Admin@${tenantId}.example.test` });
const stepsOf = (tenantId: string) => calls.filter((call) => call.tenantId === tenantId);
const names = (tenantId: string) => factoryInstallationNames(fleetId, tenantId, { secretsRoot: join(root, "installations"), operatorRoot: join(root, "operator") });

async function canLogin(role: string, password: string, database: string): Promise<boolean> {
  const target = new URL(url!); target.pathname = `/${database}`; target.username = role; target.password = password;
  const client = new SQL(target.toString(), { max: 1, connectionTimeout: 5 });
  try { await client`SELECT 1`; return true; } catch { return false; } finally { await client.close(); }
}

async function credential(tenantId: string, kind: FactoryDatabaseKind): Promise<{ role: string; password: string }> {
  const file = kind === "product" ? "product-database.json" : "pool-database-credential.json";
  return JSON.parse(await Bun.file(join(names(tenantId).secretDirectory, file)).text());
}

beforeAll(async () => {
  root = await makeFactoryPrivateRoot();
  admin = new SQL(url!, { max: 2 });
  await admin.unsafe(`CREATE DATABASE "${controlName}"`);
  const isolated = new URL(url!); isolated.pathname = `/${controlName}`; controlUrl = isolated.toString();
});

afterAll(async () => {
  for (const each of provisioners) await each.close().catch(() => undefined);
  for (const each of databaseSteps) await each.close().catch(() => undefined);
  // Drop exactly what this suite's fleet created: every name is derived from its own fleet id.
  const tenants = Array.from({ length: 99 }, (_, index) => `tenant-${String(index + 1).padStart(2, "0")}`);
  for (const tenantId of tenants) {
    for (const [database, role] of [[factoryFleetResourceName("factory_product", fleetId, tenantId), factoryFleetResourceName("factory_role", fleetId, tenantId)], [factoryFleetResourceName("factory_pool", fleetId, tenantId), factoryFleetResourceName("factory_poolrole", fleetId, tenantId)]]) {
      if ((await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`)[0]) await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
      if ((await admin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`)[0]) await admin.unsafe(`DROP ROLE "${role}"`);
    }
  }
  await admin.unsafe(`DROP DATABASE "${controlName}" WITH (FORCE)`);
  await admin.close();
  await removeFactoryPrivateRoot(root);
});

describe("the seven steps and four phases", () => {
  test("a full run walks the steps in order, opens the route last, and reaches invitation_issued", async () => {
    const installation = await provisioner().provision(request("tenant-01"));
    expect(installation.phase).toBe("invitation_issued");
    expect(installation.state).toBe("ready");
    expect(installation.steps.map((step) => [step.step, step.ordinal, step.owner, step.state])).toEqual(FACTORY_PROVISIONING_STEPS.map((spec) => [spec.step, spec.ordinal, spec.owner, "complete"]));
    const recorded = stepsOf("tenant-01").map((call) => `${call.step}:${call.action}`);
    expect(recorded).toEqual(["storage:ensure", "temporal:ensure", "deployment:ensure", "ingress:ensure", "invitation:ensure", "ingress:serve"]);
    const events = (await provisioner().ledger.events("tenant-01")).map((event) => event.event);
    expect(events.filter((event) => event.startsWith("phase."))).toEqual(["phase.resources_prepared", "phase.deployment_ready", "phase.invitation_issued"]);
    for (const kind of ["product", "pool"] as const) {
      const pair = factoryDatabasePairs({ ...names("tenant-01"), ...request("tenant-01"), fleetId, installationId: installation.installationId, invitationId: "x" })[kind === "product" ? 0 : 1]!;
      const own = await credential("tenant-01", kind);
      expect(await canLogin(own.role, own.password, pair.database)).toBe(true);
      expect((await admin`SELECT has_database_privilege('public', ${pair.database}, 'CONNECT') AS allowed`)[0]).toEqual({ allowed: false });
    }
  });

  test("`through` stops at the phase its steps establish, and a partial tenant is not served", async () => {
    const run = provisioner();
    expect((await run.provision(request("tenant-02"), { through: "secrets" })).phase).toBe("resources_prepared");
    expect(await run.servesTraffic("tenant-02")).toBe(false);
    expect((await run.provision(request("tenant-02"), { through: "ingress" })).phase).toBe("deployment_ready");
    expect(await run.servesTraffic("tenant-02")).toBe(false);
    expect(stepsOf("tenant-02").some((call) => call.action === "serve")).toBe(false);
    expect((await run.provision(request("tenant-02"))).phase).toBe("invitation_issued");
    expect(await run.servesTraffic("tenant-02")).toBe(true);
  });

  test("a rerun over a complete installation verifies every step and re-creates nothing", async () => {
    const run = provisioner();
    const first = await run.provision(request("tenant-03"));
    const before = stepsOf("tenant-03").length;
    const second = await run.provision(request("tenant-03"));
    expect(second.installationId).toBe(first.installationId);
    expect(stepsOf("tenant-03").slice(before).map((call) => `${call.step}:${call.action}`)).toEqual(["storage:verify", "temporal:verify", "deployment:verify", "ingress:verify", "invitation:verify", "ingress:serve"]);
    expect(second.steps.map((step) => step.attempts)).toEqual(first.steps.map((step) => step.attempts));
  });

  test("concurrent provisioning of one tenant serializes on its lock and yields one identity", async () => {
    const run = provisioner();
    const [left, right] = await Promise.all([run.provision(request("tenant-04")), run.provision(request("tenant-04"))]);
    expect(left.installationId).toBe(right.installationId);
    expect(stepsOf("tenant-04").filter((call) => call.action === "ensure").map((call) => call.step)).toEqual(["storage", "temporal", "deployment", "ingress", "invitation"]);
  });

  test("a request that changes a persisted identity is refused, and so is a malformed one", async () => {
    await provisioner().provision(request("tenant-05"));
    expect((await factoryRejection(provisioner().provision({ ...request("tenant-05"), hostname: "changed.factory.test" }))).code).toBe("provisioning_request_conflict");
    expect((await factoryRejection(provisioner().provision({ ...request("tenant-05"), administratorEmail: "someone@else.test" }))).code).toBe("provisioning_request_conflict");
    expect((await factoryRejection(provisioner().provision({ ...request("tenant-05"), tenantId: "Tenant-5" }))).code).toBe("provisioning_request_invalid");
  });
});

describe("faults and recovery", () => {
  const faultable = FACTORY_PROVISIONING_STEPS.map((spec) => spec.step);
  for (const point of ["before", "after"] as const) {
    for (const [index, step] of faultable.entries()) {
      test(`a fault ${point} ${step} is recorded on the ledger and the rerun resumes there`, async () => {
        const tenantId = `tenant-${String(20 + index + (point === "after" ? 10 : 0)).padStart(2, "0")}`;
        let armed = true;
        const faulty = provisioner({ fault: async (current, at) => { if (armed && current === step && at === point) { armed = false; throw new FactoryProvisioningError("injected_fault", `injected ${at} ${current}`); } } });
        expect((await factoryRejection(faulty.provision(request(tenantId)))).code).toBe("injected_fault");
        const partial = await faulty.status(tenantId);
        const failed = partial.steps.find((entry) => entry.step === step)!;
        expect(failed.state).toBe("failed");
        expect(failed.failure).toEqual({ code: "injected_fault", message: `injected ${point} ${step}` });
        expect(partial.steps.filter((entry) => entry.ordinal < failed.ordinal).every((entry) => entry.state === "complete")).toBe(true);
        expect(partial.steps.filter((entry) => entry.ordinal > failed.ordinal).every((entry) => entry.state === "pending")).toBe(true);
        expect(await faulty.servesTraffic(tenantId)).toBe(false);
        const recovered = await faulty.provision(request(tenantId));
        expect(recovered.phase).toBe("invitation_issued");
        expect(recovered.installationId).toBe(partial.installationId);
        expect(recovered.steps.find((entry) => entry.step === step)!.attempts).toBe(2);
      });
    }
  }

  test("a driver failure is recorded with its own code and the phase does not advance", async () => {
    failures.set("temporal:ensure:tenant-40", 1);
    const run = provisioner();
    expect((await factoryRejection(run.provision(request("tenant-40")))).code).toBe("temporal_injected");
    const status = await run.status("tenant-40");
    expect(status.phase).toBe("recorded");
    expect(status.steps.find((entry) => entry.step === "temporal")!.failure?.code).toBe("temporal_injected");
    expect((await run.provision(request("tenant-40"))).phase).toBe("invitation_issued");
  });

  test("a completed step that fails re-verification is marked failed and the rerun stops there", async () => {
    const run = provisioner();
    await run.provision(request("tenant-41"));
    failures.set("deployment:verify:tenant-41", 1);
    expect((await factoryRejection(run.provision(request("tenant-41")))).code).toBe("deployment_injected");
    expect((await run.status("tenant-41")).steps.find((entry) => entry.step === "deployment")!.state).toBe("failed");
  });

  for (const [tenantId, interrupted, kind] of [["tenant-42", "role", "product"], ["tenant-43", "database", "product"], ["tenant-44", "role", "pool"], ["tenant-45", "database", "pool"]] as const) {
    test(`a crash inside ${kind} ${interrupted} creation is recognised on the rerun, never adopted blindly`, async () => {
      let armed = true;
      const crashing = provisioner({ afterExternalResourceCreated: async (resource, at) => { if (armed && resource === interrupted && at === kind) { armed = false; throw new Error(`injected ${resource} crash`); } } });
      expect((await factoryRejection(crashing.provision(request(tenantId)))).message).toBe(`injected ${interrupted} crash`);
      const database = (await crashing.status(tenantId)).steps.find((entry) => entry.step === "database")!;
      expect(database.state).toBe("failed");
      if (interrupted === "database") expect(database.resources[`${kind}DatabasePhase`]).toBe("creating");
      const recovered = await provisioner().provision(request(tenantId));
      expect(recovered.phase).toBe("invitation_issued");
      const own = await credential(tenantId, kind);
      const pair = factoryDatabasePairs({ ...names(tenantId), ...request(tenantId), fleetId, installationId: recovered.installationId, invitationId: "x" })[kind === "product" ? 0 : 1]!;
      expect(await canLogin(own.role, own.password, pair.database)).toBe(true);
    });
  }

  test("a same-named role without this installation's provenance is refused and never dropped", async () => {
    const role = factoryFleetResourceName("factory_role", fleetId, "tenant-46");
    await admin.unsafe(`CREATE ROLE "${role}" LOGIN`);
    try {
      expect((await factoryRejection(provisioner().provision(request("tenant-46")))).code).toBe("database_foreign");
      expect((await admin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`).length).toBe(1);
    } finally { await admin.unsafe(`DROP ROLE "${role}"`); }
    expect((await provisioner().provision(request("tenant-46"))).phase).toBe("invitation_issued");
  });

  test("a resource that loses its marker after completion fails verification by name", async () => {
    const run = provisioner();
    await run.provision(request("tenant-47"));
    const role = factoryFleetResourceName("factory_role", fleetId, "tenant-47");
    await admin.unsafe(`COMMENT ON ROLE "${role}" IS 'tampered'`);
    expect((await factoryRejection(run.provision(request("tenant-47")))).code).toBe("database_lost");
    const status = await run.status("tenant-47");
    const database = status.steps.find((entry) => entry.step === "database")!;
    await admin.unsafe(`COMMENT ON ROLE "${role}" IS '${factoryDatabaseMarker("role", { ...names("tenant-47"), ...request("tenant-47"), fleetId, installationId: status.installationId, invitationId: "x" }, factoryDatabasePairs({ ...names("tenant-47"), ...request("tenant-47"), fleetId, installationId: status.installationId, invitationId: "x" })[0]!, database.resources.productPlan!)}'`);
    expect((await run.provision(request("tenant-47"))).phase).toBe("invitation_issued");
  });
});

describe("credentials: uniqueness, rotation, and revocation", () => {
  test("every installation's secrets are distinct, and a copied one is refused as shared", async () => {
    const run = provisioner();
    await run.provision(request("tenant-50"));
    await run.provision(request("tenant-51"));
    const jwt = (tenantId: string) => Bun.file(join(names(tenantId).secretDirectory, "application-jwt-secret")).text();
    expect(await jwt("tenant-50")).not.toBe(await jwt("tenant-51"));
    const digest = (await run.status("tenant-50")).steps.find((entry) => entry.step === "secrets")!.resources.jwtSecretDigest!;
    expect(await run.ledger.digestConflicts("tenant-51", [digest])).toEqual(["tenant-50"]);
    expect(await run.ledger.digestConflicts("tenant-50", [digest])).toEqual([]);
    expect(await run.ledger.digestConflicts("tenant-50", [])).toEqual([]);
  });

  test("rotating the database credential makes the old password fail before it returns", async () => {
    const run = provisioner();
    await run.provision(request("tenant-52"));
    const old = await credential("tenant-52", "product");
    await run.rotate("tenant-52", "database");
    const next = await credential("tenant-52", "product");
    const database = factoryFleetResourceName("factory_product", fleetId, "tenant-52");
    expect(next.password).not.toBe(old.password);
    expect(await canLogin(old.role, old.password, database)).toBe(false);
    expect(await canLogin(next.role, next.password, database)).toBe(true);
    expect(stepsOf("tenant-52").some((call) => call.step === "deployment" && call.action === "rotate")).toBe(true);
    expect((await run.ledger.events("tenant-52")).some((event) => event.event === "step.rotated" && event.step === "database")).toBe(true);
  });

  test("rotation is refused before resources exist and for a step with no credential", async () => {
    const run = provisioner();
    await run.provision(request("tenant-53"), { through: "storage" });
    expect((await factoryRejection(run.rotate("tenant-53", "database"))).code).toBe("provisioning_phase_forbidden");
    await run.provision(request("tenant-53"));
    const rotateless = new LocalFactoryProvisioner({ fleetId, controlDatabaseUrl: controlUrl, secretsRoot: join(root, "installations"), operatorRoot: join(root, "operator"), drivers: { ...drivers(databaseSteps[0]!, new RecordingDriver("secrets")), temporal: { step: "temporal", ensure: async () => ({}), verify: async () => undefined, teardown: async () => undefined } as unknown as FactoryProvisioningDrivers["temporal"] } });
    provisioners.push(rotateless);
    expect((await factoryRejection(rotateless.rotate("tenant-53", "temporal"))).code).toBe("provisioning_rotation_unsupported");
  });
});

describe("teardown and purge", () => {
  const census = (open: { active: number; uncertain: number }): FactoryWorkCensus => ({ count: async () => open });

  test("teardown holds the route first, walks steps backwards, withdraws logins, keeps data, and names its residue", async () => {
    const run = provisioner();
    await run.provision(request("tenant-60"));
    const product = await credential("tenant-60", "product");
    const database = factoryFleetResourceName("factory_product", fleetId, "tenant-60");
    const before = stepsOf("tenant-60").length;
    const outcome = await run.teardown("tenant-60", { reason: "customer left" });
    expect(outcome.installation.phase).toBe("torn_down");
    expect(outcome.residues.map((residue) => [residue.step, residue.failure.code])).toEqual([["storage", "storage_revocation_unsupported"]]);
    expect(stepsOf("tenant-60").slice(before).map((call) => `${call.step}:${call.action}`)).toEqual(["ingress:hold", "invitation:teardown", "ingress:teardown", "deployment:teardown", "temporal:teardown", "storage:teardown"]);
    expect(await canLogin(product.role, product.password, database)).toBe(false);
    expect((await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`).length).toBe(1);
    expect(outcome.installation.steps.every((step) => step.state === "torn_down")).toBe(true);
    expect(await run.servesTraffic("tenant-60")).toBe(false);
    expect((await factoryRejection(run.provision(request("tenant-60")))).code).toBe("provisioning_torn_down");
    expect((await run.teardown("tenant-60", { reason: "again" })).residues).toEqual([]);
  });

  test("teardown of a partial installation tears down only the steps that created something", async () => {
    const run = provisioner();
    await run.provision(request("tenant-61"), { through: "temporal" });
    const before = stepsOf("tenant-61").length;
    await run.teardown("tenant-61", { reason: "abandoned" });
    expect(stepsOf("tenant-61").slice(before).map((call) => `${call.step}:${call.action}`)).toEqual(["temporal:teardown", "storage:teardown"]);
  });

  test("a teardown failure stops with the tenant still tearing down, and the rerun resumes it", async () => {
    const run = provisioner();
    await run.provision(request("tenant-62"));
    failures.set("temporal:teardown:tenant-62", 1);
    expect((await factoryRejection(run.teardown("tenant-62", { reason: "x" }))).code).toBe("temporal_injected");
    expect((await run.status("tenant-62")).phase).toBe("tearing_down");
    expect((await run.teardown("tenant-62", { reason: "x" })).installation.phase).toBe("torn_down");
  });

  test("purge needs a recorded administrator and closed work, drops the databases, and keeps the archive key", async () => {
    const run = provisioner();
    const installation = await run.provision(request("tenant-63"));
    expect((await factoryRejection(run.observeBootstrap("tenant-63", { observe: async () => ({ complete: true, invitationId: "someone-else" }) }))).code).toBe("bootstrap_admin_mismatch");
    expect((await run.observeBootstrap("tenant-63", { observe: async () => ({ complete: false }) })).phase).toBe("invitation_issued");
    const invitationId = (await run.ledger.installation("tenant-63"))!.invitationId;
    expect((await run.observeBootstrap("tenant-63", { observe: async () => ({ complete: true, invitationId }) })).phase).toBe("bootstrap_complete");
    expect((await run.observeBootstrap("tenant-63", { observe: async () => { throw new Error("not called"); } })).phase).toBe("bootstrap_complete");
    const admin63 = "admin:admin@tenant-63.example.test";
    expect((await run.ledger.installation("tenant-63"))!.membershipRefs).toEqual([admin63]);
    expect((await factoryRejection(run.purge("tenant-63", { approvedBy: admin63, reason: "early" }, census({ active: 0, uncertain: 0 })))).code).toBe("provisioning_phase_forbidden");
    await run.teardown("tenant-63", { reason: "done" });
    expect((await factoryRejection(run.purge("tenant-63", { approvedBy: "admin:intruder@example.test", reason: "x" }, census({ active: 0, uncertain: 0 })))).code).toBe("purge_approver_unknown");
    expect((await factoryRejection(run.purge("tenant-63", { approvedBy: admin63, reason: "x" }, census({ active: 1, uncertain: 0 })))).code).toBe("purge_work_open");
    expect((await factoryRejection(run.purge("tenant-63", { approvedBy: admin63, reason: "x" }, census({ active: 0, uncertain: 2 })))).code).toBe("purge_work_open");
    const purged = await run.purge("tenant-63", { approvedBy: admin63, reason: "retention elapsed" }, census({ active: 0, uncertain: 0 }));
    expect(purged.phase).toBe("purged");
    for (const database of [installation.productDatabase, factoryFleetResourceName("factory_pool", fleetId, "tenant-63")]) expect((await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`).length).toBe(0);
    expect(await Bun.file(join(names("tenant-63").operatorDirectory, "master.key")).exists()).toBe(true);
    expect(await Bun.file(join(names("tenant-63").operatorDirectory, "escrow-wraps.json")).exists()).toBe(true);
    expect(await Bun.file(join(names("tenant-63").secretDirectory, "application-jwt-secret")).exists()).toBe(false);
    const loss = (await run.ledger.events("tenant-63")).find((event) => event.event === "purge.audit_loss")!;
    expect(loss.detail).toMatchObject({ approvedBy: admin63, releaseArchive: "retained", activeAtPurge: "0", uncertainAtPurge: "0" });
    expect((await factoryRejection(run.purge("tenant-63", { approvedBy: admin63, reason: "x" }, census({ active: 0, uncertain: 0 })))).code).toBe("provisioning_phase_forbidden");
  });

  test("bootstrap cannot be observed before the invitation is issued, nor for an unknown tenant", async () => {
    const run = provisioner();
    await run.provision(request("tenant-64"), { through: "secrets" });
    expect((await factoryRejection(run.observeBootstrap("tenant-64", { observe: async () => ({ complete: true }) }))).code).toBe("provisioning_phase_forbidden");
    expect((await factoryRejection(run.observeBootstrap("tenant-98", { observe: async () => ({ complete: true }) }))).code).toBe("provisioning_unknown_tenant");
    expect((await factoryRejection(run.status("tenant-98"))).code).toBe("provisioning_unknown_tenant");
    expect((await factoryRejection(run.teardown("tenant-98", { reason: "x" }))).code).toBe("provisioning_unknown_tenant");
  });
});

describe("the control ledger holds references only", () => {
  test("a credential-shaped value is refused before it can reach a row", () => {
    expect(assertFactoryStepResources({ path: "/a/b", oid: "123" })).toEqual({ path: "/a/b", oid: "123" });
    for (const bad of [{ key: "-----BEGIN PRIVATE KEY-----" }, { key: "line\nbreak" }, { key: "x".repeat(4_097) }, { "bad-key": "x" }]) {
      expect(() => assertFactoryStepResources(bad)).toThrow(FactoryProvisioningError);
    }
  });

  test("the directory publishes routing, identity, contact, limits, and membership references only", async () => {
    const run = provisioner();
    await run.provision(request("tenant-65"), { planLimits: { maxActiveRuns: 10 } });
    const entry = (await run.ledger.directory()).find((record) => record.tenantId === "tenant-65")!;
    expect(entry.planLimits).toEqual({ maxActiveRuns: 10 });
    const control = new SQL(controlUrl, { max: 1 });
    try {
      const columns = await control`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position` as { table_name: string; column_name: string; data_type: string }[];
      const allowed = /^(tenant_id|installation_id|hostname|administrator_email|product_database|product_role|temporal_namespace|secret_bundle_path|state|current_step|invitation_id|role_oid|database_oid|role_plan|database_plan|fleet_id|operator_directory|phase|plan_limits|membership_refs|phase_changed_at|step|ordinal|owner|attempts|resources|failure_code|failure_message|updated_at|completed_at|event_id|event|detail|recorded_at|build_id|image|revision|release_directory|registered_at|retired_at|component|previous_build_id|wave_id|target_build_id|canary_tenant_id|failure_tenant_id|failure_component|started_at|finished_at|action)$/;
      expect(columns.filter((column) => !allowed.test(column.column_name))).toEqual([]);
      expect(columns.some((column) => /password|secret_value|token|private_key|artifact|payload/.test(column.column_name))).toBe(false);
    } finally { await control.close(); }
  });
});

describe("fleet upgrade waves", () => {
  const applied: { tenantId: string; component: FactoryUpgradeComponent; buildId: string }[] = [];
  const brokenReadiness = new Set<string>();
  const brokenApply = new Set<string>();
  let upgrades: FactoryFleetUpgrades;
  let upgradeSql: SQL;
  const build = (id: string): FactoryBuild => ({ buildId: id, image: `localhost/ezcorp-factory@sha256:${id.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/g, "a")}`, revision: "a".repeat(40), releaseDirectory: `/opt/release/${id}` });
  const tenants = ["tenant-70", "tenant-71", "tenant-72"];

  beforeAll(async () => {
    const run = provisioner();
    for (const tenantId of tenants) await run.provision(request(tenantId));
    upgradeSql = new SQL(controlUrl, { max: 2 });
    upgrades = new FactoryFleetUpgrades(upgradeSql, {
      apply: async (installation, component, builds) => {
        if (brokenApply.has(`${installation.tenantId}:${component}:${builds[component].buildId}`)) throw new FactoryProvisioningError("migration_failed", "the candidate migration raised");
        applied.push({ tenantId: installation.tenantId, component, buildId: builds[component].buildId });
      },
      ready: async (installation) => { if (brokenReadiness.has(installation.tenantId)) { brokenReadiness.delete(installation.tenantId); throw new FactoryProvisioningError("deployment_not_ready", "readiness failed"); } },
    }, async (tenantId) => {
      const record = (await run.ledger.installation(tenantId))!;
      return { ...record } as unknown as FactoryInstallationContext;
    });
    await upgrades.setup();
    await upgrades.setup();
    for (const id of ["b1", "b2", "b3"]) await upgrades.register(build(id));
    await upgrades.register(build("b1"));
    for (const tenantId of tenants) await upgrades.adopt(tenantId, "b1");
  });

  afterAll(async () => { await upgradeSql.close(); });

  test("a build is a pinned image and a full revision; a conflicting re-registration is refused", async () => {
    expect((await factoryRejection(upgrades.register({ ...build("bad"), image: "localhost/ezcorp-factory:latest" }))).code).toBe("upgrade_build_invalid");
    expect((await factoryRejection(upgrades.register({ ...build("b1"), releaseDirectory: "/elsewhere" }))).code).toBe("upgrade_build_conflict");
    expect((await factoryRejection(upgrades.build("missing"))).code).toBe("upgrade_build_unknown");
    expect(await upgrades.builds("tenant-99")).toBeUndefined();
  });

  test("the canary goes first and alone, each installation moves host, orchestrator, harness in that order", async () => {
    applied.length = 0;
    const result = await upgrades.wave({ buildId: "b2", canary: "tenant-71", tenants });
    expect(result.state).toBe("completed");
    expect(result.upgraded).toEqual(["tenant-71", "tenant-70", "tenant-72"]);
    expect(applied.map((entry) => `${entry.tenantId}:${entry.component}`)).toEqual(["tenant-71:host", "tenant-71:orchestrator", "tenant-71:harness", "tenant-70:host", "tenant-70:orchestrator", "tenant-70:harness", "tenant-72:host", "tenant-72:orchestrator", "tenant-72:harness"]);
    expect(Object.values((await upgrades.builds("tenant-72"))!).map((entry) => entry.buildId)).toEqual(["b2", "b2", "b2"]);
  });

  test("a migration failure in the canary stops the wave, rolls the canary back in reverse, and touches nobody else", async () => {
    applied.length = 0;
    brokenApply.add("tenant-70:harness:b3");
    const result = await upgrades.wave({ buildId: "b3", canary: "tenant-70", tenants });
    expect(result.state).toBe("stopped");
    expect(result.failure).toMatchObject({ tenantId: "tenant-70", component: "harness", code: "migration_failed" });
    expect(result.upgraded).toEqual([]);
    expect(result.rolledBack).toEqual(["tenant-70"]);
    expect(result.untouched).toEqual(["tenant-71", "tenant-72"]);
    expect(applied.map((entry) => `${entry.tenantId}:${entry.component}:${entry.buildId}`)).toEqual(["tenant-70:host:b3", "tenant-70:orchestrator:b3", "tenant-70:harness:b2", "tenant-70:orchestrator:b2", "tenant-70:host:b2"]);
    for (const tenantId of tenants) expect(Object.values((await upgrades.builds(tenantId))!).map((entry) => entry.buildId)).toEqual(["b2", "b2", "b2"]);
    brokenApply.clear();
  });

  test("a readiness failure after the canary stops the wave at that installation", async () => {
    applied.length = 0;
    brokenReadiness.add("tenant-71");
    const result = await upgrades.wave({ buildId: "b3", canary: "tenant-70", tenants });
    expect(result.state).toBe("stopped");
    expect(result.upgraded).toEqual(["tenant-70"]);
    expect(result.rolledBack).toEqual(["tenant-71"]);
    expect(result.untouched).toEqual(["tenant-72"]);
    expect(Object.values((await upgrades.builds("tenant-70"))!).map((entry) => entry.buildId)).toEqual(["b3", "b3", "b3"]);
    expect(Object.values((await upgrades.builds("tenant-71"))!).map((entry) => entry.buildId)).toEqual(["b2", "b2", "b2"]);
  });

  test("an unknown canary is refused, and a build nothing needs is retired while referenced ones are kept", async () => {
    expect((await factoryRejection(upgrades.wave({ buildId: "b3", canary: "tenant-99", tenants }))).code).toBe("upgrade_canary_unknown");
    await upgrades.register(build("b4"));
    // b3 and b2 are running somewhere, b2 is tenant-70's rollback target and b1 is tenant-72's.
    expect(await upgrades.retire({ count: async () => ({ active: 0, uncertain: 0 }) })).toEqual(["b4"]);
    await upgrades.register(build("b5"));
    const busy = await upgrades.retire({ count: async (installation) => ({ active: installation.tenantId === "tenant-70" ? 1 : 0, uncertain: 0 }) });
    expect(busy).toEqual(["b5"]);
  });
});

describe("the purge work census", () => {
  test("counts active and uncertain rows by state only, and treats an absent table as zero", async () => {
    const database = `factory_census_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    const scratch = new SQL(target.toString(), { max: 1 });
    try {
      await scratch.unsafe("CREATE TABLE factory_run_lifecycle (status text); CREATE TABLE factory_release_operations (state text)");
      await scratch.unsafe("INSERT INTO factory_run_lifecycle VALUES ('queued'), ('running'), ('succeeded'), ('uncertain'); INSERT INTO factory_release_operations VALUES ('uncertain'), ('succeeded')");
      const installation = { productDatabase: database } as FactoryInstallationContext;
      expect(await factoryDatabaseCensus(url!).count(installation)).toEqual({ active: 2, uncertain: 2 });
      expect((await factoryRejection(factoryDatabaseCensus(url!, [{ table: "bad;table", column: "state", active: [], uncertain: [] }]).count(installation))).message).toBe("census table name is invalid");
    } finally {
      await scratch.close();
      await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    }
  });
});

test("a tenant-scoped secret file written by hand is never adopted as another tenant's", async () => {
  const run = provisioner();
  await run.provision(request("tenant-80"));
  const jwt = await Bun.file(join(names("tenant-80").secretDirectory, "application-jwt-secret")).text();
  await run.provision(request("tenant-81"), { through: "temporal" });
  await writeModeFile(join(names("tenant-81").secretDirectory, "application-jwt-secret"), jwt);
  expect((await factoryRejection(run.provision(request("tenant-81"))) as FactoryProvisioningError).code).toBe("application_secret_shared");
});

describe("fleet composition", () => {
  test("one settings document composes every driver over real stores, and the provisioner it builds answers", async () => {
    const { composeFactoryProvisioner, parseFactoryFleetSettings } = await import("../../src/factory/provisioning/fleet");
    const operator = join(root, "fleet-operator");
    const identities = JSON.stringify({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "a", secretKey: "b" }] }] });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(operator, { recursive: true, mode: 0o700 });
    const controlPath = await writeModeFile(join(operator, "control-database-url"), `${controlUrl}\n`);
    const adminPath = await writeModeFile(join(operator, "product-admin-url"), `${url}\n`);
    const ordinary = await writeModeFile(join(operator, "ordinary.json"), identities);
    const archive = await writeModeFile(join(operator, "archive.json"), identities);
    const settings = parseFactoryFleetSettings({
      schemaVersion: "factory.fleet.v1", fleetId, profile: "compose",
      roots: { operator, secrets: join(root, "installations"), runtime: join(root, "runtime") },
      control: { databaseUrlPath: controlPath },
      database: { adminUrlPath: adminPath, serviceHost: "127.0.0.1", servicePort: 5432 },
      storage: { ordinary: { endpoint: "http://127.0.0.1:18333", prefix: "ordinary", issuer: { kind: "seeded", serverIdentityPath: ordinary } }, archive: { endpoint: "http://127.0.0.1:18334", prefix: "archive", issuer: { kind: "seeded", serverIdentityPath: archive } }, failureDomain: "same-host-not-independent" },
      temporal: { port: 32001, serverName: "temporal.local" },
      ingress: { address: "127.0.0.1", port: 32005, domain: `${fleetId}.factory.test` },
      installations: { portBase: 31000, cpuCapacity: 2, interpreterCompatibility: "factory-kernel.v1", runnerProfiles: (await import("../../src/__tests__/helpers/factory-private-root")).FACTORY_TEST_RUNNER_PROFILES },
      image: { reference: `localhost/ezcorp-factory@sha256:${"a".repeat(64)}`, revision: "b".repeat(40) },
      release: { directory: join(import.meta.dir, "../.."), bun: process.execPath, path: "/usr/bin:/bin" },
    });
    const fleet = await composeFactoryProvisioner(settings, { compose: { argv: ["true"], env: {} }, uid: process.getuid!(), gid: process.getgid!() });
    try {
      await fleet.provisioner.setup();
      expect((await fleet.provisioner.ledger.directory()).some((entry) => entry.fleetId === fleetId)).toBe(true);
      expect(fleet.deploymentSettings.network.publicOrigin({ hostname: "tenant-01.x" } as FactoryInstallationContext)).toBe("https://tenant-01.x:32005");
      expect(fleet.platform.temporal.revocationsPath.startsWith(operator)).toBe(true);
    } finally { await fleet.close(); }
  });
});

describe("the operator entry", () => {
  test("init writes a local fleet with its own control role, and the main entry answers a status over it", async () => {
    const { writeFactoryLocalFleet, runFactoryFleetMain } = await import("../../src/factory/provisioning/fleet-cli");
    const { FACTORY_TEST_RUNNER_PROFILES } = await import("../../src/__tests__/helpers/factory-private-root");
    const { mkdir } = await import("node:fs/promises");
    const storage = join(root, "local-storage");
    await mkdir(storage, { recursive: true, mode: 0o700 });
    const identities = JSON.stringify({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "a", secretKey: "b" }] }] });
    await writeModeFile(join(storage, "ordinary.json"), identities);
    await writeModeFile(join(storage, "archive.json"), identities);
    const localFleet = `lf${randomBytes(3).toString("hex")}`;
    const options = { fleetId: localFleet, root: join(root, "local-fleet"), image: `localhost/ezcorp-factory@sha256:${"c".repeat(64)}`, revision: "d".repeat(40), portBase: 31000, adminUrl: url!, storageSecretsDirectory: storage, releaseDirectory: join(import.meta.dir, "../.."), bun: process.execPath, runnerProfiles: FACTORY_TEST_RUNNER_PROFILES };
    const first = await writeFactoryLocalFleet(options);
    const second = await writeFactoryLocalFleet(options);
    expect(second.settings).toEqual(first.settings);
    expect(first.settings.temporal.port).toBe(32001);
    expect(first.settings.ingress.port).toBe(32005);
    const controlDatabase = `factory_control_${localFleet}`;
    try {
      expect((await admin`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = ${controlDatabase}`)[0]).toEqual({ owner: `${controlDatabase}_role` });
      expect((await admin`SELECT has_database_privilege('public', ${controlDatabase}, 'CONNECT') AS allowed`)[0]).toEqual({ allowed: false });
      const printed: unknown[] = [];
      await runFactoryFleetMain([first.settingsPath, "status"], { argv: ["true"], env: {} }, { print: (value) => printed.push(value), fail: (value) => printed.push({ failed: value }) });
      expect(printed).toEqual([{ directory: [] }]);
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${controlDatabase}" WITH (FORCE)`);
      await admin.unsafe(`DROP ROLE IF EXISTS "${controlDatabase}_role"`);
    }
  });
});
