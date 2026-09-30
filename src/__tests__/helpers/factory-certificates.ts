import { connect } from "node:tls";
import { sign, type KeyObject } from "node:crypto";
import { expect } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Client certificates a verifying listener must refuse: each names the trusted client subject. */
export type UntrustedClients = Readonly<Record<"expired" | "notYetValid" | "serverAuthOnly" | "selfSigned", { readonly cert: string; readonly key: string }>>;

export type Certificates = { ca: string; serverKey: string; serverCert: string; clientKey: string; clientCert: string; foreignKey: string; foreignCert: string; untrusted?: UntrustedClients };

async function command(args: string[]): Promise<void> {
  const child = Bun.spawn(["openssl", ...args], { stdout: "ignore", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
}

/**
 * `untrustedClients` adds, for the client subject: a certificate from this
 * authority whose validity ended in 2020, one valid only from 2099, one with
 * serverAuth only, and a self-signed one. `serverAltNames` replaces the server
 * certificate's names (default `DNS:localhost,IP:127.0.0.1`), for example to
 * prove that a client verifies a pinned IP against the hostname only.
 */
export async function certificates(directories: string[], clientSubject = "tenant-a", options: { readonly untrustedClients?: boolean; readonly serverAltNames?: string } = {}): Promise<Certificates> {
  const root = await mkdtemp(join(tmpdir(), "factory-gateway-"));
  directories.push(root);
  await command(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "ca.key"), "-out", join(root, "ca.pem"), "-days", "1", "-subj", "/CN=factory-test-ca"]);
  const clientAuth = "extendedKeyUsage=clientAuth";
  // [file name, subject, extensions, validity arguments]
  const leaves: [string, string, string, string[]][] = [
    ["server", "localhost", `subjectAltName=${options.serverAltNames ?? "DNS:localhost,IP:127.0.0.1"}\nextendedKeyUsage=serverAuth`, ["-days", "1"]],
    ["client", clientSubject, clientAuth, ["-days", "1"]],
    ["foreign", "tenant-b", clientAuth, ["-days", "1"]],
  ];
  if (options.untrustedClients) {
    leaves.push(
      ["expired", clientSubject, clientAuth, ["-not_before", "20200101000000Z", "-not_after", "20200102000000Z"]],
      ["not-yet-valid", clientSubject, clientAuth, ["-not_before", "20990101000000Z", "-not_after", "20990102000000Z"]],
      ["server-auth-only", clientSubject, "extendedKeyUsage=serverAuth", ["-days", "1"]],
    );
    await command(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "self-signed.key"), "-out", join(root, "self-signed.pem"), "-days", "1", "-subj", `/CN=${clientSubject}`, "-addext", clientAuth]);
  }
  for (const [name, subject, extension, validity] of leaves) {
    await command(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, `${name}.key`), "-out", join(root, `${name}.csr`), "-subj", `/CN=${subject}`]);
    await Bun.write(join(root, `${name}.ext`), extension);
    await command(["x509", "-req", "-in", join(root, `${name}.csr`), "-CA", join(root, "ca.pem"), "-CAkey", join(root, "ca.key"), "-CAcreateserial", "-out", join(root, `${name}.pem`), ...validity, "-extfile", join(root, `${name}.ext`)]);
  }
  const get = (name: string) => readFile(join(root, name), "utf8");
  const pair = async (name: string) => ({ cert: await get(`${name}.pem`), key: await get(`${name}.key`) });
  return {
    ca: await get("ca.pem"), serverKey: await get("server.key"), serverCert: await get("server.pem"), clientKey: await get("client.key"), clientCert: await get("client.pem"), foreignKey: await get("foreign.key"), foreignCert: await get("foreign.pem"),
    ...(options.untrustedClients ? { untrusted: { expired: await pair("expired"), notYetValid: await pair("not-yet-valid"), serverAuthOnly: await pair("server-auth-only"), selfSigned: await pair("self-signed") } } : {}),
  };
}

export function signedServiceToken(privateKey: KeyObject, claims: Readonly<Record<string, unknown>>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}


export async function rawTls(url: string, certificates: Certificates, chunks: string[]): Promise<string> {
  const endpoint = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(endpoint.port), ca: certificates.ca, cert: certificates.clientCert, key: certificates.clientKey, servername: "localhost", rejectUnauthorized: true });
    socket.setTimeout(5_000, () => socket.destroy(new Error("TLS test request timed out")));
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", bytes => { response += bytes; });
    socket.once("error", reject);
    socket.once("end", () => resolve(response));
    socket.once("secureConnect", async () => { for (const chunk of chunks) { socket.write(chunk); await new Promise(resolve => setTimeout(resolve, 1)); } });
  });
}


async function nodeFixture<Result>(filename: string, input: unknown, label: string): Promise<Result> {
  const child = Bun.spawn(["node", new URL(filename, import.meta.url).pathname], { stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${label} failed: ${stderr}`);
  return JSON.parse(stdout);
}

/** Run the actual Node HTTP stack; secret inputs travel only on stdin. */
export async function nodeHttpsRequest(url: string, certs: Certificates, options: { method?: string; body?: unknown; token?: string; certificate?: "client" | "foreign" | "none"; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Buffer }> {
  const certificate = options.certificate ?? "client";
  const received = await nodeFixture<{ status: number; body: string }>("./factory-node-https-client.mjs", { url, method: options.method ?? "POST", ...(options.body === undefined ? {} : { body: Buffer.from(JSON.stringify(options.body)).toString("base64") }), ca: certs.ca, cert: certificate === "client" ? certs.clientCert : certificate === "foreign" ? certs.foreignCert : undefined, key: certificate === "client" ? certs.clientKey : certificate === "foreign" ? certs.foreignKey : undefined, headers: { "content-type": "application/json", "x-ezcorp-factory-version": "1", ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }), ...options.headers } }, "Node HTTPS client");
  return { status: received.status, body: Buffer.from(received.body, "base64") };
}

/** Exercise the production Node queue client against the live Bun service. */
export async function nodeFactoryQueueCycle(url: string, certs: Certificates, token: string): Promise<{ command: unknown; confirmed: boolean; empty: unknown }> {
  return nodeFixture("./factory-node-queue-client.mjs", { url, ca: certs.ca, cert: certs.clientCert, key: certs.clientKey, token }, "Node queue client");
}
