/**
 * One real factory installation on this host, brought up from nothing.
 *
 * Ported from the W09b/W01g/W15b real-server harness
 * (`/tmp/factory-platform-evidence/{w09b,w01g,w15b}/repro/`). Every process
 * the architecture names runs for real:
 *
 *   - the shared PostgreSQL proof container and the two shared S3 services,
 *     observed read-only and never reconfigured;
 *   - the pool admission process, on its own fresh database, with RS256
 *     service tokens over mutual TLS;
 *   - the host supervisor, owning the one PodmanRunner, its launch and stop
 *     services, and `services.guestBrokers`, the per-tenant routes it carries a guest's
 *     staging frames and model requests back over;
 *   - a Temporal dev server behind a mutual-TLS terminator, and the Node
 *     orchestrator under a restart loop;
 *   - the built SvelteKit server on a FRESH product database, composing the
 *     factory from its startup document: the guest-broker route, the model
 *     provider pin, the three runner profiles, the recovery sections.
 *
 * Two deployment facts the harness supplies are stated in every record: the
 * TLS terminator in front of Temporal, and the runner package installation,
 * which no product route owns yet (W02).
 *
 * Credential values never leave the private 0600 files under the stack root;
 * the record carries paths, ports, and names only.
 */
import { createPublicKey, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { SQL } from "bun";
import type { JsonValue } from "@ezcorp/factory-sdk";
import { FACTORY_GUEST_BROKER_AUDIENCE } from "../../src/factory/runner/guest-broker-contract";

export const TENANT = "tenant-01";
export const INSTALLATION = "installation-w19a";
export const HOST_ID = "host-w19a";
const POOL_ID = "pool-w19a";
const NAMESPACE = "tenant-01.factory";
const SUPERVISOR_SUBJECT = "supervisor-w19a";
const TEMPORAL_CLI = process.env.W19A_TEMPORAL_CLI ?? "/tmp/factory-tools/temporal-cli/temporal";
const GUEST_BROKER_ISSUER = "w19a-proof";

export interface StackOptions {
  readonly repo: string;
  /** The pinned bun, used for every bun child. */
  readonly bun: string;
  /** The runner profiles, from the guest the stack built (their references carry its digest). */
  readonly runnerProfiles: (guestBuild: unknown) => Record<string, JsonValue>;
  /** The installation's `modelProvider`. Absent, no guest may call a model. */
  readonly modelProvider?: { readonly provider: string; readonly model: string };
  /** Builds the guest into the supervisor's runner store before the supervisor takes its lease. */
  readonly buildGuest: (runnerRoot: string) => Promise<unknown>;
  /** Extra environment for the web server only (the mock mode opens the test surface). */
  readonly webEnv?: Readonly<Record<string, string>>;
  readonly record: Record<string, unknown>;
}

interface Child { readonly name: string; child: ReturnType<typeof spawn>; log: string[] }

export interface Stack {
  readonly root: string;
  readonly port: number;
  readonly productUrl: string;
  readonly productDatabase: string;
  readonly runnerRoot: string;
  readonly session: ReturnType<typeof session>;
  readonly children: readonly Child[];
  /** Stop every child, write the logs, and drop the databases (the product one only if `keepProduct` is false). */
  stop(keepProduct: boolean): Promise<void>;
}

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function reachable(port: number): Promise<boolean> {
  return new Promise((settle) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    const done = (value: boolean) => { socket.destroy(); settle(value); };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Kill a process group without caring whether it is still there. */
function stopGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(-pid, signal); }
  catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

async function privateWrite(path: string, content: string | Uint8Array): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

function rs256(privateKey: import("node:crypto").KeyObject, kid: string, claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", kid })}.${encode(claims)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(privateKey).toString("base64url")}`;
}

/** One session's worth of real HTTP, cookies included: the product's own auth, never around it. */
export function session(port: number) {
  let cookie = "";
  return {
    async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ method: string; path: string; status: number; body: unknown }> {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        redirect: "manual",
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const issued = response.headers.getSetCookie?.() ?? [];
      if (issued.length > 0) cookie = issued.map((entry) => entry.split(";")[0]).join("; ");
      let parsed: unknown = await response.text();
      try { parsed = JSON.parse(parsed as string); } catch { parsed = (parsed as string).slice(0, 400); }
      return { method, path, status: response.status, body: parsed };
    },
  };
}

/**
 * Is each shared object store answering? Read-only by construction: one HTTP
 * request to each service's root, no compose, no restart, no write.
 */
export async function checkSharedStores(): Promise<Array<{ store: string; port: number; reachable: boolean; detail: string }>> {
  const ports = { ordinary: 18333, archive: 18334 };
  return Promise.all(Object.entries(ports).map(async ([store, port]) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) });
      return { store, port, reachable: true, detail: `http ${response.status}` };
    } catch (error) {
      return { store, port, reachable: false, detail: String((error as Error)?.message ?? error) };
    }
  }));
}

