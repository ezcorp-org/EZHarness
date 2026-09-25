import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, createVerify, X509Certificate } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { factoryRejection, makeFactoryPrivateRoot, makeFactoryTestInstallation, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import { factoryDatabasePairs } from "./database";
import {
  FACTORY_HOST_FILES,
  FACTORY_HOST_OPERATOR_FILES,
  FactoryFleetHost,
  factoryFleetHostIdentity,
  factoryFleetHostPaths,
  type FactoryFleetHostBuild,
  type FactoryFleetHostBundle,
  type FactoryFleetHostPaths,
  type FactoryFleetHostRuntime,
} from "./host";
import type { FactoryInstallationContext, FactoryStepResources } from "./installation";
import { FACTORY_GUEST_BROKER_AUDIENCE, FACTORY_GUEST_BROKER_SCOPE } from "../runner/guest-broker-contract";
import { FACTORY_HOST_KEY_ID, FACTORY_MESH_FILES, FACTORY_POOL_AUDIENCE } from "./mesh";
import { factoryInstallationPorts } from "./ports";
import { FactoryProvisioningError } from "./steps";

const SLOW = 60_000;
const NOW_MS = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const BUILD: FactoryFleetHostBuild = { image: `registry.test/ezcorp@sha256:${"d".repeat(64)}`, revision: "e".repeat(40), release: "/releases/default" };

let root: string;
let now: number;
let runtime: RecordingRuntime;
let database: FakeDatabase;
let host: FactoryFleetHost;

class RecordingRuntime implements FactoryFleetHostRuntime {
  readonly calls: string[] = [];
  readonly bundles: FactoryFleetHostBundle[] = [];
  async apply(bundle: FactoryFleetHostBundle): Promise<void> { this.calls.push(`apply:${bundle.admitted.map((entry) => entry.tenantId).join(",")}:${bundle.build.image.slice(-4)}`); this.bundles.push(bundle); }
  async ready(bundle: FactoryFleetHostBundle): Promise<void> { this.calls.push(`ready:${bundle.admitted.length}`); }
  async remove(paths: FactoryFleetHostPaths): Promise<void> { this.calls.push(`remove:${paths.context.tenantId}`); }
  async purge(paths: FactoryFleetHostPaths): Promise<void> { this.calls.push(`purge:${paths.context.tenantId}`); }
}

/** The database step owning only the pool pair: writes the credential it would create, returns references. */
class FakeDatabase {
  readonly ensured: (FactoryStepResources | undefined)[] = [];
  readonly purged: FactoryStepResources[] = [];
  async ensure(context: FactoryInstallationContext, recorded: FactoryStepResources | undefined): Promise<FactoryStepResources> {
    this.ensured.push(recorded);
    const [, pool] = factoryDatabasePairs(context);
    await mkdir(context.secretDirectory, { recursive: true, mode: 0o700 });
    await chmod(context.secretDirectory, 0o700);
    await writeModeFile(join(context.secretDirectory, pool!.credentialFile), `${JSON.stringify({ role: pool!.role, password: "p".repeat(43) })}\n`);
    return { poolPlan: "plan-1", poolRoleOid: "11", poolDatabaseOid: "12", poolDatabasePhase: "created" };
  }
  async purge(_context: FactoryInstallationContext, resources: FactoryStepResources): Promise<void> { this.purged.push(resources); }
}

/** An in-process stand-in for the fleet's advisory lock: one holder at a time. */
function processLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return <Result>(work: () => Promise<Result>): Promise<Result> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
}

function makeHost(overrides: { readonly now?: () => number } = {}): FactoryFleetHost {
  return new FactoryFleetHost({
    settings: {
      fleetId: "w16", secretsRoot: join(root, "secrets"), operatorRoot: join(root, "operator"), runtimeRoot: join(root, "runtime"),
      portBase: 31_000, cpuCapacity: 3, database: { host: "127.0.0.1", port: 55_432 }, build: BUILD,
    },
    runtime, database, locked: processLock(), ...(overrides.now ? { now: overrides.now } : { now: () => now }),
  });
}

