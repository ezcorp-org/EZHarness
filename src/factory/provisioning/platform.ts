/**
 * The fleet's operator material and shared platform services.
 *
 * Created once per fleet, before any tenant: the Temporal authority (CA,
 * server certificate, token key, control identity, JWKS, revocation list) and
 * the ingress authority (CA, rendered config). All of it lives under the
 * operator root, which no installation process ever mounts.
 *
 * One deliberate exception to "every file 0600 in a 0700 directory": the
 * Temporal SERVER directory is 0755 with 0644 files, because the Temporal,
 * JWKS, and gateway containers run as unprivileged users inside their own user
 * namespaces and must read the server certificate and key. It sits under the
 * 0700 operator root, so no other host user can reach it.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createFactoryCertificateAuthority, issueFactoryCertificate, type FactoryCommandRunner } from "./certificates";
import type { FactoryCommandExecutor, FactoryComposeCommand } from "./compose-profile";
import { ensureFactoryPrivateCertificatePair, ensureFactoryPrivateFile, factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivateText, replaceFactoryPrivateFile } from "./secret-files";
import { FactoryProvisioningError } from "./steps";
import { FACTORY_TEMPORAL_CONTROL_SUBJECT, factoryTemporalJwks, type FactoryTemporalAuthorityPaths } from "./temporal";
import type { FactoryTemporalControlIdentity } from "./temporal-client";

export interface FactoryPlatformPaths {
  readonly root: string;
  readonly temporal: FactoryTemporalAuthorityPaths & FactoryTemporalControlIdentity & { readonly serverDirectory: string; readonly revocationsDirectory: string; readonly databaseEnvPath: string; readonly httpTokensDirectory: string };
  readonly ingress: { readonly root: string; readonly caCertificatePath: string; readonly caKeyPath: string };
}

export function factoryPlatformPaths(operatorRoot: string): FactoryPlatformPaths {
  const temporal = resolve(operatorRoot, "platform", "temporal");
  const ingress = resolve(operatorRoot, "platform", "ingress");
  // The ingress CA signs every installation's hostname certificate. It lives
  // beside, never inside, the directory the ingress process mounts.
  const ingressAuthority = resolve(operatorRoot, "platform", "ingress-ca");
  return Object.freeze({
    root: resolve(operatorRoot, "platform"),
    temporal: Object.freeze({
      caCertificatePath: resolve(temporal, "ca.crt"), caKeyPath: resolve(temporal, "ca.key"),
      tokenKeyPath: resolve(temporal, "token.key"), tokenKeyId: "factory-local",
      revocationsDirectory: resolve(temporal, "revocations"), revocationsPath: resolve(temporal, "revocations", "revocations.json"),
      certificatePath: resolve(temporal, "control.crt"), privateKeyPath: resolve(temporal, "control.key"),
      serverDirectory: resolve(temporal, "server"),
      databaseEnvPath: resolve(temporal, "database.env"),
      // One `read:<namespace>` token per namespace, injected by the gateway on the read-only HTTP route.
      httpTokensDirectory: resolve(temporal, "http-tokens"),
    }),
    ingress: Object.freeze({ root: ingress, caCertificatePath: resolve(ingressAuthority, "ca.crt"), caKeyPath: resolve(ingressAuthority, "ca.key") }),
  });
}

async function ensureAuthority(directory: string, subject: string, run?: FactoryCommandRunner): Promise<void> {
  const handle = await openFactoryPrivateDirectory(directory);
  try { await ensureFactoryPrivateCertificatePair(handle, { key: "ca.key", certificate: "ca.crt" }, () => createFactoryCertificateAuthority(subject, run)); }
  finally { await handle.close(); }
}

/** Temporal and ingress authorities, created once and verified on every rerun. */
export async function ensureFactoryPlatformMaterial(operatorRoot: string, options: { readonly run?: FactoryCommandRunner } = {}): Promise<FactoryPlatformPaths> {
  const paths = factoryPlatformPaths(operatorRoot);
  const temporalDirectory = resolve(paths.temporal.caCertificatePath, "..");
  await ensureAuthority(temporalDirectory, "factory-temporal-ca", options.run);
  const temporal = await openFactoryPrivateDirectory(temporalDirectory);
  try {
    const control = { certificatePath: paths.temporal.caCertificatePath, keyPath: paths.temporal.caKeyPath };
    await ensureFactoryPrivateCertificatePair(temporal, { key: "control.key", certificate: "control.crt" }, () => issueFactoryCertificate(control, { subject: FACTORY_TEMPORAL_CONTROL_SUBJECT, usage: "client" }, options.run));
    await ensureFactoryPrivateFile(temporal, "token.key", () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    await ensureFactoryPrivateFile(temporal, "database.env", () => { const password = randomBytes(24).toString("base64url"); return `POSTGRES_PASSWORD=${password}\nPOSTGRES_PWD=${password}\n`; });
    // The server directory: readable by the platform containers (see the file header).
    await mkdir(paths.temporal.serverDirectory, { recursive: true, mode: 0o755 });
    await chmod(paths.temporal.serverDirectory, 0o755);
    const serverCertificate = resolve(paths.temporal.serverDirectory, "server.crt");
    if (!await Bun.file(serverCertificate).exists()) {
      const server = await issueFactoryCertificate(control, { subject: "temporal.local", usage: "peer", dnsNames: ["temporal.local", "localhost"], ipAddresses: ["127.0.0.1"], days: 365 }, options.run);
      await writeFile(resolve(paths.temporal.serverDirectory, "server.key"), server.privateKeyPem, { mode: 0o644 });
      await writeFile(serverCertificate, server.certificatePem, { mode: 0o644 });
    }
    await writeFile(resolve(paths.temporal.serverDirectory, "ca.crt"), await readFactoryPrivateText(temporal, "ca.crt"), { mode: 0o644 });
    await writeFile(resolve(paths.temporal.serverDirectory, "jwks.json"), `${JSON.stringify(factoryTemporalJwks(await readFactoryPrivateText(temporal, "token.key"), paths.temporal.tokenKeyId))}\n`, { mode: 0o644 });
    for (const name of ["server.key", "server.crt", "ca.crt", "jwks.json"]) await chmod(resolve(paths.temporal.serverDirectory, name), 0o644);
  } finally { await temporal.close(); }
  const revocations = await openFactoryPrivateDirectory(paths.temporal.revocationsDirectory);
  try { await ensureFactoryPrivateFile(revocations, "revocations.json", () => `${JSON.stringify({ schemaVersion: "factory.temporal-revocations.v1", subjects: [], certificateHashes: [], tokenIds: [] })}\n`); }
  finally { await revocations.close(); }
  await (await openFactoryPrivateDirectory(paths.temporal.httpTokensDirectory)).close();
  await ensureAuthority(resolve(paths.ingress.caCertificatePath, ".."), "factory-ingress-ca", options.run);
  for (const name of ["routes", "certs", "conf"]) await (await openFactoryPrivateDirectory(resolve(paths.ingress.root, name))).close();
  return paths;
}

export interface FactoryPlatformSettings {
  readonly fleetId: string;
  readonly operatorRoot: string;
  readonly repositoryRoot: string;
  readonly temporalPort: number;
  /** Host port of the gateway's read-only Temporal HTTP route. */
  readonly temporalHttpPort: number;
  readonly ingressAddress: string;
  readonly ingressPort: number;
}

export function factoryPlatformProject(fleetId: string): string { return `ezcorp-factory-${fleetId}-platform`; }

/** The nginx main config: nothing but the rendered routes, on loopback, as an unprivileged listener. */
export function factoryIngressMainConfig(): string {
  return [
    "worker_processes 2;",
    "pid /tmp/nginx.pid;",
    "error_log /dev/stderr warn;",
    "events { worker_connections 1024; }",
    "http {",
    "  access_log /dev/stdout;",
    "  client_body_temp_path /tmp/client-body;",
    "  proxy_temp_path /tmp/proxy;",
    "  fastcgi_temp_path /tmp/fastcgi;",
    "  uwsgi_temp_path /tmp/uwsgi;",
    "  scgi_temp_path /tmp/scgi;",
    "  server_tokens off;",
    "  ssl_protocols TLSv1.2 TLSv1.3;",
    "  include /etc/ezcorp-ingress/conf/*.conf;",
    "}",
    "",
  ].join("\n");
}

export function factoryPlatformEnvironment(settings: FactoryPlatformSettings, paths: FactoryPlatformPaths): Readonly<Record<string, string>> {
  return Object.freeze({
    EZCORP_FACTORY_PLATFORM_PROJECT: factoryPlatformProject(settings.fleetId),
    EZCORP_FACTORY_TEMPORAL_DB_ENV: paths.temporal.databaseEnvPath,
    EZCORP_FACTORY_TEMPORAL_SERVER_DIR: paths.temporal.serverDirectory,
    EZCORP_FACTORY_TEMPORAL_REVOCATIONS_DIR: paths.temporal.revocationsDirectory,
    EZCORP_FACTORY_TEMPORAL_HTTP_TOKENS: paths.temporal.httpTokensDirectory,
    EZCORP_FACTORY_TEMPORAL_HTTP_PORT: String(settings.temporalHttpPort),
    EZCORP_FACTORY_AUTHORIZER_SCRIPTS: resolve(settings.repositoryRoot, "scripts"),
    EZCORP_FACTORY_TEMPORAL_GATEWAY_CONFIG: resolve(settings.repositoryRoot, "config/factory-temporal-gateway.yaml"),
    EZCORP_FACTORY_TEMPORAL_PORT: String(settings.temporalPort),
    EZCORP_FACTORY_INGRESS_DIR: paths.ingress.root,
  });
}

/** Render the platform's env file and bring its services up. Idempotent. */
/**
 * Start the platform and, when `serves` is given, return only once it serves
 * end to end (`waitForFactoryPlatform`), so the first provisioning step does
 * not race the Temporal server's schema setup.
 */
export async function startFactoryPlatform(settings: FactoryPlatformSettings, paths: FactoryPlatformPaths, compose: FactoryComposeCommand, execute: FactoryCommandExecutor, serves?: () => Promise<boolean>, wait?: Parameters<typeof waitForFactoryPlatform>[1]): Promise<void> {
  await replaceFactoryPrivateFile(factoryPrivatePath(paths.ingress.root, "nginx.conf"), factoryIngressMainConfig());
  const conf = await openFactoryPrivateDirectory(resolve(paths.ingress.root, "conf"));
  try { await ensureFactoryPrivateFile(conf, "ezcorp-factory.conf", () => `server {\n  listen ${settings.ingressAddress}:${settings.ingressPort} ssl default_server;\n  ssl_reject_handshake on;\n}\n`); }
  finally { await conf.close(); }
  const env = factoryPlatformEnvironment(settings, paths);
  const envPath = factoryPrivatePath(paths.root, "platform.env");
  await replaceFactoryPrivateFile(envPath, `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  const result = await execute([...compose.argv, "--project-name", factoryPlatformProject(settings.fleetId), "--file", resolve(settings.repositoryRoot, "deploy/factory/compose/platform.yml"), "--env-file", envPath, "up", "--detach", "--remove-orphans"], { env: compose.env });
  if (result.code !== 0) throw new FactoryProvisioningError("platform_compose_failed", `platform compose up failed: ${result.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
  if (serves) await waitForFactoryPlatform(serves, wait);
}

/** The running ingress reloads onto the rendered config; a bad config is refused by `nginx -t` first. */
export function factoryPodmanIngressReloader(fleetId: string, execute: FactoryCommandExecutor, engine = "podman"): { reload(): Promise<void> } {
  const container = `${factoryPlatformProject(fleetId)}-ingress-1`;
  return {
    async reload() {
      const test = await execute([engine, "exec", container, "nginx", "-t", "-c", "/etc/ezcorp-ingress/nginx.conf"]);
      if (test.code !== 0) throw new FactoryProvisioningError("ingress_config_invalid", `The rendered ingress config was refused: ${test.stderr.trim().split("\n").slice(-2).join(" | ")}`);
      const reload = await execute([engine, "exec", container, "nginx", "-s", "reload", "-c", "/etc/ezcorp-ingress/nginx.conf"]);
      if (reload.code !== 0) throw new FactoryProvisioningError("ingress_reload_failed", `The ingress did not reload: ${reload.stderr.trim()}`);
    },
  };
}

/**
 * Wait until the platform serves, not merely listens: the gateway opens its
 * port before the Temporal server behind it has created its schema. `serves`
 * answers true once a request succeeds end to end. Any failure until the
 * deadline is a "not yet"; the deadline itself is a named failure.
 */
export async function waitForFactoryPlatform(serves: () => Promise<boolean>, options: { readonly attempts?: number; readonly intervalMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {}): Promise<number> {
  const attempts = options.attempts ?? 150, intervalMs = options.intervalMs ?? 2_000, sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  let last = "no answer";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { if (await serves()) return attempt; last = "not serving"; }
    catch (error) { last = error instanceof Error ? error.message : String(error); }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new FactoryProvisioningError("platform_not_ready", `The platform did not serve within ${attempts} attempts: ${last.slice(0, 200)}`);
}
