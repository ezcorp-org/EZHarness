/**
 * The `factory-services` lane's real stack (C11 lane 6, W14).
 *
 * Boots every process the factory architecture names, over the shared
 * PostgreSQL and object storage, then HOLDS it for the browser journeys:
 *   - the pool admission process, with its own database and RS256 tokens over
 *     mutual TLS;
 *   - the host supervisor, holding the host key and the one Podman runner;
 *   - the pinned Temporal CLI dev server behind a TLS-terminating sidecar, and the
 *     Node orchestrator connecting to it with mutual TLS;
 *   - the built SvelteKit server, which composes the factory, binds the private
 *     service, and runs the background roles.
 *
 * The stack supplies four deployment facts and states them in the state file:
 *   1. the TLS terminator in front of Temporal, which terminates no TLS itself;
 *   2. the first-run administrator setup and two projects, over real HTTP;
 *   3. the v4 installation record of the guest release (the v4 install step);
 *   4. the package PREPARATION, once the console has bound and trusted the
 *      package, because no product route or role prepares a package yet.
 *
 * Inputs: FACTORY_TEST_POSTGRES_URL, EZCORP_FACTORY_STORAGE_SECRETS_DIR, and
 * FACTORY_TEMPORAL_CLI (all required), FACTORY_SERVICES_PORT (4191),
 * FACTORY_SERVICES_STATE, FACTORY_SERVICES_LOGS, and FACTORY_SERVICES_STOP.
 * The web server must already be built (`web/build`).
 *
 * It prints `[factory-services] held` once the state file is written, and
 * stops on SIGTERM, SIGINT, the stop file, or the hold deadline. Stopping drops
 * the pool database, and the product database too unless the stack failed.
 */
import { createPublicKey, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { SQL } from "bun";
import { buildFactoryGuest } from "./guest";
import { freePort, httpSession, reachable, StackProcesses, waitFor } from "./processes";
import { FACTORY_SERVICES_STATE_PATH, type FactoryServicesState } from "./state";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const WEB = join(REPO, "web");
const BUN = process.execPath;

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`the factory-services stack requires ${name}`);
	return value;
}
const POSTGRES_URL = required("FACTORY_TEST_POSTGRES_URL");
const STORAGE_SECRETS = required("EZCORP_FACTORY_STORAGE_SECRETS_DIR");
const TEMPORAL = required("FACTORY_TEMPORAL_CLI");
const WEB_PORT = Number(process.env.FACTORY_SERVICES_PORT ?? 4191);
const STOP_FILE = process.env.FACTORY_SERVICES_STOP ?? `${FACTORY_SERVICES_STATE_PATH}.stop`;
const HOLD_MS = Number(process.env.FACTORY_SERVICES_HOLD_MS ?? 3_600_000);
const STORE_PORTS = {
	ordinary: Number(process.env.EZCORP_FACTORY_STORAGE_ORDINARY_S3_PORT ?? 18333),
	archive: Number(process.env.EZCORP_FACTORY_STORAGE_ARCHIVE_S3_PORT ?? 18334),
} as const;
const TENANT = "tenant-01";
const INSTALLATION = "installation-factory-services";
const POOL = "pool-factory-services";
const HOST = "host-factory-services";
const SUPERVISOR = "supervisor-factory-services";
const NAMESPACE = `${TENANT}.factory`;

const processes = new StackProcesses();
const logs = process.env.FACTORY_SERVICES_LOGS ?? await mkdtemp(join(tmpdir(), "factory-services-logs-"));
await mkdir(logs, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "factory-services-"));
await chmod(root, 0o700);
const secrets = join(root, "secrets");
const readiness = join(root, "readiness");
for (const path of [secrets, readiness, join(root, "project", "reader")]) await mkdir(path, { recursive: true, mode: 0o700 });
const secret = (name: string) => join(secrets, name);

/** Writes a private file at 0600, which the product's bounded readers require. */
async function writePrivate(name: string, content: string | Uint8Array): Promise<string> {
	await writeFile(secret(name), content, { mode: 0o600 });
	await chmod(secret(name), 0o600);
	return secret(name);
}