/** An installation whose own mesh authority exists (the trust bundle carries it) and whose secret directory is private. */
async function installation(tenantId: string, overrides: Partial<FactoryInstallationContext> = {}): Promise<FactoryInstallationContext> {
  const context = makeFactoryTestInstallation(root, { tenantId, fleetId: "w16", ...overrides });
  await mkdir(context.secretDirectory, { recursive: true, mode: 0o700 });
  await chmod(context.secretDirectory, 0o700);
  await writeModeFile(join(context.secretDirectory, FACTORY_MESH_FILES.caCertificate), `-----BEGIN CERTIFICATE-----\n${tenantId}-authority\n-----END CERTIFICATE-----\n`);
  return context;
}

const text = (path: string) => readFile(path, "utf8");
const hostSecret = (name: string) => join(host.paths.context.secretDirectory, name);
const hostOperator = (name: string) => join(host.paths.context.operatorDirectory, name);

function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.trim().split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

function verifies(publicKeyPem: string, token: string): boolean {
  const [header, payload, signature] = token.trim().split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  return verifier.verify(createPublicKey(publicKeyPem), Buffer.from(signature!, "base64url"));
}

beforeEach(async () => {
  root = await makeFactoryPrivateRoot();
  now = NOW_MS;
  runtime = new RecordingRuntime();
  database = new FakeDatabase();
  host = makeHost();
});
afterEach(async () => { await removeFactoryPrivateRoot(root); });

describe("identity and paths", () => {
  test("the shared services name the fleet, and their ports sit beside the Temporal gateway's", () => {
    expect(factoryFleetHostIdentity("w16", 31_000)).toEqual({ poolId: "pool.w16", hostId: "host.w16", supervisor: "supervisor.w16", issuer: "factory-host:w16", ports: { pool: 32_002, supervisor: 32_003 } });
    for (const base of [1_023, 64_600, 31_000.5]) {
      const error = (() => { try { factoryFleetHostIdentity("w16", base); } catch (thrown) { return thrown as FactoryProvisioningError; } throw new Error("expected a refusal"); })();
      expect(error.code).toBe("deployment_ports_invalid");
    }
  });

  test("the host is one more context under the fleet's roots, with its own pool database names", () => {
    const paths = factoryFleetHostPaths("w16", { secretsRoot: "/s", operatorRoot: "/o", runtimeRoot: "/r" });
    expect(paths.context).toMatchObject({ tenantId: "host", fleetId: "w16", installationId: "host:w16", secretDirectory: "/s/host", operatorDirectory: "/o/host" });
    expect(paths).toMatchObject({ runtimeDirectory: "/r/host", readinessDirectory: "/r/host/readiness", runnerRoot: "/r/host/runner", poolDelivery: "/s/host/deliver/pool", supervisorDelivery: "/s/host/deliver/supervisor" });
    const [, pool] = factoryDatabasePairs(paths.context);
    expect(pool!.database).toMatch(/^factory_pool_[0-9a-f]{20}$/);
    expect(pool!.role).toMatch(/^factory_poolrole_[0-9a-f]{20}$/);
  });

  test("facts name the host's public material and readiness directories", () => {
    expect(host.facts()).toEqual({
      ...host.identity,
      caCertificatePath: join(root, "secrets", "host", FACTORY_HOST_FILES.caCertificate),
      hostPublicKeyPath: join(root, "secrets", "host", FACTORY_HOST_FILES.hostPublicKey),
      tokenPublicKeyPath: join(root, "secrets", "host", FACTORY_HOST_FILES.tokenPublicKey),
      poolReadinessDirectory: join(root, "runtime", "host", "readiness", "pool"),
      supervisorReadinessDirectory: join(root, "runtime", "host", "readiness", "supervisor"),
    });
  });
});

