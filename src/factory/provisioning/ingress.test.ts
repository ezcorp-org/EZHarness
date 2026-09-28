import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  factoryRejection,
  makeFactoryPrivateRoot,
  makeFactoryTestAuthority,
  makeFactoryTestInstallation,
  removeFactoryPrivateRoot,
  writeModeFile,
} from "../../__tests__/helpers/factory-private-root";
import { issueFactoryCertificate } from "./certificates";
import {
  FACTORY_INGRESS_PROOF_FILE,
  FactoryIngressStep,
  factoryHttpsIngressProbe,
  factoryIngressBootstrapObserver,
  readFactoryIngressRoutes,
  renderFactoryIngressConfig,
  type FactoryIngressPaths,
  type FactoryIngressProbe,
  type FactoryIngressProbeResult,
  type FactoryIngressRoute,
  type FactoryIngressStepOptions,
} from "./ingress";
import type { FactoryInstallationContext } from "./installation";
import { openFactoryPrivateDirectory } from "./secret-files";
import { factoryCertificateHash } from "./temporal";

const PATHS = { root: "/srv/ingress", mountedRoot: "/etc/ezcorp-ingress", listenAddress: "127.0.0.1", listenPort: 30443 };

function route(overrides: Partial<FactoryIngressRoute> = {}): FactoryIngressRoute {
  return { schemaVersion: "factory.ingress-route.v1", tenantId: "tenant-01", hostname: "tenant-01.factory.example", installationId: "inst-tenant-01", upstreamPort: 40_010, state: "held", proof: "a".repeat(64), ...overrides };
}

function refusalCode(work: () => unknown): string | undefined {
  try { work(); } catch (error) { return (error as { code?: string }).code; }
  return undefined;
}