let stopping: Promise<void> | null = null;
let failed = false;
let dropDatabases: () => Promise<void> = async () => {};

async function stop(reason: string): Promise<void> {
	stopping ??= (async () => {
		console.log(`[factory-services] stopping: ${reason}`);
		processes.stopAll("SIGTERM");
		await sleep(2_000);
		processes.stopAll("SIGKILL");
		await Promise.all(processes.children.map(entry => Bun.write(join(logs, `${entry.name}.log`), entry.log.join(""))));
		await dropDatabases().catch(error => console.error("[factory-services] database cleanup failed:", error));
		await rm(root, { recursive: true, force: true });
	})();
	return stopping;
}

async function fail(error: unknown): Promise<never> {
	failed = true;
	console.error("[factory-services] the stack failed:", error);
	await Promise.race([stop("failure"), sleep(20_000)]);
	process.exit(1);
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { void stop(signal).then(() => process.exit(0)); });

// ── The shared object stores, observed and never reconfigured ─────────
for (const [store, port] of Object.entries(STORE_PORTS)) {
	// Any HTTP answer proves the service; an unauthenticated 403 is healthy.
	const answer = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
	if (!answer) await fail(`the shared ${store} object store does not answer on port ${port}`);
}

// ── Keys and certificates ─────────────────────────────────────────────
const tokenKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function serviceToken(subject: string, scopes: readonly string[]): string {
	const input = `${encode({ alg: "RS256", kid: "stack" })}.${encode({ sub: subject, iss: "factory-services", aud: "factory-pool", exp: Math.floor(Date.now() / 1_000) + 7_200, scope: scopes })}`;
	const signer = createSign("RSA-SHA256");
	signer.update(input);
	signer.end();
	return `${input}.${signer.sign(tokenKeys.privateKey).toString("base64url")}`;
}

const { certificates } = await import(join(REPO, "src/__tests__/helpers/factory-certificates.ts")) as { certificates(directories: string[]): Promise<void> };
const certificateDirectories: string[] = [];
await certificates(certificateDirectories);
const certificateRoot = certificateDirectories.at(-1)!;
for (const name of ["server.key", "server.pem", "client.key", "client.pem", "ca.pem"]) await writePrivate(name, await readFile(join(certificateRoot, name)));
// The pool resolves a principal from the client certificate's common name, and
// only a supervisor may settle the ledger, so the supervisor needs its own.
for (const args of [
	["req", "-newkey", "rsa:2048", "-nodes", "-keyout", secret("supervisor.key"), "-out", secret("supervisor.csr"), "-subj", `/CN=${SUPERVISOR}`],
	["x509", "-req", "-in", secret("supervisor.csr"), "-CA", join(certificateRoot, "ca.pem"), "-CAkey", join(certificateRoot, "ca.key"), "-CAcreateserial", "-out", secret("supervisor.pem"), "-days", "1", "-extfile", join(certificateRoot, "client.ext")],
]) {
	const openssl = Bun.spawn(["openssl", ...args], { stdout: "ignore", stderr: "pipe" });
	if (await openssl.exited !== 0) await fail(`openssl could not issue the supervisor certificate: ${await new Response(openssl.stderr).text()}`);
}
await Promise.all(["supervisor.key", "supervisor.pem"].map(name => chmod(secret(name), 0o600)));
await rm(certificateRoot, { recursive: true, force: true });
const clientTls = { caPath: secret("ca.pem"), certificatePath: secret("client.pem"), privateKeyPath: secret("client.key") };
const serverTls = { caPath: secret("ca.pem"), certificatePath: secret("server.pem"), privateKeyPath: secret("server.key") };
const supervisorTls = { caPath: secret("ca.pem"), certificatePath: secret("supervisor.pem"), privateKeyPath: secret("supervisor.key") };