describe("ensureMaterial", () => {
  test("creates the host authority, both leaves, the token key, and the signing key, all private; a rerun rewrites nothing", async () => {
    await host.ensureMaterial();
    const ca = new X509Certificate(await text(hostOperator(FACTORY_HOST_OPERATOR_FILES.caCertificate)));
    expect(ca.subject).toBe("CN=host.w16");
    expect(await text(hostSecret(FACTORY_HOST_FILES.caCertificate))).toBe(await text(hostOperator(FACTORY_HOST_OPERATOR_FILES.caCertificate)));
    for (const [certificate, key, subject] of [[FACTORY_HOST_FILES.serverCertificate, FACTORY_HOST_FILES.serverKey, "CN=localhost"], [FACTORY_HOST_FILES.supervisorCertificate, FACTORY_HOST_FILES.supervisorKey, "CN=supervisor.w16"]] as const) {
      const leaf = new X509Certificate(await text(hostSecret(certificate)));
      expect(leaf.subject).toBe(subject);
      expect(leaf.verify(ca.publicKey)).toBe(true);
      expect(leaf.checkPrivateKey(createPrivateKey(await text(hostSecret(key))))).toBe(true);
    }
    const tokenKey = await text(hostOperator(FACTORY_HOST_OPERATOR_FILES.tokenKey));
    expect(await text(hostSecret(FACTORY_HOST_FILES.tokenPublicKey))).toBe(createPublicKey(createPrivateKey(tokenKey)).export({ type: "spki", format: "pem" }).toString());
    expect(await text(hostSecret(FACTORY_HOST_FILES.hostPublicKey))).toBe(createPublicKey(createPrivateKey(await text(hostSecret(FACTORY_HOST_FILES.hostKey)))).export({ type: "spki", format: "pem" }).toString());
    expect(await text(hostSecret(FACTORY_HOST_FILES.hostKeyId))).toBe(FACTORY_HOST_KEY_ID);
    const supervisorToken = await text(hostSecret(FACTORY_HOST_FILES.supervisorPoolToken));
    expect(verifies(await text(hostSecret(FACTORY_HOST_FILES.tokenPublicKey)), supervisorToken)).toBe(true);
    expect(claims(supervisorToken)).toMatchObject({ sub: "supervisor.w16", iss: "factory-host:w16", aud: FACTORY_POOL_AUDIENCE, scope: ["pool:supervisor:supervisor.w16"], iat: NOW_MS / 1_000 });
    // The supervisor's token on every installation's guest-broker route: W01g's route checks its subject against the supervisor certificate and requires the route scope.
    const brokerToken = await text(hostSecret(FACTORY_HOST_FILES.supervisorGuestBrokerToken));
    expect(verifies(await text(hostSecret(FACTORY_HOST_FILES.tokenPublicKey)), brokerToken)).toBe(true);
    expect(claims(brokerToken)).toMatchObject({ sub: "supervisor.w16", iss: "factory-host:w16", aud: FACTORY_GUEST_BROKER_AUDIENCE, scope: [FACTORY_GUEST_BROKER_SCOPE], iat: NOW_MS / 1_000 });
    expect((await readdir(host.paths.context.operatorDirectory)).sort()).toEqual(Object.values(FACTORY_HOST_OPERATOR_FILES).sort());
    for (const directory of [host.paths.context.secretDirectory, host.paths.context.operatorDirectory]) {
      for (const name of await readdir(directory)) expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
    const snapshot = async () => Object.fromEntries(await Promise.all((await readdir(host.paths.context.secretDirectory)).map(async (name) => [name, await text(hostSecret(name))])));
    const before = await snapshot();
    now += DAY_MS;
    await host.ensureMaterial();
    expect(await snapshot()).toEqual(before);
  }, SLOW);

  test("the supervisor's pool token is re-minted only in its last week", async () => {
    await host.ensureMaterial();
    const first = await text(hostSecret(FACTORY_HOST_FILES.supervisorPoolToken));
    now = NOW_MS + 22 * DAY_MS;
    await host.ensureMaterial();
    expect(await text(hostSecret(FACTORY_HOST_FILES.supervisorPoolToken))).toBe(first);
    now = NOW_MS + 24 * DAY_MS;
    await host.ensureMaterial();
    const second = await text(hostSecret(FACTORY_HOST_FILES.supervisorPoolToken));
    expect(second).not.toBe(first);
    expect(claims(second).iat).toBe(now / 1_000);
  }, SLOW);

  test("a token file that is not a token is re-minted", async () => {
    await host.ensureMaterial();
    await writeModeFile(hostSecret(FACTORY_HOST_FILES.supervisorPoolToken), "garbage\n");
    await host.ensureMaterial();
    expect(claims(await text(hostSecret(FACTORY_HOST_FILES.supervisorPoolToken))).sub).toBe("supervisor.w16");
  }, SLOW);

  test("uses the real clock by default", async () => {
    const real = makeHost({ now: Date.now });
    const before = Math.floor(Date.now() / 1_000);
    await real.ensureMaterial();
    expect(claims(await text(hostSecret(FACTORY_HOST_FILES.supervisorPoolToken))).iat as number).toBeGreaterThanOrEqual(before);
  }, SLOW);
});

describe("admission", () => {
  test("admit mints the installation's own pool token, adds it to both services' trust, publishes, and waits ready", async () => {
    const one = await installation("tenant-01");
    const facts = await host.admit(one);
    expect(facts).toEqual(host.facts());
    const token = await text(join(one.secretDirectory, FACTORY_MESH_FILES.harnessPoolToken));
    expect(verifies(await text(hostSecret(FACTORY_HOST_FILES.tokenPublicKey)), token)).toBe(true);
    expect(claims(token)).toMatchObject({ sub: "tenant-01", iss: "factory-host:w16", aud: FACTORY_POOL_AUDIENCE, scope: ["pool:tenant:tenant-01", "pool:grant:tenant-01:factory", "pool:restore:tenant-01"] });
    expect((await stat(join(one.secretDirectory, FACTORY_MESH_FILES.harnessPoolToken))).mode & 0o777).toBe(0o600);
    expect(runtime.calls).toEqual([`apply:tenant-01:${BUILD.image.slice(-4)}`, "ready:1"]);
    expect(database.ensured).toEqual([undefined]);
    expect(await host.admitted()).toEqual([{ installationId: "inst-tenant-01", tenantId: "tenant-01", harnessIdentity: "harness.tenant-01", caCertificatePath: join(one.secretDirectory, FACTORY_MESH_FILES.caCertificate) }]);
  }, SLOW);

  test("two installations share one pool and one supervisor; each token names only its own tenant", async () => {
    const one = await installation("tenant-01");
    const two = await installation("tenant-02");
    await host.admit(one);
    await host.admit(two);
    expect((await host.admitted()).map((entry) => entry.tenantId)).toEqual(["tenant-01", "tenant-02"]);
    expect(database.ensured[1]).toEqual({ poolPlan: "plan-1", poolRoleOid: "11", poolDatabaseOid: "12", poolDatabasePhase: "created" });
    const bundle = runtime.bundles.at(-1)!;
    const pool = bundle.pool as { poolId: string; identities: { tenants: Record<string, unknown>; supervisors: Record<string, unknown> }; tls: { caPath: string } };
    expect(pool.poolId).toBe("pool.w16");
    expect(pool.identities.tenants).toEqual({ "harness.tenant-01": { tenantId: "tenant-01", tokenSubject: "tenant-01" }, "harness.tenant-02": { tenantId: "tenant-02", tokenSubject: "tenant-02" } });
    expect(Object.keys(pool.identities.supervisors)).toEqual(["supervisor.w16"]);
    const supervisor = bundle.supervisor as { hostId: string; services: { allowedPeers: string[]; port: number } };
    expect(supervisor.hostId).toBe("host.w16");
    expect(supervisor.services.allowedPeers).toEqual(["harness.tenant-01", "harness.tenant-02"]);
    expect(supervisor.services.port).toBe(32_003);
    // One guest-broker route per admitted installation, keyed by its tenant, at its own port; the trust bundle holds each installation's authority.
    const brokerEndpoint = (port: number) => ({
      baseUrl: `https://127.0.0.1:${port}`, serviceTokenPath: join(host.paths.supervisorDelivery, FACTORY_HOST_FILES.supervisorGuestBrokerToken),
      tls: { caPath: join(host.paths.supervisorDelivery, FACTORY_HOST_FILES.trustBundle), certificatePath: join(host.paths.supervisorDelivery, FACTORY_HOST_FILES.supervisorCertificate), privateKeyPath: join(host.paths.supervisorDelivery, FACTORY_HOST_FILES.supervisorKey) },
    });
    expect((bundle.supervisor as { services: { guestBrokers?: unknown } }).services.guestBrokers).toEqual({
      "tenant-01": brokerEndpoint(factoryInstallationPorts("tenant-01", 31_000).guestBroker),
      "tenant-02": brokerEndpoint(factoryInstallationPorts("tenant-02", 31_000).guestBroker),
    });
    expect(await readdir(host.paths.supervisorDelivery)).toContain(FACTORY_HOST_FILES.supervisorGuestBrokerToken);
    expect(await readdir(host.paths.poolDelivery)).not.toContain(FACTORY_HOST_FILES.supervisorGuestBrokerToken);
    for (const [tenant, context] of [["tenant-01", one], ["tenant-02", two]] as const) {
      expect((claims(await text(join(context.secretDirectory, FACTORY_MESH_FILES.harnessPoolToken))).scope as string[]).every((scope) => scope.endsWith(tenant) || scope.includes(`:${tenant}:`))).toBe(true);
    }
    // Both deliveries carry the trust bundle: the host authority, then each admitted installation's.
    const trust = await text(join(host.paths.poolDelivery, FACTORY_HOST_FILES.trustBundle));
    expect(trust).toBe(`${(await text(hostSecret(FACTORY_HOST_FILES.caCertificate))).trim()}\n${(await text(join(one.secretDirectory, FACTORY_MESH_FILES.caCertificate))).trim()}\n${(await text(join(two.secretDirectory, FACTORY_MESH_FILES.caCertificate))).trim()}\n`);
    expect(await text(join(host.paths.supervisorDelivery, FACTORY_HOST_FILES.trustBundle))).toBe(trust);
    const [, poolPair] = factoryDatabasePairs(host.paths.context);
    const url = new URL((JSON.parse(await text(join(host.paths.poolDelivery, "pool-database.json"))) as { databaseUrl: string }).databaseUrl);
    expect([url.hostname, url.port, url.pathname, url.username, url.password]).toEqual(["127.0.0.1", "55432", `/${poolPair!.database}`, poolPair!.role, "p".repeat(43)]);
    expect(JSON.parse(await text(join(host.paths.poolDelivery, "pool.json")))).toEqual(bundle.pool);
    expect(JSON.parse(await text(join(host.paths.supervisorDelivery, "supervisor.json")))).toEqual(bundle.supervisor);
    expect((await readdir(host.paths.poolDelivery)).sort()).toEqual([FACTORY_HOST_FILES.serverCertificate, FACTORY_HOST_FILES.serverKey, FACTORY_HOST_FILES.tokenPublicKey, FACTORY_HOST_FILES.trustBundle, "pool-database.json", "pool.json"].sort());
    expect(await readdir(host.paths.supervisorDelivery)).not.toContain(FACTORY_HOST_FILES.tokenPublicKey);
    expect(await readdir(host.paths.supervisorDelivery)).toContain(FACTORY_HOST_FILES.hostKey);
    for (const directory of [join(host.paths.readinessDirectory, "pool"), join(host.paths.readinessDirectory, "supervisor"), host.paths.runnerRoot]) expect((await stat(directory)).mode & 0o777).toBe(0o700);
  }, SLOW);

  test("each installation's pool token carries pool:restore for its own tenant and no other tenant's scope", async () => {
    // W14's restore point, referenced from the recovery-section declaration test in deployment.test.ts.
    const admitted = [await installation("tenant-01"), await installation("tenant-02")];
    for (const context of admitted) await host.admit(context);
    for (const context of admitted) {
      const scope = claims(await text(join(context.secretDirectory, FACTORY_MESH_FILES.harnessPoolToken))).scope as string[];
      expect(scope).toContain(`pool:restore:${context.tenantId}`);
      const other = context.tenantId === "tenant-01" ? "tenant-02" : "tenant-01";
      expect(scope.filter((entry) => entry.includes(other))).toEqual([]);
    }
  }, SLOW);

  test("admitting the same installation again is idempotent", async () => {
    const one = await installation("tenant-01");
    await host.admit(one);
    await host.admit(one);
    expect((await host.admitted()).map((entry) => entry.tenantId)).toEqual(["tenant-01"]);
  }, SLOW);

  test("a tenant admitted under another installation is refused by name, and nothing is published", async () => {
    await host.admit(await installation("tenant-01"));
    const impostor = await installation("tenant-01", { installationId: "inst-other", secretDirectory: join(root, "secrets", "other") });
    await mkdir(impostor.secretDirectory, { recursive: true, mode: 0o700 });
    const calls = runtime.calls.length;
    const error = await factoryRejection(host.admit(impostor));
    expect(error).toBeInstanceOf(FactoryProvisioningError);
    expect(error.code).toBe("host_admission_conflict");
    expect(error.message).toBe("Tenant tenant-01 is admitted under another installation.");
    expect(runtime.calls.length).toBe(calls);
    expect((await factoryRejection(host.release(impostor))).code).toBe("host_admission_conflict");
  }, SLOW);

  test("release removes an installation and re-publishes; the last release stops the host; an unknown one is a no-op", async () => {
    const one = await installation("tenant-01");
    const two = await installation("tenant-02");
    await host.admit(one);
    await host.admit(two);
    runtime.calls.length = 0;
    await host.release(two);
    expect(runtime.calls).toEqual([`apply:tenant-01:${BUILD.image.slice(-4)}`, "ready:1"]);
    expect((runtime.bundles.at(-1)!.supervisor as { services: { allowedPeers: string[] } }).services.allowedPeers).toEqual(["harness.tenant-01"]);
    // A released installation's guest-broker route leaves the supervisor with it.
    expect(Object.keys((runtime.bundles.at(-1)!.supervisor as { services: { guestBrokers: Record<string, unknown> } }).services.guestBrokers)).toEqual(["tenant-01"]);
    await host.release(one);
    expect(runtime.calls.at(-1)).toBe("remove:host");
    expect(await host.admitted()).toEqual([]);
    runtime.calls.length = 0;
    await host.release(one);
    expect(runtime.calls).toEqual([]);
  }, SLOW);

  test("render with nothing admitted is refused by name", async () => {
    const error = await factoryRejection(host.render());
    expect(error.code).toBe("host_nothing_admitted");
    await host.admit(await installation("tenant-01"));
    expect((await host.render()).admitted.map((entry) => entry.tenantId)).toEqual(["tenant-01"]);
  }, SLOW);
});

describe("the installation's pool token", () => {
  test("is kept while more than a week remains, re-minted in its last week, and re-minted on demand", async () => {
    const one = await installation("tenant-01");
    await host.ensureMaterial();
    const path = join(one.secretDirectory, FACTORY_MESH_FILES.harnessPoolToken);
    expect(await host.mintInstallationToken(one)).toBe(NOW_MS + 30 * DAY_MS);
    const first = await text(path);
    now = NOW_MS + 22 * DAY_MS;
    expect(await host.mintInstallationToken(one)).toBe(NOW_MS + 30 * DAY_MS);
    expect(await text(path)).toBe(first);
    expect(await host.mintInstallationToken(one, true)).toBe(now + 30 * DAY_MS);
    const forced = await text(path);
    expect(forced).not.toBe(first);
    now = NOW_MS + 22 * DAY_MS + 24 * DAY_MS;
    await host.mintInstallationToken(one);
    expect(await text(path)).not.toBe(forced);
  }, SLOW);

  test("an unsafe token file is refused, not replaced", async () => {
    const one = await installation("tenant-01");
    await host.ensureMaterial();
    await host.mintInstallationToken(one);
    await chmod(join(one.secretDirectory, FACTORY_MESH_FILES.harnessPoolToken), 0o644);
    expect((await factoryRejection(host.mintInstallationToken(one))).message).toBe("Private file must be owned, private, regular, and bounded.");
  }, SLOW);

  test("cannot be minted before the host has its token key", async () => {
    expect((await factoryRejection(host.mintInstallationToken(await installation("tenant-01")))).code).toBe("ENOENT");
  });
});

describe("builds", () => {
  const NEXT: FactoryFleetHostBuild = { image: `registry.test/ezcorp@sha256:${"f".repeat(64)}`, revision: "a".repeat(40), release: "/releases/next" };

  test("a new build is saved and published; the running build moves nothing", async () => {
    await host.admit(await installation("tenant-01"));
    runtime.calls.length = 0;
    await host.useBuild(BUILD);
    expect(runtime.calls).toEqual([]);
    await host.useBuild(NEXT);
    expect(runtime.calls).toEqual([`apply:tenant-01:${NEXT.image.slice(-4)}`, "ready:1"]);
    expect(runtime.bundles.at(-1)!.build).toEqual(NEXT);
    runtime.calls.length = 0;
    await host.useBuild(NEXT);
    expect(runtime.calls).toEqual([]);
    for (const changed of [{ ...NEXT, revision: "b".repeat(40) }, { ...NEXT, release: "/releases/other" }]) {
      await host.useBuild(changed);
      expect(runtime.bundles.at(-1)!.build).toEqual(changed);
    }
  }, SLOW);

  test("with nothing admitted a build is saved but nothing is published", async () => {
    await host.useBuild(NEXT);
    expect(runtime.calls).toEqual([]);
    await host.admit(await installation("tenant-01"));
    expect(runtime.bundles.at(-1)!.build).toEqual(NEXT);
  }, SLOW);
});

describe("state", () => {
  test("database progress merges into the host's state and is what the next admission passes back", async () => {
    await host.recordDatabaseProgress({ poolPlan: "crashed-plan" });
    await host.recordDatabaseProgress({ poolRoleOid: "7" });
    await host.admit(await installation("tenant-01"));
    expect(database.ensured).toEqual([{ poolPlan: "crashed-plan", poolRoleOid: "7" }]);
  }, SLOW);

  test("a state file that is not a host state document is refused by name", async () => {
    await mkdir(host.paths.context.operatorDirectory, { recursive: true, mode: 0o700 });
    for (const document of [{ schemaVersion: "other" }, { schemaVersion: "factory.host-state.v1", admitted: null }, { schemaVersion: "factory.host-state.v1", admitted: "x" }]) {
      await writeModeFile(hostOperator(FACTORY_HOST_FILES.state), JSON.stringify(document));
      const error = await factoryRejection(host.admitted());
      expect(error.code).toBe("host_state_corrupt");
      expect(error.message).toBe("The fleet host's state file is not a host state document.");
    }
  });

  test("an unsafe state file is refused, not taken as empty", async () => {
    await mkdir(host.paths.context.operatorDirectory, { recursive: true, mode: 0o700 });
    await writeModeFile(hostOperator(FACTORY_HOST_FILES.state), JSON.stringify({ schemaVersion: "factory.host-state.v1", database: null, admitted: {} }), 0o644);
    expect((await factoryRejection(host.admitted())).message).toBe("Private file must be owned, private, regular, and bounded.");
  });
});

describe("decommission", () => {
  test("is refused while any installation is admitted", async () => {
    await host.admit(await installation("tenant-01"));
    const error = await factoryRejection(host.decommission());
    expect(error.code).toBe("host_in_use");
    expect(database.purged).toEqual([]);
  }, SLOW);

  test("purges the runtime and the pool database, forgets it, and removes the host's secrets", async () => {
    const one = await installation("tenant-01");
    await host.admit(one);
    await host.release(one);
    await host.decommission();
    expect(runtime.calls.slice(-1)).toEqual(["purge:host"]);
    expect(database.purged).toEqual([{ poolPlan: "plan-1", poolRoleOid: "11", poolDatabaseOid: "12", poolDatabasePhase: "created" }]);
    expect((await factoryRejection(stat(host.paths.context.secretDirectory))).code).toBe("ENOENT");
    // A second decommission has no database to drop.
    await host.decommission();
    expect(database.purged).toHaveLength(1);
    expect(runtime.calls.slice(-1)).toEqual(["purge:host"]);
  }, SLOW);
});