describe("renderFactoryIngressConfig", () => {
  test("with no route, only the default server that refuses every handshake", () => {
    const config = renderFactoryIngressConfig(PATHS, []);
    expect(config).toContain("  listen 127.0.0.1:30443 ssl default_server;\n  ssl_reject_handshake on;");
    expect(config).not.toContain("server_name");
    expect(config.endsWith("\n")).toBe(true);
  });

  test("a held route answers 503 and forwards nothing", () => {
    const config = renderFactoryIngressConfig(PATHS, [route()]);
    expect(config).toContain("  server_name tenant-01.factory.example;");
    expect(config).toContain("  ssl_certificate /etc/ezcorp-ingress/certs/tenant-01.crt;");
    expect(config).toContain("  ssl_certificate_key /etc/ezcorp-ingress/certs/tenant-01.key;");
    expect(config).toContain("  add_header X-EZCorp-Route held always;");
    expect(config).toContain(`    return 503 '{"error":"installation_not_serving"}';`);
    expect(config).not.toContain("proxy_pass");
    expect(config).not.toContain("X-EZCorp-Installation");
    expect(config).not.toContain("X-EZCorp-Ingress-Proof");
    expect(config).not.toContain("a".repeat(64));
  });

  test("a serving route forwards to its harness and overwrites the installation header", () => {
    const config = renderFactoryIngressConfig(PATHS, [route({ state: "serving" })]);
    expect(config).toContain("    proxy_pass http://127.0.0.1:40010;");
    expect(config).toContain('    proxy_set_header X-EZCorp-Installation "inst-tenant-01";');
    // proxy_set_header REPLACES a header of the same name the client sent, so a
    // client-supplied proof never reaches the harness; only the route's does.
    expect(config).toContain(`    proxy_set_header X-EZCorp-Ingress-Proof "${"a".repeat(64)}";`);
    expect(config.match(/X-EZCorp-Ingress-Proof/g)?.length).toBe(1);
    expect(config).not.toMatch(/\$http_x_ezcorp_ingress_proof|proxy_pass_request_headers|underscores_in_headers/);
    expect(config).toContain("  add_header X-EZCorp-Route serving always;");
    expect(config).not.toContain("return 503");
  });

  test("every route refuses a request whose TLS server name differs from its Host with 421", () => {
    const config = renderFactoryIngressConfig(PATHS, [route(), route({ tenantId: "tenant-02", hostname: "tenant-02.factory.example", installationId: "inst-tenant-02", state: "serving" })]);
    expect(config.match(/ {2}if \(\$ssl_server_name != \$host\) \{ return 421; \}/g)?.length).toBe(2);
  });

  test("routes are rendered in hostname order whatever order they are read in", () => {
    const b = route({ tenantId: "tenant-02", hostname: "b.factory.example", installationId: "inst-b" });
    const a = route({ tenantId: "tenant-03", hostname: "a.factory.example", installationId: "inst-a" });
    const config = renderFactoryIngressConfig(PATHS, [b, a]);
    expect(config.indexOf("server_name a.factory.example")).toBeLessThan(config.indexOf("server_name b.factory.example"));
    expect(renderFactoryIngressConfig(PATHS, [a, b])).toBe(config);
  });

  test("one hostname bound by two installations is refused", () => {
    expect(refusalCode(() => renderFactoryIngressConfig(PATHS, [route(), route({ tenantId: "tenant-02", installationId: "inst-tenant-02" })]))).toBe("ingress_hostname_conflict");
  });

  test("a route with an unsafe hostname, installation identity, or port is refused", () => {
    for (const bad of [
      { hostname: "Tenant.example" }, { hostname: "a b.example" }, { hostname: "" }, { hostname: `${"a".repeat(254)}` }, { hostname: "evil.example;\n  return 200" },
      { installationId: "inst tenant" }, { installationId: 'inst"; more' }, { installationId: "a".repeat(65) }, { installationId: "" },
      { upstreamPort: 40_010.5 }, { upstreamPort: Number.NaN },
      { proof: "" }, { proof: "A".repeat(64) }, { proof: "a".repeat(63) }, { proof: `${"a".repeat(62)}";` },
    ]) {
      expect(refusalCode(() => renderFactoryIngressConfig(PATHS, [route(bad)]))).toBe("ingress_route_invalid");
    }
    expect(refusalCode(() => renderFactoryIngressConfig(PATHS, [route({ hostname: "a".repeat(253), installationId: "a".repeat(64) })]))).toBeUndefined();
  });
});

/**
 * A fake ingress: `reload` reads the rendered config the step wrote, and the
 * probe answers each hostname as that config says — absent (connection
 * refused), held (503), or serving (200).
 */
function fakeIngress(paths: FactoryIngressPaths): { reloader: FactoryIngressStepOptions["reloader"]; probe: FactoryIngressProbe; readonly reloads: number; readonly requests: string[] } {
  let live = new Map<string, "held" | "serving">();
  let reloads = 0;
  const requests: string[] = [];
  return {
    reloader: {
      async reload() {
        reloads++;
        const config = await readFile(join(paths.root, "conf", "ezcorp-factory.conf"), "utf8");
        live = new Map([...config.matchAll(/server_name (\S+);[\s\S]*?X-EZCorp-Route (held|serving)/g)].map((match) => [match[1]!, match[2] as "held" | "serving"]));
      },
    },
    probe: {
      async request(hostname, path) {
        requests.push(`${hostname}${path}`);
        const state = live.get(hostname);
        if (!state) throw new Error("connection refused");
        return state === "held" ? { status: 503, route: "held" } : { status: 200, route: "serving" };
      },
    },
    get reloads() { return reloads; },
    requests,
  };
}