const tokenPublicKey = await writePrivate("pool-token.pem", tokenKeys.publicKey.export({ type: "pkcs1", format: "pem" }) as string);
const tenantToken = await writePrivate("tenant.token", serviceToken(TENANT, [`pool:tenant:${TENANT}`, `pool:grant:${TENANT}:factory`]));
const supervisorToken = await writePrivate("supervisor.token", serviceToken(SUPERVISOR, [`pool:supervisor:${SUPERVISOR}`]));
const orchestratorToken = await writePrivate("orchestrator.token", serviceToken("tenant-a", ["factory:orchestrate"]));
const attemptTokenSecret = await writePrivate("attempt-token", randomBytes(32).toString("hex"));
// Storage credentials are copied private, as a real installation's provisioner does.
for (const kind of ["ordinary", "archive"]) await writePrivate(`${kind}-storage.json`, await readFile(join(STORAGE_SECRETS, `${kind}.json`)));

// ── Databases: one for the pool ledger, one fresh product database ────
const admin = new SQL(POSTGRES_URL, { max: 1 });
const suffix = `${Date.now()}_${randomBytes(3).toString("hex")}`;
const poolDatabase = `factory_services_pool_${suffix}`;
const productDatabase = `factory_services_product_${suffix}`;
await admin.unsafe(`CREATE DATABASE "${poolDatabase}"`);
await admin.unsafe(`CREATE DATABASE "${productDatabase}"`);
dropDatabases = async () => {
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS "${poolDatabase}" WITH (FORCE)`);
		// A failed stack keeps its product database for diagnosis, and says so.
		if (failed) console.error(`[factory-services] kept product database ${productDatabase} for diagnosis`);
		else await admin.unsafe(`DROP DATABASE IF EXISTS "${productDatabase}" WITH (FORCE)`);
	} finally {
		await admin.close();
	}
};
const databaseUrl = (name: string) => { const url = new URL(POSTGRES_URL); url.pathname = `/${name}`; return url; };
const poolUrl = databaseUrl(poolDatabase);
const productUrl = databaseUrl(productDatabase);
const poolCredentials = await writePrivate("pool-database.json", JSON.stringify({ databaseUrl: poolUrl.toString() }));

// ── Installation key material, as a provisioner writes it ─────────────
const { InstallationDataKey, StaticMasterKeyProvider } = await import(join(REPO, "src/factory/encryption.ts"));
const masterKeyId = "master-1";
const masterKey = await writePrivate("master.key", randomBytes(32));
type Wrap = { installationId: string; wrapVersion: number; masterKeyId: string; wrappedDataKey: Uint8Array };
const wraps: Wrap[] = [];
await InstallationDataKey.loadOrCreate(INSTALLATION, {
	async load() { return wraps.map(wrap => ({ ...wrap, wrappedDataKey: Uint8Array.from(wrap.wrappedDataKey) })); },
	async save(wrap: Wrap) { wraps.push({ ...wrap }); },
}, new StaticMasterKeyProvider({ id: masterKeyId, bytes: new Uint8Array(await readFile(masterKey)) }));
const wrappedKeys = await writePrivate("wraps.json", JSON.stringify({
	schemaVersion: "factory.key-wraps.v1", installationId: INSTALLATION,
	wraps: wraps.map(wrap => ({ ...wrap, wrappedDataKey: Buffer.from(wrap.wrappedDataKey).toString("base64") })),
}));

// ── The guest package, built before the supervisor leases its store ───
const guest = await buildFactoryGuest(REPO, join(root, "runner"), "factory-services-guest-supervisor-store");

// ── Pool admission ────────────────────────────────────────────────────
const poolPort = freePort();
const poolConfig = await writePrivate("pool.json", JSON.stringify({
	schemaVersion: "factory.pool-process.v1", installationId: INSTALLATION, poolId: POOL, hostname: "127.0.0.1", port: poolPort,
	database: { credentialsPath: poolCredentials, expectedDatabase: poolDatabase, expectedRole: decodeURIComponent(poolUrl.username) },
	tls: serverTls,
	tokens: { issuer: "factory-services", audience: "factory-pool", publicKeyPaths: { stack: tokenPublicKey } },
	// Keyed by the client certificate's common name, which the pool looks up.
	identities: {
		tenants: { "tenant-a": { tenantId: TENANT, tokenSubject: TENANT } },
		supervisors: { [SUPERVISOR]: { supervisorId: SUPERVISOR, tokenSubject: SUPERVISOR, hostIds: [HOST] } },
	},
	resources: { capacities: { cpu: 4 }, gpuHosts: [], hosts: [HOST] },
	readinessFilePath: join(readiness, "pool.json"), readinessHeartbeatMs: 2_000,
}));
processes.start("pool", BUN, [join(REPO, "src/factory/pool/process.ts"), poolConfig], { cwd: REPO });

// ── Host supervisor ───────────────────────────────────────────────────
const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const hostKeyPath = await writePrivate("host.key", hostKey.export({ type: "pkcs8", format: "pem" }) as string);
const hostKeyIdPath = await writePrivate("host.kid", "host-key-1");
const hostPublicKey = await writePrivate("host.pub", createPublicKey(hostKey).export({ type: "spki", format: "pem" }) as string);
const hostServicePort = freePort();
const supervisorConfig = await writePrivate("supervisor.json", JSON.stringify({
	schemaVersion: "factory.supervisor-process.v1", installationId: INSTALLATION, hostId: HOST,
	hostKeyPath, hostKeyId: "host-key-1", runnerRoot: join(root, "runner"),
	readinessFilePath: join(readiness, "supervisor.json"), readinessHeartbeatMs: 2_000,
	services: {
		hostname: "127.0.0.1", port: hostServicePort, allowedPeers: ["tenant-a"], hostKeyIdPath, tls: serverTls,
		pool: { baseUrl: `https://127.0.0.1:${poolPort}`, serviceTokenPath: supervisorToken, tls: supervisorTls },
	},
}));
processes.start("supervisor", BUN, [join(REPO, "src/factory/runner/supervisor-process.ts"), supervisorConfig], { cwd: REPO });