export async function startStack(options: StackOptions): Promise<Stack> {
  const { repo, bun, record } = options;
  const here = join(repo, "scripts/factory-graph-proof/processes");
  const children: Child[] = [];
  const start = (name: string, command: string, args: string[], extra: { cwd?: string; env?: Record<string, string> } = {}) => {
    const child = spawn(command, args, { cwd: extra.cwd ?? repo, env: { ...process.env, ...extra.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const log: string[] = [];
    child.stdout.on("data", (bytes) => log.push(String(bytes)));
    child.stderr.on("data", (bytes) => log.push(String(bytes)));
    const entry = { name, child, log };
    children.push(entry);
    return entry;
  };

  const root = await mkdtemp(join(process.env.HOME!, ".w19a-stack-"));
  await chmod(root, 0o700);
  for (const directory of ["secrets", "project", "readiness"]) await mkdir(join(root, directory), { mode: 0o700 });
  const secrets = join(root, "secrets");
  const directories = [root];
  const created: string[] = [];
  let admin: SQL | undefined;
  let productDatabase = "";
  let web: Child | undefined;
  let stopped = false;
  /** Takes down everything this stack made, whatever point it reached. */
  const stop = async (keepProduct: boolean) => {
    if (stopped) return;
    stopped = true;
    if (web !== undefined) {
      stopGroup(web.child.pid, "SIGTERM");
      await Promise.race([new Promise((settle) => web!.child.once("exit", settle)), sleep(30_000)]);
    }
    for (const entry of children) stopGroup(entry.child.pid, "SIGKILL");
    await sleep(500);
    try {
      for (const database of created) {
        if (keepProduct && database === productDatabase) { record.retainedProductDatabase = database; continue; }
        await admin?.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
      }
    } finally {
      await admin?.close();
    }
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
  };
  try {

  // ── mTLS material: the shared test CA, and a second client identity ──
  const { certificates } = await import(join(repo, "src/__tests__/helpers/factory-certificates.ts"));
  await certificates(directories);
  const certificateRoot = directories.at(-1)!;
  for (const name of ["server.key", "server.pem", "client.key", "client.pem", "ca.pem"]) {
    await copyFile(join(certificateRoot, name), join(secrets, name));
    await chmod(join(secrets, name), 0o600);
  }
  // The supervisor is not a tenant: C03 lets only a supervisor settle a stop.
  for (const args of [
    ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(secrets, "supervisor.key"), "-out", join(secrets, "supervisor.csr"), "-subj", `/CN=${SUPERVISOR_SUBJECT}`],
    ["x509", "-req", "-in", join(secrets, "supervisor.csr"), "-CA", join(certificateRoot, "ca.pem"), "-CAkey", join(certificateRoot, "ca.key"), "-CAcreateserial", "-out", join(secrets, "supervisor.pem"), "-days", "1", "-extfile", join(certificateRoot, "client.ext")],
  ]) {
    const openssl = Bun.spawn(["openssl", ...args], { stdout: "ignore", stderr: "pipe" });
    if (await openssl.exited !== 0) throw new Error(`the supervisor certificate could not be issued: ${await new Response(openssl.stderr).text()}`);
  }
  await chmod(join(secrets, "supervisor.key"), 0o600);
  await chmod(join(secrets, "supervisor.pem"), 0o600);

  // ── Service tokens: one RS256 key for pool, private service and orchestrator ──
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const poolToken = (subject: string, scopes: string[]) => rs256(keys.privateKey, "proof", { sub: subject, iss: "factory-proof", aud: "factory-pool", exp: Math.floor(Date.now() / 1_000) + 7_200, scope: scopes });
  await privateWrite(join(secrets, "pool-token.pem"), keys.publicKey.export({ type: "pkcs1", format: "pem" }).toString());
  await privateWrite(join(secrets, "tenant.token"), poolToken(TENANT, [`pool:tenant:${TENANT}`, `pool:grant:${TENANT}:factory`]));
  await privateWrite(join(secrets, "supervisor.token"), poolToken(SUPERVISOR_SUBJECT, [`pool:supervisor:${SUPERVISOR_SUBJECT}`]));
  await privateWrite(join(secrets, "orchestrator.token"), poolToken("tenant-a", ["factory:orchestrate"]));
  await privateWrite(join(secrets, "attempt-token"), randomBytes(32).toString("hex"));
  // The guest-broker route's host token: the supervisor presents it, the product verifies it.
  const brokerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await privateWrite(join(secrets, "guest-broker-host.token"), rs256(brokerKeys.privateKey, "w19a", { sub: SUPERVISOR_SUBJECT, iss: GUEST_BROKER_ISSUER, aud: FACTORY_GUEST_BROKER_AUDIENCE, exp: Math.floor(Date.now() / 1_000) + 7_200, scope: ["factory:guest-broker"] }));
  await privateWrite(join(secrets, "guest-broker-host-token.pem"), brokerKeys.publicKey.export({ type: "spki", format: "pem" }).toString());

  // Storage credentials copied to 0600, as a real provisioner does.
  for (const kind of ["ordinary", "archive"]) {
    await copyFile(join(process.env.EZCORP_FACTORY_STORAGE_SECRETS_DIR!, `${kind}.json`), join(secrets, `${kind}-storage.json`));
    await chmod(join(secrets, `${kind}-storage.json`), 0o600);
  }

  // ── Fresh pool and product databases on the shared PostgreSQL ──
  admin = new SQL(process.env.FACTORY_TEST_POSTGRES_URL!, { max: 1 });
  const stamp = `${Date.now()}_${randomBytes(3).toString("hex")}`;
  const poolDatabase = `w19a_pool_${stamp}`;
  productDatabase = `w19a_product_${stamp}`;
  for (const database of [poolDatabase, productDatabase]) {
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    created.push(database);
  }
  const productUrl = new URL(process.env.FACTORY_TEST_POSTGRES_URL!);
  productUrl.pathname = `/${productDatabase}`;
  const poolUrl = new URL(process.env.FACTORY_TEST_POSTGRES_URL!);
  poolUrl.pathname = `/${poolDatabase}`;
  await privateWrite(join(secrets, "pool-database.json"), JSON.stringify({ databaseUrl: poolUrl.toString() }));
  record.databases = { pool: poolDatabase, product: productDatabase };

  // ── The installation's key material, wrapped by the operator master key ──
  const { InstallationDataKey, StaticMasterKeyProvider } = await import(join(repo, "src/factory/encryption.ts"));
  const masterKeyPath = join(secrets, "master.key");
  const masterKeyId = "master-1";
  await privateWrite(masterKeyPath, randomBytes(32));
  const heldWraps: Array<{ installationId: string; wrapVersion: number; masterKeyId: string; wrappedDataKey: Uint8Array }> = [];
  await InstallationDataKey.loadOrCreate(INSTALLATION, {
    async load() { return heldWraps.map((wrap) => ({ ...wrap, wrappedDataKey: Uint8Array.from(wrap.wrappedDataKey) })); },
    async save(wrap: (typeof heldWraps)[number]) { heldWraps.push({ ...wrap }); },
  } as never, new StaticMasterKeyProvider({ id: masterKeyId, bytes: new Uint8Array(await readFile(masterKeyPath)) }));
  const wrappedKeyPath = join(secrets, "wraps.json");
  await privateWrite(wrappedKeyPath, JSON.stringify({
    schemaVersion: "factory.key-wraps.v1", installationId: INSTALLATION,
    wraps: heldWraps.map((wrap) => ({ installationId: wrap.installationId, wrapVersion: wrap.wrapVersion, masterKeyId: wrap.masterKeyId, wrappedDataKey: Buffer.from(wrap.wrappedDataKey).toString("base64") })),
  }));

  // ── The guest, built into the store the supervisor will launch from ──
  const runnerRoot = join(root, "runner");
  const guestBuild = await options.buildGuest(runnerRoot);
  record.guestBuild = guestBuild;

  // ── Pool admission process ──
  const poolPort = freePort();
  await privateWrite(join(secrets, "pool.json"), JSON.stringify({
    schemaVersion: "factory.pool-process.v1", installationId: INSTALLATION, poolId: POOL_ID,
    hostname: "127.0.0.1", port: poolPort,
    database: { credentialsPath: join(secrets, "pool-database.json"), expectedDatabase: poolDatabase, expectedRole: decodeURIComponent(poolUrl.username) },
    tls: { privateKeyPath: join(secrets, "server.key"), certificatePath: join(secrets, "server.pem"), caPath: join(secrets, "ca.pem") },
    tokens: { issuer: "factory-proof", audience: "factory-pool", publicKeyPaths: { proof: join(secrets, "pool-token.pem") } },
    identities: {
      tenants: { "tenant-a": { tenantId: TENANT, tokenSubject: TENANT } },
      supervisors: { [SUPERVISOR_SUBJECT]: { supervisorId: SUPERVISOR_SUBJECT, tokenSubject: SUPERVISOR_SUBJECT, hostIds: [HOST_ID] } },
    },
    resources: { capacities: { cpu: 4 }, gpuHosts: [], hosts: [HOST_ID] },
    readinessFilePath: join(root, "readiness", "pool.json"), readinessHeartbeatMs: 2_000,
  }));
  start("pool", bun, [join(repo, "src/factory/pool/process.ts"), join(secrets, "pool.json")]);

  // ── Host supervisor, carrying guest frames back over services.guestBrokers ──
  const { privateKey: hostKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await privateWrite(join(secrets, "host.key"), hostKey.export({ type: "pkcs8", format: "pem" }).toString());
  await privateWrite(join(secrets, "host.kid"), "host-key-1");
  await privateWrite(join(secrets, "host.pub"), createPublicKey(hostKey).export({ type: "spki", format: "pem" }).toString());
  const hostServicePort = freePort();
  const guestBrokerPort = freePort();
  const supervisorTls = { caPath: join(secrets, "ca.pem"), certificatePath: join(secrets, "supervisor.pem"), privateKeyPath: join(secrets, "supervisor.key") };
  await privateWrite(join(secrets, "supervisor.json"), JSON.stringify({
    schemaVersion: "factory.supervisor-process.v1", installationId: INSTALLATION, hostId: HOST_ID,
    hostKeyPath: join(secrets, "host.key"), hostKeyId: "host-key-1",
    runnerRoot, readinessFilePath: join(root, "readiness", "supervisor.json"), readinessHeartbeatMs: 2_000,
    services: {
      hostname: "127.0.0.1", port: hostServicePort, allowedPeers: ["tenant-a"], hostKeyIdPath: join(secrets, "host.kid"),
      tls: { caPath: join(secrets, "ca.pem"), certificatePath: join(secrets, "server.pem"), privateKeyPath: join(secrets, "server.key") },
      pool: { baseUrl: `https://127.0.0.1:${poolPort}`, serviceTokenPath: join(secrets, "supervisor.token"), tls: supervisorTls },
      // One route per tenant; this stack runs one tenant.
      guestBrokers: { [TENANT]: { baseUrl: `https://127.0.0.1:${guestBrokerPort}`, serviceTokenPath: join(secrets, "guest-broker-host.token"), tls: supervisorTls } },
    },
  }));
  start("supervisor", bun, [join(repo, "src/factory/runner/supervisor-process.ts"), join(secrets, "supervisor.json")]);

  // ── Temporal behind a mutual-TLS terminator ──
  const temporalPort = freePort();
  const temporalTlsPort = freePort();
  const temporalHttpPort = freePort();
  start("temporal", TEMPORAL_CLI, ["server", "start-dev", "--ip", "127.0.0.1", "--port", String(temporalPort), "--http-port", String(temporalHttpPort), "--namespace", NAMESPACE, "--headless", "--db-filename", join(root, "temporal.sqlite")]);
  for (let attempt = 0; attempt < 90 && !await reachable(temporalPort); attempt++) await sleep(1_000);
  start("temporal-tls", "node", [join(here, "tls-terminator.mjs"), String(temporalTlsPort), String(temporalPort), secrets]);
  for (let attempt = 0; attempt < 30 && !await reachable(temporalTlsPort); attempt++) await sleep(500);

  // ── The product's startup document ──
  const gatewayPort = freePort();
  const privateServicePort = freePort();
  const clientTls = { caPath: join(secrets, "ca.pem"), certificatePath: join(secrets, "client.pem"), privateKeyPath: join(secrets, "client.key") };
  const serverTls = { caPath: join(secrets, "ca.pem"), certificatePath: join(secrets, "server.pem"), privateKeyPath: join(secrets, "server.key") };
  const startup = {
    schemaVersion: "factory.startup.v1",
    installationId: INSTALLATION, tenantId: TENANT, poolId: POOL_ID, hostId: HOST_ID,
    temporalNamespace: NAMESPACE,
    orphanSweepIntervalMs: 30_000,
    orchestrationReadinessFilePath: join(root, "readiness", "orchestration.json"),
    poolReadinessFilePath: join(root, "readiness", "pool.json"),
    supervisorReadinessFilePath: join(root, "readiness", "supervisor.json"),
    readinessHeartbeatMs: 5_000,
    readinessRetry: { delayMs: 2_000, windowMs: 240_000 },
    gateway: { hostname: "127.0.0.1", port: gatewayPort, tls: clientTls },
    privateService: {
      hostname: "127.0.0.1", port: privateServicePort, certificateIdentity: "tenant-a", tls: serverTls,
      tokens: { issuer: "factory-proof", audience: "factory-pool", publicKeyPaths: { proof: join(secrets, "pool-token.pem") } },
    },
    temporalHttp: { endpoint: `http://127.0.0.1:${temporalHttpPort}` },
    pool: { baseUrl: `https://127.0.0.1:${poolPort}`, serviceTokenPath: join(secrets, "tenant.token"), tls: clientTls },
    hostLaunch: {
      baseUrl: `https://127.0.0.1:${hostServicePort}`, serverName: "localhost",
      attemptTokenSecretPath: join(secrets, "attempt-token"),
      tls: { ...clientTls, serviceTokenPath: join(secrets, "tenant.token") },
    },
    hostStopKeys: [{ hostId: HOST_ID, hostKeyId: "host-key-1", publicKeyPath: join(secrets, "host.pub") }],
    guestBroker: {
      hostname: "127.0.0.1", port: guestBrokerPort, hosts: { [SUPERVISOR_SUBJECT]: HOST_ID }, tls: serverTls,
      tokens: { issuer: GUEST_BROKER_ISSUER, audience: FACTORY_GUEST_BROKER_AUDIENCE, publicKeyPaths: { w19a: join(secrets, "guest-broker-host-token.pem") } },
    },
    runnerProfiles: options.runnerProfiles(guestBuild),
    ...(options.modelProvider === undefined ? {} : { modelProvider: options.modelProvider }),
    storage: {
      ordinary: { endpoint: "http://127.0.0.1:18333", bucket: TENANT, prefix: "ordinary", credentialSet: "ordinary", credentialsPath: join(secrets, "ordinary-storage.json") },
      archive: { endpoint: "http://127.0.0.1:18334", bucket: TENANT, prefix: "archive", credentialSet: "archive", credentialsPath: join(secrets, "archive-storage.json") },
    },
    keys: { masterKeyFilePath: masterKeyPath, masterKeyId, wrappedKeyFilePath: wrappedKeyPath, grantableRoots: [join(root, "project")] },
    workers: { idleDelayMs: 200, batch: 4 },
  };
  await privateWrite(join(secrets, "factory-startup.json"), JSON.stringify(startup));
  record.startupDocument = { runnerProfiles: startup.runnerProfiles, modelProvider: options.modelProvider ?? null, guestBroker: { port: guestBrokerPort, hosts: startup.guestBroker.hosts } };

  // ── The Node orchestrator's configuration ──
  await privateWrite(join(secrets, "temporal-api.key"), "w19a-proof-temporal-api-key");
  await privateWrite(join(secrets, "orchestrator.json"), JSON.stringify({
    schemaVersion: "factory.orchestrator-process.v1", installationId: INSTALLATION, tenantId: TENANT,
    temporal: { address: `127.0.0.1:${temporalTlsPort}`, namespace: NAMESPACE, serverName: "localhost", ...clientTls, apiKeyPath: join(secrets, "temporal-api.key") },
    gateway: { baseUrl: `https://127.0.0.1:${privateServicePort}`, serverName: "localhost", tls: { ...clientTls, serviceTokenPath: join(secrets, "orchestrator.token") } },
    codec: { wrappedKeyFilePath: wrappedKeyPath, masterKeyFilePath: masterKeyPath, masterKeyId, grantableRoots: [join(root, "project")] },
    readinessFilePath: join(root, "readiness", "orchestration.json"), readinessHeartbeatMs: 5_000,
  }));

  start("gateway-stub", bun, [join(here, "gateway-listener.ts")], { env: { W19A_REPO: repo, W19A_ROOT: root, W19A_GATEWAY_PORT: String(gatewayPort) } });

  // ── Wait for the two host processes ──
  for (let attempt = 0; attempt < 60; attempt++) {
    const published = await Promise.all(["pool.json", "supervisor.json"].map((name) => readFile(join(root, "readiness", name), "utf8").catch(() => "")));
    if (published.every((value) => value.includes('"ready"'))) break;
    await sleep(1_000);
  }
  record.hostProcesses = Object.fromEntries(await Promise.all(["pool", "supervisor"].map(async (name) => [name, JSON.parse(await readFile(join(root, "readiness", `${name}.json`), "utf8").catch(() => "null"))?.lifecycle ?? null])));

  // ── The web server ──
  const port = freePort();
  web = start("web", bun, ["build/index.js"], {
    cwd: join(repo, "web"),
    env: {
      PORT: String(port), HOST: "127.0.0.1", ORIGIN: `http://127.0.0.1:${port}`,
      EZCORP_FACTORY_ENABLED: "1", EZCORP_INSTALLATION_ID: INSTALLATION,
      EZCORP_FACTORY_INTERPRETER_COMPATIBILITY: "factory-kernel.v1",
      // One class per node; the startup document keys admission by class.
      EZCORP_FACTORY_RESOURCE_CLASSES: "cpu,cpu-infer,cpu-combine",
      EZCORP_PERM_SWEEP_INTERVAL_MS: "30000",
      EZCORP_SECRETS_DIR: secrets, EZCORP_PROJECT_ROOT: join(root, "project"),
      DATABASE_URL: productUrl.toString(),
      EZCORP_JWT_SECRET: `w19a-jwt-${randomBytes(12).toString("hex")}`,
      EZCORP_ENCRYPTION_SECRET: `w19a-enc-${randomBytes(12).toString("hex")}`,
      EZCORP_FACTORY_STORAGE_SECRETS_DIR: process.env.EZCORP_FACTORY_STORAGE_SECRETS_DIR!,
      ...options.webEnv,
    },
  });

  // ── The orchestrator, once the private service accepts ──
  for (let attempt = 0; attempt < 180 && !await reachable(privateServicePort); attempt++) await sleep(1_000);
  start("orchestrator", "bash", [join(here, "orchestrator-runner.sh")], { env: { W19A_REPO: repo, W19A_ORCHESTRATOR_CONFIG: join(secrets, "orchestrator.json") } });
  let orchestration: { lifecycle?: string } | null = null;
  for (let attempt = 0; attempt < 120; attempt++) {
    orchestration = JSON.parse(await readFile(join(root, "readiness", "orchestration.json"), "utf8").catch(() => "null"));
    if (orchestration?.lifecycle === "ready") break;
    await sleep(1_000);
  }
  record.orchestration = orchestration?.lifecycle ?? null;

  let ready: { status: number; body: unknown } | null = null;
  const api = session(port);
  for (let attempt = 0; attempt < 180; attempt++) {
    const probe = await api.call("GET", "/api/ready").catch((error: unknown) => ({ status: 0, body: String(error) }));
    if (probe.status === 200) { ready = probe; break; }
    await sleep(1_000);
  }
  record.ready = ready;

  if (ready === null) {
    record.processLogs = Object.fromEntries(children.map((entry) => [entry.name, entry.log.join("").slice(-6_000)]));
  }
  return { root, port, productUrl: productUrl.toString(), productDatabase, runnerRoot, session: api, children, stop };
  } catch (error) {
    // Nothing a failed start made may outlive it: not a child, not a
    // database on the shared server, not a private directory.
    record.processLogs = Object.fromEntries(children.map((entry) => [entry.name, entry.log.join("").slice(-6_000)]));
    await stop(false);
    throw error;
  }
}

/** The supervisor's lease children: one runner held for life means exactly one `flock`. */
export function leaseChildren(pid: number): number {
  try { return execFileSync("pgrep", ["-P", String(pid), "-x", "flock"], { encoding: "utf8" }).split("\n").filter((value) => value.trim()).length; }
  catch { return 0; }
}