describe("FactoryIngressStep", () => {
  let root: string;
  let paths: FactoryIngressPaths;
  let caPem: string;
  let authority: FactoryIngressStepOptions["authority"];
  let installation: FactoryInstallationContext;
  let ingress: ReturnType<typeof fakeIngress>;
  let slept: number[];

  const step = (overrides: Partial<FactoryIngressStepOptions> = {}) => new FactoryIngressStep({
    paths, authority, reloader: ingress.reloader, probe: ingress.probe, upstreamPort: () => 40_010, sleep: async (milliseconds) => { slept.push(milliseconds); }, ...overrides,
  });
  const proofFile = (target = installation) => join(target.secretDirectory, FACTORY_INGRESS_PROOF_FILE);
  const deliveredProofFile = (target = installation) => join(target.secretDirectory, "deliver", "harness", FACTORY_INGRESS_PROOF_FILE);
  const routeFile = (tenantId = "tenant-01") => join(paths.root, "routes", `${tenantId}.json`);
  const config = () => readFile(join(paths.root, "conf", "ezcorp-factory.conf"), "utf8");

  beforeAll(async () => {
    root = await makeFactoryPrivateRoot();
    const ingressRoot = join(root, "ingress");
    const authorityRoot = join(root, "ingress-ca");
    for (const directory of [ingressRoot, authorityRoot]) await (await openFactoryPrivateDirectory(directory)).close();
    const made = await makeFactoryTestAuthority(authorityRoot, "ingress-ca");
    caPem = made.certificatePem;
    authority = { certificatePath: made.certificatePath, keyPath: made.keyPath };
    paths = { ...PATHS, root: ingressRoot };
    installation = makeFactoryTestInstallation(root);
  });
  afterAll(async () => { await removeFactoryPrivateRoot(root); });
  beforeEach(() => { ingress = fakeIngress(paths); slept = []; });

  test("ensure issues the hostname certificate, binds a held route, publishes, and observes it held", async () => {
    const resources = await step().ensure(installation);
    const certificatePem = await readFile(join(paths.root, "certs", "tenant-01.crt"), "utf8");
    const certificate = new X509Certificate(certificatePem);
    expect(certificate.subjectAltName).toBe("DNS:tenant-01.factory.example");
    expect(certificate.verify(new X509Certificate(caPem).publicKey)).toBe(true);
    expect(resources).toEqual({ hostname: "tenant-01.factory.example", installationId: "inst-tenant-01", routePath: routeFile(), certificateHash: factoryCertificateHash(certificatePem), upstreamPort: "40010" });
    const proof = (await readFile(proofFile(), "utf8")).trim();
    expect(proof).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(routeFile(), "utf8"))).toEqual(route({ proof }));
    expect(await readFile(deliveredProofFile(), "utf8")).toBe(`${proof}\n`);
    for (const path of [proofFile(), deliveredProofFile()]) expect((await stat(path)).mode & 0o777).toBe(0o600);
    // The ingress process mounts only its root; the authority that signs every hostname is not in it.
    expect((await readdir(paths.root)).sort()).toEqual(["certs", "conf", "routes"]);
    expect(authority.keyPath.startsWith(`${paths.root}/`)).toBe(false);
    expect((await stat(join(paths.root, "certs", "tenant-01.key"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(paths.root, "conf", "ezcorp-factory.conf"))).mode & 0o777).toBe(0o600);
    expect(await config()).toContain("X-EZCorp-Route held");
    expect(ingress.reloads).toBe(1);
    expect(ingress.requests).toEqual(["tenant-01.factory.example/api/ready"]);
    expect(slept).toEqual([]);
  });

  test("verify accepts the recorded binding and re-observes the live route", async () => {
    const resources = await step().ensure(installation);
    ingress.requests.length = 0;
    await step().verify(installation, resources);
    expect(ingress.requests).toEqual(["tenant-01.factory.example/api/ready"]);
  });

  test("verify refuses a binding whose certificate or installation changed since it was recorded", async () => {
    const resources = await step().ensure(installation);
    expect((await factoryRejection(step().verify(installation, { ...resources, certificateHash: "sha256:other" }))).code).toBe("ingress_resource_mismatch");
    expect((await factoryRejection(step().verify({ ...installation, installationId: "inst-other" }, resources))).code).toBe("ingress_resource_mismatch");
  });

  test("a certificate that does not name the installation's hostname is refused", async () => {
    await step().ensure(installation);
    const renamed = { ...installation, hostname: "renamed.factory.example" };
    expect((await factoryRejection(step().verify(renamed, {}))).code).toBe("ingress_certificate_invalid");
  });

  test("serve opens the route to the harness; a rerun of ensure keeps it serving and keeps the certificate", async () => {
    const first = await step().ensure(installation);
    await step().serve(installation);
    expect(JSON.parse(await readFile(routeFile(), "utf8")).state).toBe("serving");
    expect(await config()).toContain("proxy_pass http://127.0.0.1:40010;");
    const proof = await readFile(proofFile(), "utf8");
    expect(await config()).toContain(`proxy_set_header X-EZCorp-Ingress-Proof "${proof.trim()}";`);
    const again = await step().ensure(installation);
    expect(again.certificateHash).toBe(first.certificateHash);
    expect(await readFile(proofFile(), "utf8")).toBe(proof);
    expect(JSON.parse(await readFile(routeFile(), "utf8")).state).toBe("serving");
  });

  test("hold closes a serving route without unbinding the hostname", async () => {
    await step().ensure(installation);
    await step().serve(installation);
    await step().hold(installation);
    expect(JSON.parse(await readFile(routeFile(), "utf8")).state).toBe("held");
    expect(await config()).toContain("server_name tenant-01.factory.example;");
    expect(await config()).not.toContain("proxy_pass");
  });

  test("hold of an installation that was never bound does nothing", async () => {
    await step().hold(makeFactoryTestInstallation(root, { tenantId: "tenant-09" }));
    expect(ingress.reloads).toBe(0);
    expect(ingress.requests).toEqual([]);
  });

  test("a second installation cannot bind the first installation's hostname", async () => {
    await step().ensure(installation);
    const squatter = makeFactoryTestInstallation(root, { tenantId: "tenant-02", hostname: installation.hostname });
    expect((await factoryRejection(step().ensure(squatter))).code).toBe("ingress_hostname_conflict");
    // The owner keeps answering the hostname, so the squatter's teardown
    // removes its files but cannot observe the hostname absent.
    expect((await factoryRejection(step({ attempts: 2 }).teardown(squatter))).code).toBe("ingress_route_unobserved");
    expect(await readdir(join(paths.root, "routes"))).not.toContain("tenant-02.json");
    expect(await config()).toContain("server_name tenant-01.factory.example;");
  });

  test("two installations are routed independently, and routes are read back sorted", async () => {
    const second = makeFactoryTestInstallation(root, { tenantId: "tenant-02" });
    await step().ensure(installation);
    await step({ upstreamPort: () => 40_020 }).ensure(second);
    await step({ upstreamPort: () => 40_020 }).serve(second);
    const routes = await readFactoryIngressRoutes(paths);
    expect(routes.map((entry) => [entry.tenantId, entry.state, entry.upstreamPort])).toEqual([["tenant-01", "held", 40_010], ["tenant-02", "serving", 40_020]]);
    expect(await config()).toContain("proxy_pass http://127.0.0.1:40020;");
    expect(await config()).not.toContain("proxy_pass http://127.0.0.1:40010;");
    await step().teardown(second);
  });

  test("teardown unbinds the hostname, deletes its certificate and key, and runs twice", async () => {
    await step().ensure(installation);
    await step().teardown(installation);
    expect(await readdir(join(paths.root, "routes"))).not.toContain("tenant-01.json");
    const certs = await readdir(join(paths.root, "certs"));
    expect(certs).not.toContain("tenant-01.crt");
    expect(certs).not.toContain("tenant-01.key");
    expect(await Bun.file(proofFile()).exists()).toBe(false);
    expect(await config()).not.toContain("tenant-01.factory.example");
    await step().teardown(installation);
    expect(ingress.requests.at(-1)).toBe("tenant-01.factory.example/api/ready");
  });

  test("a route the ingress never answers as expected fails after the configured attempts", async () => {
    const probe: FactoryIngressProbe = { request: async () => ({ status: 500 }) };
    const error = await factoryRejection(step({ probe, attempts: 3 }).ensure(installation));
    expect(error.code).toBe("ingress_route_unobserved");
    expect(error.message).toBe("Ingress did not answer tenant-01.factory.example as held (last status 500).");
    expect(slept).toEqual([250, 250, 250]);
  });

  test("a probe that cannot connect counts as status 0, which only an absent route accepts", async () => {
    const probe: FactoryIngressProbe = { request: async () => { throw new Error("ECONNREFUSED"); } };
    const error = await factoryRejection(step({ probe, attempts: 2 }).serve(installation));
    expect(error.message).toBe("Ingress did not answer tenant-01.factory.example as serving (last status 0).");
    await step({ probe }).teardown(installation);
    expect(slept).toEqual([250, 250]);
  });

  test("a held answer without the route header is not accepted as held", async () => {
    const probe: FactoryIngressProbe = { request: async () => ({ status: 503 }) };
    expect((await factoryRejection(step({ probe, attempts: 1 }).ensure(installation))).code).toBe("ingress_route_unobserved");
    await step({ probe: { request: async () => { throw new Error("gone"); } } }).teardown(installation);
  });

  test("zero attempts reports an unobserved route with no status", async () => {
    const error = await factoryRejection(step({ attempts: 0 }).ensure(installation));
    expect(error.message).toContain("(last status undefined)");
    await step().teardown(installation);
  });

  test("without an injected sleep the step still waits between attempts and then fails", async () => {
    const probe: FactoryIngressProbe = { request: async () => ({ status: 502 }) };
    const error = await factoryRejection(new FactoryIngressStep({ paths, authority, reloader: ingress.reloader, probe, upstreamPort: () => 40_010, attempts: 1 }).ensure(installation));
    expect(error.code).toBe("ingress_route_unobserved");
    await step().teardown(installation);
  });

  test("a corrupt route file is reported rather than treated as unbound", async () => {
    await step().ensure(installation);
    await writeModeFile(routeFile(), "{not json");
    expect((await factoryRejection(step().ensure(installation))).code).toBe("provisioning_secret_corrupt");
    await step().teardown(installation);
  });

  test("a certificate file that is not private is refused rather than reissued over", async () => {
    await writeModeFile(join(paths.root, "certs", "tenant-07.crt"), "not a certificate", 0o644);
    const error = await factoryRejection(step().ensure(makeFactoryTestInstallation(root, { tenantId: "tenant-07" })));
    expect(error.message).toContain("private");
    expect(await readFile(join(paths.root, "certs", "tenant-07.crt"), "utf8")).toBe("not a certificate");
  });

  test("verify refuses a harness that does not hold the current ingress proof", async () => {
    const resources = await step().ensure(installation);
    await writeModeFile(deliveredProofFile(), `${"b".repeat(64)}\n`);
    const error = await factoryRejection(step().verify(installation, resources));
    expect(error.code).toBe("ingress_proof_undelivered");
    expect(error.message).toBe("The harness does not hold the installation's current ingress proof.");
    await rm(deliveredProofFile());
    expect((await factoryRejection(step().verify(installation, resources))).code).toBe("ENOENT");
    // A rerun of ensure re-delivers it.
    await step().ensure(installation);
    await step().verify(installation, resources);
    await step().teardown(installation);
  });

  test("a malformed ingress proof is refused rather than rendered", async () => {
    await mkdir(installation.secretDirectory, { recursive: true, mode: 0o700 });
    await writeModeFile(proofFile(), "not-a-proof\n");
    const error = await factoryRejection(step().ensure(installation));
    expect(error.code).toBe("ingress_proof_invalid");
    expect(await readdir(join(paths.root, "routes"))).not.toContain("tenant-01.json");
    await rm(proofFile());
    await step().teardown(installation);
  });

  test("route, render, and reload run inside the fleet-exclusive section, so two concurrent publishes both reach the config", async () => {
    let tail: Promise<unknown> = Promise.resolve();
    let inside = 0, overlapped = false, sections = 0;
    const reloadsInside: boolean[] = [];
    const exclusive: FactoryIngressStepOptions["exclusive"] = (work) => {
      const run = tail.then(async () => {
        sections++; inside++;
        if (inside > 1) overlapped = true;
        try { return await work(); } finally { inside--; }
      });
      tail = run.catch(() => undefined);
      return run;
    };
    // A reload that yields lets an unserialised publish interleave: its render would drop the other's route.
    const reloader = { reload: async () => { reloadsInside.push(inside === 1); await new Promise((settle) => setTimeout(settle, 5)); await ingress.reloader.reload(); } };
    const second = makeFactoryTestInstallation(root, { tenantId: "tenant-02" });
    await Promise.all([step({ exclusive, reloader }).ensure(installation), step({ exclusive, reloader, upstreamPort: () => 40_020 }).ensure(second)]);
    expect(overlapped).toBe(false);
    expect(sections).toBe(2);
    expect(reloadsInside).toEqual([true, true]);
    expect(await config()).toContain("server_name tenant-01.factory.example;");
    expect(await config()).toContain("server_name tenant-02.factory.example;");
    await step({ exclusive }).teardown(second);
    await step({ exclusive }).teardown(installation);
    expect(sections).toBe(4);
  });

  test("readFactoryIngressRoutes reads only route documents", async () => {
    await writeModeFile(join(paths.root, "routes", "notes.txt"), "ignored");
    await step().ensure(installation);
    expect((await readFactoryIngressRoutes(paths)).map((entry) => entry.tenantId)).toEqual(["tenant-01"]);
    await step().teardown(installation);
  });
});