// ── Temporal, behind a TLS terminator ─────────────────────────────────
const temporalPort = freePort();
const temporalTlsPort = freePort();
// The dev server, not the Java test server: only it reports the task-queue
// pollers the orchestrator's readiness requires.
processes.start("temporal", TEMPORAL, ["server", "start-dev", "--ip", "127.0.0.1", "--port", String(temporalPort), "--http-port", String(freePort()), "--ui-port", String(freePort()), "--namespace", NAMESPACE, "--headless", "--db-filename", join(root, "temporal.sqlite")], { cwd: root });
if (!await waitFor(async () => await reachable(temporalPort) || null, 120, 1_000)) await fail("the Temporal dev server did not listen");
processes.start("temporal-tls", "node", [join(HERE, "tls-terminator.mjs"), String(temporalTlsPort), String(temporalPort), secrets], { cwd: root });
if (!await waitFor(async () => await reachable(temporalTlsPort) || null, 60, 500)) await fail("the Temporal TLS terminator did not listen");

// ── A gateway peer, so the gateway probe reaches a real TLS listener ──
const gatewayPort = freePort();
const { startFactoryPrivateHttps } = await import(join(REPO, "src/factory/private-https.ts"));
startFactoryPrivateHttps({
	tls: { key: await readFile(secret("server.key"), "utf8"), cert: await readFile(secret("server.pem"), "utf8"), ca: await readFile(secret("ca.pem"), "utf8") },
	hostname: "127.0.0.1",
	port: gatewayPort,
	async handle() { return { status: 200, body: Buffer.from(JSON.stringify({ schemaVersion: "factory.execution-gateway.v1" })), contentType: "application/json" as const }; },
});

