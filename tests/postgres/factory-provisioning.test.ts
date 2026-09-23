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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { factoryRejection, makeFactoryPrivateRoot, removeFactoryPrivateRoot, writeModeFile } from "../../src/__tests__/helpers/factory-private-root";
import { FactoryDatabaseStep, factoryDatabaseMarker, factoryDatabasePairs, type FactoryDatabaseKind } from "../../src/factory/provisioning/database";
import type { FactoryInstallationContext, FactoryProvisioningDriver, FactoryStepResources } from "../../src/factory/provisioning/installation";
import { factoryFleetResourceName, factoryInstallationNames } from "../../src/factory/provisioning/installation";
import { assertFactoryStepResources, FactoryProvisioningLedger } from "../../src/factory/provisioning/ledger";
import { FACTORY_PURGE_RETAINED, LocalFactoryProvisioner, type FactoryPurgeChecks, type FactoryProvisioningDrivers } from "../../src/factory/provisioning/local";
import { replaceFactoryPrivateFile } from "../../src/factory/provisioning/secret-files";
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
/**
 * Pools a test creates are closed when that test ends: each provisioner holds
 * up to ten connections, and the shared server's limit is reached long before
 * the file ends. Pools created at describe level live until afterAll.
 */
let testPools: { close(): Promise<void> }[] | undefined;
beforeEach(() => { testPools = []; });
afterEach(async () => {
  const pools = testPools ?? [];
  testPools = undefined;
  for (const pool of pools) await pool.close();
});

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
  async rotate(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<FactoryStepResources> { calls.push({ step: this.step, action: "rotate", tenantId: installation.tenantId }); this.fail("rotate", installation.tenantId); return { ...resources, rotated: "yes" }; }
  async redeliver(installation: FactoryInstallationContext): Promise<void> { calls.push({ step: this.step, action: "redeliver", tenantId: installation.tenantId }); this.fail("redeliver", installation.tenantId); }
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

function provisioner(options: { readonly fault?: (step: FactoryProvisioningStepName, point: "before" | "after") => Promise<void>; readonly afterExternalResourceCreated?: (resource: "role" | "database", kind: FactoryDatabaseKind) => Promise<void>; readonly afterRotationAltered?: (kind: FactoryDatabaseKind) => Promise<void> } = {}): LocalFactoryProvisioner {
  let created: LocalFactoryProvisioner | undefined;
  const database = new FactoryDatabaseStep({ adminUrl: url!, progress: (installation, resources) => created!.ledger.stepProgress(installation.tenantId, "database", resources), ...(options.afterExternalResourceCreated ? { afterExternalResourceCreated: options.afterExternalResourceCreated } : {}), ...(options.afterRotationAltered ? { afterRotationAltered: options.afterRotationAltered } : {}) });
  databaseSteps.push(database);
  testPools?.push(database);
  const secrets = new FactorySecretsStep({ registry: { conflicts: (tenantId, digests) => created!.ledger.digestConflicts(tenantId, digests) }, grantableRoots: () => [join(root, "projects")] });
  created = new LocalFactoryProvisioner({ fleetId, controlDatabaseUrl: controlUrl, secretsRoot: join(root, "installations"), operatorRoot: join(root, "operator"), drivers: drivers(database, secrets), ...(options.fault ? { fault: options.fault } : {}) });
  provisioners.push(created);
  testPools?.push(created);
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
    // The new credential reaches the running services through step 5, which does not rotate its own mesh for it.
    expect(stepsOf("tenant-52").filter((call) => call.step === "deployment" && ["rotate", "redeliver"].includes(call.action)).map((call) => call.action)).toEqual(["redeliver"]);
    expect((await run.ledger.events("tenant-52")).some((event) => event.event === "step.rotated" && event.step === "database")).toBe(true);
  });

  test("a crash between ALTER ROLE and the credential swap is finished by the next read, never a lockout", async () => {
    let armed = true;
    const run = provisioner({ afterRotationAltered: async (kind) => { if (armed && kind === "product") { armed = false; throw new Error("injected rotation crash"); } } });
    await run.provision(request("tenant-54"));
    const old = await credential("tenant-54", "product");
    const database = factoryFleetResourceName("factory_product", fleetId, "tenant-54");
    await expect(run.rotate("tenant-54", "database")).rejects.toThrow("injected rotation crash");
    const pendingPath = join(names("tenant-54").secretDirectory, "product-database.json.pending");
    const next = JSON.parse(await Bun.file(pendingPath).text()) as { role: string; password: string };
    // The role already has the pending password, and the live file still names the old one.
    expect((await credential("tenant-54", "product")).password).toBe(old.password);
    expect(await canLogin(old.role, old.password, database)).toBe(false);
    expect(await canLogin(next.role, next.password, database)).toBe(true);
    await run.provision(request("tenant-54"));
    expect((await credential("tenant-54", "product")).password).toBe(next.password);
    expect(await Bun.file(pendingPath).exists()).toBe(false);
  });

  test("a pending credential whose ALTER never ran is applied on the next read", async () => {
    const run = provisioner();
    await run.provision(request("tenant-55"));
    const old = await credential("tenant-55", "pool");
    const next = { role: old.role, password: randomBytes(32).toString("base64url") };
    await replaceFactoryPrivateFile(join(names("tenant-55").secretDirectory, "pool-database-credential.json.pending"), `${JSON.stringify(next)}\n`);
    await run.provision(request("tenant-55"));
    const database = factoryFleetResourceName("factory_pool", fleetId, "tenant-55");
    expect((await credential("tenant-55", "pool")).password).toBe(next.password);
    expect(await canLogin(old.role, old.password, database)).toBe(false);
    expect(await canLogin(next.role, next.password, database)).toBe(true);
  });

  test("canLogin answers false only for a refused credential and rethrows any other failure", async () => {
    const step = new FactoryDatabaseStep({ adminUrl: url!, progress: async () => undefined });
    databaseSteps.push(step);
    expect(await step.canLogin(`factory_absent_${randomBytes(4).toString("hex")}`, "not-a-password", "postgres")).toBe(false);
    const unreachable = new URL(url!); unreachable.hostname = "127.0.0.1"; unreachable.port = "1";
    const offline = new FactoryDatabaseStep({ adminUrl: unreachable.toString(), progress: async () => undefined });
    databaseSteps.push(offline);
    await expect(offline.canLogin("any_role", "not-a-password", "postgres")).rejects.toBeDefined();
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

describe("rotation through the provisioner", () => {
  const rotations = (tenantId: string, from: number) => stepsOf(tenantId).slice(from).filter((call) => ["rotate", "redeliver"].includes(call.action)).map((call) => `${call.step}:${call.action}`);

  test("the deployment rotates its own mesh and re-delivers nothing else; the invitation delivers itself", async () => {
    const run = provisioner();
    await run.provision(request("tenant-56"));
    let from = stepsOf("tenant-56").length;
    const rotated = await run.rotate("tenant-56", "deployment", { actor: "cli:operator" });
    expect(rotations("tenant-56", from)).toEqual(["deployment:rotate"]);
    expect(rotated.steps.find((entry) => entry.step === "deployment")!.resources.rotated).toBe("yes");
    from = stepsOf("tenant-56").length;
    await run.rotate("tenant-56", "invitation");
    expect(rotations("tenant-56", from)).toEqual(["invitation:rotate"]);
    from = stepsOf("tenant-56").length;
    await run.rotate("tenant-56", "temporal");
    expect(rotations("tenant-56", from)).toEqual(["temporal:rotate", "deployment:redeliver"]);
    const events = await run.ledger.events("tenant-56");
    expect(events.filter((event) => event.event === "operation.rotate").map((event) => [event.detail.step, event.detail.actor])).toEqual([["deployment", "cli:operator"], ["invitation", "unattributed"], ["temporal", "unattributed"]]);
    expect(events.filter((event) => event.event === "step.rotated").map((event) => event.step)).toEqual(["deployment", "invitation", "temporal"]);
  });

  test("before step 5 exists, a rotated credential is not re-delivered", async () => {
    const run = provisioner();
    await run.provision(request("tenant-57"), { through: "secrets" });
    const from = stepsOf("tenant-57").length;
    await run.rotate("tenant-57", "temporal");
    expect(rotations("tenant-57", from)).toEqual(["temporal:rotate"]);
  });

  test("a step that is not complete cannot rotate, so no invitation is issued ahead of its route", async () => {
    const run = provisioner();
    await run.provision(request("tenant-58"), { through: "secrets" });
    for (const step of ["deployment", "invitation"] as const) expect((await factoryRejection(run.rotate("tenant-58", step))).code).toBe("provisioning_phase_forbidden");
    expect(stepsOf("tenant-58").some((call) => call.action === "rotate")).toBe(false);
    expect((await run.status("tenant-58")).steps.find((entry) => entry.step === "invitation")!.state).toBe("pending");
  });

  test("a failed rotation or re-delivery is recorded on the ledger and leaves the step complete", async () => {
    const run = provisioner();
    await run.provision(request("tenant-59"));
    failures.set("temporal:rotate:tenant-59", 1);
    expect((await factoryRejection(run.rotate("tenant-59", "temporal"))).code).toBe("temporal_injected");
    failures.set("deployment:redeliver:tenant-59", 1);
    expect((await factoryRejection(run.rotate("tenant-59", "temporal"))).code).toBe("deployment_injected");
    const status = await run.status("tenant-59");
    expect(status.steps.find((entry) => entry.step === "temporal")!.state).toBe("complete");
    const events = await run.ledger.events("tenant-59");
    expect(events.filter((event) => event.event === "step.rotation_failed").map((event) => [event.step, event.detail.code])).toEqual([["temporal", "temporal_injected"], ["temporal", "deployment_injected"]]);
    expect(events.some((event) => event.event === "step.rotated")).toBe(false);
  });
});

describe("the provisioner's own guards", () => {
  test("every mutation is attributed on the ledger to whoever asked for it", async () => {
    const run = provisioner();
    await run.provision(request("tenant-66"), { actor: "operator:operator-alice", through: "secrets" });
    await run.provision(request("tenant-66"));
    await run.teardown("tenant-66", { reason: "x", actor: "cli:ops" });
    const attributed = (await run.ledger.events("tenant-66")).filter((event) => event.event.startsWith("operation."));
    expect(attributed.map((event) => [event.event, event.detail])).toEqual([
      ["operation.provision", { actor: "operator:operator-alice", through: "secrets" }],
      ["operation.provision", { actor: "unattributed" }],
      ["operation.teardown", { actor: "cli:ops" }],
    ]);
  });

  test("a ledger with a later step complete while an earlier one is not is refused, never skipped past", async () => {
    const run = provisioner();
    await run.provision(request("tenant-67"), { through: "storage" });
    await run.ledger.stepCompleted("tenant-67", "secrets", { owner: "forged" });
    const from = stepsOf("tenant-67").length;
    const refused = await factoryRejection(run.provision(request("tenant-67")));
    expect(refused.code).toBe("provisioning_ledger_out_of_order");
    expect(stepsOf("tenant-67").slice(from).map((call) => `${call.step}:${call.action}`)).toEqual(["storage:verify"]);
    expect((await run.status("tenant-67")).steps.find((entry) => entry.step === "temporal")!.state).toBe("pending");
  });

  test("a phase another writer moved first is refused, not silently recorded", async () => {
    const run = provisioner();
    await run.provision(request("tenant-68"), { through: "secrets" });
    const control = new SQL(controlUrl, { max: 1 });
    try {
      const ledger = new FactoryProvisioningLedger(control);
      const real = ledger.installation.bind(ledger);
      // A reader that saw the phase before another writer moved it on.
      ledger.installation = async (tenantId) => { const record = await real(tenantId); return record && { ...record, phase: "recorded" }; };
      expect((await factoryRejection(ledger.setPhase("tenant-68", "deployment_ready"))).code).toBe("provisioning_phase_conflict");
      expect((await run.status("tenant-68")).phase).toBe("resources_prepared");
      expect((await run.ledger.events("tenant-68")).some((event) => event.event === "phase.deployment_ready")).toBe(false);
    } finally { await control.close(); }
  });
});

describe("teardown and purge", () => {
  const APPROVAL_63 = "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
  /** Closed or open work, and an approvals store that knows one approval, issued by tenant-63's administrator. */
  const census = (open: { active: number; uncertain: number }): FactoryPurgeChecks => ({
    census: { count: async () => open },
    approvals: { verify: async (_installation, approvalId) => { if (approvalId !== APPROVAL_63) throw new FactoryProvisioningError("purge_approval_invalid", "unknown approval"); return { approvedBy: "admin:admin@tenant-63.example.test" }; } },
  });

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

  test("purge needs an installation-issued approval and closed work, drops the databases, and keeps the archive key", async () => {
    const run = provisioner();
    const installation = await run.provision(request("tenant-63"));
    expect((await factoryRejection(run.observeBootstrap("tenant-63", { observe: async () => ({ complete: true, invitationId: "someone-else" }) }))).code).toBe("bootstrap_admin_mismatch");
    expect((await run.observeBootstrap("tenant-63", { observe: async () => ({ complete: false }) })).phase).toBe("invitation_issued");
    const invitationId = (await run.ledger.installation("tenant-63"))!.invitationId;
    expect((await run.observeBootstrap("tenant-63", { observe: async () => ({ complete: true, invitationId }) })).phase).toBe("bootstrap_complete");
    expect((await run.observeBootstrap("tenant-63", { observe: async () => { throw new Error("not called"); } })).phase).toBe("bootstrap_complete");
    const admin63 = "admin:admin@tenant-63.example.test";
    expect((await run.ledger.installation("tenant-63"))!.membershipRefs).toEqual([admin63]);
    expect((await factoryRejection(run.purge("tenant-63", { approvalId: APPROVAL_63, reason: "early" }, census({ active: 0, uncertain: 0 })))).code).toBe("provisioning_phase_forbidden");
    const wraps = await Bun.file(join(names("tenant-63").secretDirectory, "wraps.json")).bytes();
    await run.teardown("tenant-63", { reason: "done" });
    // Secrets teardown moved the wrap into the operator's escrow before deleting it.
    expect(await Bun.file(join(names("tenant-63").secretDirectory, "wraps.json")).exists()).toBe(false);
    expect(await Bun.file(join(names("tenant-63").operatorDirectory, "escrow-wraps.json")).bytes()).toEqual(wraps);
    expect((await factoryRejection(run.purge("tenant-63", { approvalId: "7c1e2d3f-0000-4c6d-8e7f-9a0b1c2d3e4f", reason: "x" }, census({ active: 0, uncertain: 0 })))).code).toBe("purge_approval_invalid");
    expect((await factoryRejection(run.purge("tenant-63", { approvalId: APPROVAL_63, reason: "x" }, census({ active: 1, uncertain: 0 })))).code).toBe("purge_work_open");
    expect((await factoryRejection(run.purge("tenant-63", { approvalId: APPROVAL_63, reason: "x" }, census({ active: 0, uncertain: 2 })))).code).toBe("purge_work_open");
    const purged = await run.purge("tenant-63", { approvalId: APPROVAL_63, reason: "retention elapsed", actor: "operator:operator-alice" }, census({ active: 0, uncertain: 0 }));
    expect(purged.phase).toBe("purged");
    for (const database of [installation.productDatabase, factoryFleetResourceName("factory_pool", fleetId, "tenant-63")]) expect((await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`).length).toBe(0);
    expect(await Bun.file(join(names("tenant-63").operatorDirectory, "master.key")).exists()).toBe(true);
    expect(await Bun.file(join(names("tenant-63").operatorDirectory, "escrow-wraps.json")).bytes()).toEqual(wraps);
    expect(await Bun.file(join(names("tenant-63").secretDirectory, "application-jwt-secret")).exists()).toBe(false);
    const loss = (await run.ledger.events("tenant-63")).find((event) => event.event === "purge.audit_loss")!;
    expect(loss.detail).toEqual({ approvedBy: admin63, approvalId: APPROVAL_63, reason: "retention elapsed", activeAtPurge: "0", uncertainAtPurge: "0", ...FACTORY_PURGE_RETAINED });
    expect((await run.ledger.events("tenant-63")).filter((event) => event.event === "operation.purge").map((event) => event.detail)).toEqual([
      { actor: "unattributed", approvalId: "7c1e2d3f-0000-4c6d-8e7f-9a0b1c2d3e4f" }, { actor: "unattributed", approvalId: APPROVAL_63 }, { actor: "unattributed", approvalId: APPROVAL_63 }, { actor: "operator:operator-alice", approvalId: APPROVAL_63 },
    ]);
    expect((await factoryRejection(run.purge("tenant-63", { approvalId: APPROVAL_63, reason: "x" }, census({ active: 0, uncertain: 0 })))).code).toBe("provisioning_phase_forbidden");
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
    for (const bad of [{ key: "-----BEGIN PRIVATE KEY-----" }, { key: "line\nbreak" }, { key: "x".repeat(4_097) }, { "bad-key": "x" }] as Readonly<Record<string, string>>[]) {
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
    // tenant-73 serves traffic but has no recorded build; tenant-74 stops at resources_prepared.
    await run.provision(request("tenant-73"));
    await run.provision(request("tenant-74"), { through: "secrets" });
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

  const waveRow = async (code: string) => (await upgradeSql`SELECT state, failure_tenant_id, failure_code, skipped FROM factory_upgrade_waves WHERE failure_code = ${code}`)[0] as { state: string; failure_tenant_id: string | null; failure_code: string; skipped: unknown };
  const runningWaves = async () => Number((await upgradeSql`SELECT count(*)::int AS n FROM factory_upgrade_waves WHERE state = 'running'`)[0].n);

  test("an installation that serves no traffic is skipped and named; an ineligible canary stops the wave before anything moves", async () => {
    applied.length = 0;
    expect((await factoryRejection(upgrades.wave({ buildId: "b3", canary: "tenant-74", tenants: ["tenant-70", "tenant-74"] }))).code).toBe("upgrade_canary_ineligible");
    expect(await waveRow("upgrade_canary_ineligible")).toMatchObject({ state: "stopped", failure_tenant_id: "tenant-74" });
    expect(applied).toEqual([]);
    // tenant-70 already runs b3 on every component, so it moves nothing and is proven ready.
    const result = await upgrades.wave({ buildId: "b3", canary: "tenant-70", tenants: ["tenant-70", "tenant-74"] });
    expect(result).toMatchObject({ state: "completed", upgraded: ["tenant-70"], skipped: [{ tenantId: "tenant-74", phase: "resources_prepared" }] });
    const row = (await upgradeSql`SELECT skipped FROM factory_upgrade_waves WHERE wave_id = ${result.waveId}`)[0] as { skipped: unknown };
    expect(typeof row.skipped === "string" ? JSON.parse(row.skipped) : row.skipped).toEqual([{ tenantId: "tenant-74", phase: "resources_prepared" }]);
    expect(await runningWaves()).toBe(0);
  });

  test("a wave that throws is recorded stopped with the failure, never left running", async () => {
    expect((await factoryRejection(upgrades.wave({ buildId: "b3", canary: "tenant-73", tenants: ["tenant-73"] }))).code).toBe("upgrade_installation_unknown");
    expect(await waveRow("upgrade_installation_unknown")).toMatchObject({ state: "stopped", failure_tenant_id: "tenant-73" });
    expect(await runningWaves()).toBe(0);
  });

  test("one wave runs at a time; a wave a crashed process left running is refused until the operator abandons it", async () => {
    const crashed = randomUUID();
    await upgradeSql`INSERT INTO factory_upgrade_waves(wave_id, target_build_id, canary_tenant_id, state) VALUES (${crashed}, 'b3', 'tenant-70', 'running')`;
    const second = randomUUID();
    expect((await factoryRejection(upgradeSql`INSERT INTO factory_upgrade_waves(wave_id, target_build_id, canary_tenant_id, state) VALUES (${second}, 'b3', 'tenant-70', 'running')`)).message).toContain("factory_upgrade_waves_one_running");
    const refused = await factoryRejection(upgrades.wave({ buildId: "b3", canary: "tenant-70", tenants }));
    expect(refused.code).toBe("upgrade_wave_running");
    expect(refused.message).toContain(crashed);
    await upgrades.abandon(crashed);
    expect(await waveRow("upgrade_wave_abandoned")).toMatchObject({ state: "stopped" });
    expect((await factoryRejection(upgrades.abandon(crashed))).code).toBe("upgrade_wave_not_running");
    expect((await upgrades.wave({ buildId: "b3", canary: "tenant-70", tenants: ["tenant-70"] })).state).toBe("completed");
  });

  test("a wave waits for the installation's provisioner lock", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const lockSql = new SQL(controlUrl, { max: 1 });
    try {
      const locked = new FactoryProvisioningLedger(lockSql).locked("tenant-70", async () => { entered(); await held; });
      await inside;
      let finished = false;
      const wave = upgrades.wave({ buildId: "b3", canary: "tenant-70", tenants: ["tenant-70"] }).then((result) => { finished = true; return result; });
      await Bun.sleep(300);
      expect(finished).toBe(false);
      release();
      await locked;
      expect((await wave).state).toBe("completed");
    } finally { await lockSql.close(); }
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
      // No platform runs for this fleet, so the serving check is a failure, never a false "serves".
      expect(await fleet.platformServes().then((served) => (served ? "served" : "not serving"), () => "unreachable")).toBe("unreachable");
      // The upgrade ledger finds each installation's context through the provisioner's ledger.
      const { factoryFleetDefaultBuild } = await import("../../src/factory/provisioning/fleet");
      const build = factoryFleetDefaultBuild(settings).buildId;
      await fleet.provisioner.ledger.record({ tenantId: "tenant-97", fleetId, installationId: randomUUID(), hostname: `tenant-97.${fleetId}.factory.test`, administratorEmail: "admin@tenant-97.example.test", invitationId: randomUUID(), ...names("tenant-97"), rolePlan: randomUUID(), databasePlan: randomUUID() });
      await fleet.upgrades.adopt("tenant-97", build);
      const counted: string[] = [];
      await fleet.upgrades.retire({ count: async (installation) => { counted.push(`${installation.tenantId}:${installation.fleetId}`); return { active: 0, uncertain: 0 }; } });
      expect(counted).toContain(`tenant-97:${fleetId}`);
      await fleet.upgrades.adopt("tenant-96", build);
      const control = new SQL(controlUrl, { max: 1 });
      try {
        expect((await factoryRejection(fleet.upgrades.retire({ count: async () => ({ active: 0, uncertain: 0 }) })) as FactoryProvisioningError).code).toBe("provisioning_unknown_tenant");
      } finally {
        // Remove the orphan build row so no later retire meets it.
        await control`DELETE FROM factory_installation_builds WHERE tenant_id = ${"tenant-96"}`;
        await control.close();
      }
    } finally { await fleet.close(); }
  });
});

describe("store claims on the real cluster", () => {
  test("a (store, bucket) claimed by one fleet is refused to another, and the holder's rerun passes", async () => {
    const { factoryDatabaseStorageClaims, factoryStorageClaimRole } = await import("../../src/factory/provisioning/storage");
    // A unique endpoint gives a claim role no other run can hold; only that role is removed afterwards.
    const scope = { domain: "ordinary" as const, endpoint: `http://claim-test-${randomBytes(6).toString("hex")}.invalid:1`, bucket: "tenant-01", prefix: "ordinary" };
    const role = factoryStorageClaimRole(scope);
    const claims = factoryDatabaseStorageClaims(url!);
    const holder = { ...names("tenant-01"), ...request("tenant-01"), fleetId: "claim-fleet-a", installationId: "claim-installation", invitationId: "x" };
    try {
      await claims.claim(holder, scope);
      await claims.claim(holder, scope);
      expect((await admin`SELECT rolcanlogin, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = ${role}`)[0]).toEqual({ rolcanlogin: false, marker: "factory-store-claim:claim-fleet-a:tenant-01" });
      expect((await factoryRejection(claims.claim({ ...holder, fleetId: "claim-fleet-b" }, scope)) as FactoryProvisioningError).code).toBe("storage_claimed_by_other_fleet");
      expect((await factoryRejection(claims.claim({ ...holder, tenantId: "tenant-02" }, scope)) as FactoryProvisioningError).code).toBe("storage_claimed_by_other_fleet");
    } finally { await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`); }
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
      // A purge reads the admin URL for its census and approvals, then refuses an installation that is not torn down.
      await runFactoryFleetMain([first.settingsPath, "purge", "tenant-01", "--approval", "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"], { argv: ["true"], env: {} }, { print: (value) => printed.push(value), fail: (value) => printed.push({ failed: value }) });
      expect(printed[1]).toMatchObject({ failed: { error: { code: "provisioning_phase_forbidden" } } });
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${controlDatabase}" WITH (FORCE)`);
      await admin.unsafe(`DROP ROLE IF EXISTS "${controlDatabase}_role"`);
    }
  });
});