describe("factoryHttpsIngressProbe", () => {
  const HOSTNAME = "tenant-01.factory.example";
  let root: string;
  let caPem: string;
  let server: Server;
  let port: number;
  const seen: { host?: string; path?: string }[] = [];

  beforeAll(async () => {
    root = await makeFactoryPrivateRoot();
    const authority = await makeFactoryTestAuthority(root, "probe-ca");
    caPem = authority.certificatePem;
    const leaf = await issueFactoryCertificate(authority, { subject: "tenant-01", usage: "server", dnsNames: [HOSTNAME] });
    server = createServer({ key: leaf.privateKeyPem, cert: leaf.certificatePem }, (request, response) => {
      seen.push({ host: request.headers.host, path: request.url });
      if (request.url === "/hang") return;
      if (request.url === "/large") { response.writeHead(200); response.end("x".repeat(200 * 1024)); return; }
      if (request.url === "/bare") { response.writeHead(204); response.end(); return; }
      response.writeHead(request.url === "/api/ready" ? 503 : 200, { "X-EZCorp-Route": "held", "content-type": "application/json" });
      response.end(JSON.stringify({ path: request.url }));
    });
    await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((settle) => server.close(() => settle()));
    await removeFactoryPrivateRoot(root);
  });
  afterEach(() => { seen.length = 0; });

  test("returns the status, the route header, and the body, with Host set to the hostname", async () => {
    const result = await factoryHttpsIngressProbe("127.0.0.1", port, caPem).request(HOSTNAME, "/api/ready");
    expect(result).toEqual({ status: 503, route: "held", body: '{"path":"/api/ready"}' });
    expect(seen).toEqual([{ host: HOSTNAME, path: "/api/ready" }]);
  });

  test("a Host override is sent while the TLS identity check keeps the hostname", async () => {
    const result = await factoryHttpsIngressProbe("127.0.0.1", port, caPem).request(HOSTNAME, "/x", { host: "tenant-02.factory.example" });
    expect(result.status).toBe(200);
    // The certificate names only tenant-01, so the handshake was checked against the hostname, not the Host.
    expect(seen).toEqual([{ host: "tenant-02.factory.example", path: "/x" }]);
  });

  test("an answer without the route header reports no route", async () => {
    expect(await factoryHttpsIngressProbe("127.0.0.1", port, caPem).request(HOSTNAME, "/bare")).toEqual({ status: 204, route: undefined, body: "" });
  });

  test("a body is kept only up to 64 KiB", async () => {
    const result = await factoryHttpsIngressProbe("127.0.0.1", port, caPem).request(HOSTNAME, "/large");
    expect(result.status).toBe(200);
    expect(result.body!.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.body!.length).toBeLessThan(200 * 1024);
  });

  test("a server certificate from another authority is refused", async () => {
    const other = await makeFactoryPrivateRoot();
    try {
      const foreign = await makeFactoryTestAuthority(other, "foreign-ca");
      const error = await factoryRejection(factoryHttpsIngressProbe("127.0.0.1", port, foreign.certificatePem).request(HOSTNAME, "/api/ready"));
      expect(error).toBeInstanceOf(Error);
      expect(seen).toEqual([]);
    } finally { await removeFactoryPrivateRoot(other); }
  });

  test("a hostname the certificate does not name is refused", async () => {
    const error = await factoryRejection(factoryHttpsIngressProbe("127.0.0.1", port, caPem).request("tenant-02.factory.example", "/api/ready"));
    expect(error).toBeInstanceOf(Error);
    expect(seen).toEqual([]);
  });

  test("a refused connection rejects", async () => {
    const closed = createServer();
    await new Promise<void>((settle) => closed.listen(0, "127.0.0.1", settle));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((settle) => closed.close(() => settle()));
    const error = await factoryRejection(factoryHttpsIngressProbe("127.0.0.1", closedPort, caPem).request(HOSTNAME, "/api/ready"));
    expect((error as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
  });

  test("a server that never answers is abandoned at the probe timeout", async () => {
    const error = await factoryRejection(factoryHttpsIngressProbe("127.0.0.1", port, caPem).request(HOSTNAME, "/hang"));
    expect(error.message).toBe("ingress probe timed out");
  }, 15_000);
});

describe("factoryIngressBootstrapObserver", () => {
  const installation = makeFactoryTestInstallation("/unused");
  const observer = (result: FactoryIngressProbeResult, seen: string[] = []) => factoryIngressBootstrapObserver({ request: async (hostname, path) => { seen.push(`${hostname}${path}`); return result; } });

  test("a consented bootstrap is complete and names its invitation", async () => {
    const seen: string[] = [];
    expect(await observer({ status: 200, body: '{"state":"consented","invitationId":"invite-tenant-01"}' }, seen).observe(installation)).toEqual({ complete: true, invitationId: "invite-tenant-01" });
    expect(seen).toEqual(["tenant-01.factory.example/api/installation/bootstrap/status"]);
  });

  test("a redeemed but not consented bootstrap is not complete, and a non-string invitation is dropped", async () => {
    expect(await observer({ status: 200, body: '{"state":"redeemed","invitationId":7}' }).observe(installation)).toEqual({ complete: false });
    expect(await observer({ status: 200, body: "{}" }).observe(installation)).toEqual({ complete: false });
  });

  test("a non-200 answer or an empty body is unobservable", async () => {
    for (const result of [{ status: 503, route: "held", body: "{}" }, { status: 404, body: "" }, { status: 200 }, { status: 200, body: "" }]) {
      const error = await factoryRejection(observer(result).observe(installation));
      expect(error.code).toBe("bootstrap_unobservable");
      expect(error.message).toBe(`The bootstrap status of tenant-01 answered ${result.status}.`);
    }
  });

  test("a malformed status body is a parse error", async () => {
    expect(await factoryRejection(observer({ status: 200, body: "<html>" }).observe(installation))).toBeInstanceOf(SyntaxError);
  });
});
