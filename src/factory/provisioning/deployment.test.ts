import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  FACTORY_TEST_IMAGE,
  factoryRejection,
  makeFactoryPrivateRoot,
  makeFactoryTestDeploymentSettings,
  makeFactoryTestInstallation,
  removeFactoryPrivateRoot,
  writeFactoryTestDatabaseCredentials,
  writeModeFile,
} from "../../__tests__/helpers/factory-private-root";
import { parseFactoryPoolProcessConfig } from "../pool/process";
import { parseFactorySupervisorProcessConfig } from "../runner/supervisor-process";
import { parseFactoryStartupConfig } from "../startup-config";
import { factoryDatabasePairs } from "./database";
import {
  FACTORY_CONTAINER_SERVICES,
  FACTORY_DEPLOYED_SERVICES,
  FactoryDeploymentStep,
  factoryInstallationPorts,
  renderFactoryInstallationBundle,
  writeFactoryDeliveries,
  type FactoryDeploymentTarget,
  type FactoryInstallationBundle,
} from "./deployment";
import type { FactoryInstallationBuilds } from "./fleet-upgrade";
import type { FactoryInstallationContext } from "./installation";
import { FACTORY_BOOTSTRAP_INVITATION_FILE } from "./invitation";
import { FACTORY_MESH_FILES, FACTORY_MESH_OPERATOR_FILES } from "./mesh";
import { FACTORY_APPLICATION_SECRET_FILES, FACTORY_KEY_FILES } from "./secrets";
import { factoryTemporalOwnerMarker } from "./temporal";

/** Every tenant-secret file the secrets, storage, temporal and invitation steps leave in the secret directory. */
const TENANT_SECRET_FILES = [
  FACTORY_APPLICATION_SECRET_FILES.jwt, FACTORY_APPLICATION_SECRET_FILES.encryption, FACTORY_APPLICATION_SECRET_FILES.salt,
  "ordinary-storage.json", "archive-storage.json", FACTORY_BOOTSTRAP_INVITATION_FILE,
  "temporal-ca.crt", "temporal-client.crt", "temporal-client.key", "temporal-token", FACTORY_KEY_FILES.wraps,
] as const;

/** Every mesh file, with a marker so a delivered copy is traceable to its source. */
const MESH_FILE_NAMES = Object.values(FACTORY_MESH_FILES);

const marker = (name: string) => `marker:${name}\n`;

/** Seed every file a delivery copies, the way the earlier steps would have left them. */
async function seedInstallationFiles(installation: FactoryInstallationContext, options: { readonly mesh: boolean }): Promise<{ readonly product: string; readonly pool: string }> {
  const passwords = await writeFactoryTestDatabaseCredentials(installation);
  for (const name of [...TENANT_SECRET_FILES, ...(options.mesh ? MESH_FILE_NAMES : [])]) await writeModeFile(join(installation.secretDirectory, name), marker(name));
  await mkdir(installation.operatorDirectory, { recursive: true, mode: 0o700 });
  await chmod(installation.operatorDirectory, 0o700);
  await writeModeFile(join(installation.operatorDirectory, FACTORY_KEY_FILES.master), marker(FACTORY_KEY_FILES.master));
  return passwords;
}

async function filesIn(directory: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) out[name] = await readFile(join(directory, name), "utf8");
  return out;
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe("factoryInstallationPorts", () => {
  test("derives five consecutive ports ten apart per tenant number", () => {
    expect(factoryInstallationPorts("tenant-01", 40_000)).toEqual({ harness: 40_010, privateService: 40_011, gateway: 40_012, pool: 40_013, supervisor: 40_014 });
    expect(factoryInstallationPorts("tenant-00", 1_024).harness).toBe(1_024);
    expect(factoryInstallationPorts("tenant-99", 64_535).supervisor).toBe(64_535 + 990 + 4);
    expect(Object.isFrozen(factoryInstallationPorts("tenant-02", 40_000))).toBe(true);
  });

  test("two tenants never share a port", () => {
    const first = Object.values(factoryInstallationPorts("tenant-01", 40_000));
    const second = Object.values(factoryInstallationPorts("tenant-02", 40_000));
    expect(first.filter((port) => second.includes(port))).toEqual([]);
  });

  test("refuses a malformed tenant or an out-of-range base", () => {
    for (const [tenant, base] of [["tenant-1", 40_000], ["tenant-001", 40_000], ["TENANT-01", 40_000], ["tenant-01", 1_023], ["tenant-01", 64_536], ["tenant-01", 40_000.5], ["tenant-01", Number.NaN]] as const) {
      let code: string | undefined;
      try { factoryInstallationPorts(tenant, base); } catch (error) { code = (error as { code?: string }).code; }
      expect(code).toBe("deployment_ports_invalid");
    }
  });
});

