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
 *     services, and `services.guestBroker`, the route it carries a guest's
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
import { collectSecretValues, openProcessLog, preserveStackDiagnostics, redactStreamedLogs, type PassDiagnostics, type ProcessLog } from "./diagnostics";
import { GUEST_BROKER_AUDIENCE, GUEST_BROKER_ISSUER, INSTALLATION, MASTER_KEY_ID, NAMESPACE, SUPERVISOR_SUBJECT, TENANT, orchestratorDocument, poolDatabaseDocument, poolDocument, startupDocument, supervisorDocument, wrapsDocument, type StackLayout } from "./stack-documents";

export { HOST_ID, INSTALLATION, TENANT } from "./stack-documents";
/** How often the streamed logs are redacted while a pass runs. */
const REDACT_INTERVAL_MS = 2_000;
const TEMPORAL_CLI = process.env.W19A_TEMPORAL_CLI ?? "/tmp/factory-tools/temporal-cli/temporal";

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
  /** Where each process's output streams as it arrives, and where a failed pass's stack files are kept. */
  readonly diagnostics: PassDiagnostics;
}

interface Child { readonly name: string; child: ReturnType<typeof spawn>; log: string[]; readonly file: ProcessLog; readonly closed: Promise<void> }

export interface Stack {
  readonly root: string;
  readonly port: number;
  readonly productUrl: string;
  readonly productDatabase: string;
  readonly runnerRoot: string;
  readonly session: ReturnType<typeof session>;
  readonly children: readonly Child[];
  /**
   * Stop every child, redact and close the streamed logs, and drop the
   * databases (the product one only if `keepProduct` is false). With
   * `keepDiagnostics`, the stack's readiness files and logs are copied out
   * first; it defaults to `keepProduct`, so a failed pass keeps both.
   */
  stop(keepProduct: boolean, keepDiagnostics?: boolean): Promise<void>;
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
    // Streamed to the pass's output directory as it arrives, so a pass that
    // dies or deletes its stack still leaves every process's own words.
    const file = openProcessLog(options.diagnostics, name, command, args, child.pid);
    const take = (bytes: Buffer) => { log.push(String(bytes)); file.write(bytes); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const closed = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => { void file.close({ code, signal }).then(resolve, resolve); });
      child.once("error", () => { void file.close({ code: null, signal: "spawn-error" }).then(resolve, resolve); });
    });
    const entry = { name, child, log, file, closed };
    children.push(entry);
    return entry;
  };

  const root = await mkdtemp(join(process.env.HOME!, ".w19a-stack-"));
  await chmod(root, 0o700);
  for (const directory of ["secrets", "project", "readiness"]) await mkdir(join(root, directory), { mode: 0o700 });
  const secrets = join(root, "secrets");
  const directories = [root];
  const created: string[] = [];
  // Secrets that live only in a process environment, never in a file: the
  // redaction and the copy scan must know them too.
  const webSecrets = { jwt: `w19a-jwt-${randomBytes(12).toString("hex")}`, encryption: `w19a-enc-${randomBytes(12).toString("hex")}` };
  const secretsInEnvironment = [webSecrets.jwt, webSecrets.encryption];
  const secretValues = () => collectSecretValues(secrets, [...secretsInEnvironment, process.env.FACTORY_TEST_POSTGRES_URL ?? ""]);
  // Redaction runs while the pass runs, not only at its end, so a harness that
  // dies leaves at most one interval of output unredacted.
  const redactions: Record<string, number> = {};
  const redact = (values: readonly string[]) => {
    for (const [path, count] of Object.entries(redactStreamedLogs(children.map((entry) => entry.file.path), values))) redactions[path] = (redactions[path] ?? 0) + count;
  };
  const redactTimer = setInterval(() => { void secretValues().then(redact, () => undefined); }, REDACT_INTERVAL_MS);
  redactTimer.unref();
  let admin: SQL | undefined;
  let productDatabase = "";
  let web: Child | undefined;
  let stopped = false;
  /** Takes down everything this stack made, whatever point it reached. */
  const stop = async (keepProduct: boolean, keepDiagnostics = keepProduct) => {
    if (stopped) return;
    stopped = true;
    clearInterval(redactTimer);
    if (web !== undefined) {
      stopGroup(web.child.pid, "SIGTERM");
      await Promise.race([new Promise((settle) => web!.child.once("exit", settle)), sleep(30_000)]);
    }
    for (const entry of children) stopGroup(entry.child.pid, "SIGKILL");
    // Every exit line on disk before anything is scanned or copied.
    await Promise.race([Promise.all(children.map((entry) => entry.closed)), sleep(10_000)]);
    await Promise.all(children.map((entry) => entry.file.close({ code: null, signal: "harness-stopped" })));
    try {
      const values = await secretValues();
      redact(values);
      record.diagnostics = {
        processLogs: children.map((entry) => entry.file.path),
        redactions,
        ...(keepDiagnostics ? { stack: await preserveStackDiagnostics(root, options.diagnostics, values) } : {}),
      };
    } catch (error) {
      record.diagnostics = { error: String(error) };
    }
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
  await privateWrite(join(secrets, "guest-broker-host.token"), rs256(brokerKeys.privateKey, "w19a", { sub: SUPERVISOR_SUBJECT, iss: GUEST_BROKER_ISSUER, aud: GUEST_BROKER_AUDIENCE, exp: Math.floor(Date.now() / 1_000) + 7_200, scope: ["factory:guest-broker"] }));
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
  await privateWrite(join(secrets, "pool-database.json"), JSON.stringify(poolDatabaseDocument(poolUrl.toString())));
  record.databases = { pool: poolDatabase, product: productDatabase };

  // ── The installation's key material, wrapped by the operator master key ──
  const { InstallationDataKey, StaticMasterKeyProvider } = await import(join(repo, "src/factory/encryption.ts"));
  const masterKeyPath = join(secrets, "master.key");
  const masterKeyId = MASTER_KEY_ID;
  await privateWrite(masterKeyPath, randomBytes(32));
  const heldWraps: Array<{ installationId: string; wrapVersion: number; masterKeyId: string; wrappedDataKey: Uint8Array }> = [];
  await InstallationDataKey.loadOrCreate(INSTALLATION, {
    async load() { return heldWraps.map((wrap) => ({ ...wrap, wrappedDataKey: Uint8Array.from(wrap.wrappedDataKey) })); },
    async save(wrap: (typeof heldWraps)[number]) { heldWraps.push({ ...wrap }); },
  } as never, new StaticMasterKeyProvider({ id: masterKeyId, bytes: new Uint8Array(await readFile(masterKeyPath)) }));
  const wrappedKeyPath = join(secrets, "wraps.json");
  await privateWrite(wrappedKeyPath, JSON.stringify(wrapsDocument(heldWraps)));

  // ── The guest, built into the store the supervisor will launch from ──
  const runnerRoot = join(root, "runner");
  const guestBuild = await options.buildGuest(runnerRoot);
  record.guestBuild = guestBuild;

  // Every port and path a document names, fixed before the first document is written.
  const layout: StackLayout = {
    root, poolDatabase, poolUrl: poolUrl.toString(),
    ports: { pool: freePort(), hostService: freePort(), guestBroker: freePort(), temporalTls: freePort(), temporalHttp: freePort(), gateway: freePort(), privateService: freePort() },
    runnerProfiles: options.runnerProfiles(guestBuild),
    ...(options.modelProvider === undefined ? {} : { modelProvider: options.modelProvider }),
  };
  const { temporalTls: temporalTlsPort, temporalHttp: temporalHttpPort, gateway: gatewayPort, privateService: privateServicePort, guestBroker: guestBrokerPort } = layout.ports;

  // ── Pool admission process ──
  await privateWrite(join(secrets, "pool.json"), JSON.stringify(poolDocument(layout)));
  start("pool", bun, [join(repo, "src/factory/pool/process.ts"), join(secrets, "pool.json")]);

  // ── Host supervisor, carrying guest frames back over services.guestBroker ──
  const { privateKey: hostKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await privateWrite(join(secrets, "host.key"), hostKey.export({ type: "pkcs8", format: "pem" }).toString());
  await privateWrite(join(secrets, "host.kid"), "host-key-1");
  await privateWrite(join(secrets, "host.pub"), createPublicKey(hostKey).export({ type: "spki", format: "pem" }).toString());
  await privateWrite(join(secrets, "supervisor.json"), JSON.stringify(supervisorDocument(layout)));
  start("supervisor", bun, [join(repo, "src/factory/runner/supervisor-process.ts"), join(secrets, "supervisor.json")]);

  // ── Temporal behind a mutual-TLS terminator ──
  const temporalPort = freePort();
  start("temporal", TEMPORAL_CLI, ["server", "start-dev", "--ip", "127.0.0.1", "--port", String(temporalPort), "--http-port", String(temporalHttpPort), "--namespace", NAMESPACE, "--headless", "--db-filename", join(root, "temporal.sqlite")]);
  for (let attempt = 0; attempt < 90 && !await reachable(temporalPort); attempt++) await sleep(1_000);
  start("temporal-tls", "node", [join(here, "tls-terminator.mjs"), String(temporalTlsPort), String(temporalPort), secrets]);
  for (let attempt = 0; attempt < 30 && !await reachable(temporalTlsPort); attempt++) await sleep(500);

  // ── The product's startup document ──
  const startup = startupDocument(layout);
  await privateWrite(join(secrets, "factory-startup.json"), JSON.stringify(startup));
  record.startupDocument = { runnerProfiles: startup.runnerProfiles, modelProvider: options.modelProvider ?? null, guestBroker: { port: guestBrokerPort, hosts: startup.guestBroker.hosts } };

  // ── The Node orchestrator's configuration ──
  await privateWrite(join(secrets, "temporal-api.key"), "w19a-proof-temporal-api-key");
  await privateWrite(join(secrets, "orchestrator.json"), JSON.stringify(orchestratorDocument(layout)));

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
      EZCORP_JWT_SECRET: webSecrets.jwt,
      EZCORP_ENCRYPTION_SECRET: webSecrets.encryption,
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

  return { root, port, productUrl: productUrl.toString(), productDatabase, runnerRoot, session: api, children, stop };
  } catch (error) {
    // Nothing a failed start made may outlive it: not a child, not a
    // database on the shared server, not a private directory.
    // A start that failed is a failed pass: its diagnostics are kept.
    await stop(false, true);
    throw error;
  }
}

/** The supervisor's lease children: one runner held for life means exactly one `flock`. */
export function leaseChildren(pid: number): number {
  try { return execFileSync("pgrep", ["-P", String(pid), "-x", "flock"], { encoding: "utf8" }).split("\n").filter((value) => value.trim()).length; }
  catch { return 0; }
}