// ── The factory startup document ──────────────────────────────────────
const privateServicePort = freePort();
const releaseAdapter = { package: guest.reference.package, manifestName: guest.reference.manifestName, version: guest.reference.version, digest: `sha256:${"d".repeat(64)}`, export: "publish" };
await writePrivate("factory-startup.json", JSON.stringify({
	schemaVersion: "factory.startup.v1", installationId: INSTALLATION, tenantId: TENANT, poolId: POOL, hostId: HOST, temporalNamespace: NAMESPACE,
	orphanSweepIntervalMs: 30_000,
	orchestrationReadinessFilePath: join(readiness, "orchestration.json"),
	poolReadinessFilePath: join(readiness, "pool.json"),
	supervisorReadinessFilePath: join(readiness, "supervisor.json"),
	readinessHeartbeatMs: 5_000,
	// The product and the orchestrator each wait for the other.
	readinessRetry: { delayMs: 2_000, windowMs: 240_000 },
	gateway: { hostname: "127.0.0.1", port: gatewayPort, tls: clientTls },
	privateService: {
		hostname: "127.0.0.1", port: privateServicePort, certificateIdentity: "tenant-a", tls: serverTls,
		tokens: { issuer: "factory-services", audience: "factory-pool", publicKeyPaths: { stack: tokenPublicKey } },
	},
	pool: { baseUrl: `https://127.0.0.1:${poolPort}`, serviceTokenPath: tenantToken, tls: clientTls },
	hostLaunch: { baseUrl: `https://127.0.0.1:${hostServicePort}`, serverName: "localhost", attemptTokenSecretPath: attemptTokenSecret, tls: { ...clientTls, serviceTokenPath: tenantToken } },
	hostStopKeys: [{ hostId: HOST, hostKeyId: "host-key-1", publicKeyPath: hostPublicKey }],
	runnerProfiles: {
		brokerAudience: "factory-gateway",
		profiles: [{
			runner: guest.reference, resourceClass: "cpu", allowedCapabilities: [],
			allocation: { resources: { cpu: 1 }, memoryBytes: 1_073_741_824, budget: { costMicros: "1000000", tokens: 1_000, computeMs: 600_000 } },
		}],
	},
	storage: {
		ordinary: { endpoint: `http://127.0.0.1:${STORE_PORTS.ordinary}`, bucket: TENANT, prefix: "ordinary", credentialSet: "ordinary", credentialsPath: secret("ordinary-storage.json") },
		archive: { endpoint: `http://127.0.0.1:${STORE_PORTS.archive}`, bucket: TENANT, prefix: "archive", credentialSet: "archive", credentialsPath: secret("archive-storage.json") },
	},
	keys: { masterKeyFilePath: masterKey, masterKeyId, wrappedKeyFilePath: wrappedKeys, grantableRoots: [join(root, "project")] },
	// Declaring a destination and profile is what runs the release-outcome role.
	release: {
		destinations: [{ name: "ordinary", kind: "s3", endpoint: `http://127.0.0.1:${STORE_PORTS.ordinary}`, bucket: TENANT, account: TENANT, prefix: `ordinary/factory-services-release/${suffix}`, credentialsPath: secret("ordinary-storage.json") }],
		profiles: [{ adapter: releaseAdapter, action: "factory.release.publish", destination: "ordinary", estimatedSpendMicros: 1_000 }],
	},
	workers: { idleDelayMs: 200, batch: 4 },
}));

// ── Orchestrator configuration ────────────────────────────────────────
const temporalApiKey = await writePrivate("temporal-api.key", randomBytes(16).toString("hex"));
const orchestratorConfig = await writePrivate("orchestrator.json", JSON.stringify({
	schemaVersion: "factory.orchestrator-process.v1", installationId: INSTALLATION, tenantId: TENANT,
	temporal: { address: `127.0.0.1:${temporalTlsPort}`, namespace: NAMESPACE, serverName: "localhost", ...clientTls, apiKeyPath: temporalApiKey },
	gateway: { baseUrl: `https://127.0.0.1:${privateServicePort}`, serverName: "localhost", tls: { ...clientTls, serviceTokenPath: orchestratorToken } },
	codec: { wrappedKeyFilePath: wrappedKeys, masterKeyFilePath: masterKey, masterKeyId, grantableRoots: [join(root, "project")] },
	readinessFilePath: join(readiness, "orchestration.json"), readinessHeartbeatMs: 5_000,
}));

const hostReady = await waitFor(async () => {
	const published = await Promise.all(["pool.json", "supervisor.json"].map(name => readFile(join(readiness, name), "utf8").catch(() => "")));
	return published.every(value => value.includes('"ready"')) || null;
}, 90, 1_000);
if (!hostReady) await fail("the pool or the supervisor did not publish ready");

