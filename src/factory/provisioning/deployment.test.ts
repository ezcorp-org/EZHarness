import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FACTORY_TEST_IMAGE,
  factoryRejection,
  makeFactoryPrivateRoot,
  makeFactoryTestDeploymentSettings,
  makeFactoryTestHostFacts,
  makeFactoryTestInstallation,
  removeFactoryPrivateRoot,
  writeFactoryTestDatabaseCredentials,
  writeFactoryTestHostMaterial,
  writeModeFile,
} from "../../__tests__/helpers/factory-private-root";
import { factoryTemporalPositionsFromConfig } from "../recovery-composition";
import { parseFactoryStartupConfig } from "../startup-config";
import { FactoryTemporalHttpPositions } from "../temporal-retention";
import {
  FACTORY_CONTAINER_PATHS,
  FACTORY_CONTAINER_SERVICES,
  FACTORY_DEFAULT_DATABASE_POOL_MAX,
  FACTORY_DEPLOYED_SERVICES,
  FactoryDeploymentStep,
  factoryDeploymentHandle,
  factoryInstallationPorts,
  renderFactoryInstallationBundle,
  writeFactoryDeliveries,
  type FactoryDeploymentTarget,
  type FactoryInstallationBundle,
} from "./deployment";
import type { FactoryInstallationBuilds } from "./fleet-upgrade";
import type { FactoryInstallationContext } from "./installation";
import { FACTORY_INGRESS_PROOF_FILE } from "./ingress";
import { FACTORY_HOST_FILES, factoryFleetHostIdentity } from "./host";
import { composeFactoryGuestBroker } from "../guest-broker-composition";
import { certificates } from "../../__tests__/helpers/factory-certificates";
import { FACTORY_BOOTSTRAP_INVITATION_FILE } from "./invitation";
import { FACTORY_GUEST_BROKER_AUDIENCE, FACTORY_MESH_FILES, FACTORY_MESH_OPERATOR_FILES, FACTORY_MESH_TOKEN_KEY_ID } from "./mesh";
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