describe("renderFactoryInstallationBundle", () => {
  let root: string;
  let installation: FactoryInstallationContext;
  let passwords: { readonly product: string; readonly pool: string };
  let bundle: FactoryInstallationBundle;

  beforeAll(async () => {
    root = await makeFactoryPrivateRoot();
    installation = makeFactoryTestInstallation(root);
    passwords = await seedInstallationFiles(installation, { mesh: true });
    bundle = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime")));
  });
  afterAll(async () => { await removeFactoryPrivateRoot(root); });

  test("names the installation's ports, host, directories and origin", () => {
    expect(bundle.ports).toEqual(factoryInstallationPorts("tenant-01", 40_000));
    expect(bundle.hostId).toBe("host.tenant-01.fleet-a");
    expect(bundle.runtimeDirectory).toBe(join(root, "runtime", "tenant-01"));
    expect(bundle.readinessDirectory).toBe(join(bundle.runtimeDirectory, "readiness"));
    expect(bundle.runnerRoot).toBe(join(bundle.runtimeDirectory, "runner"));
    expect(bundle.dataDirectory).toBe(join(bundle.runtimeDirectory, "harness-data"));
    expect(bundle.publicOrigin).toBe("https://tenant-01.factory.example:30443");
    expect(bundle.environment.harness.ORIGIN).toBe(bundle.publicOrigin);
    expect(bundle.environment.harness.PORT).toBe("40010");
    expect(Object.keys(bundle.deliveries).sort()).toEqual([...FACTORY_DEPLOYED_SERVICES].sort());
    expect(Object.keys(bundle.environment).sort()).toEqual([...FACTORY_CONTAINER_SERVICES].sort());
  });

  test("without a builds provider every container runs the pinned image and the supervisor runs the fleet default", () => {
    expect(bundle.images).toEqual({ pool: FACTORY_TEST_IMAGE, gateway: FACTORY_TEST_IMAGE, harness: FACTORY_TEST_IMAGE, orchestrator: FACTORY_TEST_IMAGE });
    expect(bundle.images.supervisorRelease).toBeUndefined();
  });

  test("the orchestrator delivery alone holds the master key and the wrapped data key", () => {
    const holders = (name: string) => Object.values(bundle.deliveries).filter((delivery) => name in delivery.files).map((delivery) => delivery.service);
    expect(holders(FACTORY_KEY_FILES.master)).toEqual(["orchestrator"]);
    expect(holders(FACTORY_KEY_FILES.wraps)).toEqual(["orchestrator"]);
    expect(bundle.deliveries.orchestrator.files[FACTORY_KEY_FILES.master]).toEqual({ source: join(installation.operatorDirectory, FACTORY_KEY_FILES.master) });
  });

  test("the supervisor holds the host signing key and no tenant secret", () => {
    const supervisor = Object.keys(bundle.deliveries.supervisor.files).sort();
    expect(supervisor).toContain(FACTORY_MESH_FILES.hostKey);
    expect(supervisor).toEqual([
      FACTORY_MESH_FILES.caCertificate, FACTORY_MESH_FILES.serverCertificate, FACTORY_MESH_FILES.serverKey, FACTORY_MESH_FILES.supervisorCertificate,
      FACTORY_MESH_FILES.supervisorKey, FACTORY_MESH_FILES.supervisorPoolToken, FACTORY_MESH_FILES.hostKey, FACTORY_MESH_FILES.hostKeyId, "supervisor.json",
    ].sort());
    for (const forbidden of [...TENANT_SECRET_FILES, FACTORY_KEY_FILES.master, FACTORY_MESH_FILES.attemptTokenSecret, "pool-database.json", "gateway-database-url", "harness-database-url", "product-database.json", "pool-database-credential.json"]) {
      expect(supervisor).not.toContain(forbidden);
    }
  });

  test("only the supervisor holds the host signing key; the harness gets its public half", () => {
    const holders = Object.values(bundle.deliveries).filter((delivery) => FACTORY_MESH_FILES.hostKey in delivery.files).map((delivery) => delivery.service);
    expect(holders).toEqual(["supervisor"]);
    expect(FACTORY_MESH_FILES.hostPublicKey in bundle.deliveries.harness.files).toBe(true);
  });

  test("the harness delivery holds no master key, no wrapped key, and no operator material", () => {
    const harness = Object.keys(bundle.deliveries.harness.files);
    for (const forbidden of [FACTORY_KEY_FILES.master, FACTORY_KEY_FILES.wraps, FACTORY_MESH_FILES.hostKey, ...Object.values(FACTORY_MESH_OPERATOR_FILES).filter((name) => name !== FACTORY_MESH_FILES.caCertificate)]) {
      expect(harness).not.toContain(forbidden);
    }
    for (const delivery of Object.values(bundle.deliveries)) {
      for (const entry of Object.values(delivery.files)) {
        if ("source" in entry && entry.source.startsWith(installation.operatorDirectory)) expect(delivery.service).toBe("orchestrator");
      }
    }
  });

  test("the rendered pool, startup and supervisor documents are accepted by their own process parsers", () => {
    const document = (service: keyof typeof bundle.deliveries, name: string) => (bundle.deliveries[service].files[name] as { document: unknown }).document;
    const pool = document("pool", "pool.json");
    const startup = document("harness", "factory-startup.json");
    const supervisor = document("supervisor", "supervisor.json");
    expect(parseFactoryPoolProcessConfig(JSON.parse(JSON.stringify(pool)))).toEqual(pool as never);
    expect(parseFactoryStartupConfig(JSON.parse(JSON.stringify(startup)))).toEqual(startup as never);
    expect(parseFactorySupervisorProcessConfig(JSON.parse(JSON.stringify(supervisor)))).toEqual(supervisor as never);
    const [, poolPair] = factoryDatabasePairs(installation);
    expect((pool as { database: { expectedRole: string } }).database.expectedRole).toBe(poolPair!.role);
    expect((supervisor as { hostKeyPath: string }).hostKeyPath).toBe(join(bundle.deliveries.supervisor.directory, FACTORY_MESH_FILES.hostKey));
  });

  test("database URLs carry each service's own credential, and only there", () => {
    const text = (service: keyof typeof bundle.deliveries, name: string) => (bundle.deliveries[service].files[name] as { text: string }).text;
    expect(text("gateway", "gateway-database-url")).toContain(passwords.product);
    expect(text("harness", "harness-database-url")).toContain(passwords.product);
    const poolDocument = (bundle.deliveries.pool.files["pool-database.json"] as { document: { databaseUrl: string } }).document;
    expect(new URL(poolDocument.databaseUrl).password).toBe(passwords.pool);
    expect(new URL(poolDocument.databaseUrl).host).toBe("127.0.0.1:55432");
    expect(JSON.stringify(bundle.environment)).not.toContain(passwords.product);
    expect(JSON.stringify(bundle.deliveries.supervisor)).not.toContain(passwords.product);
    expect(JSON.stringify(bundle.deliveries.supervisor)).not.toContain(passwords.pool);
  });

  test("a second installation's deliveries share no path with the first", async () => {
    const other = makeFactoryTestInstallation(root, { tenantId: "tenant-02" });
    await seedInstallationFiles(other, { mesh: false });
    const second = await renderFactoryInstallationBundle(other, makeFactoryTestDeploymentSettings(join(root, "runtime")));
    const paths = (value: FactoryInstallationBundle) => Object.values(value.deliveries).flatMap((delivery) => [delivery.directory, ...Object.values(delivery.files).flatMap((entry) => "source" in entry ? [entry.source] : [])]);
    const firstPaths = new Set(paths(bundle));
    expect(paths(second).filter((path) => firstPaths.has(path))).toEqual([]);
    expect(second.ports.harness).toBe(40_020);
  });

  test("a builds provider moves each service onto its component's image and the supervisor onto the host release", async () => {
    const build = (component: string, digit: string) => ({ buildId: `${component}-2`, image: `registry.test/${component}@sha256:${digit.repeat(64)}`, revision: "e".repeat(40), releaseDirectory: `/srv/releases/${component}` });
    const builds: FactoryInstallationBuilds = { host: build("host", "1"), harness: build("harness", "2"), orchestrator: build("orchestrator", "3") };
    const seen: string[] = [];
    const upgraded = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime"), { builds: async (value) => { seen.push(value.tenantId); return builds; } }));
    expect(seen).toEqual(["tenant-01"]);
    expect(upgraded.images).toEqual({ pool: builds.host.image, gateway: builds.harness.image, harness: builds.harness.image, orchestrator: builds.orchestrator.image, supervisorRelease: "/srv/releases/host" });
    expect(upgraded.image.reference).toBe(FACTORY_TEST_IMAGE);
  });

  test("a builds provider that has recorded nothing leaves every service on the pinned image", async () => {
    const unchanged = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime"), { builds: async () => undefined }));
    expect(unchanged.images).toEqual(bundle.images);
  });

  test("an image referenced by tag, or with a short digest, is refused", async () => {
    for (const reference of ["registry.test/ezcorp:latest", `registry.test/ezcorp@sha256:${"b".repeat(63)}`, `registry test/ezcorp@sha256:${"b".repeat(64)}`, `@sha256:${"b".repeat(64)}`]) {
      const settings = makeFactoryTestDeploymentSettings(join(root, "runtime"), { image: { reference, revision: "c".repeat(40) } });
      expect((await factoryRejection(renderFactoryInstallationBundle(installation, settings))).code).toBe("deployment_image_unpinned");
    }
  });

  test("an installation whose database credentials were never written cannot render", async () => {
    const missing = makeFactoryTestInstallation(root, { tenantId: "tenant-03" });
    const error = await factoryRejection(renderFactoryInstallationBundle(missing, makeFactoryTestDeploymentSettings(join(root, "runtime"))));
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});

describe("writeFactoryDeliveries", () => {
  let root: string;
  let installation: FactoryInstallationContext;
  let passwords: { readonly product: string; readonly pool: string };
  let bundle: FactoryInstallationBundle;

  beforeAll(async () => {
    root = await makeFactoryPrivateRoot();
    installation = makeFactoryTestInstallation(root);
    passwords = await seedInstallationFiles(installation, { mesh: true });
    bundle = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime")));
    await writeFactoryDeliveries(bundle);
  });
  afterAll(async () => { await removeFactoryPrivateRoot(root); });

  test("each delivery directory is 0700 and holds exactly its listed files, each 0600", async () => {
    for (const delivery of Object.values(bundle.deliveries)) {
      expect(await mode(delivery.directory)).toBe(0o700);
      expect((await readdir(delivery.directory)).sort()).toEqual(Object.keys(delivery.files).sort());
      for (const name of Object.keys(delivery.files)) expect(await mode(join(delivery.directory, name))).toBe(0o600);
    }
    for (const directory of [bundle.runtimeDirectory, bundle.readinessDirectory, bundle.runnerRoot, bundle.dataDirectory]) expect(await mode(directory)).toBe(0o700);
  });

  test("source entries are copied byte for byte, documents as JSON, texts verbatim", async () => {
    const orchestrator = await filesIn(bundle.deliveries.orchestrator.directory);
    expect(orchestrator[FACTORY_KEY_FILES.master]).toBe(marker(FACTORY_KEY_FILES.master));
    expect(orchestrator[FACTORY_KEY_FILES.wraps]).toBe(marker(FACTORY_KEY_FILES.wraps));
    const pool = await filesIn(bundle.deliveries.pool.directory);
    expect(JSON.parse(pool["pool.json"]!)).toEqual(JSON.parse(JSON.stringify((bundle.deliveries.pool.files["pool.json"] as { document: unknown }).document)));
    const gateway = await filesIn(bundle.deliveries.gateway.directory);
    expect(gateway["gateway-database-url"]).toBe((bundle.deliveries.gateway.files["gateway-database-url"] as { text: string }).text);
  });

  test("the written supervisor directory contains no tenant secret byte", async () => {
    const supervisor = Object.values(await filesIn(bundle.deliveries.supervisor.directory)).join("\n");
    expect(supervisor).toContain(marker(FACTORY_MESH_FILES.hostKey));
    for (const secret of [passwords.product, passwords.pool, ...TENANT_SECRET_FILES.map(marker), marker(FACTORY_MESH_FILES.attemptTokenSecret), marker(FACTORY_KEY_FILES.master)]) {
      expect(supervisor).not.toContain(secret);
    }
    const harness = Object.values(await filesIn(bundle.deliveries.harness.directory)).join("\n");
    expect(harness).not.toContain(marker(FACTORY_KEY_FILES.master));
    expect(harness).not.toContain(marker(FACTORY_MESH_FILES.hostKey));
  });

  test("the written documents parse with the process parsers", async () => {
    expect(parseFactoryPoolProcessConfig(JSON.parse(await readFile(join(bundle.deliveries.pool.directory, "pool.json"), "utf8"))).poolId).toBe("pool.tenant-01");
    expect(parseFactoryStartupConfig(JSON.parse(await readFile(join(bundle.deliveries.harness.directory, "factory-startup.json"), "utf8"))).tenantId).toBe("tenant-01");
    expect(parseFactorySupervisorProcessConfig(JSON.parse(await readFile(join(bundle.deliveries.supervisor.directory, "supervisor.json"), "utf8"))).hostId).toBe("host.tenant-01.fleet-a");
  });

  test("a rewrite is idempotent, and a file dropped from a delivery is gone after the next write", async () => {
    await writeFactoryDeliveries(bundle);
    expect((await readdir(bundle.deliveries.pool.directory)).sort()).toEqual(Object.keys(bundle.deliveries.pool.files).sort());
    const { [FACTORY_MESH_FILES.tokenPublicKey]: _dropped, ...kept } = bundle.deliveries.pool.files;
    const narrowed: FactoryInstallationBundle = { ...bundle, deliveries: { ...bundle.deliveries, pool: { ...bundle.deliveries.pool, files: kept } } };
    await writeFactoryDeliveries(narrowed);
    const after = await readdir(bundle.deliveries.pool.directory);
    expect(after).not.toContain(FACTORY_MESH_FILES.tokenPublicKey);
    expect(after.sort()).toEqual(Object.keys(kept).sort());
  });

  test("a source that is not private is refused rather than delivered", async () => {
    const leaky = join(installation.secretDirectory, "leaky.txt");
    await writeModeFile(leaky, "world readable\n", 0o644);
    const tainted: FactoryInstallationBundle = { ...bundle, deliveries: { ...bundle.deliveries, pool: { ...bundle.deliveries.pool, files: { "leaky.txt": { source: leaky } } } } };
    const error = await factoryRejection(writeFactoryDeliveries(tainted));
    expect(error.message).toContain("private");
  });
});

interface RecordedCall { readonly method: "apply" | "ready" | "remove" | "purge"; readonly tenantId: string }

function recordingTarget(options: { readonly failReady?: Error } = {}): FactoryDeploymentTarget & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    profile: "compose",
    calls,
    async apply(bundle) { calls.push({ method: "apply", tenantId: bundle.installation.tenantId }); return { composeProject: `project-${bundle.installation.tenantId}` }; },
    async ready(bundle) { calls.push({ method: "ready", tenantId: bundle.installation.tenantId }); if (options.failReady) throw options.failReady; },
    async remove(bundle) { calls.push({ method: "remove", tenantId: bundle.installation.tenantId }); },
    async purge(bundle) { calls.push({ method: "purge", tenantId: bundle.installation.tenantId }); },
  };
}