// ── The built web server ──────────────────────────────────────────────
const baseURL = `http://127.0.0.1:${WEB_PORT}`;
const web = processes.start("web", BUN, ["build/index.js"], {
	cwd: WEB,
	env: {
		PORT: String(WEB_PORT), HOST: "127.0.0.1", ORIGIN: baseURL,
		EZCORP_FACTORY_ENABLED: "1", EZCORP_INSTALLATION_ID: INSTALLATION,
		// The installation declares the interpreter its reference lock pins.
		EZCORP_FACTORY_INTERPRETER_COMPATIBILITY: "factory-kernel.v1",
		EZCORP_PERM_SWEEP_INTERVAL_MS: "30000",
		EZCORP_SECRETS_DIR: secrets, EZCORP_PROJECT_ROOT: join(root, "project"),
		DATABASE_URL: productUrl.toString(),
		EZCORP_JWT_SECRET: randomBytes(24).toString("hex"), EZCORP_ENCRYPTION_SECRET: randomBytes(24).toString("hex"),
		EZCORP_FACTORY_STORAGE_SECRETS_DIR: STORAGE_SECRETS,
	},
});

// The orchestrator's readiness probes the private service, so it starts once
// that accepts, under the restart loop a deployment gives a daemon.
if (!await waitFor(async () => await reachable(privateServicePort) || null, 240, 1_000)) await fail("the product never bound its private service");
void (async () => {
	while (!stopping) {
		const orchestrator = processes.start(`orchestrator-${processes.children.length}`, "node", [join(REPO, "src/factory/orchestration-process.ts"), orchestratorConfig], { cwd: REPO });
		await new Promise(settle => orchestrator.child.once("exit", settle));
		if (!stopping) await sleep(2_000);
	}
})();

const ready = await waitFor(async () => {
	const response = await fetch(`${baseURL}/api/ready`).catch(() => null);
	return response?.status === 200 || null;
}, 360, 1_000);
if (!ready) await fail(`the application never reported ready:\n${web.log.join("").slice(-3_000)}`);

// ── The administrator, two projects, and the guest's v4 installation ──
const call = httpSession(baseURL);
const adminCredentials = { name: "Factory Services Admin", email: "factory-services-admin@example.invalid", password: randomBytes(18).toString("base64url") };
const setup = await call("POST", "/api/auth/setup", adminCredentials);
const owned = await call("POST", "/api/projects", { name: "Factory console journeys", path: join(root, "project") });
const reader = await call("POST", "/api/projects", { name: "Shared artifact reader", path: join(root, "project", "reader") });
const me = await call("GET", "/api/auth/me");
const idOf = (body: unknown) => {
	const value = body as { id?: string; project?: { id?: string }; user?: { id?: string } } | null;
	return value?.id ?? value?.project?.id ?? value?.user?.id;
};
const [projectId, readerProjectId, adminId] = await (async (): Promise<[string, string, string]> => {
	const ids = [idOf(owned.body), idOf(reader.body), idOf(me.body)];
	if (ids.every(id => typeof id === "string")) return ids as [string, string, string];
	return fail(`setup did not yield an administrator and two projects: ${JSON.stringify({ setup: setup.status, owned: owned.status, reader: reader.status, me: me.status })}`);
})();

const { drizzle } = await import(join(REPO, "node_modules/drizzle-orm/bun-sql/index.js"));
const productSql = new SQL(productUrl.toString(), { max: 2 });
const productDb = drizzle(productSql, { schema: await import(join(REPO, "src/db/schema.ts")) });
const { DatabaseLifecycleRepository } = await import(join(REPO, "src/db/queries/extension-releases.ts"));
const repository = new DatabaseLifecycleRepository(productDb);
const release = guest.release as { id: string; installationId: string };
await repository.create({
	installation: { id: release.installationId, ownerId: adminId, scope: `project:${projectId}`, generation: 1, activeReleaseId: release.id, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 },
	workspaces: {}, revisions: {}, operations: {}, releases: { [release.id]: guest.release }, approvals: {},
});

