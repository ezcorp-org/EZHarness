/**
 * C12 step 6: the trusted hostname ingress, bound to the installation ID.
 *
 * The ingress is the one component that maps a hostname to an installation,
 * and the installation checks the mapping rather than trusting it (C01): the
 * ingress sets `X-EZCorp-Installation` and the per-installation
 * `X-EZCorp-Ingress-Proof` on every request it forwards, overwriting anything
 * a client sent, and the harness refuses a request whose host, installation
 * header, or proof is not its own (`ingress-identity.ts`).
 *
 * A route has two states, and only the provisioner moves it between them:
 *
 *   - `held`: the hostname is bound and answers 503. Every installation's route
 *     starts here, and one returns here the moment teardown begins, so a
 *     partial or departing tenant serves no traffic.
 *   - `serving`: forwarded to the harness. Set only after the invitation step
 *     completes.
 *
 * A request whose TLS server name differs from its Host header is refused with
 * 421, so one hostname's certificate cannot front another installation.
 */
import { randomBytes, X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { readdir } from "node:fs/promises";
import { issueFactoryCertificate, type FactoryCommandRunner } from "./certificates";
import { factoryDeliveryDirectory, type FactoryInstallationContext, type FactoryProvisioningDriver, type FactoryStepResources } from "./installation";
import { ensureFactoryPrivateCertificatePair, ensureFactoryPrivateFile, factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivateJson, readFactoryPrivatePath, readFactoryPrivateText, removeFactoryPrivateFile, replaceFactoryPrivateFile } from "./secret-files";
import { FactoryProvisioningError } from "./steps";
import { factoryCertificateHash } from "./temporal";

export type FactoryIngressRouteState = "held" | "serving";

/**
 * The per-installation secret the ingress adds to every forwarded request and
 * the harness requires. The installation ID alone is not secret, so without
 * this a local process that reached a harness's loopback port could forge the
 * ingress's headers; with it, only the ingress can.
 */
export const FACTORY_INGRESS_PROOF_FILE = "ingress-proof";
const PROOF = /^[a-f0-9]{64}$/;

export interface FactoryIngressRoute {
  readonly schemaVersion: "factory.ingress-route.v1";
  readonly tenantId: string;
  readonly hostname: string;
  readonly installationId: string;
  readonly upstreamPort: number;
  readonly state: FactoryIngressRouteState;
  /** The installation's ingress proof. Kept in the operator's private route file, never in the ledger. */
  readonly proof: string;
}

export interface FactoryIngressPaths {
  /** Operator directory holding the ingress CA, host certificates, routes, and rendered config. */
  readonly root: string;
  /** Where the ingress process sees `root`. */
  readonly mountedRoot: string;
  readonly listenAddress: string;
  readonly listenPort: number;
}

/** Reloads the running ingress onto the rendered config. */
export interface FactoryIngressReloader { reload(): Promise<void> }

export interface FactoryIngressProbeResult { readonly status: number; readonly route?: string; readonly body?: string }
export interface FactoryIngressProbe { request(hostname: string, path: string, options?: { readonly host?: string }): Promise<FactoryIngressProbeResult> }

export interface FactoryIngressStepOptions {
  readonly paths: FactoryIngressPaths;
  /** The ingress CA, kept OUTSIDE the directory the ingress process mounts. */
  readonly authority: { readonly certificatePath: string; readonly keyPath: string };
  /**
   * Serialises route writes, rendering, and reloads across the fleet. The
   * rendered configuration is one file for every installation, so two
   * concurrent publishes would otherwise let the later render drop the earlier
   * route. The fleet composition supplies a database advisory lock.
   */
  readonly exclusive?: <Result>(work: () => Promise<Result>) => Promise<Result>;
  readonly reloader: FactoryIngressReloader;
  readonly probe: FactoryIngressProbe;
  readonly upstreamPort: (installation: FactoryInstallationContext) => number;
  readonly run?: FactoryCommandRunner;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly attempts?: number;
}

const dir = (paths: FactoryIngressPaths, name: "routes" | "certs" | "conf") => `${paths.root}/${name}`;

function renderRoute(paths: FactoryIngressPaths, route: FactoryIngressRoute): string {
  const certificate = `${paths.mountedRoot}/certs/${route.tenantId}.crt`;
  const key = `${paths.mountedRoot}/certs/${route.tenantId}.key`;
  const body = route.state === "serving"
    ? [
      `    proxy_pass http://127.0.0.1:${route.upstreamPort};`,
      "    proxy_set_header Host $host;",
      "    proxy_set_header X-Forwarded-Host $host;",
      "    proxy_set_header X-Forwarded-Proto https;",
      "    proxy_set_header X-Forwarded-For $remote_addr;",
      `    proxy_set_header X-EZCorp-Installation "${route.installationId}";`,
      `    proxy_set_header X-EZCorp-Ingress-Proof "${route.proof}";`,
      "    proxy_http_version 1.1;",
      "    proxy_set_header Upgrade $http_upgrade;",
      "    proxy_set_header Connection $connection_upgrade;",
      "    proxy_buffering off;",
      "    proxy_read_timeout 3600s;",
      "    client_max_body_size 128m;",
    ]
    : ["    default_type application/json;", "    return 503 '{\"error\":\"installation_not_serving\"}';"];
  return [
    "server {",
    `  listen ${paths.listenAddress}:${paths.listenPort} ssl;`,
    "  http2 on;",
    `  server_name ${route.hostname};`,
    `  ssl_certificate ${certificate};`,
    `  ssl_certificate_key ${key};`,
    `  add_header X-EZCorp-Route ${route.state} always;`,
    "  if ($ssl_server_name != $host) { return 421; }",
    "  location / {",
    ...body,
    "  }",
    "}",
  ].join("\n");
}

/** The whole ingress configuration: unknown names are refused at the TLS handshake. */
export function renderFactoryIngressConfig(paths: FactoryIngressPaths, routes: readonly FactoryIngressRoute[]): string {
  const hostnames = new Set<string>();
  for (const route of routes) {
    if (hostnames.has(route.hostname)) throw new FactoryProvisioningError("ingress_hostname_conflict", `Hostname ${route.hostname} is bound twice.`);
    hostnames.add(route.hostname);
    if (!/^[a-z0-9.-]{1,253}$/.test(route.hostname) || !/^[A-Za-z0-9-]{1,64}$/.test(route.installationId) || !Number.isSafeInteger(route.upstreamPort) || !PROOF.test(route.proof)) throw new FactoryProvisioningError("ingress_route_invalid", `Route for ${route.tenantId} is invalid.`);
  }
  return [
    "# Rendered by the factory provisioner (C12 step 6). Do not edit: the next render replaces it.",
    "map $http_upgrade $connection_upgrade { default upgrade; '' close; }",
    "server {",
    `  listen ${paths.listenAddress}:${paths.listenPort} ssl default_server;`,
    "  ssl_reject_handshake on;",
    "}",
    ...[...routes].sort((a, b) => a.hostname.localeCompare(b.hostname)).map((route) => renderRoute(paths, route)),
    "",
  ].join("\n");
}

export async function readFactoryIngressRoutes(paths: FactoryIngressPaths): Promise<readonly FactoryIngressRoute[]> {
  const directory = await openFactoryPrivateDirectory(dir(paths, "routes"));
  try {
    const names = (await readdir(dir(paths, "routes"))).filter((name) => name.endsWith(".json")).sort();
    const routes: FactoryIngressRoute[] = [];
    for (const name of names) routes.push(await readFactoryPrivateJson<FactoryIngressRoute>(directory, name));
    return routes;
  } finally { await directory.close(); }
}

export class FactoryIngressStep implements FactoryProvisioningDriver {
  readonly step = "ingress" as const;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly exclusive: <Result>(work: () => Promise<Result>) => Promise<Result>;
  constructor(private readonly options: FactoryIngressStepOptions) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((settle) => setTimeout(settle, milliseconds)));
    this.exclusive = options.exclusive ?? ((work) => work());
  }

  private async publish(): Promise<void> {
    const routes = await readFactoryIngressRoutes(this.options.paths);
    await replaceFactoryPrivateFile(factoryPrivatePath(dir(this.options.paths, "conf"), "ezcorp-factory.conf"), renderFactoryIngressConfig(this.options.paths, routes));
    await this.options.reloader.reload();
  }

  /** Wait until the running ingress answers this hostname as the route state says it must. */
  private async expect(installation: FactoryInstallationContext, state: FactoryIngressRouteState | "absent"): Promise<void> {
    let last: FactoryIngressProbeResult | undefined;
    for (let attempt = 0; attempt < (this.options.attempts ?? 40); attempt++) {
      try { last = await this.options.probe.request(installation.hostname, "/api/ready"); }
      catch { last = { status: 0 }; }
      if (state === "absent" ? last.status === 0 : state === "held" ? last.status === 503 && last.route === "held" : last.status === 200 && last.route === "serving") return;
      await this.sleep(250);
    }
    throw new FactoryProvisioningError("ingress_route_unobserved", `Ingress did not answer ${installation.hostname} as ${state} (last status ${last?.status}).`);
  }

  private async proof(installation: FactoryInstallationContext): Promise<string> {
    const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
    try {
      await ensureFactoryPrivateFile(secrets, FACTORY_INGRESS_PROOF_FILE, () => `${randomBytes(32).toString("hex")}\n`);
      const proof = (await readFactoryPrivateText(secrets, FACTORY_INGRESS_PROOF_FILE)).trim();
      if (!PROOF.test(proof)) throw new FactoryProvisioningError("ingress_proof_invalid", "The installation's ingress proof is malformed.");
      return proof;
    } finally { await secrets.close(); }
  }

  /**
   * Hand the proof to the running harness through its own delivery. The
   * harness refuses every routed request until the file exists, then keeps
   * the value it read; the proof is issued once and never rotated.
   */
  private async deliverProof(installation: FactoryInstallationContext, proof: string): Promise<void> {
    await replaceFactoryPrivateFile(factoryPrivatePath(factoryDeliveryDirectory(installation, "harness"), FACTORY_INGRESS_PROOF_FILE), `${proof}\n`);
  }

  private async writeRoute(installation: FactoryInstallationContext, state: FactoryIngressRouteState): Promise<void> {
    const route: FactoryIngressRoute = { schemaVersion: "factory.ingress-route.v1", tenantId: installation.tenantId, hostname: installation.hostname, installationId: installation.installationId, upstreamPort: this.options.upstreamPort(installation), state, proof: await this.proof(installation) };
    await replaceFactoryPrivateFile(factoryPrivatePath(dir(this.options.paths, "routes"), `${installation.tenantId}.json`), `${JSON.stringify(route)}\n`);
  }

  private async currentState(installation: FactoryInstallationContext): Promise<FactoryIngressRouteState | undefined> {
    const directory = await openFactoryPrivateDirectory(dir(this.options.paths, "routes"));
    try { return (await readFactoryPrivateJson<FactoryIngressRoute>(directory, `${installation.tenantId}.json`)).state; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    finally { await directory.close(); }
  }

  /** Write the route in `state`, publish, and wait for the running ingress to answer so, as one fleet-exclusive act. */
  private async route(installation: FactoryInstallationContext, state: FactoryIngressRouteState): Promise<void> {
    await this.exclusive(async () => {
      // A hostname another installation already holds is refused BEFORE anything
      // is written: a route file left behind would fail every later publish.
      const claimed = (await readFactoryIngressRoutes(this.options.paths)).find((existing) => existing.hostname === installation.hostname && existing.tenantId !== installation.tenantId);
      if (claimed) throw new FactoryProvisioningError("ingress_hostname_conflict", `Hostname ${installation.hostname} is bound to ${claimed.tenantId}.`);
      await this.writeRoute(installation, state);
      await this.publish();
    });
    await this.expect(installation, state);
  }

  async ensure(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    const certs = await openFactoryPrivateDirectory(dir(this.options.paths, "certs"));
    try {
      await ensureFactoryPrivateCertificatePair(certs, { key: `${installation.tenantId}.key`, certificate: `${installation.tenantId}.crt` }, () => issueFactoryCertificate(this.options.authority, { subject: installation.tenantId, usage: "server", dnsNames: [installation.hostname] }, this.options.run));
    } finally { await certs.close(); }
    await this.deliverProof(installation, await this.proof(installation));
    await this.route(installation, await this.currentState(installation) ?? "held");
    return this.resources(installation);
  }

  async verify(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void> {
    const current = await this.resources(installation);
    if (current.certificateHash !== resources.certificateHash || resources.installationId !== installation.installationId) throw new FactoryProvisioningError("ingress_resource_mismatch", "The ingress binding changed since it was recorded.");
    const delivered = new TextDecoder().decode(await readFactoryPrivatePath(factoryPrivatePath(factoryDeliveryDirectory(installation, "harness"), FACTORY_INGRESS_PROOF_FILE))).trim();
    if (delivered !== await this.proof(installation)) throw new FactoryProvisioningError("ingress_proof_undelivered", "The harness does not hold the installation's current ingress proof.");
    await this.expect(installation, await this.currentState(installation) ?? "held");
  }

  /** Open the route. Only the provisioner calls this, and only after the invitation step. */
  async serve(installation: FactoryInstallationContext): Promise<void> {
    await this.route(installation, "serving");
  }

  /** Close the route to traffic without unbinding the hostname. The first act of teardown. */
  async hold(installation: FactoryInstallationContext): Promise<void> {
    if (await this.currentState(installation) === undefined) return;
    await this.route(installation, "held");
  }

  async teardown(installation: FactoryInstallationContext): Promise<void> {
    await this.exclusive(async () => {
      for (const [root, name] of [[dir(this.options.paths, "routes"), `${installation.tenantId}.json`], [dir(this.options.paths, "certs"), `${installation.tenantId}.crt`], [dir(this.options.paths, "certs"), `${installation.tenantId}.key`], [installation.secretDirectory, FACTORY_INGRESS_PROOF_FILE]] as const) {
        const directory = await openFactoryPrivateDirectory(root);
        try { await removeFactoryPrivateFile(directory, name); } finally { await directory.close(); }
      }
      await this.publish();
    });
    await this.expect(installation, "absent");
  }

  private async resources(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    const certificatePem = new TextDecoder().decode(await readFactoryPrivatePath(`${dir(this.options.paths, "certs")}/${installation.tenantId}.crt`));
    const certificate = new X509Certificate(certificatePem);
    if (!certificate.subjectAltName?.split(", ").includes(`DNS:${installation.hostname}`)) throw new FactoryProvisioningError("ingress_certificate_invalid", "The ingress certificate does not name the installation's hostname.");
    return Object.freeze({ hostname: installation.hostname, installationId: installation.installationId, routePath: factoryPrivatePath(dir(this.options.paths, "routes"), `${installation.tenantId}.json`), certificateHash: factoryCertificateHash(certificatePem), upstreamPort: String(this.options.upstreamPort(installation)) });
  }
}

/** Probe the ingress over real TLS: SNI and Host both set to the hostname, the fleet CA trusted. */
export function factoryHttpsIngressProbe(address: string, port: number, caPem: string): FactoryIngressProbe {
  return {
    request: (hostname, path, options = {}) => new Promise((settle, reject) => {
      const request = httpsRequest({ host: address, port, path, method: "GET", servername: hostname, ca: caPem, headers: { host: options.host ?? hostname }, timeout: 5_000 }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size <= 64 * 1024) chunks.push(chunk); });
        response.once("end", () => settle({ status: response.statusCode ?? 0, route: typeof response.headers["x-ezcorp-route"] === "string" ? response.headers["x-ezcorp-route"] : undefined, body: Buffer.concat(chunks).toString("utf8") }));
      });
      // Bun does not emit `error` for `destroy(error)`, so the timeout rejects itself.
      request.once("timeout", () => { const error = new Error("ingress probe timed out"); request.destroy(error); reject(error); });
      request.once("error", reject);
      request.end();
    }),
  };
}

/**
 * Observe a human bootstrap from outside, through the installation's own route.
 * The status route names a state and an invitation only.
 */
export function factoryIngressBootstrapObserver(probe: FactoryIngressProbe): { observe(installation: FactoryInstallationContext): Promise<{ readonly complete: boolean; readonly invitationId?: string }> } {
  return {
    async observe(installation) {
      const result = await probe.request(installation.hostname, "/api/installation/bootstrap/status");
      if (result.status !== 200 || !result.body) throw new FactoryProvisioningError("bootstrap_unobservable", `The bootstrap status of ${installation.tenantId} answered ${result.status}.`);
      const status = JSON.parse(result.body) as { state?: unknown; invitationId?: unknown };
      return { complete: status.state === "consented", ...(typeof status.invitationId === "string" ? { invitationId: status.invitationId } : {}) };
    },
  };
}
