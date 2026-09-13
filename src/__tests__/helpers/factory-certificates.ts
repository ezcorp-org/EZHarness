import { connect } from "node:tls";
import { expect } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Certificates = { ca: string; serverKey: string; serverCert: string; clientKey: string; clientCert: string; foreignKey: string; foreignCert: string };

async function command(args: string[]): Promise<void> {
  const child = Bun.spawn(["openssl", ...args], { stdout: "ignore", stderr: "pipe" });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
}

export async function certificates(directories: string[]): Promise<Certificates> {
  const root = await mkdtemp(join(tmpdir(), "factory-gateway-"));
  directories.push(root);
  await command(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "ca.key"), "-out", join(root, "ca.pem"), "-days", "1", "-subj", "/CN=factory-test-ca"]);
  for (const [name, subject, extension] of [["server", "localhost", "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth"], ["client", "tenant-a", "extendedKeyUsage=clientAuth"], ["foreign", "tenant-b", "extendedKeyUsage=clientAuth"]] as const) {
    await command(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, `${name}.key`), "-out", join(root, `${name}.csr`), "-subj", `/CN=${subject}`]);
    await Bun.write(join(root, `${name}.ext`), extension);
    await command(["x509", "-req", "-in", join(root, `${name}.csr`), "-CA", join(root, "ca.pem"), "-CAkey", join(root, "ca.key"), "-CAcreateserial", "-out", join(root, `${name}.pem`), "-days", "1", "-extfile", join(root, `${name}.ext`)]);
  }
  const get = (name: string) => readFile(join(root, name), "utf8");
  return { ca: await get("ca.pem"), serverKey: await get("server.key"), serverCert: await get("server.pem"), clientKey: await get("client.key"), clientCert: await get("client.pem"), foreignKey: await get("foreign.key"), foreignCert: await get("foreign.pem") };
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

