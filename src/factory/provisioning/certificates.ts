/**
 * The provisioner's certificate authority, on openssl.
 *
 * Two authorities use it. The fleet's Temporal authority signs one client
 * certificate per namespace. Each installation's MESH authority signs the
 * certificates its own processes present to each other — the product's private
 * service, the pool, the supervisor, the gateway — so a certificate issued for
 * one installation is worthless against another's listeners.
 *
 * Key material is generated inside a private scratch directory that is removed
 * before any function here returns. A CA key is read by openssl from its
 * operator path and never copied.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryProvisioningError } from "./steps";

export interface FactoryCertificateAuthorityPaths {
  readonly certificatePath: string;
  readonly keyPath: string;
}

export interface FactoryIssuedCertificate {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

export interface FactoryCertificateRequest {
  readonly subject: string;
  /** `peer` carries both usages: a Temporal node presents its server certificate as a client to its peers. */
  readonly usage: "client" | "server" | "peer";
  readonly dnsNames?: readonly string[];
  readonly ipAddresses?: readonly string[];
  readonly days?: number;
}

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const DNS = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const IP = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export type FactoryCommandRunner = (command: string, args: readonly string[]) => Promise<void>;

export const factorySpawnRunner: FactoryCommandRunner = (command, args) => new Promise((resolve_, reject) => {
  const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("error", (error) => reject(new FactoryProvisioningError("certificate_tool_unavailable", `${command} could not start: ${error.message}`)));
  child.once("close", (code) => code === 0 ? resolve_() : reject(new FactoryProvisioningError("certificate_issue_failed", `${command} ${args[0]} exited ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`)));
});

async function scratch<Result>(work: (directory: string) => Promise<Result>): Promise<Result> {
  const directory = await mkdtemp(join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "factory-certificate-"));
  try { return await work(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

export function factoryCertificateExtensions(request: FactoryCertificateRequest): string {
  if (!SUBJECT.test(request.subject)) throw new FactoryProvisioningError("certificate_subject_invalid", "Certificate subject is invalid.");
  const dns = request.dnsNames ?? [];
  const ips = request.ipAddresses ?? [];
  if (dns.some((name) => !DNS.test(name)) || ips.some((address) => !IP.test(address))) throw new FactoryProvisioningError("certificate_subject_invalid", "Certificate subject alternative name is invalid.");
  const alternatives = [...dns.map((name) => `DNS:${name}`), ...ips.map((address) => `IP:${address}`)];
  return [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    `extendedKeyUsage=${request.usage === "server" ? "serverAuth" : request.usage === "client" ? "clientAuth" : "serverAuth,clientAuth"}`,
    ...(alternatives.length > 0 ? [`subjectAltName=${alternatives.join(",")}`] : []),
    "",
  ].join("\n");
}

/** Create a CA key and self-signed certificate. The caller writes both privately. */
export async function createFactoryCertificateAuthority(subject: string, run: FactoryCommandRunner = factorySpawnRunner): Promise<FactoryIssuedCertificate> {
  if (!SUBJECT.test(subject)) throw new FactoryProvisioningError("certificate_subject_invalid", "Certificate authority subject is invalid.");
  return scratch(async (directory) => {
    const key = join(directory, "ca.key"), certificate = join(directory, "ca.crt");
    await run("openssl", ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", key]);
    await run("openssl", ["req", "-x509", "-new", "-key", key, "-sha256", "-days", "365", "-subj", `/CN=${subject}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", certificate]);
    return { certificatePem: await readFile(certificate, "utf8"), privateKeyPem: await readFile(key, "utf8") };
  });
}

/** Issue one leaf certificate from a CA held at operator paths. */
export async function issueFactoryCertificate(authority: FactoryCertificateAuthorityPaths, request: FactoryCertificateRequest, run: FactoryCommandRunner = factorySpawnRunner): Promise<FactoryIssuedCertificate> {
  const extensions = factoryCertificateExtensions(request);
  return scratch(async (directory) => {
    const key = join(directory, "leaf.key"), csr = join(directory, "leaf.csr"), certificate = join(directory, "leaf.crt"), extfile = join(directory, "leaf.ext");
    await writeFile(extfile, extensions, { mode: 0o600 });
    await run("openssl", ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", key]);
    await run("openssl", ["req", "-new", "-key", key, "-out", csr, "-subj", `/CN=${request.subject}`]);
    await run("openssl", ["x509", "-req", "-in", csr, "-CA", authority.certificatePath, "-CAkey", authority.keyPath, "-set_serial", `0x${randomBytes(16).toString("hex")}`, "-days", String(request.days ?? 90), "-sha256", "-extfile", extfile, "-out", certificate]);
    return { certificatePem: await readFile(certificate, "utf8"), privateKeyPem: await readFile(key, "utf8") };
  });
}