/** Seed every file a delivery copies, the way the earlier steps (and the fleet host) would have left them. */
async function seedInstallationFiles(installation: FactoryInstallationContext, options: { readonly mesh: boolean; readonly runtimeRoot: string }): Promise<{ readonly product: string; readonly pool: string }> {
  const passwords = await writeFactoryTestDatabaseCredentials(installation);
  await writeFactoryTestHostMaterial(makeFactoryTestHostFacts(options.runtimeRoot));
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
  test("derives four consecutive ports ten apart per tenant number", () => {
    expect(factoryInstallationPorts("tenant-01", 40_000)).toEqual({ harness: 40_010, privateService: 40_011, gateway: 40_012, guestBroker: 40_013 });
    // The highest tenant's guest-broker port stays below the fleet host's pool port (base + 1002).
    expect(factoryInstallationPorts("tenant-99", 40_000).guestBroker).toBeLessThan(factoryFleetHostIdentity("fleet-a", 40_000).ports.pool);
    expect(factoryInstallationPorts("tenant-00", 1_024).harness).toBe(1_024);
    expect(factoryInstallationPorts("tenant-99", 64_535).gateway).toBe(64_535 + 990 + 2);
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
    passwords = await seedInstallationFiles(installation, { mesh: true, runtimeRoot: join(root, "runtime") });
    bundle = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime")));
  });
  afterAll(async () => { await removeFactoryPrivateRoot(root); });

  test("names the installation's ports, the fleet host, directories and origin", () => {
    expect(bundle.ports).toEqual(factoryInstallationPorts("tenant-01", 40_000));
    expect(bundle.host).toEqual(makeFactoryTestHostFacts(join(root, "runtime")));
    expect([bundle.host.poolId, bundle.host.hostId, bundle.host.ports]).toEqual(["pool.fleet-a", "host.fleet-a", { pool: 41_002, supervisor: 41_003 }]);
    expect(bundle.runtimeDirectory).toBe(join(root, "runtime", "tenant-01"));
    expect(bundle.readinessDirectory).toBe(join(bundle.runtimeDirectory, "readiness"));
    expect(bundle.dataDirectory).toBe(join(bundle.runtimeDirectory, "harness-data"));
    expect(bundle.publicOrigin).toBe("https://tenant-01.factory.example:30443");
    expect(bundle.environment.harness.ORIGIN).toBe(bundle.publicOrigin);
    expect(bundle.environment.harness.PORT).toBe("40010");
    expect(Object.keys(bundle.deliveries).sort()).toEqual([...FACTORY_DEPLOYED_SERVICES].sort());
    expect(Object.keys(bundle.environment).sort()).toEqual([...FACTORY_CONTAINER_SERVICES].sort());
  });

  test("without a builds provider every container runs the pinned image", () => {
    expect(bundle.images).toEqual({ gateway: FACTORY_TEST_IMAGE, harness: FACTORY_TEST_IMAGE, orchestrator: FACTORY_TEST_IMAGE });
  });

  test("the orchestrator delivery alone holds the master key and the wrapped data key", () => {
    const holders = (name: string) => Object.values(bundle.deliveries).filter((delivery) => name in delivery.files).map((delivery) => delivery.service);
    expect(holders(FACTORY_KEY_FILES.master)).toEqual(["orchestrator"]);
    expect(holders(FACTORY_KEY_FILES.wraps)).toEqual(["orchestrator"]);
    expect(bundle.deliveries.orchestrator.files[FACTORY_KEY_FILES.master]).toEqual({ source: join(installation.operatorDirectory, FACTORY_KEY_FILES.master) });
  });

  test("no installation delivery holds a pool, a supervisor, or the host signing key; the harness gets the host's public material", () => {
    expect(Object.keys(bundle.deliveries).sort()).toEqual(["gateway", "harness", "orchestrator"]);
    for (const delivery of Object.values(bundle.deliveries)) {
      for (const name of ["pool.json", "supervisor.json", "pool-database.json", FACTORY_HOST_FILES.hostKey]) expect(Object.keys(delivery.files)).not.toContain(name);
    }
    expect(bundle.deliveries.harness.files[FACTORY_HOST_FILES.caCertificate]).toEqual({ source: bundle.host.caCertificatePath });
    expect(bundle.deliveries.harness.files[FACTORY_HOST_FILES.hostPublicKey]).toEqual({ source: bundle.host.hostPublicKeyPath });
    expect(bundle.deliveries.harness.files[FACTORY_MESH_FILES.harnessPoolToken]).toEqual({ source: join(installation.secretDirectory, FACTORY_MESH_FILES.harnessPoolToken) });
  });

  test("the startup document names the fleet host's shared pool and supervisor, trusted through the host authority", () => {
    const startup = parseFactoryStartupConfig(JSON.parse(JSON.stringify((bundle.deliveries.harness.files["factory-startup.json"] as { document: unknown }).document)));
    expect([startup.poolId, startup.hostId]).toEqual(["pool.fleet-a", "host.fleet-a"]);
    const json = JSON.stringify(startup);
    expect(json).toContain("https://127.0.0.1:41002");
    expect(json).toContain("https://127.0.0.1:41003");
    expect(json).toContain(`/run/ezcorp/secrets/${FACTORY_HOST_FILES.caCertificate}`);
    expect(json).toContain(`/run/ezcorp/secrets/${FACTORY_HOST_FILES.hostPublicKey}`);
  });

  test("the harness delivery holds no master key, no wrapped key, and no operator material", () => {
    const harness = Object.keys(bundle.deliveries.harness.files);
    for (const forbidden of [FACTORY_KEY_FILES.master, FACTORY_KEY_FILES.wraps, FACTORY_HOST_FILES.hostKey, ...Object.values(FACTORY_MESH_OPERATOR_FILES).filter((name) => name !== FACTORY_MESH_FILES.caCertificate)]) {
      expect(harness).not.toContain(forbidden);
    }
    for (const delivery of Object.values(bundle.deliveries)) {
      for (const entry of Object.values(delivery.files)) {
        if ("source" in entry && entry.source.startsWith(installation.operatorDirectory)) expect(delivery.service).toBe("orchestrator");
      }
    }
  });

  test("the rendered startup document is accepted by its own process parser", () => {
    const startup = (bundle.deliveries.harness.files["factory-startup.json"] as { document: unknown }).document;
    expect(parseFactoryStartupConfig(JSON.parse(JSON.stringify(startup)))).toEqual(startup as never);
  });

  test("database URLs carry each service's own credential, and only there", () => {
    const text = (service: keyof typeof bundle.deliveries, name: string) => (bundle.deliveries[service].files[name] as { text: string }).text;
    expect(text("gateway", "gateway-database-url")).toContain(passwords.product);
    expect(text("harness", "harness-database-url")).toContain(passwords.product);
    expect(new URL(text("gateway", "gateway-database-url").trim()).host).toBe("127.0.0.1:55432");
    expect(JSON.stringify(bundle.environment)).not.toContain(passwords.product);
    // The installation no longer owns a pool database: no delivery carries a pool credential.
    expect(JSON.stringify(bundle.deliveries)).not.toContain(passwords.pool);
  });

  test("a second installation's deliveries share no path with the first", async () => {
    const other = makeFactoryTestInstallation(root, { tenantId: "tenant-02" });
    await seedInstallationFiles(other, { mesh: false, runtimeRoot: join(root, "runtime") });
    const second = await renderFactoryInstallationBundle(other, makeFactoryTestDeploymentSettings(join(root, "runtime")));
    const paths = (value: FactoryInstallationBundle) => Object.values(value.deliveries).flatMap((delivery) => [delivery.directory, ...Object.values(delivery.files).flatMap((entry) => "source" in entry ? [entry.source] : [])]);
    const firstPaths = new Set(paths(bundle));
    // Only the fleet host's public material is common to both.
    expect(paths(second).filter((path) => firstPaths.has(path)).sort()).toEqual([bundle.host.caCertificatePath, bundle.host.hostPublicKeyPath, bundle.host.tokenPublicKeyPath].sort());
    expect(second.ports.harness).toBe(40_020);
  });

  test("a builds provider moves each service onto its component's image; the host component is the fleet host's", async () => {
    const build = (component: string, digit: string) => ({ buildId: `${component}-2`, image: `registry.test/${component}@sha256:${digit.repeat(64)}`, revision: "e".repeat(40), releaseDirectory: `/srv/releases/${component}` });
    const builds: FactoryInstallationBuilds = { host: build("host", "1"), harness: build("harness", "2"), orchestrator: build("orchestrator", "3") };
    const seen: string[] = [];
    const upgraded = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime"), { builds: async (value) => { seen.push(value.tenantId); return builds; } }));
    expect(seen).toEqual(["tenant-01"]);
    expect(upgraded.images).toEqual({ gateway: builds.harness.image, harness: builds.harness.image, orchestrator: builds.orchestrator.image });
    expect(upgraded.image.reference).toBe(FACTORY_TEST_IMAGE);
  });

  test("the harness and gateway get bounded database pools, overridable per fleet", async () => {
    expect([bundle.environment.harness.DB_POOL_MAX, bundle.environment.gateway.DB_POOL_MAX]).toEqual([String(FACTORY_DEFAULT_DATABASE_POOL_MAX.harness), String(FACTORY_DEFAULT_DATABASE_POOL_MAX.gateway)]);
    const tuned = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime"), { databasePoolMax: { harness: 6, gateway: 3 } }));
    expect([tuned.environment.harness.DB_POOL_MAX, tuned.environment.gateway.DB_POOL_MAX]).toEqual(["6", "3"]);
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

/**
 * Coordinator ruling (recovery): every rendered startup document declares
 * every section W15's recovery roles compose from (`composeFactoryRecoveryRoles`):
 * the archive, the ordinary store retention erases from, the pool's checkpoint
 * client, the Temporal HTTP route, and the key management kind. A section left
 * out holds the barrier role by name instead of sealing.
 *
 * W14 asked this test to confirm the pool restore scope and the temporalHttp
 * route. The restore scope lives in the token `pool.serviceTokenPath` names;
 * the fleet host mints that file, and host.test.ts ("each installation's pool
 * token carries pool:restore for its own tenant and no other tenant's scope")
 * proves it carries `pool:restore:<tenant>`. Here: that the document names it
 * and the harness receives it.
 */
describe("every rendered startup document declares the recovery sections W15's barrier composes from", () => {
  const tenants = ["tenant-01", "tenant-02"] as const;
  const secret = (name: string) => `${FACTORY_CONTAINER_PATHS.secrets}/${name}`;
  let root: string;
  const bundles = new Map<string, FactoryInstallationBundle>();

  beforeAll(async () => {
    root = await makeFactoryPrivateRoot();
    for (const tenantId of tenants) {
      const installation = makeFactoryTestInstallation(root, { tenantId });
      await seedInstallationFiles(installation, { mesh: true, runtimeRoot: join(root, "runtime") });
      const bundle = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime")));
      await writeFactoryDeliveries(bundle);
      bundles.set(tenantId, bundle);
    }
  });
  const scratch: string[] = [];
  afterAll(async () => {
    await removeFactoryPrivateRoot(root);
    await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
  });

  const harnessOf = (tenantId: string) => bundles.get(tenantId)!.deliveries.harness;
  /** The document as the harness reads it: the written file, through the process parser. */
  const startupOf = async (tenantId: string) => parseFactoryStartupConfig(JSON.parse(await readFile(join(harnessOf(tenantId).directory, "factory-startup.json"), "utf8")));
  /** The file the harness delivery holds at a container secret path. */
  const delivered = (tenantId: string, containerPath: string) => {
    expect(containerPath.startsWith(secret(""))).toBe(true);
    return join(harnessOf(tenantId).directory, containerPath.slice(secret("").length));
  };
  const expectDelivered = async (tenantId: string, containerPaths: readonly string[]) => {
    for (const path of containerPaths) expect({ path, mode: await mode(delivered(tenantId, path)) }).toEqual({ path, mode: 0o600 });
  };

  for (const tenantId of tenants) {
    test(`${tenantId}: storage.archive and storage.ordinary name the tenant's own bucket and delivered credentials`, async () => {
      const { storage } = await startupOf(tenantId);
      expect(storage).toEqual({
        ordinary: { endpoint: "http://127.0.0.1:59000", bucket: tenantId, prefix: "ordinary", credentialSet: "ordinary", credentialsPath: secret("ordinary-storage.json") },
        archive: { endpoint: "http://127.0.0.1:59001", bucket: tenantId, prefix: "archive", credentialSet: "archive", credentialsPath: secret("archive-storage.json") },
      } as never);
      await expectDelivered(tenantId, [storage.ordinary.credentialsPath, storage.archive.credentialsPath]);
    });

    test(`${tenantId}: pool names the fleet host's shared pool over the host authority, with the host-minted token that carries pool:restore`, async () => {
      const { pool } = await startupOf(tenantId);
      const bundle = bundles.get(tenantId)!;
      expect(pool).toEqual({
        baseUrl: `https://127.0.0.1:${bundle.host.ports.pool}`,
        serviceTokenPath: secret(FACTORY_MESH_FILES.harnessPoolToken),
        tls: { caPath: secret(FACTORY_HOST_FILES.caCertificate), certificatePath: secret(FACTORY_MESH_FILES.harnessCertificate), privateKeyPath: secret(FACTORY_MESH_FILES.harnessKey) },
      } as never);
      await expectDelivered(tenantId, [pool.serviceTokenPath, pool.tls.caPath, pool.tls.certificatePath, pool.tls.privateKeyPath]);
      // The token delivered is the one the fleet host mints into the installation's secrets on admission.
      expect(harnessOf(tenantId).files[FACTORY_MESH_FILES.harnessPoolToken]).toEqual({ source: join(makeFactoryTestInstallation(root, { tenantId }).secretDirectory, FACTORY_MESH_FILES.harnessPoolToken) });
    });

    test(`${tenantId}: temporalHttp names the gateway's read-only route and the namespace certificate, never the namespace token, and the barrier's reader composes from it`, async () => {
      const startup = await startupOf(tenantId);
      expect(startup.temporalHttp).toEqual({
        endpoint: makeFactoryTestDeploymentSettings(join(root, "runtime")).network.temporalHttpEndpoint,
        tls: { caPath: secret("temporal-ca.crt"), certificatePath: secret("temporal-client.crt"), privateKeyPath: secret("temporal-client.key") },
      });
      const tls = startup.temporalHttp!.tls!;
      await expectDelivered(tenantId, [tls.caPath, tls.certificatePath, tls.privateKeyPath]);
      expect(Object.keys(harnessOf(tenantId).files)).not.toContain("temporal-token");
      expect(await readdir(harnessOf(tenantId).directory)).not.toContain("temporal-token");
      // W15's own composer reads the delivered files the document names.
      const positions = await factoryTemporalPositionsFromConfig({
        temporalNamespace: startup.temporalNamespace,
        temporalHttp: { endpoint: startup.temporalHttp!.endpoint, tls: { caPath: delivered(tenantId, tls.caPath), certificatePath: delivered(tenantId, tls.certificatePath), privateKeyPath: delivered(tenantId, tls.privateKeyPath) } },
      });
      expect(positions).toBeInstanceOf(FactoryTemporalHttpPositions);
      expect(positions.namespace).toBe(startup.temporalNamespace);
    });

    test(`${tenantId}: keyManagement declares the operator master key`, async () => {
      expect((await startupOf(tenantId)).keyManagement).toEqual({ kind: "operator-master-key" });
    });

    test(`${tenantId}: guestBroker declares W01g's route for the fleet host's supervisor, and W01g's composer binds it`, async () => {
      const startup = await startupOf(tenantId);
      const bundle = bundles.get(tenantId)!;
      expect(startup.guestBroker).toEqual({
        hostname: "0.0.0.0", port: bundle.ports.guestBroker,
        // The supervisor's client certificate names `host.supervisor`; it forwards for the fleet's one host.
        hosts: { [bundle.host.supervisor]: bundle.host.hostId },
        tls: { caPath: secret(FACTORY_HOST_FILES.caCertificate), certificatePath: secret(FACTORY_MESH_FILES.serverCertificate), privateKeyPath: secret(FACTORY_MESH_FILES.serverKey) },
        tokens: { issuer: bundle.host.issuer, audience: FACTORY_GUEST_BROKER_AUDIENCE, publicKeyPaths: { [FACTORY_MESH_TOKEN_KEY_ID]: secret(FACTORY_HOST_FILES.tokenPublicKey) } },
      });
      const route = startup.guestBroker!;
      // The route verifies attempt tokens with the host launch secret, which the parser requires beside it.
      await expectDelivered(tenantId, [route.tls.caPath, route.tls.certificatePath, route.tls.privateKeyPath, ...Object.values(route.tokens.publicKeyPaths), startup.hostLaunch!.attemptTokenSecretPath]);
      expect(harnessOf(tenantId).files[FACTORY_HOST_FILES.tokenPublicKey]).toEqual({ source: bundle.host.tokenPublicKeyPath });

      // W01g's own composer, over the delivered files at the rendered paths.
      // The fixture seeds markers, so real material replaces the four files
      // the route reads at bind time: the host authority, the server pair,
      // and the attempt-token secret.
      const real = await certificates(scratch, bundle.host.supervisor);
      for (const [path, text] of [[route.tls.caPath, real.ca], [route.tls.certificatePath, real.serverCert], [route.tls.privateKeyPath, real.serverKey], [startup.hostLaunch!.attemptTokenSecretPath, `${randomBytes(32).toString("hex")}\n`]] as const) {
        await writeFile(delivered(tenantId, path), text, { mode: 0o600 });
      }
      const reports: unknown[] = [];
      // Binding reads no row: the stand-ins only satisfy the material store's
      // check that the artifacts share the route's database.
      const database = {} as never;
      const composed = await composeFactoryGuestBroker({
        database, application: { artifacts: { database } as never, journal: {} as never }, blobs: {} as never,
        report: (_role, error) => { reports.push(error); },
        config: {
          ...startup,
          hostLaunch: { ...startup.hostLaunch!, attemptTokenSecretPath: delivered(tenantId, startup.hostLaunch!.attemptTokenSecretPath) },
          // Port 0: the rendered port may be taken on a test host; every path is the rendered one.
          guestBroker: { ...route, hostname: "127.0.0.1", port: 0, tls: { caPath: delivered(tenantId, route.tls.caPath), certificatePath: delivered(tenantId, route.tls.certificatePath), privateKeyPath: delivered(tenantId, route.tls.privateKeyPath) } },
        },
      });
      try { expect({ readiness: composed.readiness, reports }).toEqual({ readiness: { state: "bound" }, reports: [] }); }
      finally { composed.listener?.stop(); }
    });
  }
});

describe("writeFactoryDeliveries", () => {
  let root: string;
  let installation: FactoryInstallationContext;
  let passwords: { readonly product: string; readonly pool: string };
  let bundle: FactoryInstallationBundle;

  beforeAll(async () => {
    root = await makeFactoryPrivateRoot();
    installation = makeFactoryTestInstallation(root);
    passwords = await seedInstallationFiles(installation, { mesh: true, runtimeRoot: join(root, "runtime") });
    bundle = await renderFactoryInstallationBundle(installation, makeFactoryTestDeploymentSettings(join(root, "runtime")));
    await writeFactoryDeliveries(bundle);
  });
  afterAll(async () => { await removeFactoryPrivateRoot(root); });

  test("each delivery directory is 0700 and holds exactly its listed files, each 0600; an absent optional source is not delivered yet", async () => {
    for (const delivery of Object.values(bundle.deliveries)) {
      expect(await mode(delivery.directory)).toBe(0o700);
      const delivered = Object.keys(delivery.files).filter((name) => name !== FACTORY_INGRESS_PROOF_FILE);
      expect((await readdir(delivery.directory)).sort()).toEqual(delivered.sort());
      for (const name of delivered) expect(await mode(join(delivery.directory, name))).toBe(0o600);
    }
    expect(bundle.deliveries.harness.files[FACTORY_INGRESS_PROOF_FILE]).toEqual({ source: join(installation.secretDirectory, FACTORY_INGRESS_PROOF_FILE), optional: true });
    // The harness boots only with its projects root and home present.
    for (const directory of [bundle.runtimeDirectory, bundle.readinessDirectory, bundle.dataDirectory, join(bundle.dataDirectory, "projects"), join(bundle.dataDirectory, "home"), join(bundle.dataDirectory, "app-state")]) expect(await mode(directory)).toBe(0o700);
  });

  test("the orchestration writer has its own private directory; the pool and supervisor records are the fleet host's", async () => {
    expect(await mode(join(bundle.readinessDirectory, "orchestration"))).toBe(0o700);
    expect(await readdir(bundle.readinessDirectory)).toEqual(["orchestration"]);
    const startup = parseFactoryStartupConfig(JSON.parse(await readFile(join(bundle.deliveries.harness.directory, "factory-startup.json"), "utf8")));
    expect([startup.poolReadinessFilePath, startup.orchestrationReadinessFilePath, startup.supervisorReadinessFilePath]).toEqual([
      "/run/ezcorp/readiness/pool/pool.json", "/run/ezcorp/readiness/orchestration/orchestration.json", "/run/ezcorp/readiness/supervisor/supervisor.json",
    ]);
    expect(JSON.parse(await readFile(join(bundle.deliveries.orchestrator.directory, "orchestrator.json"), "utf8")).readinessFilePath).toBe("/run/ezcorp/readiness/orchestration/orchestration.json");
  });

  test("an optional source is delivered once it exists and withdrawn once it is gone, in place", async () => {
    const before = (await stat(bundle.deliveries.harness.directory)).ino;
    const proof = join(installation.secretDirectory, FACTORY_INGRESS_PROOF_FILE);
    await writeModeFile(proof, marker(FACTORY_INGRESS_PROOF_FILE));
    await writeFactoryDeliveries(bundle);
    expect(await readFile(join(bundle.deliveries.harness.directory, FACTORY_INGRESS_PROOF_FILE), "utf8")).toBe(marker(FACTORY_INGRESS_PROOF_FILE));
    await rm(proof);
    await writeFactoryDeliveries(bundle);
    expect(await readdir(bundle.deliveries.harness.directory)).not.toContain(FACTORY_INGRESS_PROOF_FILE);
    // The directory a running container's bind mount pins is never replaced.
    expect((await stat(bundle.deliveries.harness.directory)).ino).toBe(before);
  });

  test("a missing required source is refused, and an unsafe optional source is refused rather than skipped", async () => {
    const missing: FactoryInstallationBundle = { ...bundle, deliveries: { ...bundle.deliveries, gateway: { ...bundle.deliveries.gateway, files: { "absent.txt": { source: join(installation.secretDirectory, "absent.txt") } } } } };
    expect((await factoryRejection(writeFactoryDeliveries(missing))).code).toBe("ENOENT");
    const unsafe = join(installation.secretDirectory, "unsafe-optional.txt");
    await writeModeFile(unsafe, "readable\n", 0o644);
    const tainted: FactoryInstallationBundle = { ...bundle, deliveries: { ...bundle.deliveries, gateway: { ...bundle.deliveries.gateway, files: { "unsafe-optional.txt": { source: unsafe, optional: true } } } } };
    expect((await factoryRejection(writeFactoryDeliveries(tainted))).message).toContain("private");
    await rm(unsafe);
    await writeFactoryDeliveries(bundle);
  });

  test("source entries are copied byte for byte, documents as JSON, texts verbatim", async () => {
    const orchestrator = await filesIn(bundle.deliveries.orchestrator.directory);
    expect(orchestrator[FACTORY_KEY_FILES.master]).toBe(marker(FACTORY_KEY_FILES.master));
    expect(orchestrator[FACTORY_KEY_FILES.wraps]).toBe(marker(FACTORY_KEY_FILES.wraps));
    const harness = await filesIn(bundle.deliveries.harness.directory);
    expect(JSON.parse(harness["factory-startup.json"]!)).toEqual(JSON.parse(JSON.stringify((bundle.deliveries.harness.files["factory-startup.json"] as { document: unknown }).document)));
    expect(harness[FACTORY_HOST_FILES.caCertificate]).toBe(`marker:${FACTORY_HOST_FILES.caCertificate}\n`);
    const gateway = await filesIn(bundle.deliveries.gateway.directory);
    expect(gateway["gateway-database-url"]).toBe((bundle.deliveries.gateway.files["gateway-database-url"] as { text: string }).text);
  });

  test("no written delivery but the orchestrator's holds the master key, and none holds the pool credential", async () => {
    for (const service of ["gateway", "harness"] as const) {
      const text = Object.values(await filesIn(bundle.deliveries[service].directory)).join("\n");
      expect(text).not.toContain(marker(FACTORY_KEY_FILES.master));
      expect(text).not.toContain(passwords.pool);
    }
  });

  test("the written startup document parses with the process parser", async () => {
    expect(parseFactoryStartupConfig(JSON.parse(await readFile(join(bundle.deliveries.harness.directory, "factory-startup.json"), "utf8"))).tenantId).toBe("tenant-01");
  });

  test("a rewrite is idempotent, and a file dropped from a delivery is gone after the next write", async () => {
    await writeFactoryDeliveries(bundle);
    expect((await readdir(bundle.deliveries.gateway.directory)).sort()).toEqual(Object.keys(bundle.deliveries.gateway.files).sort());
    const { [FACTORY_MESH_FILES.attemptTokenSecret]: _dropped, ...kept } = bundle.deliveries.gateway.files;
    const narrowed: FactoryInstallationBundle = { ...bundle, deliveries: { ...bundle.deliveries, gateway: { ...bundle.deliveries.gateway, files: kept } } };
    await writeFactoryDeliveries(narrowed);
    const after = await readdir(bundle.deliveries.gateway.directory);
    expect(after).not.toContain(FACTORY_MESH_FILES.attemptTokenSecret);
    expect(after.sort()).toEqual(Object.keys(kept).sort());
  });

  test("a source that is not private is refused rather than delivered", async () => {
    const leaky = join(installation.secretDirectory, "leaky.txt");
    await writeModeFile(leaky, "world readable\n", 0o644);
    const tainted: FactoryInstallationBundle = { ...bundle, deliveries: { ...bundle.deliveries, gateway: { ...bundle.deliveries.gateway, files: { "leaky.txt": { source: leaky } } } } };
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

/** Every minted pool token is distinct across fake hosts, as real mints are. */
let mintSerial = 0;

/** The fleet host as the step sees it: admission, release, and the pool token it mints into the installation. */
function recordingHost(options: { readonly expiresAtMs?: number } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async admit(installation: FactoryInstallationContext) { calls.push(`admit:${installation.tenantId}`); return makeFactoryTestHostFacts(join(installation.secretDirectory, "..", "..", "runtime")); },
    async release(installation: Pick<FactoryInstallationContext, "tenantId">) { calls.push(`release:${installation.tenantId}`); },
    async mintInstallationToken(installation: FactoryInstallationContext, force = false) {
      calls.push(`mint:${installation.tenantId}:${force}`);
      const path = join(installation.secretDirectory, FACTORY_MESH_FILES.harnessPoolToken);
      if (force || !(await Bun.file(path).exists())) { mintSerial += 1; await writeModeFile(path, `pool-token-${mintSerial}\n`); }
      return options.expiresAtMs ?? Date.now() + 40 * 24 * 60 * 60 * 1000;
    },
  };
}

describe("FactoryDeploymentStep", () => {
  let root: string;
  let installation: FactoryInstallationContext;

  beforeAll(async () => {
    root = await makeFactoryPrivateRoot();
    installation = makeFactoryTestInstallation(root);
    await seedInstallationFiles(installation, { mesh: false, runtimeRoot: join(root, "runtime") });
  });
  afterAll(async () => { await removeFactoryPrivateRoot(root); });

  test("ensure creates the mesh, writes deliveries, applies, waits ready, and returns references only", async () => {
    const target = recordingTarget();
    const host = recordingHost();
    const step = new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target, host });
    expect(step.step).toBe("deployment");
    const resources = await step.ensure(installation);
    expect(target.calls.map((call) => call.method)).toEqual(["apply", "ready"]);
    // Admitted to the fleet host before anything renders, with its pool token minted.
    expect(host.calls).toEqual(["admit:tenant-01", "mint:tenant-01:false"]);
    expect(resources).toEqual({
      composeProject: "project-tenant-01", profile: "compose", image: FACTORY_TEST_IMAGE, revision: "c".repeat(40), hostId: "host.fleet-a", poolId: "pool.fleet-a",
      temporalOwner: factoryTemporalOwnerMarker(installation), harnessPort: "40010", publicOrigin: "https://tenant-01.factory.example:30443",
      runtimeDirectory: join(root, "runtime", "tenant-01"), meshTokensExpireAtMs: expect.any(String),
    });
    // Service tokens live 30 days; the recorded deadline is what `status` shows.
    expect(Number(resources.meshTokensExpireAtMs) - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(Object.isFrozen(resources)).toBe(true);
    // The mesh landed in the installation's own secret and operator directories.
    const secrets = await readdir(installation.secretDirectory);
    for (const name of MESH_FILE_NAMES) expect(secrets).toContain(name);
    const operator = await readdir(installation.operatorDirectory);
    for (const name of Object.values(FACTORY_MESH_OPERATOR_FILES)) expect(operator).toContain(name);
    expect(secrets).not.toContain(FACTORY_MESH_OPERATOR_FILES.caKey);
    expect(secrets).not.toContain(FACTORY_MESH_OPERATOR_FILES.tokenKey);
    // The installation holds no host signing key: that is the fleet host supervisor's alone.
    expect(secrets).not.toContain(FACTORY_HOST_FILES.hostKey);
    expect(await readFile(join(installation.secretDirectory, "deliver", "harness", FACTORY_MESH_FILES.harnessPoolToken), "utf8")).toBe(await readFile(join(installation.secretDirectory, FACTORY_MESH_FILES.harnessPoolToken), "utf8"));
  });

  test("the recorded token deadline is the earlier of the mesh token's and the host-minted pool token's", async () => {
    const soon = Date.now() + 24 * 60 * 60 * 1000;
    const resources = await new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target: recordingTarget(), host: recordingHost({ expiresAtMs: soon }) }).ensure(installation);
    expect(Number(resources.meshTokensExpireAtMs)).toBe(soon);
  });

  test("a rerun of ensure keeps the mesh the running processes already trust", async () => {
    const before = await readFile(join(installation.secretDirectory, FACTORY_MESH_FILES.serverCertificate), "utf8");
    const target = recordingTarget();
    await new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target, host: recordingHost() }).ensure(installation);
    expect(await readFile(join(installation.secretDirectory, FACTORY_MESH_FILES.serverCertificate), "utf8")).toBe(before);
    expect(target.calls.map((call) => call.method)).toEqual(["apply", "ready"]);
  });

  test("ensure fails when the target never becomes ready", async () => {
    const failure = Object.assign(new Error("not ready"), { code: "deployment_not_ready" });
    const target = recordingTarget({ failReady: failure });
    const error = await factoryRejection(new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target, host: recordingHost() }).ensure(installation));
    expect(error.code).toBe("deployment_not_ready");
  });

  test("verify asks the target to prove readiness of this installation's bundle", async () => {
    const target = recordingTarget();
    await new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target, host: recordingHost() }).verify(installation);
    expect(target.calls).toEqual([{ method: "ready", tenantId: "tenant-01" }]);
  });

  test("redeliver copies the current sources into place and restarts onto them", async () => {
    const target = recordingTarget();
    const delivered = join(installation.secretDirectory, "deliver", "harness", FACTORY_APPLICATION_SECRET_FILES.jwt);
    await writeModeFile(join(installation.secretDirectory, FACTORY_APPLICATION_SECRET_FILES.jwt), "rotated-jwt\n");
    await new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target, host: recordingHost() }).redeliver(installation);
    expect(await readFile(delivered, "utf8")).toBe("rotated-jwt\n");
    expect(target.calls.map((call) => call.method)).toEqual(["remove", "apply", "ready"]);
  });

  test("rotate re-mints the mesh leaves and tokens, has the host force a new pool token, re-delivers, restarts, and records the new token deadline", async () => {
    const target = recordingTarget();
    const host = recordingHost();
    const certificate = join(installation.secretDirectory, FACTORY_MESH_FILES.serverCertificate);
    const token = join(installation.secretDirectory, FACTORY_MESH_FILES.harnessPoolToken);
    const [certificateBefore, tokenBefore] = [await readFile(certificate, "utf8"), await readFile(token, "utf8")];
    const later = Date.now() + 60_000;
    const recorded = { composeProject: "project-tenant-01", meshTokensExpireAtMs: "1" };
    const rotated = await new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target, host, mesh: { now: () => later } }).rotate(installation, recorded);
    expect(host.calls).toEqual(["mint:tenant-01:true"]);
    expect(rotated).toEqual({ composeProject: "project-tenant-01", meshTokensExpireAtMs: expect.any(String) });
    expect(Number(rotated.meshTokensExpireAtMs)).toBeGreaterThan(later);
    expect(Object.isFrozen(rotated)).toBe(true);
    expect(await readFile(certificate, "utf8")).not.toBe(certificateBefore);
    expect(await readFile(token, "utf8")).not.toBe(tokenBefore);
    // The running services receive the new material, not the superseded one.
    expect(await readFile(join(installation.secretDirectory, "deliver", "harness", FACTORY_MESH_FILES.harnessPoolToken), "utf8")).toBe(await readFile(token, "utf8"));
    expect(target.calls.map((call) => call.method)).toEqual(["remove", "apply", "ready"]);
  });

  test("teardown removes the services, leaves the fleet host, destroys every delivery and the pool token, and a second teardown still succeeds", async () => {
    const target = recordingTarget();
    const host = recordingHost();
    const step = new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target, host });
    await step.teardown(installation);
    expect(target.calls).toEqual([{ method: "remove", tenantId: "tenant-01" }]);
    expect(host.calls).toEqual(["release:tenant-01"]);
    const left = await readdir(installation.secretDirectory);
    expect(left).not.toContain("deliver");
    expect(left).not.toContain(FACTORY_MESH_FILES.harnessPoolToken);
    await step.teardown(installation);
    expect(target.calls.map((call) => call.method)).toEqual(["remove", "remove"]);
    expect(host.calls).toEqual(["release:tenant-01", "release:tenant-01"]);
  });

  test("purge hands the installation's handle to the target", async () => {
    const target = recordingTarget();
    await new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target, host: recordingHost() }).purge(installation);
    expect(target.calls).toEqual([{ method: "purge", tenantId: "tenant-01" }]);
  });

  test("teardown and purge need no credential: an installation that cannot render still stops and purges", async () => {
    const handles: unknown[] = [];
    const target: FactoryDeploymentTarget = { ...recordingTarget(), async remove(handle) { handles.push(handle); }, async purge(handle) { handles.push(handle); } };
    const step = new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target, host: recordingHost() });
    const unrendered = makeFactoryTestInstallation(root, { tenantId: "tenant-04" });
    await step.teardown(unrendered);
    await step.purge(unrendered);
    const handle = factoryDeploymentHandle(unrendered, join(root, "runtime"));
    expect(handles).toEqual([handle, handle]);
    expect(handle).toEqual({ installation: unrendered, runtimeDirectory: join(root, "runtime", "tenant-04"), readinessDirectory: join(root, "runtime", "tenant-04", "readiness") });
  });

  test("a target failure during teardown or purge is reported, never swallowed", async () => {
    const failure = Object.assign(new Error("stop failed"), { code: "deployment_supervisor_failed" });
    const target: FactoryDeploymentTarget = { ...recordingTarget(), async remove() { throw failure; }, async purge() { throw failure; } };
    const step = new FactoryDeploymentStep({ settings: makeFactoryTestDeploymentSettings(join(root, "runtime")), target, host: recordingHost() });
    expect(await factoryRejection(step.teardown(installation))).toBe(failure);
    expect(await factoryRejection(step.purge(installation))).toBe(failure);
  });
});