const consoleFactoryId = "factory-services.console.v1";
const definitionPath = join(root, "console-definition.json");
await writeFile(definitionPath, JSON.stringify({
	schemaVersion: "factory.v1", id: consoleFactoryId, version: "1.0.0", interpreterCompatibility: "factory-kernel.v1",
	inputPorts: { message: { type: "string" } }, outputPorts: {},
	graph: {
		nodes: [{
			id: "work", kind: "task", runner: guest.reference,
			inputPorts: { message: { type: "string" } },
			bindings: { message: { kind: "ref", root: "input", name: "message" } },
			retry: { maxAttempts: 1, initialDelayMs: 1_000, maximumDelayMs: 2_000 },
			resources: { resourceClass: "cpu" },
		}],
		outputs: {},
	},
	acceptance: { id: "factory-services.contract", version: "1", claims: [{ id: "claim", validator: guest.reference, required: true, protected: true }] },
	packages: [{ name: guest.reference.package, version: guest.reference.version, digest: guest.reference.digest }],
	capabilities: [], effects: ["none"],
	bounds: { maxExpandedNodes: 10, maxScopeDepth: 16, runDeadlineMs: 600_000 },
}, null, 2), { mode: 0o600 });

const state: { -readonly [K in keyof FactoryServicesState]: FactoryServicesState[K] } = {
	baseURL, admin: adminCredentials, adminId, tenantId: TENANT, installationId: INSTALLATION,
	projectId, readerProjectId, consoleFactoryId, definitionPath,
	guest: { reference: guest.reference, installationId: release.installationId, releaseId: release.id },
	prepared: false,
};
await writeFile(FACTORY_SERVICES_STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
await rm(STOP_FILE, { force: true });
console.log(`[factory-services] held at ${baseURL}; logs in ${logs}`);

// ── Hold, and prepare the package once the console has trusted it ─────
const { FileBlobStore } = await import(join(REPO, "src/extensions/v4/blobs.ts"));
const { FactoryGrants } = await import(join(REPO, "src/factory/grants.ts"));
const { FactoryPackagePreparations, FactoryPackageTrusts, FactoryV4PackageCatalog } = await import(join(REPO, "src/factory/package-preparation.ts"));
const { PodmanRunner, buildLimits } = await import(join(REPO, "packages/@ezcorp/extension-runner/src/index.ts"));
const { provisionToolchain } = await import(join(REPO, "packages/@ezcorp/extension-runner/src/provision.ts"));
const heldUntil = Date.now() + HOLD_MS;
while (!stopping && Date.now() < heldUntil && !await Bun.file(STOP_FILE).exists()) {
	if (!state.prepared) {
		const trust = await productSql.unsafe(
			`SELECT r.state FROM factory_runner_package_trust_current c JOIN factory_runner_package_trust_revisions r ON r.tenant_id = c.tenant_id AND r.project_id = c.project_id AND r.reference_digest = c.reference_digest AND r.revision = c.revision WHERE c.tenant_id = $1 AND c.project_id = $2 AND c.package_digest = $3`,
			[TENANT, projectId, guest.reference.digest],
		) as Array<{ state: string }>;
		if (trust[0]?.state === "active") {
			const runner = new PodmanRunner({ root: join(root, "prepare"), ...await provisionToolchain({ sdkEntrypoint: process.env.EZ_RUNNER_SDK_ENTRY }) });
			try {
				const grants = new FactoryGrants(productDb, TENANT);
				const trusts = new FactoryPackageTrusts(productDb, TENANT, grants);
				await new FactoryPackagePreparations(productDb, TENANT, grants, trusts,
					new FactoryV4PackageCatalog(repository, new FileBlobStore(join(root, "runner", "release-blobs"))), runner, buildLimits,
				).prepare(projectId, guest.reference);
				state.prepared = true;
				await writeFile(FACTORY_SERVICES_STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
				console.log("[factory-services] package prepared");
			} catch (error) {
				console.error("[factory-services] preparation failed; retrying:", error);
			} finally {
				await runner.close();
			}
		}
	}
	await sleep(2_000);
}
await productSql.close();
await stop(stopping ? "signal" : "hold ended");
process.exit(0);