describe("FactoryDeploymentStep", () => {
  let root: string;
  let installation: FactoryInstallationContext;

  beforeAll(async () => {
    root = await makeFactoryPrivateRoot();
    installation = makeFactoryTestInstallation(root);
    await seedInstallationFiles(installation, { mesh: false });
  });
  afterAll(async () => { await removeFactoryPrivateRoot(root); });

  test("ensure creates the mesh, writes deliveries, applies, waits ready, and returns references only", async () => {
    const target = recordingTarget();
    const step = new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target });
    expect(step.step).toBe("deployment");
    const resources = await step.ensure(installation);
    expect(target.calls.map((call) => call.method)).toEqual(["apply", "ready"]);
    expect(resources).toEqual({
      composeProject: "project-tenant-01", profile: "compose", image: FACTORY_TEST_IMAGE, revision: "c".repeat(40), hostId: "host.tenant-01.fleet-a",
      temporalOwner: factoryTemporalOwnerMarker(installation), harnessPort: "40010", publicOrigin: "https://tenant-01.factory.example:30443",
      runtimeDirectory: join(root, "runtime", "tenant-01"),
    });
    expect(Object.isFrozen(resources)).toBe(true);
    // The mesh landed in the installation's own secret and operator directories.
    const secrets = await readdir(installation.secretDirectory);
    for (const name of MESH_FILE_NAMES) expect(secrets).toContain(name);
    const operator = await readdir(installation.operatorDirectory);
    for (const name of Object.values(FACTORY_MESH_OPERATOR_FILES)) expect(operator).toContain(name);
    expect(secrets).not.toContain(FACTORY_MESH_OPERATOR_FILES.caKey);
    expect(secrets).not.toContain(FACTORY_MESH_OPERATOR_FILES.tokenKey);
    // The delivered supervisor host key is the real one the mesh generated.
    const hostKey = await readFile(join(installation.secretDirectory, "deliver", "supervisor", FACTORY_MESH_FILES.hostKey), "utf8");
    expect(hostKey).toContain("PRIVATE KEY");
    expect(hostKey).toBe(await readFile(join(installation.secretDirectory, FACTORY_MESH_FILES.hostKey), "utf8"));
  });

  test("a rerun of ensure keeps the mesh the running processes already trust", async () => {
    const before = await readFile(join(installation.secretDirectory, FACTORY_MESH_FILES.serverCertificate), "utf8");
    const target = recordingTarget();
    await new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target }).ensure(installation);
    expect(await readFile(join(installation.secretDirectory, FACTORY_MESH_FILES.serverCertificate), "utf8")).toBe(before);
    expect(target.calls.map((call) => call.method)).toEqual(["apply", "ready"]);
  });

  test("ensure fails when the target never becomes ready", async () => {
    const failure = Object.assign(new Error("not ready"), { code: "deployment_not_ready" });
    const target = recordingTarget({ failReady: failure });
    const error = await factoryRejection(new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target }).ensure(installation));
    expect(error.code).toBe("deployment_not_ready");
  });

  test("verify asks the target to prove readiness of this installation's bundle", async () => {
    const target = recordingTarget();
    await new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target }).verify(installation);
    expect(target.calls).toEqual([{ method: "ready", tenantId: "tenant-01" }]);
  });

  test("rotate re-delivers, restarts onto the new material, and keeps the recorded references", async () => {
    const target = recordingTarget();
    const recorded = { composeProject: "project-tenant-01" };
    const rotated = await new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target }).rotate(installation, recorded);
    expect(rotated).toBe(recorded);
    expect(target.calls.map((call) => call.method)).toEqual(["remove", "apply", "ready"]);
  });

  test("teardown removes the services and every delivery, and a second teardown still succeeds", async () => {
    const target = recordingTarget();
    const step = new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target });
    await step.teardown(installation);
    expect(target.calls).toEqual([{ method: "remove", tenantId: "tenant-01" }]);
    expect(await readdir(installation.secretDirectory)).not.toContain("deliver");
    await step.teardown(installation);
    expect(target.calls.map((call) => call.method)).toEqual(["remove", "remove"]);
  });

  test("purge hands the bundle to the target", async () => {
    const target = recordingTarget();
    await new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target }).purge(installation);
    expect(target.calls).toEqual([{ method: "purge", tenantId: "tenant-01" }]);
  });

  test("teardown and purge of an installation that cannot render touch no target", async () => {
    const target = recordingTarget();
    const step = new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target });
    const unrendered = makeFactoryTestInstallation(root, { tenantId: "tenant-04" });
    await step.teardown(unrendered);
    await step.purge(unrendered);
    expect(target.calls).toEqual([]);
  });
});
